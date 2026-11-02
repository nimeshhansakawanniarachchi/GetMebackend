// =====================================================
// SAFE JSON (security review 2026-10-30, B-01 / B-18)
// A last line of defence on every /api response:
// * password fields never leave the server, whatever a query selected
//   (a SELECT * / to_jsonb(row) once sent shop password hashes)
// * a 5xx reply carries no internal error text (error.message from pg
//   or Node can name tables, columns, files and values)
// Controllers should still select only what they need; this catches
// what slips through.
// =====================================================

const SECRET_KEYS = new Set(['password', 'password_hash', 'passwordHash']);
const INTERNAL_KEYS = ['error', 'stack', 'detail', 'sql', 'query'];

const strip = (value, depth = 0) => {
  if (!value || typeof value !== 'object' || depth > 12) return value;
  if (Array.isArray(value)) return value.map((item) => strip(item, depth + 1));
  if (value instanceof Date) return value;

  const copy = {};
  for (const [key, item] of Object.entries(value)) {
    if (!SECRET_KEYS.has(key)) copy[key] = strip(item, depth + 1);
  }
  return copy;
};

const safeJson = (req, res, next) => {
  const json = res.json.bind(res);

  res.json = (body) => {
    if (!body || typeof body !== 'object') return json(body);

    let out = body;

    // Cheap check first: most replies have no password key at all
    if (/"(password|password_hash|passwordHash)"\s*:/.test(JSON.stringify(body))) {
      out = strip(body);
    }

    if (res.statusCode >= 500 && !Array.isArray(out)) {
      out = { ...out };
      INTERNAL_KEYS.forEach((key) => delete out[key]);
    }

    return json(out);
  };

  next();
};

module.exports = safeJson;
