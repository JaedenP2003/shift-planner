// Pure scheduling rules: dates, holidays, hours and copying weeks.
// Nothing here touches the page or storage, so it can be tested with Node.

export const HOLIDAY_MINUTES = 8 * 60;
// Shifts move in quarter hours, so 39.75 through 40 all count as a full-time week.
export const FULL_WEEK = { from: 39.75 * 60, to: 40 * 60 };
export const NOTE_LENGTH = 120;
export const DEFAULT_HOURS = { full: 40, part: 20 };
export const LUNCH_CHOICES = [0, 30, 45, 60];

// ---------- dates (always "YYYY-MM-DD" strings, computed in UTC to avoid DST surprises) ----------

const toDate = (iso) => new Date(iso + 'T00:00:00Z');
const toISO = (date) => date.toISOString().slice(0, 10);

export function isISODate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = toDate(value);
  return !Number.isNaN(date.getTime()) && toISO(date) === value;
}

export function addDays(iso, days) {
  const date = toDate(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return toISO(date);
}

export const dayOfWeek = (iso) => toDate(iso).getUTCDay(); // 0 = Sunday
export const weekStart = (iso) => addDays(iso, -dayOfWeek(iso));
export const weekDates = (start) => Array.from({ length: 7 }, (_, i) => addDays(start, i));

export function todayISO(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function formatDate(iso, options = { month: 'short', day: 'numeric' }) {
  return toDate(iso).toLocaleDateString('en-US', { ...options, timeZone: 'UTC' });
}

export function weekLabel(start) {
  const end = addDays(start, 6);
  return `${formatDate(start, { month: 'short', day: 'numeric' })} – ${formatDate(end, { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

// ---------- holidays ----------

// The nth given weekday of a month, e.g. 4th Thursday of November. month is 1-12.
function nthWeekday(year, month, weekday, n) {
  const first = toISO(new Date(Date.UTC(year, month - 1, 1)));
  const offset = (weekday - dayOfWeek(first) + 7) % 7;
  return addDays(first, offset + (n - 1) * 7);
}

function lastWeekday(year, month, weekday) {
  const last = toISO(new Date(Date.UTC(year, month, 0)));
  return addDays(last, -((dayOfWeek(last) - weekday + 7) % 7));
}

// Federal Reserve rule: a holiday on Sunday is observed Monday. A Saturday one stays put.
function fixedDate(year, month, day) {
  const iso = toISO(new Date(Date.UTC(year, month - 1, day)));
  return dayOfWeek(iso) === 0 ? addDays(iso, 1) : iso;
}

export function federalHolidays(year) {
  return {
    [fixedDate(year, 1, 1)]: "New Year's Day",
    [nthWeekday(year, 1, 1, 3)]: 'Martin Luther King Jr. Day',
    [nthWeekday(year, 2, 1, 3)]: "Presidents' Day",
    [lastWeekday(year, 5, 1)]: 'Memorial Day',
    [fixedDate(year, 6, 19)]: 'Juneteenth',
    [fixedDate(year, 7, 4)]: 'Independence Day',
    [nthWeekday(year, 9, 1, 1)]: 'Labor Day',
    [nthWeekday(year, 10, 1, 2)]: 'Columbus Day',
    [fixedDate(year, 11, 11)]: 'Veterans Day',
    [nthWeekday(year, 11, 4, 4)]: 'Thanksgiving Day',
    [fixedDate(year, 12, 25)]: 'Christmas Day',
  };
}

// `edits` holds her changes: a name adds or renames a holiday, null means "open that day".
export function holidayName(iso, edits = {}) {
  if (Object.hasOwn(edits, iso)) return edits[iso];
  return federalHolidays(Number(iso.slice(0, 4)))[iso] ?? null;
}

export function holidaysForYear(year, edits = {}) {
  const dates = new Set(Object.keys(federalHolidays(year)));
  for (const iso of Object.keys(edits)) if (iso.startsWith(`${year}-`)) dates.add(iso);
  return [...dates]
    .sort()
    .map((date) => ({ date, name: holidayName(date, edits) }))
    .filter((h) => h.name !== null);
}

// Returns a new edits object with the holiday on `iso` set to `name` (null = no holiday).
export function setHoliday(edits, iso, name) {
  const next = { ...edits };
  const standard = federalHolidays(Number(iso.slice(0, 4)))[iso] ?? null;
  if (name === standard) delete next[iso];
  else next[iso] = name;
  return next;
}

// ---------- hours ----------

export function timeToMinutes(time) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time ?? '');
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

// Returns a message explaining what is wrong with a shift, or null if it is fine.
export function shiftProblem({ start, end, lunch, lunchStart }) {
  const from = timeToMinutes(start);
  const to = timeToMinutes(end);
  if (from === null || to === null) return 'Enter both a start and an end time.';
  if (to <= from) return 'End time must be after the start time.';
  if (to - from <= lunch) return 'The shift must be longer than the lunch break.';
  if (lunch && lunchStart) {
    const meal = timeToMinutes(lunchStart);
    if (meal === null) return 'Enter a valid lunch start time.';
    if (meal < from || meal + lunch > to) return 'Lunch must fall within the shift.';
  }
  return null;
}

export function paidMinutes(shift) {
  if (!shift || shiftProblem(shift)) return 0;
  return timeToMinutes(shift.end) - timeToMinutes(shift.start) - shift.lunch;
}

export const isFullTime = (person) => person.employment === 'full';

// What one person has on one day: a holiday, a shift, or nothing, plus the minutes it counts for.
export function dayInfo(state, person, date) {
  const holiday = holidayName(date, state.holidayEdits);
  if (holiday !== null) {
    return { type: 'holiday', name: holiday, minutes: isFullTime(person) ? HOLIDAY_MINUTES : 0 };
  }
  const shift = state.shifts[date]?.[person.id];
  if (shift) return { type: 'shift', shift, minutes: paidMinutes(shift) };
  return { type: 'off', minutes: 0 };
}

export function weekSummary(state, person, start) {
  const minutes = weekDates(start).reduce((sum, date) => sum + dayInfo(state, person, date).minutes, 0);
  const diff = minutes - Math.round(person.weeklyTarget * 60);
  const inFullWeek = (m) => m >= FULL_WEEK.from && m <= FULL_WEEK.to;
  const fullWeek = isFullTime(person) && inFullWeek(minutes) && inFullWeek(person.weeklyTarget * 60);
  const status = diff === 0 || fullWeek ? 'on' : diff > 0 ? 'over' : 'under';
  return { minutes, diff, status };
}

export const formatHours = (minutes) => String(Math.round((minutes / 60) * 100) / 100);

export function statusSentence(person, summary) {
  const worked = `${formatHours(summary.minutes)} of ${person.weeklyTarget} hours`;
  if (summary.status === 'on') return summary.diff ? `${worked}, counts as full time.` : `${worked}, right on target.`;
  const gap = formatHours(Math.abs(summary.diff));
  return `${worked}, ${gap} ${gap === '1' ? 'hour' : 'hours'} ${summary.status}.`;
}

export const minutesToTime = (total) =>
  `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;

// Reads typed times such as "9", "915", "9:15a" or "2:45 PM" into "HH:MM".
// Without a.m./p.m., 7 through 11 are morning and 12 through 6 are afternoon.
export function parseTime(value) {
  const match = /^(\d{1,2})(?::?(\d{2}))?\s*(?:([ap])\.?(?:m\.?)?)?$/i.exec(String(value ?? '').trim());
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const suffix = match[3]?.toLowerCase();
  if (minute > 59) return null;
  if (suffix) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (suffix === 'p' ? 12 : 0);
  } else if (hour > 23) {
    return null;
  } else if (hour >= 1 && hour <= 6 && !match[1].startsWith('0')) {
    hour += 12;
  }
  return minutesToTime(hour * 60 + minute);
}

// "14:45" -> "2:45 PM", for the time boxes.
export function clockLabel(time) {
  const total = timeToMinutes(time);
  if (total === null) return '';
  const hour = Math.floor(total / 60);
  return `${hour % 12 || 12}:${String(total % 60).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
}

export function formatTime(time) {
  const total = timeToMinutes(time);
  if (total === null) return '';
  const hour = Math.floor(total / 60);
  const minute = total % 60;
  const suffix = hour < 12 ? 'A' : 'P';
  return `${hour % 12 || 12}${minute ? ':' + String(minute).padStart(2, '0') : ''}${suffix}`;
}

export const shiftLabel = (shift) => `${formatTime(shift.start)}–${formatTime(shift.end)}`;

// "12:45P–1:30P Meal", the way her work schedule shows it.
export function mealLabel({ lunch, lunchStart }) {
  if (!lunch) return '';
  const from = timeToMinutes(lunchStart);
  if (from === null) return `${lunch}m Meal`;
  return `${formatTime(lunchStart)}–${formatTime(minutesToTime(from + lunch))} Meal`;
}

// ---------- lunch defaults ----------

export const isWeekend = (iso) => dayOfWeek(iso) === 0 || dayOfWeek(iso) === 6;

// 45 minutes on weekdays, 30 on weekends.
export const defaultLunch = (iso) => (isWeekend(iso) ? 30 : 45);

// This person's latest lunch start on the same kind of day, otherwise the usual time.
export function defaultLunchStart(state, personId, iso) {
  for (const date of Object.keys(state.shifts).sort().reverse()) {
    const shift = state.shifts[date][personId];
    if (shift?.lunch && shift.lunchStart && isWeekend(date) === isWeekend(iso)) return shift.lunchStart;
  }
  return isWeekend(iso) ? '12:00' : '12:45';
}

// Reuses a shift on another date. Moving between weekday and weekend switches to that
// day's lunch; a lunch start that no longer fits is left blank.
export function adaptShift(state, personId, shift, from, to) {
  const next = { start: shift.start, end: shift.end, lunch: shift.lunch, lunchStart: shift.lunchStart ?? null };
  if (isWeekend(from) !== isWeekend(to) && next.lunch) {
    next.lunch = defaultLunch(to);
    next.lunchStart = defaultLunchStart(state, personId, to);
    if (shiftProblem(next)) next.lunchStart = null;
  }
  return next;
}

// ---------- branches ----------

// The schedule as one branch sees it: its own people and notes. Shifts, positions
// and holidays are shared. Falls back to the first branch if `branchId` is gone.
export function branchView(state, branchId) {
  const branch = state.branches.find((b) => b.id === branchId) ?? state.branches[0];
  return { ...state, branch, notes: branch.notes, people: state.people.filter((p) => p.branchId === branch.id) };
}

// ---------- schedule notes ----------

// Returns a new notes object; a blank note removes that day's entry.
export function setNote(notes, iso, value) {
  const next = { ...notes };
  const clean = value.replace(/\s+/g, ' ').trim().slice(0, NOTE_LENGTH);
  if (clean) next[iso] = clean;
  else delete next[iso];
  return next;
}

// ---------- copying ----------

// Both of these only look at `state.people`, so passing a branch view leaves other branches alone.
export function weekHasShifts(state, start) {
  return weekDates(start).some((date) =>
    holidayName(date, state.holidayEdits) === null && state.people.some((p) => state.shifts[date]?.[p.id]));
}

// Makes the target week match the source week. Holidays in either week are left alone,
// so a holiday last week doesn't wipe out the same weekday this week.
export function copyWeek(state, from, to) {
  const shifts = { ...state.shifts };
  const skipped = []; // target dates that had nothing to copy because the source day was a holiday
  for (let i = 0; i < 7; i++) {
    const source = addDays(from, i);
    const target = addDays(to, i);
    if (holidayName(target, state.holidayEdits) !== null) continue;
    if (holidayName(source, state.holidayEdits) !== null) {
      skipped.push(target);
      continue;
    }
    const day = { ...shifts[target] };
    for (const { id } of state.people) {
      const shift = state.shifts[source]?.[id];
      if (shift) day[id] = { ...shift };
      else delete day[id];
    }
    if (Object.keys(day).length) shifts[target] = day;
    else delete shifts[target];
  }
  return { shifts, skipped };
}
