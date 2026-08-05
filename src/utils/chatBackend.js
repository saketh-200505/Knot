/**
 * chatBackend.js — shared Firebase Realtime Database helpers.
 * Kept in one place so ChatTab and the unread-count hook use identical
 * credentials and semantics.
 */

export const FIREBASE_CONFIG = {
  apiKey:      'AIzaSyBHnA05bunLw23gy40u-Llxsshn9Lc3LBI',
  databaseURL: 'https://saketh-3ee4f-default-rtdb.asia-southeast1.firebasedatabase.app',
};

const DB = () => FIREBASE_CONFIG.databaseURL;

export async function fbGet(path) {
  try {
    const res = await fetch(`${DB()}/${path}.json?auth=${FIREBASE_CONFIG.apiKey}`);
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const j = await res.json(); if (j?.error) msg = j.error; } catch {}
      return { ok: false, data: null, error: msg };
    }
    const data = await res.json();
    return { ok: true, data };
  } catch (e) { return { ok: false, data: null, error: e?.message || 'Network error' }; }
}

export async function fbSet(path, data) {
  try {
    const res = await fetch(`${DB()}/${path}.json?auth=${FIREBASE_CONFIG.apiKey}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const j = await res.json(); if (j?.error) msg = j.error; } catch {}
      return { ok: false, error: msg };
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: e?.message || 'Network error' }; }
}

export async function fbPatch(path, data) {
  try {
    const res = await fetch(`${DB()}/${path}.json?auth=${FIREBASE_CONFIG.apiKey}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const j = await res.json(); if (j?.error) msg = j.error; } catch {}
      return { ok: false, error: msg };
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: e?.message || 'Network error' }; }
}

// Same room-path convention as ChatTab: sorted pubkeys joined.
export function roomPath(a, b) {
  return 'chats/' + [a, b].sort().join('__');
}

// ─── Message retention (client-side "cron") ────────────────────────────────
// There's no server here to run a real cron job, so instead: every time a
// room is polled, if it's been >24h since we last checked, sweep any
// message older than MESSAGE_TTL_MS out of Firebase. This uses the room
// data ALREADY downloaded by the poll — no extra GET — and only issues a
// PATCH (cheap) for the stale ids, if any exist. Both sides of a chat do
// this independently, so the room stays trimmed regardless of which
// device happens to be open when the sweep runs.
//
// Note: this only trims the SERVER copy. Each device's own local message
// history (persisted separately in AsyncStorage) is untouched, so nothing
// disappears from your chat view — this purely keeps future room downloads
// small by not re-fetching your entire history every poll.
export const MESSAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export async function pruneOldMessages(path, roomData) {
  if (!roomData || typeof roomData !== 'object') return { pruned: 0 };
  const cutoff = Date.now() - MESSAGE_TTL_MS;
  const toDelete = {};
  let count = 0;
  for (const [id, msg] of Object.entries(roomData)) {
    if (msg && typeof msg === 'object' && typeof msg.ts === 'number' && msg.ts < cutoff) {
      toDelete[id] = null; // Firebase: setting a key to null deletes it
      count++;
    }
  }
  if (count === 0) return { pruned: 0 };
  const res = await fbPatch(path, toDelete); // one multi-location delete, not N requests
  return { pruned: res.ok ? count : 0, error: res.ok ? null : res.error };
}
