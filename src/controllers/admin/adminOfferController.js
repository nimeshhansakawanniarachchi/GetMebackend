const pool = require('../../config/db');

const { OFFER_SELECT, toOffer } = require('../shop/shopOfferController');
const { broadcastCatalogChange } = require('../../realtime');
const { recordOfferChange } = require('../../pricing/history');

// Who made an admin change, for price / offer history
const adminActor = (req) => ({ type: 'admin', id: req.admin?.adminId ?? null, name: req.admin?.fullName || 'GetMe admin' });

// =====================================================
// SHOP OFFERS (admin): every shop's offers, and a pause
// switch for mistakes or abuse. A paused offer stops pricing
// at once; the shop sees the note and can't switch it back on.
// =====================================================

// GET /api/admin/offers?status=live|scheduled|ended|off|paused_by_admin&shopId=
const listOffers = async (req, res) => {
  try {
    const shopId = Number(req.query.shopId);

    const result = await pool.query(
      `
      SELECT x.*, s.shop_name
      FROM (${OFFER_SELECT}) x
      INNER JOIN shops s ON s.id = x.shop_id
      WHERE ($1::int IS NULL OR x.shop_id = $1)
      ORDER BY x.created_at DESC
      LIMIT 500
      `,
      [Number.isInteger(shopId) && shopId > 0 ? shopId : null]
    );

    const status = String(req.query.status || '');

    const offers = result.rows
      .map((row) => ({ ...toOffer(row), shopName: row.shop_name }))
      .filter((offer) => !status || offer.status === status);

    return res.json({ success: true, offers });
  } catch (error) {
    console.error('❌ admin listOffers error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to load offers' });
  }
};

// PATCH /api/admin/offers/:id/pause { paused: boolean, note? }
const setOfferPaused = async (req, res) => {
  try {
    const offerId = Number(req.params.id);

    if (!Number.isInteger(offerId) || offerId <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid offer ID' });
    }

    if (typeof req.body?.paused !== 'boolean') {
      return res.status(400).json({ success: false, message: 'Say whether to pause the offer' });
    }

    const paused = req.body.paused;
    const note = paused && req.body?.note ? String(req.body.note).trim().slice(0, 300) : null;

    const before = (await pool.query('SELECT * FROM product_offers WHERE id = $1', [offerId])).rows[0];

    const result = await pool.query(
      `
      UPDATE product_offers
      SET paused_by_admin = $2, admin_note = $3, updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [offerId, paused, note]
    );

    if (result.rows[0]) {
      await recordOfferChange(pool, {
        offerId,
        shopId: result.rows[0].shop_id,
        action: paused ? 'pause' : 'resume',
        before,
        after: result.rows[0],
        actor: adminActor(req),
      });
    }

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Offer not found' });
    }

    broadcastCatalogChange(req.app.get('io'), result.rows[0].shop_id, 'offers');

    return res.json({
      success: true,
      message: paused ? 'Offer paused' : 'Offer resumed',
    });
  } catch (error) {
    console.error('❌ admin setOfferPaused error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to update offer' });
  }
};

module.exports = {
  adminActor,
  listOffers,
  setOfferPaused,
};
