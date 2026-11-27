// Saving and loading. Everything lives in this browser's localStorage.
// Three safety nets: the previous save is kept, unreadable data is set aside
// (never silently overwritten), and she can export a backup file.

import { DEFAULT_HOURS, LUNCH_CHOICES, isISODate, setNote, timeToMinutes } from './logic.js';

const KEY = 'shiftPlanner.data';
const PREVIOUS_KEY = 'shiftPlanner.previous';
const BACKUP_DATE_KEY = 'shiftPlanner.lastBackup';
const BRANCH_KEY = 'shiftPlanner.branch';
export const VERSION = 5; // 2: full/part time and lunch start. 3: schedule notes. 4: branches. 5: required positions

export const emptyState = () => ({
  version: VERSION,
  showSunday: false,
  tags: [],
  people: [],
  shifts: {},
  holidayEdits: {},
  branches: [{ id: 'branch-1', name: 'Branch 1', notes: {} }],
});

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isId = (value) => typeof value === 'string' && /^[\w-]{1,60}$/.test(value) && value !== '__proto__';
const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

// Rebuilds a clean state from untrusted JSON (a saved copy or an imported file).
// Throws if it isn't Shift Planner data at all; drops individual bad entries.
export function sanitize(raw) {
  if (!isObject(raw) || !Array.isArray(raw.people) || !Array.isArray(raw.tags) || !isObject(raw.shifts)) {
    throw new Error('This is not Shift Planner data.');
  }
  if (raw.version > VERSION) throw new Error('This data was made by a newer version of Shift Planner.');

  const state = emptyState();
  state.showSunday = raw.showSunday === true;

  for (const tag of raw.tags) {
    if (!isObject(tag) || !isId(tag.id) || !text(tag.name, 40)) continue;
    const color = /^#[0-9a-fA-F]{6}$/.test(tag.color) ? tag.color : '#00548E';
    state.tags.push({ id: tag.id, name: text(tag.name, 40), color, required: tag.required === true });
  }

  const cleanNotes = (notes) => {
    let clean = {};
    for (const [date, note] of Object.entries(isObject(notes) ? notes : {})) {
      if (isISODate(date) && typeof note === 'string') clean = setNote(clean, date, note);
    }
    return clean;
  };
  const branches = (Array.isArray(raw.branches) ? raw.branches : [])
    .filter((b) => isObject(b) && isId(b.id) && text(b.name, 40))
    .map((b) => ({ id: b.id, name: text(b.name, 40), notes: cleanNotes(b.notes) }));
  if (branches.length) state.branches = branches;
  // Before version 4 there were no branches, and notes sat at the top level.
  else state.branches[0].notes = cleanNotes(raw.notes);

  for (const person of raw.people) {
    if (!isObject(person) || !isId(person.id) || !text(person.name, 60)) continue;
    const target = Number(person.weeklyTarget);
    // Version 1 had no full/part setting; 40 or more hours meant full time.
    const employment = person.employment === 'full' || person.employment === 'part'
      ? person.employment
      : (target >= 40 ? 'full' : 'part');
    state.people.push({
      id: person.id,
      name: text(person.name, 60),
      tagId: state.tags.some((t) => t.id === person.tagId) ? person.tagId : null,
      employment,
      branchId: state.branches.some((b) => b.id === person.branchId) ? person.branchId : state.branches[0].id,
      weeklyTarget: target >= 0 && target <= 168 ? target : DEFAULT_HOURS[employment],
    });
  }

  const ids = new Set(state.people.map((p) => p.id));
  for (const [date, day] of Object.entries(raw.shifts)) {
    if (!isISODate(date) || !isObject(day)) continue;
    for (const [personId, shift] of Object.entries(day)) {
      if (!ids.has(personId) || !isObject(shift)) continue;
      if (timeToMinutes(shift.start) === null || timeToMinutes(shift.end) === null) continue;
      state.shifts[date] ??= {};
      const lunch = LUNCH_CHOICES.includes(shift.lunch) ? shift.lunch : 0;
      state.shifts[date][personId] = {
        start: shift.start,
        end: shift.end,
        lunch,
        lunchStart: lunch && timeToMinutes(shift.lunchStart) !== null ? shift.lunchStart : null,
      };
    }
  }

  for (const [date, name] of Object.entries(isObject(raw.holidayEdits) ? raw.holidayEdits : {})) {
    if (!isISODate(date)) continue;
    if (name === null) state.holidayEdits[date] = null;
    else if (text(name, 60)) state.holidayEdits[date] = text(name, 60);
  }

  return state;
}

const parse = (json) => sanitize(JSON.parse(json));

// Returns { state, warning, locked }. `locked` means saving would destroy data we can't read.
export function load(store = localStorage) {
  let current;
  try {
    current = store.getItem(KEY);
  } catch {
    return { state: emptyState(), warning: 'This browser is blocking storage, so nothing can be saved. Try turning off private browsing.', locked: true };
  }
  if (current === null) return { state: emptyState(), warning: null, locked: false };

  try {
    return { state: parse(current), warning: null, locked: false };
  } catch (error) {
    if (/newer version/.test(error.message)) {
      return { state: emptyState(), warning: 'Your saved schedule was made by a newer version. Refresh the page to get the latest one.', locked: true };
    }
    try {
      store.setItem(`shiftPlanner.unreadable.${Date.now()}`, current);
    } catch {
      return { state: emptyState(), warning: 'Your saved schedule could not be read. Nothing has been changed. Import a backup file to recover.', locked: true };
    }
    try {
      const previous = parse(store.getItem(PREVIOUS_KEY));
      return { state: previous, warning: 'The latest save was damaged, so the one before it was restored. Please check your most recent change.', locked: false };
    } catch {
      return { state: emptyState(), warning: 'Your saved schedule could not be read. A copy was set aside. Import a backup file to recover.', locked: false };
    }
  }
}

// Returns true when the data is safely written.
export function save(state, store = localStorage) {
  try {
    const current = store.getItem(KEY);
    if (current !== null) {
      try {
        parse(current); // only a readable save is worth keeping as the fallback
        store.setItem(PREVIOUS_KEY, current);
      } catch { /* keep the older fallback */ }
    }
    store.setItem(KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export const isStorageKey = (key) => key === KEY;

export const lastBackup = () => {
  try { return Number(localStorage.getItem(BACKUP_DATE_KEY)) || null; } catch { return null; }
};

export const markBackup = () => {
  try { localStorage.setItem(BACKUP_DATE_KEY, String(Date.now())); } catch { /* not important */ }
};

// Which branch was open last. A viewing preference, so it isn't part of the schedule data.
export const lastBranch = () => {
  try { return localStorage.getItem(BRANCH_KEY); } catch { return null; }
};

export const rememberBranch = (id) => {
  try { localStorage.setItem(BRANCH_KEY, id); } catch { /* not important */ }
};

// Removes the schedule from this browser, used when signing out.
export function clearSchedule(store = localStorage) {
  for (const key of [KEY, PREVIOUS_KEY]) store.removeItem(key);
}

// Asks the browser not to evict our data when disk space runs low.
export async function requestPersistence() {
  try {
    if (!navigator.storage?.persist) return false;
    return (await navigator.storage.persisted()) || (await navigator.storage.persist());
  } catch {
    return false;
  }
}
