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
