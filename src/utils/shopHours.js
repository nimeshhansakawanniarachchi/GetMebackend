// =====================================================
// SHOP OPENING HOURS (shops.opening_hours, Asia/Colombo time)
//   { mon: { closed: false, open: "08:00", close: "21:00" }, ... }
// close <= open means the shop closes after midnight; open == close
// means open all day. Missing days count as closed.
// =====================================================

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const TIME_ZONE = 'Asia/Colombo';

const toMinutes = (hhmm) => {
  const m = String(hhmm || '').match(TIME);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

// -> { hours } or { error }
const normalizeHours = (input) => {
  if (!input || typeof input !== 'object') {
    return { error: 'Opening hours are missing' };
  }

  const hours = {};

  for (const day of DAYS) {
    const value = input[day] || { closed: true };
    const closed = value.closed === true;

    if (closed) {
      hours[day] = { closed: true, open: null, close: null };
      continue;
    }

    if (toMinutes(value.open) === null || toMinutes(value.close) === null) {
      return { error: `Enter opening and closing times as HH:MM for ${day}` };
    }

    hours[day] = { closed: false, open: value.open, close: value.close };
  }

  return { hours };
};

// Day of week (0 = Sunday) and minutes since midnight in Colombo
const colomboClock = (date = new Date()) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: TIME_ZONE,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value])
  );

  return {
    day: DAYS.indexOf(parts.weekday.toLowerCase().slice(0, 3)),
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
};

const isOpenAt = (hours, date = new Date()) => {
  if (!hours) return null;
  const { day, minutes } = colomboClock(date);
  const today = hours[DAYS[day]];
  const yesterday = hours[DAYS[(day + 6) % 7]];

  // Yesterday's hours that run past midnight
  if (yesterday && !yesterday.closed) {
    const open = toMinutes(yesterday.open);
    const close = toMinutes(yesterday.close);
    if (close < open && minutes < close) return true;
  }

  if (!today || today.closed) return false;

  const open = toMinutes(today.open);
  const close = toMinutes(today.close);

  if (open === close) return true;
  if (close > open) return minutes >= open && minutes < close;
  return minutes >= open;
};

// The next moment the scheduled state flips (null if it never does)
const nextChange = (hours, from = new Date()) => {
  if (!hours) return null;
  const start = new Date(Math.floor(from.getTime() / 60000) * 60000);
  const now = isOpenAt(hours, start);

  for (let i = 1; i <= 8 * 24 * 60; i += 1) {
    const at = new Date(start.getTime() + i * 60000);
    if (isOpenAt(hours, at) !== now) return at;
  }

  return null;
};

module.exports = { DAYS, normalizeHours, isOpenAt, nextChange, colomboClock };
