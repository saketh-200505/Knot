/**
 * useChatUnread — background poller for unread message counts.
 *
 * Runs at the Vault level so the Chat-tab badge stays live even when the
 * Chat tab isn't the focused tab. Polls each contact's room in Firebase,
 * counts messages sent by the peer that arrived after our last-read
 * timestamp for that contact, and returns { total, perContact }.
 *
 * Also emits a background presence heartbeat so the peer sees us as
 * "online" whenever the app is open — not only when we're sitting inside
 * their chat thread.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import { fbGet, fbSet } from '../utils/chatBackend';

// Same AsyncStorage keys ChatTab uses so both agree on identity/contacts.
const KEY_ID  = 'knot_chat_id';
const KEY_CON = 'knot_chat_contacts';
// Per-contact last-read timestamp, keyed by peer pubHex.
const KEY_LAST_READ = 'knot_chat_last_read';
const POLL_MS = 8000;
const PRESENCE_MS = 15000;

function roomPath(a, b) {
  return 'chats/' + [a, b].sort().join('__');
}

async function loadLastRead() {
  try {
    const raw = await AsyncStorage.getItem(KEY_LAST_READ);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}
async function saveLastRead(map) {
  try { await AsyncStorage.setItem(KEY_LAST_READ, JSON.stringify(map)); } catch {}
}

// Mark a contact's thread as read up to `ts` (default: now). Called by the
// chat screen when it opens or receives a fresh message.
export async function markContactRead(peerPubHex, ts = Date.now()) {
  const map = await loadLastRead();
  if ((map[peerPubHex] || 0) >= ts) return;
  map[peerPubHex] = ts;
  await saveLastRead(map);
}

export function useChatUnread() {
  const [state, setState] = useState({ total: 0, perContact: {} });
  const pollTimer     = useRef(null);
  const presenceTimer = useRef(null);
  const identityRef   = useRef(null);
  const contactsRef   = useRef([]);

  const refreshRoster = useCallback(async () => {
    try {
      const rawId = await AsyncStorage.getItem(KEY_ID);
      identityRef.current = rawId ? JSON.parse(rawId) : null;
      const rawC = await AsyncStorage.getItem(KEY_CON);
      contactsRef.current = rawC ? JSON.parse(rawC) : [];
    } catch {
      identityRef.current = null;
      contactsRef.current = [];
    }
  }, []);

  const pollOnce = useCallback(async () => {
    const identity = identityRef.current;
    const contacts = contactsRef.current;
    if (!identity || !contacts.length) {
      setState(prev => (prev.total === 0 && !Object.keys(prev.perContact).length ? prev : { total: 0, perContact: {} }));
      return;
    }
    const lastRead = await loadLastRead();
    const perContact = {};
    let total = 0;
    // Fetch each room in parallel — small chats, cheap.
    await Promise.all(contacts.map(async (c) => {
      const rp = roomPath(identity.pubHex, c.pubHex);
      const res = await fbGet(rp);
      if (!res.ok || !res.data || typeof res.data !== 'object') {
        perContact[c.pubHex] = 0;
        return;
      }
      const cutoff = lastRead[c.pubHex] || 0;
      let n = 0;
      for (const m of Object.values(res.data)) {
        if (!m || !m.ts || !m.sender) continue;
        if (m.sender === identity.pubHex) continue; // ours — never unread
        if (m.ts > cutoff) n++;
      }
      perContact[c.pubHex] = n;
      total += n;
    }));
    setState({ total, perContact });
  }, []);

  const beatPresence = useCallback(async (online = true) => {
    const identity = identityRef.current;
    if (!identity?.pubHex) return;
    fbSet(`presence/${identity.pubHex}`, { online, at: Date.now() }).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await refreshRoster();
      if (cancelled) return;
      pollOnce();
      beatPresence(true);
      pollTimer.current     = setInterval(async () => { await refreshRoster(); pollOnce(); }, POLL_MS);
      presenceTimer.current = setInterval(() => beatPresence(true), PRESENCE_MS);
    })();

    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') { refreshRoster().then(() => { pollOnce(); beatPresence(true); }); }
      else                   { beatPresence(false); }
    });

    return () => {
      cancelled = true;
      if (pollTimer.current)     clearInterval(pollTimer.current);
      if (presenceTimer.current) clearInterval(presenceTimer.current);
      sub.remove();
      beatPresence(false);
    };
  }, [refreshRoster, pollOnce, beatPresence]);

  return state;
}
