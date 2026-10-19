// =====================================================
// SCHEDULED DELIVERY SLOTS (Sri Lanka time, UTC+5:30)
// =====================================================

const SL_OFFSET_MINUTES = 330;

// "Now" as a Date whose UTC fields read as Sri Lankan wall time
const sriLankaNow = () => new Date(Date.now() + SL_OFFSET_MINUTES * 60000);

const pad = (value) => String(value).padStart(2, '0');

const dateKey = (date) =>
  `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;

const hourLabel = (hour) => {
  const suffix = hour >= 12 && hour < 24 ? 'PM' : 'AM';
  const display = hour % 12 === 0 ? 12 : hour % 12;

  return `${display}:00 ${suffix}`;
};

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const buildSlots = (settings) => {
  const { days, startHour, endHour, slotHours, leadMinutes } = settings.slots;
  const now = sriLankaNow();
  const earliest = now.getTime() + leadMinutes * 60000;
  const result = [];

  for (let offset = 0; offset < days; offset += 1) {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset));
    const slots = [];

    for (let hour = startHour; hour + slotHours <= endHour; hour += slotHours) {
      const slotStart = day.getTime() + hour * 3600000;

      if (slotStart >= earliest) {
        slots.push({
          start: `${pad(hour)}:00`,
          end: `${pad(hour + slotHours)}:00`,
          label: `${hourLabel(hour)} - ${hourLabel(hour + slotHours)}`,
        });
      }
    }

    if (slots.length) {
      result.push({
        date: dateKey(day),
        label:
          offset === 0
            ? 'Today'
            : offset === 1
              ? 'Tomorrow'
              : `${DAY_NAMES[day.getUTCDay()]}, ${day.getUTCDate()} ${MONTH_NAMES[day.getUTCMonth()]}`,
        slots,
      });
    }
  }

  return result;
};

const findSlot = (settings, date, start) => {
  const day = buildSlots(settings).find((item) => item.date === date);

  return day?.slots.find((slot) => slot.start === String(start || '').slice(0, 5)) || null;
};

module.exports = {
  buildSlots,
  findSlot,
};
