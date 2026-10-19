const pool = require('../config/db');

const GOOGLE_MAPS_API_KEY =
  process.env.GOOGLE_MAPS_API_KEY;

const ADDRESS_COLUMNS = `
  id,
  label,
  address,
  unit,
  building,
  instructions,
  latitude,
  longitude,
  place_id,
  last_used_at,
  created_at
`;


// ==================================================
// HELPERS
// ==================================================

const cleanText = (value, maxLength) => {
  if (value == null) {
    return null;
  }

  const text = String(value).trim();

  if (!text) {
    return null;
  }

  return maxLength
    ? text.slice(0, maxLength)
    : text;
};

const readAddressBody = (body) => {
  const latitude = Number(body?.latitude);
  const longitude = Number(body?.longitude);
  const address = cleanText(body?.address);

  if (!address) {
    return { error: 'Address is required' };
  }

  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  ) {
    return { error: 'Valid latitude and longitude are required' };
  }

  return {
    value: {
      label: cleanText(body?.label, 50) || 'Other',
      address,
      unit: cleanText(body?.unit, 100),
      building: cleanText(body?.building, 150),
      instructions: cleanText(body?.instructions, 500),
      latitude,
      longitude,
      placeId: cleanText(body?.placeId, 255),
    },
  };
};

const ensureGoogleKey = (res) => {
  if (GOOGLE_MAPS_API_KEY) {
    return true;
  }

  res.status(503).json({
    success: false,
    message: 'Address search is not configured. Add GOOGLE_MAPS_API_KEY to the backend .env file.',
  });

  return false;
};


// ==================================================
// GET SAVED ADDRESSES
// ==================================================

const getAddresses = async (req, res) => {
  try {
    const customerId = req.customer.customerId;

    const result = await pool.query(
      `SELECT ${ADDRESS_COLUMNS}
       FROM customer_addresses
       WHERE customer_id = $1
       ORDER BY last_used_at DESC`,
      [customerId]
    );

    return res.json({
      success: true,
      addresses: result.rows,
    });
  } catch (error) {
    console.error('❌ GET ADDRESSES ERROR:', error.message);

    return res.status(500).json({
      success: false,
      message: 'Unable to load saved addresses',
    });
  }
};


// ==================================================
// CREATE ADDRESS
// ==================================================

const createAddress = async (req, res) => {
  try {
    const customerId = req.customer.customerId;
    const { value, error } = readAddressBody(req.body);

    if (error) {
      return res.status(400).json({ success: false, message: error });
    }

    const result = await pool.query(
      `INSERT INTO customer_addresses
         (customer_id, label, address, unit, building, instructions, latitude, longitude, place_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${ADDRESS_COLUMNS}`,
      [
        customerId,
        value.label,
        value.address,
        value.unit,
        value.building,
        value.instructions,
        value.latitude,
        value.longitude,
        value.placeId,
      ]
    );

    return res.status(201).json({
      success: true,
      address: result.rows[0],
    });
  } catch (error) {
    console.error('❌ CREATE ADDRESS ERROR:', error.message);

    return res.status(500).json({
      success: false,
      message: 'Unable to save address',
    });
  }
};


// ==================================================
// UPDATE ADDRESS
// ==================================================

const updateAddress = async (req, res) => {
  try {
    const customerId = req.customer.customerId;
    const addressId = Number(req.params.addressId);

    if (!Number.isInteger(addressId)) {
      return res.status(400).json({ success: false, message: 'Invalid address ID' });
    }

    const { value, error } = readAddressBody(req.body);

    if (error) {
      return res.status(400).json({ success: false, message: error });
    }

    const result = await pool.query(
      `UPDATE customer_addresses
       SET label = $1,
           address = $2,
           unit = $3,
           building = $4,
           instructions = $5,
           latitude = $6,
           longitude = $7,
           place_id = $8,
           last_used_at = NOW(),
           updated_at = NOW()
       WHERE id = $9 AND customer_id = $10
       RETURNING ${ADDRESS_COLUMNS}`,
      [
        value.label,
        value.address,
        value.unit,
        value.building,
        value.instructions,
        value.latitude,
        value.longitude,
        value.placeId,
        addressId,
        customerId,
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Address not found' });
    }

    return res.json({
      success: true,
      address: result.rows[0],
    });
  } catch (error) {
    console.error('❌ UPDATE ADDRESS ERROR:', error.message);

    return res.status(500).json({
      success: false,
      message: 'Unable to update address',
    });
  }
};


// ==================================================
// MARK ADDRESS AS USED (MOVES IT TO THE TOP)
// ==================================================

const useAddress = async (req, res) => {
  try {
    const customerId = req.customer.customerId;
    const addressId = Number(req.params.addressId);

    if (!Number.isInteger(addressId)) {
      return res.status(400).json({ success: false, message: 'Invalid address ID' });
    }

    const result = await pool.query(
      `UPDATE customer_addresses
       SET last_used_at = NOW()
       WHERE id = $1 AND customer_id = $2
       RETURNING ${ADDRESS_COLUMNS}`,
      [addressId, customerId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Address not found' });
    }

    return res.json({
      success: true,
      address: result.rows[0],
    });
  } catch (error) {
    console.error('❌ USE ADDRESS ERROR:', error.message);

    return res.status(500).json({
      success: false,
      message: 'Unable to select address',
    });
  }
};


// ==================================================
// DELETE ADDRESS
// ==================================================

const deleteAddress = async (req, res) => {
  try {
    const customerId = req.customer.customerId;
    const addressId = Number(req.params.addressId);

    if (!Number.isInteger(addressId)) {
      return res.status(400).json({ success: false, message: 'Invalid address ID' });
    }

    const result = await pool.query(
      `DELETE FROM customer_addresses
       WHERE id = $1 AND customer_id = $2`,
      [addressId, customerId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Address not found' });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error('❌ DELETE ADDRESS ERROR:', error.message);

    return res.status(500).json({
      success: false,
      message: 'Unable to delete address',
    });
  }
};


// ==================================================
// GOOGLE PLACES AUTOCOMPLETE (PROXY)
// Keeps the Google key on the server.
// ==================================================

const autocompletePlaces = async (req, res) => {
  try {
    if (!ensureGoogleKey(res)) {
      return;
    }

    const input = cleanText(req.query.input, 200);

    if (!input) {
      return res.json({ success: true, suggestions: [] });
    }

    const latitude = Number(req.query.latitude);
    const longitude = Number(req.query.longitude);
    const hasOrigin =
      Number.isFinite(latitude) &&
      Number.isFinite(longitude);

    const body = {
      input,
      includedRegionCodes: ['lk'],
      languageCode: 'en',
      sessionToken: cleanText(req.query.sessionToken, 100) || undefined,
    };

    if (hasOrigin) {
      body.origin = { latitude, longitude };

      body.locationBias = {
        circle: {
          center: { latitude, longitude },
          radius: 50000,
        },
      };
    }

    const response = await fetch(
      'https://places.googleapis.com/v1/places:autocomplete',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
        },
        body: JSON.stringify(body),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error('❌ PLACES AUTOCOMPLETE ERROR:', data?.error?.message);

      return res.status(502).json({
        success: false,
        message: 'Address search is unavailable right now',
      });
    }

    const suggestions = (data?.suggestions || [])
      .map((item) => item?.placePrediction)
      .filter((prediction) => prediction?.placeId)
      .map((prediction) => ({
        placeId: prediction.placeId,
        mainText:
          prediction.structuredFormat?.mainText?.text ||
          prediction.text?.text ||
          '',
        secondaryText:
          prediction.structuredFormat?.secondaryText?.text ||
          '',
        fullText: prediction.text?.text || '',
        distanceMeters: prediction.distanceMeters ?? null,
      }));

    return res.json({ success: true, suggestions });
  } catch (error) {
    console.error('❌ PLACES AUTOCOMPLETE ERROR:', error.message);

    return res.status(500).json({
      success: false,
      message: 'Address search failed',
    });
  }
};


// ==================================================
// GOOGLE PLACE DETAILS (PROXY)
// ==================================================

const getPlaceDetails = async (req, res) => {
  try {
    if (!ensureGoogleKey(res)) {
      return;
    }

    const placeId = cleanText(req.params.placeId, 255);

    if (!placeId || !/^[\w-]+$/.test(placeId)) {
      return res.status(400).json({ success: false, message: 'Invalid place ID' });
    }

    const sessionToken = cleanText(req.query.sessionToken, 100);

    const url = new URL(
      `https://places.googleapis.com/v1/places/${placeId}`
    );

    if (sessionToken) {
      url.searchParams.set('sessionToken', sessionToken);
    }

    const response = await fetch(url, {
      headers: {
        'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
        'X-Goog-FieldMask':
          'id,displayName,formattedAddress,location',
      },
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('❌ PLACE DETAILS ERROR:', data?.error?.message);

      return res.status(502).json({
        success: false,
        message: 'Unable to load this address',
      });
    }

    const latitude = Number(data?.location?.latitude);
    const longitude = Number(data?.location?.longitude);

    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude)
    ) {
      return res.status(502).json({
        success: false,
        message: 'Google did not return a location for this address',
      });
    }

    return res.json({
      success: true,
      place: {
        placeId: data.id || placeId,
        name: data?.displayName?.text || '',
        address: data?.formattedAddress || data?.displayName?.text || '',
        latitude,
        longitude,
      },
    });
  } catch (error) {
    console.error('❌ PLACE DETAILS ERROR:', error.message);

    return res.status(500).json({
      success: false,
      message: 'Unable to load this address',
    });
  }
};

module.exports = {
  getAddresses,
  createAddress,
  updateAddress,
  useAddress,
  deleteAddress,
  autocompletePlaces,
  getPlaceDetails,
};
