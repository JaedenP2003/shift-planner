import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloud, CloudError, SESSION_KEY, toEmail } from '../js/cloud.js';
import { createSync, REPLACED_KEY } from '../js/sync.js';
import { emptyState } from '../js/storage.js';

const memory = () => {
  const items = new Map();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => items.set(key, String(value)),
    removeItem: (key) => items.delete(key),
  };
};

// A stand-in for the online row, with the same revision rule as the database.
function server() {
  const online = { row: null, down: false };
  const reach = () => { if (online.down) throw new CloudError('offline'); };
  online.cloud = {
    read: async () => { reach(); return structuredClone(online.row); },
    revision: async () => { reach(); return online.row?.revision ?? null; },
    create: async (data) => {
      reach();
      if (online.row) throw new CloudError('conflict');
      online.row = { data: structuredClone(data), revision: 1 };
      return 1;
    },
    update: async (data, base) => {
      reach();
      if (online.row?.revision !== base) throw new CloudError('conflict');
      online.row = { data: structuredClone(data), revision: base + 1 };
      return base + 1;
    },
  };
  return online;
}

function device(online, state = emptyState()) {
  const it = { state, statuses: [], replaced: [], store: memory() };
  it.sync = createSync({
    cloud: online.cloud,
    store: it.store,
    getState: () => it.state,
    setState: (next) => { it.state = next; },
    onStatus: (status) => it.statuses.push(status),
    onReplaced: (reason) => it.replaced.push(reason),
  });
  it.add = (name) => {
    it.state.people.push({ id: name, name, tagId: null, employment: 'full', branchId: 'branch-1', weeklyTarget: 40 });
    it.sync.markChanged();
  };
  it.names = () => it.state.people.map((p) => p.name);
  return it;
}

const setUp = async () => {
  const online = server();
  const first = device(online);
  first.add('Ann');
  await first.sync.refresh();
  return { online, first };
};

test('the first device with a schedule uploads it, and a new device receives it', async () => {
  const { online, first } = await setUp();
  assert.equal(online.row.revision, 1);
  assert.equal(first.statuses.at(-1), 'saved');

  const second = device(online);
  await second.sync.refresh();
  assert.deepEqual(second.names(), ['Ann']);
  assert.deepEqual(second.replaced, []);
});

test('an empty device never creates the online schedule', async () => {
  const online = server();
  await device(online).sync.refresh();
  assert.equal(online.row, null);
});

test('edits travel from one device to the other', async () => {
  const { online, first } = await setUp();
  const second = device(online);
  await second.sync.refresh();
  second.add('Bo');
  await second.sync.flush();
  await first.sync.refresh();
  assert.deepEqual(first.names(), ['Ann', 'Bo']);
  assert.equal(first.sync.pending(), false);
});

test('the second of two simultaneous saves keeps the first and sets its own copy aside', async () => {
  const { online, first } = await setUp();
  const second = device(online);
  await second.sync.refresh();
  first.add('Bo');
  second.add('Cy');
  await first.sync.flush();
  await second.sync.flush();
  assert.deepEqual(online.row.data.people.map((p) => p.name), ['Ann', 'Bo']);
  assert.deepEqual(second.names(), ['Ann', 'Bo']);
  assert.deepEqual(second.replaced, ['conflict']);
  assert.deepEqual(JSON.parse(second.store.getItem(REPLACED_KEY)).people.map((p) => p.name), ['Ann', 'Cy']);
});

test('a device with its own schedule sets it aside when it first connects', async () => {
  const { online } = await setUp();
  const other = device(online);
  other.add('Dee');
  other.sync.reset(); // never connected before
  await other.sync.refresh();
  assert.deepEqual(other.names(), ['Ann']);
  assert.deepEqual(other.replaced, ['first']);
  assert.ok(other.store.getItem(REPLACED_KEY).includes('Dee'));
});

test('offline edits wait and are sent later', async () => {
  const { online, first } = await setUp();
  online.down = true;
  first.add('Bo');
  assert.equal(await first.sync.flush(), false);
  assert.equal(first.statuses.at(-1), 'offline');
  assert.equal(first.sync.pending(), true);
  online.down = false;
  await first.sync.refresh();
  assert.equal(online.row.data.people.length, 2);
  assert.equal(first.sync.pending(), false);
});

test('an edit made while saving is sent too', async () => {
  const { online, first } = await setUp();
  const update = online.cloud.update;
  let added = false;
  online.cloud.update = async (data, base) => {
    if (!added) { added = true; first.add('Cy'); }
    return update(data, base);
  };
  first.add('Bo');
  await first.sync.flush();
  assert.deepEqual(online.row.data.people.map((p) => p.name), ['Ann', 'Bo', 'Cy']);
});

test('a schedule from a newer version is neither loaded nor overwritten', async () => {
  const { online, first } = await setUp();
  online.row = { data: { ...online.row.data, version: 99 }, revision: 2 };
  first.add('Bo');
  await first.sync.refresh();
  assert.equal(first.statuses.at(-1), 'outdated');
  assert.equal(online.row.data.version, 99);
});

test('a replacement waits while the app is busy', async () => {
  const { online, first } = await setUp();
  const second = device(online);
  await second.sync.refresh();
  first.add('Bo');
  await first.sync.flush();
  await second.sync.refresh(() => false);
  assert.deepEqual(second.names(), ['Ann']);
});

// A fake web request that answers from a list.
const replies = (...list) => {
  const sent = [];
  const send = async (url, options) => {
    sent.push({ url, ...options });
    const [status, body] = list.shift();
    return { status, ok: status < 300, json: async () => body };
  };
  return { send, sent };
};
const grant = { access_token: 'a1', refresh_token: 'r1', expires_in: 3600 };

test('a username becomes an account address, and signing in needs editor access', async () => {
  assert.equal(toEmail(' Schedule '), 'schedule@branchschedule.github.io');
  assert.equal(toEmail('a@b.com'), 'a@b.com');

  const store = memory();
  const wrong = replies([400, {}]);
  await assert.rejects(createCloud({ store, send: wrong.send }).signIn('x', 'y'), { kind: 'password' });

  const stranger = replies([200, grant], [200, []]);
  await assert.rejects(createCloud({ store, send: stranger.send }).signIn('x', 'y'), { kind: 'forbidden' });
  assert.equal(store.getItem(SESSION_KEY), null);

  const editor = replies([200, grant], [200, [{ user_id: '1' }]]);
  const cloud = createCloud({ store, send: editor.send });
  await cloud.signIn('x', 'y');
  assert.equal(cloud.signedIn(), true);
  assert.ok(!store.getItem(SESSION_KEY).includes('"y"'));
});

test('an expired sign-in is renewed, and a rejected one signs out', async () => {
  const store = memory();
  store.setItem(SESSION_KEY, JSON.stringify({ access: 'old', refresh: 'r0', expires: 0 }));
  const renewed = replies([200, grant], [200, [{ revision: 3 }]]);
  assert.equal(await createCloud({ store, send: renewed.send }).revision(), 3);
  assert.equal(renewed.sent[1].headers.Authorization, 'Bearer a1');

  store.setItem(SESSION_KEY, JSON.stringify({ access: 'old', refresh: 'r0', expires: 0 }));
  const refused = replies([400, {}]);
  const cloud = createCloud({ store, send: refused.send });
  await assert.rejects(cloud.revision(), { kind: 'auth' });
  assert.equal(cloud.signedIn(), false);
});

test('an out-of-date save is reported as a conflict', async () => {
  const store = memory();
  store.setItem(SESSION_KEY, JSON.stringify({ access: 'a', refresh: 'r', expires: Date.now() + 3600000 }));
  const cloud = createCloud({ store, send: replies([200, []]).send });
  await assert.rejects(cloud.update(emptyState(), 4), { kind: 'conflict' });
});
