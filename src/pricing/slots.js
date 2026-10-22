// =====================================================
// SCHEDULED DELIVERY SLOTS (Sri Lanka time, UTC+5:30)
// =====================================================

const SL_OFFSET_MINUTES = 330;

// "Now" as a Date whose UTC fields read as Sri Lankan wall time
const sriLankaNow = () => new Date(Date.now() + SL_OFFSET_MINUTES * 60000);

const pad = (value) => String(value).padStart(2, '0');

const dateKey = (date) =>
  `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;

// 9 -> "9am", 12 -> "Noon", 16 -> "4pm"
const hourLabel = (hour) => {
  if (hour === 12) return 'Noon';
  if (hour === 0 || hour === 24) return 'Midnight';

  return `${hour % 12}${hour < 12 ? 'am' : 'pm'}`;
};

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Windows start every hour: slotHours long, plus flexible
// windows one hour longer that save flexibleWindowDiscount.
// Listed by end time, shorter first: 4pm–6pm, 5pm–7pm,
// 4pm–7pm, 6pm–8pm, 5pm–8pm (Instacart).
const buildSlots = (settings) => {
  const { days, startHour, endHour, slotHours, leadMinutes } = settings.slots;
  const flexibleDiscount = Number(settings.flexibleWindowDiscount) || 0;
  const lengths = flexibleDiscount > 0 ? [slotHours, slotHours + 1] : [slotHours];
  const now = sriLankaNow();
  const earliest = now.getTime() + leadMinutes * 60000;
  const result = [];

  for (let offset = 0; offset < days; offset += 1) {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset));
    const slots = [];

    for (const hours of lengths) {
      for (let hour = startHour; hour + hours <= endHour; hour += 1) {
        const slotStart = day.getTime() + hour * 3600000;

        if (slotStart >= earliest) {
          slots.push({
            start: `${pad(hour)}:00`,
            end: `${pad(hour + hours)}:00`,
            label: `${hourLabel(hour)}–${hourLabel(hour + hours)}`,
            hours,
            discount: hours > slotHours ? flexibleDiscount : 0,
          });
        }
      }
    }

    slots.sort((a, b) => a.end.localeCompare(b.end) || b.start.localeCompare(a.start));

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

// Windows overlap (4pm–6pm and 4pm–7pm), so match the end
// too; without one, the standard-length window at that start
const findSlot = (settings, date, start, end = null) => {
  const day = buildSlots(settings).find((item) => item.date === date);
  const startKey = String(start || '').slice(0, 5);
  const endKey = end ? String(end).slice(0, 5) : null;

  return (
    day?.slots.find(
      (slot) =>
        slot.start === startKey &&
        (endKey ? slot.end === endKey : slot.hours === settings.slots.slotHours)
    ) || null
  );
};

module.exports = {
  buildSlots,
  findSlot,
};
