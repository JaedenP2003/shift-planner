// Keeps this browser's copy of the schedule and the shared online copy in step.
// Every edit is saved here first, then sent online. Each online save names the revision
// it was built on, so one person can't silently overwrite another.

import { emptyState, sanitize } from './storage.js';

export const SYNC_KEY = 'shiftPlanner.sync';
// The schedule that was on this device when the online one took its place.
export const REPLACED_KEY = 'shiftPlanner.replaced';

// Equal regardless of property order, which the database does not preserve.
const canonical = (value) => JSON.stringify(value, (key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((k) => [k, item[k]]))
    : item);

// Has anything been set up, compared with a brand new planner?
const hasContent = (state) => canonical({ ...state, showSunday: false }) !== canonical(emptyState());

// getState/setState read and replace the app's schedule. onStatus receives 'saving',
// 'saved', 'offline', 'error', 'outdated', 'forbidden' or 'signed-out'.
export function createSync({ cloud, store = localStorage, getState, setState, onStatus, onReplaced }) {
  // revision: the online revision this copy is built on. edit: changes on every local edit.
  const meta = () => {
    try { return { revision: null, dirty: false, edit: 0, ...JSON.parse(store.getItem(SYNC_KEY)) }; }
    catch { return { revision: null, dirty: false, edit: 0 }; }
  };
  const write = (changes) => store.setItem(SYNC_KEY, JSON.stringify({ ...meta(), ...changes }));

  // One conversation with the server at a time.
  let queue = Promise.resolve();
  const inTurn = (task) => {
    const result = queue.then(async () => {
      try {
        await task();
        return true;
      } catch (error) {
        const status = {
          offline: 'offline', auth: 'signed-out', forbidden: 'forbidden', outdated: 'outdated',
        }[error.kind] ?? 'error';
        onStatus(status);
        return false;
      }
    });
    queue = result;
    return result;
  };

  const parse = (data) => {
    try {
      return sanitize(data);
    } catch (error) {
      throw Object.assign(error, { kind: /newer version/.test(error.message) ? 'outdated' : 'server' });
    }
  };

  // The online copy wins. Anything different here is set aside, never thrown away.
  function take(row) {
    const online = parse(row.data);
    const local = getState();
    const before = meta();
    const differs = canonical(online) !== canonical(local);
    const lost = differs && (before.dirty || (before.revision === null && hasContent(local)));
    if (lost) store.setItem(REPLACED_KEY, JSON.stringify(local));
    write({ revision: row.revision, dirty: false });
    if (differs) setState(online);
    if (lost) onReplaced(before.revision === null ? 'first' : 'conflict');
  }

  async function push() {
    while (meta().dirty) {
      onStatus('saving');
      const { revision, edit } = meta();
      const data = structuredClone(getState());
      try {
        const saved = revision === null ? await cloud.create(data) : await cloud.update(data, revision);
        // Edits made while this was being sent still need to go.
        write({ revision: saved, dirty: meta().edit !== edit });
      } catch (error) {
        if (error.kind !== 'conflict') throw error;
        const row = await cloud.read();
        if (!row) throw error;
        take(row);
      }
    }
    onStatus('saved');
  }

  return {
    pending: () => meta().dirty,

    // Call after every local edit, then flush() soon after.
    markChanged() {
      write({ dirty: true, edit: meta().edit + 1 });
    },

    flush: () => inTurn(push),

    // Fetches the online schedule if it moved on, and sends anything waiting here.
    refresh: (canReplace = () => true) => inTurn(async () => {
      const online = await cloud.revision();
      if (online === null) {
        // Nothing online yet: the first device with a schedule provides it.
        write({ revision: null, dirty: hasContent(getState()) });
      } else if (online !== meta().revision) {
        if (!canReplace()) return;
        const row = await cloud.read();
        if (!canReplace()) return;
        take(row);
      }
      await push();
    }),

    // Forgets this browser's link to the online copy (used when signing out).
    reset: () => store.removeItem(SYNC_KEY),
  };
}
