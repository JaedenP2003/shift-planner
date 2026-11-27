// Talks to Supabase over plain web requests: signing in, and reading and writing
// the one row that holds the shared schedule.

import { SUPABASE_KEY, SUPABASE_URL, USERNAME_DOMAIN } from './config.js';

export const SESSION_KEY = 'shiftPlanner.session';

// kind: 'offline' (try again later), 'auth' (sign in again), 'password' (wrong sign-in),
// 'forbidden' (account not allowed), 'conflict' (someone else saved first), 'server'.
export class CloudError extends Error {
  constructor(kind, message) {
    super(message ?? kind);
    this.kind = kind;
  }
}

export const toEmail = (name) => {
  const clean = name.trim().toLowerCase();
  return clean.includes('@') ? clean : `${clean}@${USERNAME_DOMAIN}`;
};

export function createCloud({ store = localStorage, send = (...args) => fetch(...args), now = Date.now } = {}) {
  const session = () => {
    try { return JSON.parse(store.getItem(SESSION_KEY)); } catch { return null; }
  };
  const remember = (reply) => store.setItem(SESSION_KEY, JSON.stringify({
    access: reply.access_token,
    refresh: reply.refresh_token,
    expires: now() + reply.expires_in * 1000,
  }));
  const forget = () => store.removeItem(SESSION_KEY);

  async function call(path, { method = 'GET', body, token, headers } = {}) {
    let response;
    try {
      response = await send(SUPABASE_URL + path, {
        method,
        headers: {
          apikey: SUPABASE_KEY,
          ...(token && { Authorization: `Bearer ${token}` }),
          ...(body && { 'Content-Type': 'application/json' }),
          ...headers,
        },
        body: body && JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new CloudError('offline');
    }
    const reply = await response.json().catch(() => null);
    return { status: response.status, ok: response.ok, reply };
  }

  // A usable access token, renewing it when it is about to run out.
  async function token(force = false) {
    const current = session();
    if (!current) throw new CloudError('auth');
    if (!force && current.expires - now() > 60000) return current.access;
    const { ok, status, reply } = await call('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST', body: { refresh_token: current.refresh },
    });
    if (ok) {
      remember(reply);
      return reply.access_token;
    }
    // Another tab may have renewed it a moment ago.
    const latest = session();
    if (latest && latest.refresh !== current.refresh) return latest.access;
    if (status === 400 || status === 401 || status === 403) {
      forget();
      throw new CloudError('auth');
    }
    throw new CloudError('server');
  }

  async function rest(path, options = {}) {
    let result = await call(`/rest/v1/${path}`, { ...options, token: await token() });
    if (result.status === 401) result = await call(`/rest/v1/${path}`, { ...options, token: await token(true) });
    if (result.ok) return result.reply;
    if (result.status === 401) throw new CloudError('auth');
    if (result.status === 403) throw new CloudError('forbidden');
    // A duplicate row, or the database refusing an out-of-date revision.
    if (result.status === 409 || result.reply?.code === 'P0001') throw new CloudError('conflict');
    throw new CloudError('server', result.reply?.message);
  }

  const save = async (path, method, body) => {
    const rows = await rest(path, { method, body, headers: { Prefer: 'return=representation' } });
    if (!rows?.length) throw new CloudError('conflict');
    return rows[0].revision;
  };

  return {
    signedIn: () => Boolean(session()),

    async signIn(name, password) {
      const { ok, status, reply } = await call('/auth/v1/token?grant_type=password', {
        method: 'POST', body: { email: toEmail(name), password },
      });
      if (!ok) throw new CloudError(status === 400 || status === 401 ? 'password' : 'server');
      remember(reply);
      try {
        const editors = await rest('planner_editors?select=user_id');
        if (!editors.length) throw new CloudError('forbidden');
      } catch (error) {
        forget();
        throw error;
      }
    },

    // Signs out this browser only, so others using the shared account stay signed in.
    async signOut() {
      const current = session();
      forget();
      if (current) await call('/auth/v1/logout?scope=local', { method: 'POST', token: current.access }).catch(() => {});
    },

    // { data, revision }, or null when nothing has been saved online yet.
    read: async () => (await rest('planner?id=eq.main&select=data,revision'))[0] ?? null,
    revision: async () => (await rest('planner?id=eq.main&select=revision'))[0]?.revision ?? null,
    create: (data) => save('planner', 'POST', { id: 'main', data, revision: 1 }),
    update: (data, base) => save(`planner?id=eq.main&revision=eq.${base}`, 'PATCH', { data, revision: base + 1 }),
  };
}
