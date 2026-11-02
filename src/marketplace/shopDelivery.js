// =====================================================
// PHASE 60: SHOP-MANAGED DELIVERY SETTINGS (shop portal)
//   GET /api/shop/shop-delivery
//   PUT /api/shop/shop-delivery
//     { enabled, cashOnDelivery, courier, note,
//       zones: [{ district, fee, minDays, maxDays }] }
// Clothing shops only. The shop sets its own fees and delivery days
// per district; GetMe shows exactly these to customers.
// =====================================================

const { pool, fail, text, bool, round2 } = require('./common');
const { DISTRICTS, normalize } = require('./district');
const { recordShopActivity } = require('../middleware/shopAccess');
const { broadcastCatalogChange } = require('../realtime');

const viewOf = async (shopId) => {
  const shop = (await pool.query('SELECT * FROM shops WHERE id = $1', [shopId])).rows[0];
  const zones = (
    await pool.query('SELECT * FROM shop_delivery_zones WHERE shop_id = $1 ORDER BY district', [shopId])
  ).rows;
  return {
    available: shop.business_type === 'clothing',
    enabled: !!shop.shop_delivery_enabled,
    cashOnDelivery: !!shop.shop_delivery_cod,
    courier: shop.shop_delivery_courier || null,
    note: shop.shop_delivery_note || null,
    zones: zones.map((z) => ({
      district: z.district,
      province: DISTRICTS.find((d) => d.name === z.district)?.province || null,
      fee: round2(z.fee),
      minDays: Number(z.min_days),
      maxDays: Number(z.max_days),
      isActive: !!z.is_active,
    })),
    districts: DISTRICTS,
  };
};

const getShopDelivery = async (req, res) => {
  try {
    return res.json({ success: true, shopDelivery: await viewOf(req.shop.shopId) });
  } catch (error) {
    console.error('❌ SHOP DELIVERY GET ERROR:', error.message);
    return fail(res, 500, "Couldn't load delivery settings.");
  }
};

const putShopDelivery = async (req, res) => {
  const shopId = Number(req.shop.shopId);
  const body = req.body || {};
  try {
    const shop = (await pool.query('SELECT business_type FROM shops WHERE id = $1', [shopId])).rows[0];
    if (shop.business_type !== 'clothing') {
      return fail(res, 400, 'Store delivery is for clothing shops. Restaurants use GetMe riders or pickup.', 'NOT_CLOTHING');
    }
    const enabled = bool(body.enabled, false);
    const list = Array.isArray(body.zones) ? body.zones : [];
    if (list.length > DISTRICTS.length) return fail(res, 400, 'Too many districts', 'VALIDATION');

    const zones = [];
    const seen = new Set();
    for (const [i, z] of list.entries()) {
      const district = normalize(z?.district);
      if (!district) return fail(res, 400, `Row ${i + 1}: choose a district from the list`, 'VALIDATION');
      if (seen.has(district)) return fail(res, 400, `${district} is listed twice`, 'VALIDATION');
      seen.add(district);
      const fee = Number(z?.fee);
      const minDays = Number(z?.minDays);
      const maxDays = Number(z?.maxDays);
      if (!Number.isFinite(fee) || fee < 0 || fee > 50000) return fail(res, 400, `${district}: enter a delivery fee from Rs 0 to Rs 50,000`, 'VALIDATION');
      if (!Number.isInteger(minDays) || !Number.isInteger(maxDays) || minDays < 0 || maxDays > 30 || minDays > maxDays) {
        return fail(res, 400, `${district}: enter delivery days like 2 to 4 (0-30)`, 'VALIDATION');
      }
      zones.push({ district, fee: round2(fee), minDays, maxDays, isActive: z?.isActive !== false });
    }
    if (enabled && !zones.some((z) => z.isActive)) {
      return fail(res, 400, 'Add at least one district you deliver to', 'NO_ZONES');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE shops SET shop_delivery_enabled = $2, shop_delivery_cod = $3, shop_delivery_courier = $4,
                shop_delivery_note = $5, updated_at = NOW() WHERE id = $1`,
        [shopId, enabled, bool(body.cashOnDelivery, false), text(body.courier, 60), text(body.note, 300)]
      );
      await client.query('DELETE FROM shop_delivery_zones WHERE shop_id = $1 AND NOT (district = ANY($2))', [shopId, zones.map((z) => z.district)]);
      for (const z of zones) {
        await client.query(
          `INSERT INTO shop_delivery_zones (shop_id, district, fee, min_days, max_days, is_active)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (shop_id, district) DO UPDATE SET fee = $3, min_days = $4, max_days = $5, is_active = $6, updated_at = NOW()`,
          [shopId, z.district, z.fee, z.minDays, z.maxDays, z.isActive]
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    recordShopActivity({
      shopId,
      actor: { type: req.shop.staffId ? 'staff' : 'owner', id: req.shop.staffId || shopId, name: req.shop.actorName || null, role: req.shop.role },
      action: 'shop_delivery.updated',
      entityType: 'shop',
      entityId: shopId,
      summary: enabled ? `Store delivery on (${zones.filter((z) => z.isActive).length} districts)` : 'Store delivery off',
    });
    broadcastCatalogChange(req.app.get('io'), shopId, 'shop');
    return res.json({ success: true, shopDelivery: await viewOf(shopId) });
  } catch (error) {
    console.error('❌ SHOP DELIVERY PUT ERROR:', error.message);
    return fail(res, 500, "Couldn't save delivery settings.");
  }
};

module.exports = { getShopDelivery, putShopDelivery, viewOf };
