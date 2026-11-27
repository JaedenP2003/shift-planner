import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as logic from '../js/logic.js';
import { emptyState, load, save, sanitize } from '../js/storage.js';
import { buildPdf, wrap } from '../js/pdf.js';

const full = { id: 'a', name: 'Alex', tagId: null, employment: 'full', branchId: 'branch-1', weeklyTarget: 40 };
const part = { id: 'b', name: 'Bo (PT)', tagId: null, employment: 'part', branchId: 'branch-1', weeklyTarget: 20 };
const day = { start: '08:00', end: '17:00', lunch: 30, lunchStart: '12:00' };

function fakeStore(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)) };
}

test('Federal Reserve holidays for 2026', () => {
  assert.deepEqual(Object.keys(logic.federalHolidays(2026)).sort(), [
    '2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-06-19', '2026-07-04',
    '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25',
  ]);
});

test('Sunday holidays move to Monday, Saturday holidays stay', () => {
  assert.equal(logic.federalHolidays(2027)['2027-07-05'], 'Independence Day'); // July 4 2027 is a Sunday
  assert.equal(logic.federalHolidays(2027)['2027-12-25'], 'Christmas Day'); // a Saturday
});

test('holidays can be added, removed and restored', () => {
  let edits = logic.setHoliday({}, '2026-10-12', null);
  assert.equal(logic.holidayName('2026-10-12', edits), null);
  edits = logic.setHoliday(edits, '2026-12-24', 'Christmas Eve');
  assert.equal(logic.holidayName('2026-12-24', edits), 'Christmas Eve');
  assert.equal(logic.holidaysForYear(2026, edits).length, 11);
  edits = logic.setHoliday(edits, '2026-10-12', 'Columbus Day');
  assert.deepEqual(edits, { '2026-12-24': 'Christmas Eve' });
});

test('lunch is subtracted and bad shifts are rejected', () => {
  assert.equal(logic.paidMinutes(day), 510);
  assert.equal(logic.paidMinutes({ ...day, lunch: 45 }), 495);
  assert.ok(logic.shiftProblem({ start: '17:00', end: '08:00', lunch: 0 }));
  assert.ok(logic.shiftProblem({ start: '08:00', end: '08:30', lunch: 30 }));
  assert.ok(logic.shiftProblem({ start: '', end: '08:30', lunch: 0 }));
});

test('holiday counts 8 hours for full-time only, and overrides a shift', () => {
  const state = { ...emptyState(), people: [full, part], shifts: { '2026-11-26': { a: day, b: day } } };
  assert.equal(logic.dayInfo(state, full, '2026-11-26').minutes, 480);
  assert.equal(logic.dayInfo(state, part, '2026-11-26').minutes, 0);
});

test('week totals and over/under sentences', () => {
  const state = { ...emptyState(), people: [full], shifts: {} };
  const start = '2026-12-06';
  for (let i = 1; i <= 5; i++) state.shifts[logic.addDays(start, i)] = { a: day };
  let summary = logic.weekSummary(state, full, start);
  assert.equal(logic.statusSentence(full, summary), '42.5 of 40 hours, 2.5 hours over.');
  delete state.shifts['2026-12-11'];
  summary = logic.weekSummary(state, full, start);
  assert.equal(logic.statusSentence(full, summary), '34 of 40 hours, 6 hours under.');
  for (let i = 1; i <= 5; i++) state.shifts[logic.addDays(start, i)] = { a: { start: '08:00', end: '16:30', lunch: 30 } };
  assert.equal(logic.weekSummary(state, full, start).status, 'on');
});

test('copying a week skips holidays on both sides', () => {
  const state = { ...emptyState(), people: [full], shifts: {} };
  // Week of Nov 22 contains Thanksgiving (Thu 26). Copy it to the next week.
  state.shifts['2026-11-23'] = { a: day };
  state.shifts['2026-12-03'] = { a: day }; // Thursday already scheduled in the target week
  state.shifts['2026-12-01'] = { a: day }; // Tuesday: source is empty, so this is cleared
  const { shifts, skipped } = logic.copyWeek(state, '2026-11-22', '2026-11-29');
  assert.deepEqual(shifts['2026-11-30'], { a: day });
  assert.deepEqual(shifts['2026-12-03'], { a: day });
  assert.equal(shifts['2026-12-01'], undefined);
  assert.deepEqual(skipped, ['2026-12-03']);
  assert.notEqual(shifts['2026-11-30'], state.shifts['2026-11-23']);
});

test('times display in a friendly form', () => {
  assert.equal(logic.shiftLabel({ start: '08:30', end: '12:00' }), '8:30A–12P');
  assert.equal(logic.formatTime('00:00'), '12A');
});

test('saving keeps people, and a damaged save falls back to the previous one', () => {
  const store = fakeStore();
  const state = { ...emptyState(), people: [full] };
  assert.ok(save(state, store));
  assert.deepEqual(load(store).state.people, [full]);
  assert.ok(save({ ...state, people: [full, part] }, store));
  store.data.set('shiftPlanner.data', '{broken');
  const recovered = load(store);
  assert.deepEqual(recovered.state.people, [full]);
  assert.match(recovered.warning, /damaged/);
  assert.ok([...store.data.keys()].some((k) => k.startsWith('shiftPlanner.unreadable.')));
});

test('data from a newer version is never overwritten', () => {
  const store = fakeStore({ 'shiftPlanner.data': JSON.stringify({ ...emptyState(), version: 99 }) });
  assert.equal(load(store).locked, true);
});

test('imports reject junk and drop bad entries', () => {
  assert.throws(() => sanitize({ hello: 1 }));
  const clean = sanitize({
    ...emptyState(),
    tags: [{ id: 't', name: 'Teller', color: 'url(evil)' }],
    people: [full, { id: 'x' }],
    shifts: { '2026-12-01': { a: day, ghost: day }, nonsense: { a: day } },
  });
  assert.equal(clean.tags[0].color, '#00548E');
  assert.equal(clean.people.length, 1);
  assert.deepEqual(clean.shifts, { '2026-12-01': { a: day } });
});

test('PDF has a correct cross-reference table and paginates', () => {
  const people = Array.from({ length: 30 }, (_, i) => ({ ...full, id: `p${i}`, name: `Person (${i}) Ñ` }));
  const state = { ...emptyState(), people };
  const bytes = buildPdf(state, '2026-11-22', logic.weekDates('2026-11-22').slice(1));
  const text = Buffer.from(bytes).toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4'));
  assert.match(text, /\/Count 3 /);
  const xref = Number(text.match(/startxref\n(\d+)/)[1]);
  assert.equal(text.slice(xref, xref + 4), 'xref');
  const offsets = [...text.matchAll(/^(\d{10}) 00000 n /gm)].map((m) => Number(m[1]));
  offsets.forEach((offset, i) => assert.ok(text.slice(offset).startsWith(`${i + 1} 0 obj`)));
});

test('typed times are understood', () => {
  const cases = { 9: '09:00', 915: '09:15', '9:15a': '09:15', '2:45 PM': '14:45', '2:45': '14:45', '12:45p': '12:45',
    12: '12:00', '12a': '00:00', 6: '18:00', '6a': '06:00', '08:00': '08:00', '17:30': '17:30' };
  for (const [typed, expected] of Object.entries(cases)) assert.equal(logic.parseTime(typed), expected, typed);
  for (const bad of ['', 'noon', '9:75', '25', '13p', '1:2']) assert.equal(logic.parseTime(bad), null, bad);
  assert.equal(logic.clockLabel('14:45'), '2:45 PM');
});

test('lunch must fit the shift and displays as a meal time', () => {
  assert.equal(logic.mealLabel({ lunch: 45, lunchStart: '12:45' }), '12:45P–1:30P Meal');
  assert.equal(logic.mealLabel({ lunch: 30, lunchStart: null }), '30m Meal');
  assert.equal(logic.mealLabel({ lunch: 0 }), '');
  assert.ok(logic.shiftProblem({ ...day, lunchStart: '07:30' }));
  assert.ok(logic.shiftProblem({ ...day, lunchStart: '16:45' }));
  assert.equal(logic.shiftProblem({ ...day, lunchStart: '16:30' }), null);
});

test('lunch defaults to 45 on weekdays and 30 on Saturday, and remembers start times', () => {
  const state = { ...emptyState(), shifts: {} };
  assert.equal(logic.defaultLunch('2026-11-27'), 45);
  assert.equal(logic.defaultLunch('2026-11-28'), 30);
  assert.equal(logic.defaultLunchStart(state, 'a', '2026-11-27'), '12:45');
  assert.equal(logic.defaultLunchStart(state, 'a', '2026-11-28'), '12:00');
  const weekday = { start: '10:00', end: '18:00', lunch: 45, lunchStart: '14:45' };
  state.shifts['2026-11-23'] = { a: weekday };
  assert.equal(logic.defaultLunchStart(state, 'a', '2026-11-30'), '14:45');
  assert.deepEqual(logic.adaptShift(state, 'a', weekday, '2026-11-23', '2026-11-28'),
    { start: '10:00', end: '18:00', lunch: 30, lunchStart: '12:00' });
  assert.deepEqual(logic.adaptShift(state, 'a', weekday, '2026-11-23', '2026-11-24'), weekday);
  assert.equal(logic.adaptShift(state, 'a', { ...weekday, lunch: 0 }, '2026-11-23', '2026-11-28').lunch, 0);
});

test('holiday hours follow full or part time, not the hour target', () => {
  const state = emptyState();
  assert.equal(logic.dayInfo(state, { ...full, weeklyTarget: 39.75 }, '2026-11-26').minutes, 480);
  assert.equal(logic.dayInfo(state, { ...part, weeklyTarget: 40 }, '2026-11-26').minutes, 0);
});

test('a 30-hour week gets 6 holiday hours', () => {
  assert.equal(logic.holidayMinutes({ ...part, weeklyTarget: 30 }), 360);
  assert.equal(logic.holidayMinutes({ ...part, weeklyTarget: 29.75 }), 360);
  assert.equal(logic.holidayMinutes({ ...full, weeklyTarget: 30 }), 360);
  assert.equal(logic.holidayMinutes({ ...part, weeklyTarget: 29.5 }), 0);
  assert.equal(logic.holidayMinutes({ ...part, weeklyTarget: 32 }), 0);
});

test('required positions are checked at opening and closing', () => {
  const tags = [{ id: 'sup', name: 'Supervisor', required: true }, { id: 'tel', name: 'Teller', required: false }];
  const people = [{ ...full, id: 's', tagId: 'sup' }, { ...full, id: 't', tagId: 'tel' }];
  const early = { start: '08:30', end: '17:00', lunch: 0 };
  const late = { start: '09:00', end: '18:00', lunch: 0 };
  const all = { start: '08:30', end: '18:00', lunch: 0 };
  const shifts = {
    '2026-12-07': { s: all, t: early }, // covered
    '2026-12-08': { s: late, t: early }, // misses opening
    '2026-12-09': { s: early, t: late }, // misses closing
    '2026-12-10': { t: all }, // nobody
    '2026-12-11': { s: { start: '09:00', end: '17:00', lunch: 0 }, t: all }, // misses both
  };
  const state = { ...emptyState(), tags, people, shifts };
  const gaps = logic.coverageGaps(state, '2026-12-06');
  assert.deepEqual(gaps.map((g) => [g.date, g.missing]),
    [['2026-12-08', 'open'], ['2026-12-09', 'close'], ['2026-12-10', 'day'], ['2026-12-11', 'both']]);
  assert.equal(logic.gapSentence(gaps[0]), 'no Supervisor at opening (8:30A).');
  assert.equal(logic.gapSentence(gaps[3]), 'no Supervisor at opening (8:30A) or closing (6P).');
  // Holidays and days with nobody scheduled are not flagged.
  state.shifts = { '2026-12-25': { t: all } };
  assert.deepEqual(logic.coverageGaps(state, '2026-12-20'), []);
});

test('the required setting survives saving, and older data has none', () => {
  const tags = [{ id: 'a', name: 'A', color: '#00548E', required: true }, { id: 'b', name: 'B', color: '#00548E' }];
  assert.deepEqual(sanitize({ ...emptyState(), version: 4, tags }).tags.map((t) => t.required), [true, false]);
});

test('version 1 data is upgraded without losing anyone', () => {
  const old = { ...emptyState(), version: 1,
    people: [{ id: 'a', name: 'A', weeklyTarget: 40, lunch: 30 }, { id: 'b', name: 'B', weeklyTarget: 25, lunch: 45 }],
    shifts: { '2026-11-23': { a: { start: '09:00', end: '17:00', lunch: 30 } } } };
  const clean = sanitize(old);
  assert.equal(clean.version, 5);
  assert.deepEqual(clean.branches, [{ id: 'branch-1', name: 'Branch 1', notes: {} }]);
  assert.deepEqual(clean.people.map((p) => p.branchId), ['branch-1', 'branch-1']);
  assert.deepEqual(clean.people.map((p) => p.employment), ['full', 'part']);
  assert.ok(!('lunch' in clean.people[0]));
  assert.deepEqual(clean.shifts['2026-11-23'].a, { start: '09:00', end: '17:00', lunch: 30, lunchStart: null });
});

test('39.75 hours counts as a full-time week', () => {
  const week = (minutesShort, person = full) => {
    const shifts = {};
    // Four 8-hour days plus a last day that falls short by the given minutes.
    for (let i = 1; i <= 4; i++) shifts[logic.addDays('2026-12-06', i)] = { [person.id]: { start: '08:00', end: '16:00', lunch: 0 } };
    shifts['2026-12-11'] = { [person.id]: { start: '08:00', end: logic.minutesToTime(16 * 60 - minutesShort), lunch: 0 } };
    return logic.weekSummary({ ...emptyState(), shifts }, person, '2026-12-06');
  };
  assert.equal(week(15).status, 'on');
  assert.equal(logic.statusSentence(full, week(15)), '39.75 of 40 hours, counts as full time.');
  assert.equal(week(30).status, 'under');
  assert.equal(week(-15).status, 'over');
  assert.equal(week(0, { ...full, weeklyTarget: 39.75 }).status, 'on');
  assert.equal(week(15, { ...part, weeklyTarget: 40 }).status, 'under');
});

test('notes are trimmed, removed when blank, and survive saving', () => {
  const notes = logic.setNote({}, '2026-12-01', '  Staff   meeting\n8:30  ');
  assert.deepEqual(notes, { '2026-12-01': 'Staff meeting 8:30' });
  assert.deepEqual(logic.setNote(notes, '2026-12-01', '   '), {});
  const store = fakeStore();
  const state = emptyState();
  state.branches[0].notes = notes;
  save(state, store);
  assert.deepEqual(load(store).state.branches[0].notes, notes);
  const junk = { ...emptyState(), branches: [{ id: 'x', name: 'X', notes: { bad: 'x', '2026-12-02': 5 } }] };
  assert.deepEqual(sanitize(junk).branches[0].notes, {});
});

test('PDF wraps long notes', () => {
  assert.deepEqual(wrap('Staff meeting at eight thirty', 14), ['Staff meeting', 'at eight', 'thirty']);
  assert.deepEqual(wrap('abcdefghij', 4), ['abcd', 'efgh', 'ij']);
  const state = { ...emptyState(), people: [full], notes: { '2026-11-23': 'Staff meeting' } };
  const text = Buffer.from(buildPdf(state, '2026-11-22', logic.weekDates('2026-11-22').slice(1))).toString('latin1');
  assert.match(text, /\(Schedule Notes\) Tj/);
  assert.match(text, /\(Staff meeting\) Tj/);
});

const twoBranches = () => ({
  ...emptyState(),
  branches: [{ id: 'north', name: 'North', notes: { '2026-12-01': 'N' } }, { id: 'south', name: 'South', notes: {} }],
  people: [{ ...full, branchId: 'north' }, { ...part, branchId: 'south' }],
});

test('each branch sees only its own people and notes', () => {
  const state = twoBranches();
  assert.deepEqual(logic.branchView(state, 'south').people.map((p) => p.id), ['b']);
  assert.deepEqual(logic.branchView(state, 'south').notes, {});
  assert.equal(logic.branchView(state, 'gone').branch.id, 'north');
});

test('copying a week in one branch leaves the other untouched', () => {
  const state = twoBranches();
  state.shifts = { '2026-11-30': { a: day }, '2026-12-07': { b: day }, '2026-12-08': { a: day, b: day } };
  const north = logic.branchView(state, 'north');
  assert.equal(logic.weekHasShifts(logic.branchView(state, 'south'), '2026-11-29'), false);
  const { shifts } = logic.copyWeek(north, '2026-11-29', '2026-12-06');
  assert.deepEqual(shifts['2026-12-07'], { a: day, b: day });
  assert.deepEqual(shifts['2026-12-08'], { b: day });
});

test('branches survive saving, and older notes move into the first branch', () => {
  const state = twoBranches();
  assert.deepEqual(sanitize(state).branches, state.branches);
  assert.deepEqual(sanitize(state).people.map((p) => p.branchId), ['north', 'south']);
  const { branches, ...old } = emptyState();
  const upgraded = sanitize({ ...old, version: 3, notes: { '2026-12-01': 'Keep me' } });
  assert.deepEqual(upgraded.branches[0].notes, { '2026-12-01': 'Keep me' });
});
