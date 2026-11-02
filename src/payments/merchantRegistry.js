// =====================================================
// MERCHANT QR REGISTRY RULES (phase 55, payment audit P-09 / P-10)
//
// Supermarket QRs live in shop_lankaqr_merchants, fuel station QRs on
// fuel_stations (qr_*). Both are identified by the LankaPay account
// (account_hash = sha256 of the merchant account tag, never the raw
// account). These rules keep the two apart:
//  - a QR approved for a supermarket is never accepted or approved as a
//    fuel station's QR, and the other way round
//  - the MCC (merchant category code in the QR) must fit: a fuel MCC
//    can't be approved for a supermarket, a supermarket MCC can't be
//    approved for a fuel station
// The CRC in a LankaQR proves the text wasn't damaged, not who made
// it: approval is always a person comparing the QR with the store.
// =====================================================

// ISO 18245 merchant category codes seen on LankaQR stickers
const GROCERY_MCC = ['5411', '5412', '5422', '5441', '5451', '5462', '5499', '5311', '5331', '5399', '5912'];
const FUEL_MCC = ['5541', '5542', '5983', '5172'];

const categoryForMcc = (mcc) => {
  const code = String(mcc || '').trim();
  if (GROCERY_MCC.includes(code)) return 'grocery';
  if (FUEL_MCC.includes(code)) return 'fuel';
  return 'other';
};

// Is this LankaPay account a fuel station's approved QR?
const fuelStationWithAccount = async (client, accountHash) =>
  (
    await client.query('SELECT id, name FROM fuel_stations WHERE qr_account_hash = $1 LIMIT 1', [accountHash])
  ).rows[0] || null;

// Is this LankaPay account an approved supermarket QR?
const supermarketWithAccount = async (client, accountHash) =>
  (
    await client.query(
      `SELECT lm.shop_id, s.shop_name FROM shop_lankaqr_merchants lm LEFT JOIN shops s ON s.id = lm.shop_id
       WHERE lm.account_hash = $1 AND lm.status = 'approved' LIMIT 1`,
      [accountHash]
    )
  ).rows[0] || null;

module.exports = {
  GROCERY_MCC,
  FUEL_MCC,
  categoryForMcc,
  fuelStationWithAccount,
  supermarketWithAccount,
};
