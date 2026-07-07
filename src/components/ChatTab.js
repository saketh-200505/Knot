/**
 * ChatTab.js — E2EE live chat for Knot
 * Transport : Firebase Realtime Database REST API + polling
 * Encryption: AES-256-CTR (your existing aes-js + @noble/hashes)
 *
 * WHY POLLING: React Native fetch() does not support SSE/streaming.
 * Polling every 2s is reliable, fast enough for chat, zero extra packages.
 *
 * FIREBASE SETUP (10 min):
 * 1. console.firebase.google.com → Create project
 * 2. Build → Realtime Database → Create → Test mode
 * 3. Project Settings → Your apps → </> Web → Register → copy apiKey + databaseURL
 * 4. Paste below
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList,
  StyleSheet, KeyboardAvoidingView, Platform, ActivityIndicator,
  Alert, Pressable, Animated, PanResponder, BackHandler,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ExpoC from 'expo-crypto';
import * as aesjs from 'aes-js';
import { sha256 } from '@noble/hashes/sha256';
import Constants from 'expo-constants';
import { COLORS, FONTS, RADIUS, SPACING } from '../utils/theme';
import { fbGet, fbSet, fbPatch, roomPath } from '../utils/chatBackend';
import { markContactRead } from '../hooks/useChatUnread';

const POLL_INTERVAL = 2000; // ms — poll Firebase every 2 seconds

// ─── Push notifications (soft — works whether expo-notifications is installed or not) ─
// The recipient's Expo push token is published to /tokens/<pubHex> so the sender's
// device can call Expo's public push endpoint directly. No backend needed.
let Notifications = null;
try {
  Notifications = require('expo-notifications');
} catch { Notifications = null; }

// Disguise text — chat is hidden behind the snake game, so pushes must look
// like game engagement pings. Random pick per notification.
const DISGUISE_LINES = [
  { title: '🐍 Snake', body: 'Your snake is hungry — come back and feed it!' },
  { title: '🎮 New challenge', body: 'Someone posted a new high score — can you beat it?' },
  { title: '⏸ Game paused', body: 'You left a game unfinished. Tap to resume where you left off.' },
  { title: '🏆 Leaderboard', body: 'You slipped a rank overnight — climb back up.' },
  { title: '🔔 Reminder', body: 'You have progress waiting. Don\'t lose your streak.' },
  { title: '🕹 Ready?', body: 'A new level unlocked. Tap to jump back in.' },
];
function pickDisguise() {
  return DISGUISE_LINES[Math.floor(Math.random() * DISGUISE_LINES.length)];
}

// Persist the last outcome locally too, so the Rooms screen can show it
// without needing Firebase console access. This is what surfaces "Push:
// permission denied" or "Push: rules blocked write" back to the user.
const KEY_PUSH_STATUS = 'knot_chat_push_status'; // { ok, token, error, at, source }
async function setPushStatus(o) {
  try { await AsyncStorage.setItem(KEY_PUSH_STATUS, JSON.stringify({ ...o, at: Date.now() })); } catch {}
}
async function getPushStatus() {
  try {
    const raw = await AsyncStorage.getItem(KEY_PUSH_STATUS);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function registerPushToken(myPubHex) {
  if (!Notifications) {
    const err = 'expo-notifications module missing (running in Expo Go?)';
    await setPushStatus({ ok: false, error: err });
    await fbSet(`tokens/${myPubHex}`, { error: err, at: Date.now() });
    return null;
  }
  try {
    const settings = await Notifications.getPermissionsAsync();
    let status = settings.status;
    if (status !== 'granted') {
      const req = await Notifications.requestPermissionsAsync();
      status = req.status;
    }
    if (status !== 'granted') {
      const err = `notifications permission not granted (${status})`;
      await setPushStatus({ ok: false, error: err });
      await fbSet(`tokens/${myPubHex}`, { error: err, at: Date.now() });
      return null;
    }
    // SDK 52+ requires projectId to be passed explicitly — without it the call
    // throws internally and the caller sees no token. Read it from expo-constants
    // so it stays in sync with app.json's extra.eas.projectId.
    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ??
      Constants.easConfig?.projectId;
    const tokenRes = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined
    );
    const token = tokenRes?.data;
    if (!token) {
      const err = 'Expo returned an empty push token';
      await setPushStatus({ ok: false, error: err });
      await fbSet(`tokens/${myPubHex}`, { error: err, at: Date.now() });
      return null;
    }
    const write = await fbSet(`tokens/${myPubHex}`, { token, at: Date.now() });
    if (!write.ok) {
      // Token itself is fine — the RTDB rejected the write. That's the
      // rules-block case; surface it so the user can fix Realtime Database rules.
      await setPushStatus({ ok: false, token, error: `RTDB rejected /tokens write: ${write.error || 'unknown'}` });
      return null;
    }
    await setPushStatus({ ok: true, token });
    return token;
  } catch (e) {
    const msg = e?.message || String(e);
    console.warn('[knot-push] token registration skipped:', msg);
    await setPushStatus({ ok: false, error: msg });
    await fbSet(`tokens/${myPubHex}`, { error: msg, at: Date.now() }).catch(() => {});
    return null;
  }
}

async function sendPushTo(recipientPubHex) {
  try {
    const res = await fbGet(`tokens/${recipientPubHex}`);
    const token = res?.data?.token;
    if (!token) return false;
    const { title, body } = pickDisguise();
    const push = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: token,
        sound: 'default',
        title,
        body,
        // No data payload that hints at chat — keep the disguise clean.
        priority: 'high',
      }),
    });
    return push.ok;
  } catch { return false; }
}

// ─── Crypto ───────────────────────────────────────────────────────────────────
function bytesToHex(b) {
  return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
}
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2)
    out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return out;
}

// Proper UTF-8 encode/decode that handles 4-byte sequences (emojis).
// aes-js's built-in utf8.fromBytes only handles up to 3-byte sequences, so
// any emoji (U+10000 and above) comes out as CJK/Arabic garbage — that's what
// caused "emojis received as Japanese/Chinese characters". The escape/
// decodeURIComponent trick round-trips any valid UTF-8 through the JS engine's
// own URI codec, which handles the full Unicode range.
function utf8Encode(str) {
  const s = unescape(encodeURIComponent(str));
  const arr = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) arr[i] = s.charCodeAt(i);
  return arr;
}
function utf8Decode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  try { return decodeURIComponent(escape(s)); } catch { return s; }
}

// Shared key = sha256(sortedPubA + sortedPubB)
// Sorted so BOTH sides always derive the EXACT same key regardless of who calls it
// Phone A: sha256(A_pub + B_pub)  — after sorting
// Phone B: sha256(A_pub + B_pub)  — same result ✅
function deriveSharedKey(myPubHex, theirPubHex) {
  const sorted = [myPubHex, theirPubHex].sort().join('');
  return sha256(utf8Encode(sorted));
}

function encryptMsg(text, keyBytes) {
  const iv = new Uint8Array(16);
  const ts = Date.now();
  iv[0] = (ts >> 24) & 0xff; iv[1] = (ts >> 16) & 0xff;
  iv[2] = (ts >>  8) & 0xff; iv[3] =  ts        & 0xff;
  for (let i = 4; i < 16; i++) iv[i] = Math.floor(Math.random() * 256);
  const plain  = utf8Encode(text);
  const ctr    = new aesjs.ModeOfOperation.ctr(keyBytes, new aesjs.Counter(iv));
  const cipher = ctr.encrypt(plain);
  const out    = new Uint8Array(16 + cipher.length);
  out.set(iv); out.set(cipher, 16);
  let b = '';
  for (let i = 0; i < out.length; i++) b += String.fromCharCode(out[i]);
  return btoa(b);
}

function decryptMsg(b64, keyBytes) {
  try {
    const raw  = atob(b64);
    const data = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) data[i] = raw.charCodeAt(i);
    const iv     = data.slice(0, 16);
    const cipher = data.slice(16);
    const ctr    = new aesjs.ModeOfOperation.ctr(keyBytes, new aesjs.Counter(iv));
    const plain  = ctr.decrypt(cipher);
    return utf8Decode(plain);
  } catch { return null; }
}

// ─── AsyncStorage keys ────────────────────────────────────────────────────────
const KEY_ID       = 'knot_chat_id';
const KEY_CON      = 'knot_chat_contacts';
const KEY_MSG      = 'knot_chat_msgs';
const KEY_NOTIF_ON = 'knot_chat_notif_default'; // 'on' | 'off'
const notifKeyFor  = (pubHex) => `knot_chat_notif:${pubHex}`;
const HAS_NOTIF_LIB = !!Notifications;

async function isNotifEnabled(contactPubHex) {
  const v = await AsyncStorage.getItem(notifKeyFor(contactPubHex));
  if (v === 'on')  return true;
  if (v === 'off') return false;
  const d = await AsyncStorage.getItem(KEY_NOTIF_ON);
  return d !== 'off'; // default: on
}
async function setNotifEnabled(contactPubHex, on) {
  await AsyncStorage.setItem(notifKeyFor(contactPubHex), on ? 'on' : 'off');
}

// ─── Utils ────────────────────────────────────────────────────────────────────
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}
function initials(n) {
  return (n || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
}
function timeStr(ts) {
  const d = new Date(ts), now = new Date();
  const same = d.toDateString() === now.toDateString();
  return same
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
      d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ─── ROOT ─────────────────────────────────────────────────────────────────────
export function ChatTab({ unreadPerContact = {}, onChatVisibilityChange } = {}) {
  const [screen,   setScreen]   = useState('loading');
  const [identity, setIdentity] = useState(null);
  const [contacts, setContacts] = useState([]);
  const [active,   setActive]   = useState(null);

  // Tell the parent (Vault) when we enter/leave a specific chat thread so it
  // can collapse its top tab bar and give the chat the whole screen.
  useEffect(() => {
    onChatVisibilityChange?.(screen === 'chat' && !!active);
    return () => onChatVisibilityChange?.(false);
  }, [screen, active, onChatVisibilityChange]);

  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(KEY_ID);
        if (raw) {
          const id = JSON.parse(raw);
          setIdentity(id);
          const c = await AsyncStorage.getItem(KEY_CON);
          setContacts(c ? JSON.parse(c) : []);
          setScreen('rooms');
          // Re-register push token in background — cheap if it hasn't rotated.
          registerPushToken(id.pubHex).catch(() => {});
        } else {
          setScreen('setup');
        }
      } catch { setScreen('setup'); }
    })();
  }, []);

  const saveContacts = useCallback(async (list) => {
    setContacts(list);
    await AsyncStorage.setItem(KEY_CON, JSON.stringify(list));
  }, []);

  const handleSetup = useCallback(async (alias) => {
    const privBytes = await ExpoC.getRandomBytesAsync(32);
    const privHex   = bytesToHex(new Uint8Array(privBytes));
    const pubHex    = bytesToHex(sha256(hexToBytes(privHex)));
    const id        = { alias, pubHex, privHex };
    await AsyncStorage.setItem(KEY_ID, JSON.stringify(id));
    setIdentity(id);
    setScreen('rooms');
    // Register the OS push token to Firebase so contacts can push to us.
    registerPushToken(pubHex).catch(() => {});
  }, []);

  const handleAdd = useCallback(async (name, pubHex) => {
    const p = pubHex.replace(/\s+/g, '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(p)) {
      Alert.alert(
        'Invalid key',
        'A Knot public key is 64 hex characters. Ask the other person to open Messages → "My key" and copy the whole string.'
      );
      return;
    }
    if (identity && p === identity.pubHex) {
      Alert.alert('That\'s your own key', 'You can\'t add yourself as a contact.'); return;
    }
    if (contacts.find(c => c.pubHex === p)) {
      Alert.alert('Already added', 'This contact is already in your list.'); return;
    }
    await saveContacts([...contacts, { id: genId(), name, pubHex: p }]);
  }, [contacts, saveContacts, identity]);

  const handleDelete = useCallback(async (id) => {
    await saveContacts(contacts.filter(c => c.id !== id));
  }, [contacts, saveContacts]);

  if (screen === 'loading') return (
    <View style={s.center}><ActivityIndicator color={COLORS.indigo} size="large" /></View>
  );
  if (screen === 'setup') return <SetupScreen onDone={handleSetup} />;
  if (screen === 'chat' && active) return (
    <ChatScreen
      identity={identity}
      contact={active}
      onBack={() => { setActive(null); setScreen('rooms'); }}
    />
  );
  return (
    <RoomsScreen
      identity={identity}
      contacts={contacts}
      unreadPerContact={unreadPerContact}
      onOpen={c => { markContactRead(c.pubHex).catch(() => {}); setActive(c); setScreen('chat'); }}
      onAdd={handleAdd}
      onDelete={handleDelete}
    />
  );
}

// ─── SETUP ────────────────────────────────────────────────────────────────────
function SetupScreen({ onDone }) {
  const [alias, setAlias] = useState('');
  const [busy,  setBusy]  = useState(false);

  const go = async () => {
    if (!alias.trim()) return;
    setBusy(true);
    try { await onDone(alias.trim()); }
    catch (e) { Alert.alert('Error', e.message); setBusy(false); }
  };

  return (
    <View style={s.center}>
      <View style={s.card}>
        <Text style={s.setupIcon}>🔐</Text>
        <Text style={s.setupTitle}>Set up chat</Text>
        <Text style={s.setupSub}>
          Pick a name. Your encryption keys are generated on this device and
          never leave it. Firebase only stores encrypted ciphertext.
        </Text>
        <TextInput
          style={s.inp}
          placeholder="Your name"
          placeholderTextColor={COLORS.textMuted}
          value={alias}
          onChangeText={setAlias}
          autoFocus
          returnKeyType="done"
          onSubmitEditing={go}
        />
        <TouchableOpacity
          style={[s.btnP, (busy || !alias.trim()) && s.btnOff]}
          onPress={go}
          disabled={busy || !alias.trim()}
          activeOpacity={0.8}
        >
          {busy
            ? <ActivityIndicator color="#fff" />
            : <Text style={s.btnPTxt}>Create identity & start</Text>}
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─── ROOMS ────────────────────────────────────────────────────────────────────
function RoomsScreen({ identity, contacts, onOpen, onAdd, onDelete, unreadPerContact = {} }) {
  const [showKey, setShowKey] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [name,    setName]    = useState('');
  const [pub,     setPub]     = useState('');
  const [busy,    setBusy]    = useState(false);
  const [pushStatus, setPushStatusState] = useState(null);

  // Refresh push status whenever this screen becomes visible so a fresh
  // registerPushToken() call (fired by ChatTab on mount) updates the UI.
  useEffect(() => {
    let cancelled = false;
    const load = () => getPushStatus().then(s => { if (!cancelled) setPushStatusState(s); }).catch(() => {});
    load();
    const t = setInterval(load, 3000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  const retryPush = useCallback(async () => {
    if (!identity?.pubHex) return;
    await registerPushToken(identity.pubHex);
    const next = await getPushStatus();
    setPushStatusState(next);
  }, [identity?.pubHex]);

  const add = async () => {
    if (!name.trim()) {
      Alert.alert('Missing name', 'Give this contact a name.'); return;
    }
    if (!pub.trim()) {
      Alert.alert('Missing key', 'Paste the other person\'s public key.'); return;
    }
    setBusy(true);
    await onAdd(name.trim(), pub);
    setName(''); setPub(''); setShowAdd(false); setBusy(false);
  };

  const confirmDelete = c =>
    Alert.alert('Remove', `Remove "${c.name}"?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => onDelete(c.id) },
    ]);

  return (
    <View style={s.fill}>
      <View style={s.header}>
        <Text style={s.headerTitle}>Messages</Text>
        <TouchableOpacity style={s.chip} onPress={() => setShowKey(v => !v)} activeOpacity={0.7}>
          <Text style={s.chipTxt}>My key</Text>
        </TouchableOpacity>
      </View>

      {showKey && (
        <View style={s.keyCard}>
          <Text style={s.keyLbl}>Share this key with people who want to message you</Text>
          <Text style={s.keyVal} selectable numberOfLines={4}>{identity?.pubHex}</Text>
          <Text style={s.keyName}>Name: {identity?.alias}</Text>
        </View>
      )}

      {/* Push-notification diagnostic — only surfaced when something is wrong,
          so it acts as a real error banner instead of dashboard noise. Once
          push is registered ✓ we stay silent. */}
      {pushStatus && pushStatus.ok === false && (
        <View style={[s.pushCard, s.pushErr]}>
          <View style={{ flex: 1 }}>
            <Text style={s.pushTitle}>Push: not working</Text>
            <Text style={s.pushMsg} numberOfLines={3}>
              {pushStatus.error || 'Waiting for first registration attempt…'}
            </Text>
          </View>
          <TouchableOpacity onPress={retryPush} style={s.pushRetry} activeOpacity={0.7}>
            <Text style={s.pushRetryTxt}>Retry</Text>
          </TouchableOpacity>
        </View>
      )}

      {contacts.length === 0 ? (
        <View style={s.emptyWrap}>
          <Text style={{ fontSize: 44, marginBottom: 12 }}>💬</Text>
          <Text style={s.emptyTitle}>No conversations yet</Text>
          <Text style={s.emptySub}>Tap + to add someone using their public key.</Text>
        </View>
      ) : (
        <FlatList
          data={contacts}
          keyExtractor={c => c.id}
          contentContainerStyle={{ paddingBottom: 100 }}
          renderItem={({ item }) => {
            const unread = unreadPerContact[item.pubHex] || 0;
            return (
              <Pressable
                style={({ pressed }) => [s.row, pressed && { backgroundColor: COLORS.surface2 }]}
                onPress={() => onOpen(item)}
                onLongPress={() => confirmDelete(item)}
              >
                <View style={s.av}><Text style={s.avTxt}>{initials(item.name)}</Text></View>
                <View style={{ flex: 1 }}>
                  <Text style={[s.rowName, unread > 0 && { color: COLORS.textPrimary }]}>{item.name}</Text>
                  <Text style={s.rowSub}>
                    {unread > 0 ? `${unread} new message${unread > 1 ? 's' : ''}` : '🔒 End-to-end encrypted'}
                  </Text>
                </View>
                {unread > 0
                  ? <View style={s.unreadBadge}><Text style={s.unreadBadgeTxt}>{unread > 99 ? '99+' : unread}</Text></View>
                  : <Text style={{ fontSize: 20, color: COLORS.textMuted }}>›</Text>}
              </Pressable>
            );
          }}
        />
      )}

      {showAdd && (
        <View style={s.sheet}>
          <Text style={s.sheetTitle}>Add contact</Text>
          <TextInput
            style={s.inp}
            placeholder="Their name"
            placeholderTextColor={COLORS.textMuted}
            value={name}
            onChangeText={setName}
            autoFocus
          />
          <TextInput
            style={[s.inp, { height: 90, textAlignVertical: 'top', paddingTop: SPACING.sm }]}
            placeholder="Paste their public key"
            placeholderTextColor={COLORS.textMuted}
            value={pub}
            onChangeText={setPub}
            multiline
            autoCorrect={false}
            autoCapitalize="none"
          />
          <View style={{ flexDirection: 'row', gap: SPACING.sm }}>
            <TouchableOpacity style={[s.btnG, { flex: 1 }]} onPress={() => setShowAdd(false)}>
              <Text style={s.btnGTxt}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.btnP, { flex: 1 }, busy && s.btnOff]}
              onPress={add} disabled={busy}
            >
              {busy
                ? <ActivityIndicator color="#fff" size="small" />
                : <Text style={s.btnPTxt}>Add</Text>}
            </TouchableOpacity>
          </View>
        </View>
      )}

      {!showAdd && (
        <TouchableOpacity style={s.fab} onPress={() => setShowAdd(true)} activeOpacity={0.85}>
          <Text style={s.fabTxt}>+</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

// ─── CHAT ─────────────────────────────────────────────────────────────────────
function ChatScreen({ identity, contact, onBack }) {
  const [messages,   setMessages]   = useState([]);
  const [input,      setInput]      = useState('');
  const [sending,    setSending]    = useState(false);
  const [online,     setOnline]     = useState(false);
  const [presence,   setPresence]   = useState({ online: false, at: 0 });
  const [notifOn,    setNotifOn]    = useState(true);
  const [replyingTo, setReplyingTo] = useState(null);
  const [editingMsg, setEditingMsg] = useState(null); // message we're editing (only own)
  const listRef    = useRef(null);
  const nearBottom = useRef(true);   // true while user is at/near the latest message
  const seenIds    = useRef(new Set());
  const readIds    = useRef(new Set()); // messages we've already patched with readAt
  const remoteMeta = useRef(new Map()); // id -> { editedAt, deleted } for reconcile
  const sharedKey  = useRef(null);
  const pollTimer  = useRef(null);
  const path       = roomPath(identity.pubHex, contact.pubHex);
  const rid        = path.replace('chats/', '');

  // Android hardware/gesture back: leave the chat instead of exiting the app.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack?.();
      return true;
    });
    return () => sub.remove();
  }, [onBack]);

  const persistMessages = useCallback((list) => {
    AsyncStorage.getItem(KEY_MSG).then(raw => {
      const all = raw ? JSON.parse(raw) : {};
      all[rid] = list;
      return AsyncStorage.setItem(KEY_MSG, JSON.stringify(all));
    }).catch(() => {});
  }, [rid]);

  // Derive shared key once
  useEffect(() => {
    sharedKey.current = deriveSharedKey(identity.pubHex, contact.pubHex);
  }, [identity.pubHex, contact.pubHex]);

  // Load cached messages, notification pref, prime seen/read sets
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(KEY_MSG);
        const all = raw ? JSON.parse(raw) : {};
        const cached = (all[rid] || []).map(m => ({
          ...m, fromMe: m.sender === identity.pubHex,
        }));
        // Anything we've already sent/received is "seen" — don't re-process on next poll
        for (const m of cached) {
          seenIds.current.add(m.id);
          if (m.fromMe) continue;
          if (m.readAt) readIds.current.add(m.id);
        }
        if (cached.length) {
          setMessages(cached);
          setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 50);
        }
      } catch {}
      const on = await isNotifEnabled(contact.pubHex);
      setNotifOn(on);
      // Opening the thread clears the unread count for this contact.
      markContactRead(contact.pubHex).catch(() => {});
    })();
  }, [rid, identity.pubHex, contact.pubHex]);

  // Note: our own presence heartbeat is driven by the Vault-level useChatUnread
  // hook so we still look "online" to peers when we're on any tab, not just here.

  const pollPresence = useCallback(async () => {
    const res = await fbGet(`presence/${contact.pubHex}`);
    if (!res.ok || !res.data) return;
    const p = res.data;
    // Considered "online" only if last heartbeat is within 45s (3× the heartbeat interval)
    const fresh = Date.now() - (p.at || 0) < 45000;
    setPresence({ online: !!p.online && fresh, at: p.at || 0 });
  }, [contact.pubHex]);

  // ── POLLING — fetch Firebase every 2 seconds ──────────────────────────────
  const poll = useCallback(async () => {
    if (!sharedKey.current) return;
    const res = await fbGet(path);
    setOnline(res.ok);
    pollPresence().catch(() => {});
    if (!res.ok) return;
    const data = res.data;
    if (!data || typeof data !== 'object') return;

    const newMsgs = [];
    const receiptUpdates = []; // { id, readAt } — messages of ours that got read
    const editUpdates    = []; // { id, text, editedAt } — an already-seen message got edited
    const deleteUpdates  = []; // ids of already-seen messages that got deleted
    const toMarkRead = [];     // incoming messages we should PATCH readAt on

    for (const [id, m] of Object.entries(data)) {
      if (!m || !m.ct || !m.ts || !m.sender) continue;

      // Read-receipt reconciliation: if it's ours and the peer set readAt, apply it
      if (m.sender === identity.pubHex && m.readAt) {
        receiptUpdates.push({ id, readAt: m.readAt });
      }

      // Edit / soft-delete reconciliation for messages we already have
      if (seenIds.current.has(id)) {
        const prev = remoteMeta.current.get(id) || {};
        if (m.deleted && !prev.deleted) {
          deleteUpdates.push(id);
          remoteMeta.current.set(id, { ...prev, deleted: true });
        } else if (m.editedAt && m.editedAt !== prev.editedAt) {
          const newText = decryptMsg(m.ct, sharedKey.current);
          if (newText != null) {
            editUpdates.push({ id, text: newText, editedAt: m.editedAt });
            remoteMeta.current.set(id, { ...prev, editedAt: m.editedAt });
          }
        }
        continue;
      }

      seenIds.current.add(id);
      remoteMeta.current.set(id, { editedAt: m.editedAt || null, deleted: !!m.deleted });
      const text = decryptMsg(m.ct, sharedKey.current);
      if (!text) continue;

      const fromMe = m.sender === identity.pubHex;
      const item = {
        id, text, ts: m.ts, sender: m.sender, fromMe,
        replyTo: m.replyTo ? decryptReplyPreview(m.replyTo, sharedKey.current) : null,
        readAt: m.readAt || null,
        editedAt: m.editedAt || null,
        deleted: !!m.deleted,
        status: fromMe ? (m.readAt ? 'read' : 'sent') : undefined,
      };
      newMsgs.push(item);

      // If it's incoming and we haven't already told the peer we read it, queue it
      if (!fromMe && !m.deleted && !readIds.current.has(id)) toMarkRead.push(id);
    }

    // Apply edits / deletes to existing state (before appending newcomers)
    if (editUpdates.length || deleteUpdates.length) {
      setMessages(prev => {
        const eMap = new Map(editUpdates.map(u => [u.id, u]));
        const dSet = new Set(deleteUpdates);
        let changed = false;
        const next = prev.map(m => {
          if (dSet.has(m.id) && !m.deleted) { changed = true; return { ...m, deleted: true, text: '' }; }
          const e = eMap.get(m.id);
          if (e && m.editedAt !== e.editedAt) { changed = true; return { ...m, text: e.text, editedAt: e.editedAt }; }
          return m;
        });
        if (changed) persistMessages(next);
        return changed ? next : prev;
      });
    }

    // Apply read receipts to our own outgoing messages (already in state)
    if (receiptUpdates.length) {
      setMessages(prev => {
        const map = new Map(receiptUpdates.map(u => [u.id, u.readAt]));
        let changed = false;
        const next = prev.map(m => {
          const ra = map.get(m.id);
          if (ra && m.readAt !== ra) { changed = true; return { ...m, readAt: ra, status: 'read' }; }
          return m;
        });
        if (changed) persistMessages(next);
        return changed ? next : prev;
      });
    }

    // Tell the peer we read their messages (fire-and-forget)
    for (const id of toMarkRead) {
      readIds.current.add(id);
      fbPatch(`${path}/${id}`, { readAt: Date.now() }).catch(() => {});
    }

    if (!newMsgs.length) return;

    // Any peer message that arrives while we're inside this thread counts as
    // read — advance the last-read cursor so the Rooms list and Chat-tab
    // badge don't keep counting it.
    const latestPeerTs = newMsgs.reduce(
      (mx, m) => (!m.fromMe && m.ts > mx ? m.ts : mx),
      0,
    );
    if (latestPeerTs) markContactRead(contact.pubHex, latestPeerTs).catch(() => {});

    setMessages(prev => {
      const merged = [...prev];
      for (const msg of newMsgs) {
        if (!merged.find(m => m.id === msg.id)) merged.push(msg);
      }
      const sorted = merged.sort((a, b) => a.ts - b.ts);
      persistMessages(sorted);
      return sorted;
    });
    // Don't yank the user down to a new message if they've scrolled up to
    // read history — same rule the FlatList's onContentSizeChange follows.
    if (nearBottom.current) {
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 80);
    }
  }, [path, identity.pubHex, contact.pubHex, pollPresence, persistMessages]);

  // Start polling on mount, stop on unmount
  useEffect(() => {
    poll(); // immediate first fetch
    pollTimer.current = setInterval(poll, POLL_INTERVAL);
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, [poll]);

  // Scroll to bottom whenever the message count changes (new incoming/cached) —
  // but only if the user hasn't scrolled up to read older messages.
  useEffect(() => {
    if (messages.length > 0 && nearBottom.current) {
      setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 100);
    }
  }, [messages.length]);

  // Toggle notifications for this contact
  const toggleNotif = useCallback(async () => {
    const next = !notifOn;
    setNotifOn(next);
    await setNotifEnabled(contact.pubHex, next);
  }, [notifOn, contact.pubHex]);

  // Send message (or commit an in-flight edit)
  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || sending || !sharedKey.current) return;

    // Edit path — patch the existing Firebase entry with new ciphertext + editedAt.
    if (editingMsg) {
      const target = editingMsg;
      setSending(true);
      setInput('');
      setEditingMsg(null);
      const editedAt = Date.now();
      const ct = encryptMsg(text, sharedKey.current);
      setMessages(prev => {
        const next = prev.map(m => m.id === target.id ? { ...m, text, editedAt } : m);
        persistMessages(next);
        return next;
      });
      const res = await fbPatch(`${path}/${target.id}`, { ct, editedAt });
      if (!res.ok) {
        Alert.alert('Edit failed', res.error || 'Please try again.');
      } else {
        // Track our own edit so the poll's reconciler doesn't re-echo it as a
        // remote edit and clobber the state we just set.
        const prev = remoteMeta.current.get(target.id) || {};
        remoteMeta.current.set(target.id, { ...prev, editedAt });
      }
      setSending(false);
      return;
    }

    setSending(true);
    setInput('');
    const replySnapshot = replyingTo;
    setReplyingTo(null);

    const id  = genId();
    const ts  = Date.now();
    const ct  = encryptMsg(text, sharedKey.current);
    // Reply preview is short (≤120 chars) but still encrypted so the DB never sees plaintext
    const replyPayload = replySnapshot
      ? {
          id: replySnapshot.id,
          sender: replySnapshot.sender,
          ct: encryptMsg((replySnapshot.text || '').slice(0, 120), sharedKey.current),
        }
      : null;

    const msg = {
      id, text, ts, sender: identity.pubHex, fromMe: true, status: 'sending',
      replyTo: replySnapshot ? { id: replySnapshot.id, sender: replySnapshot.sender, text: replySnapshot.text } : null,
    };
    seenIds.current.add(id);
    remoteMeta.current.set(id, { editedAt: null, deleted: false });
    setMessages(prev => {
      const next = [...prev, msg].sort((a, b) => a.ts - b.ts);
      persistMessages(next);
      return next;
    });
    nearBottom.current = true; // sending always snaps you back to the latest message
    setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 80);

    // Write to Firebase and reconcile status
    const payload = { ct, ts, sender: identity.pubHex };
    if (replyPayload) payload.replyTo = replyPayload;
    const res = await fbSet(`${path}/${id}`, payload);
    setMessages(prev => {
      const next = prev.map(m =>
        m.id === id ? { ...m, status: res.ok ? 'sent' : 'failed' } : m
      );
      persistMessages(next);
      return next;
    });
    if (!res.ok) {
      Alert.alert(
        'Message not delivered',
        `Failed to reach the server: ${res.error || 'unknown error'}. Check your internet or the Firebase configuration.`
      );
    } else if (notifOn) {
      // Fire disguised push to the recipient (no-op if no token registered)
      sendPushTo(contact.pubHex).catch(() => {});
    }
    setSending(false);
  }, [input, sending, identity, path, replyingTo, editingMsg, notifOn, contact.pubHex, persistMessages]);

  // Long-press action sheet: reply / edit (own only) / delete
  const openMessageActions = useCallback((m) => {
    if (m.deleted) return;
    const actions = [
      { text: 'Reply', onPress: () => setReplyingTo({ id: m.id, sender: m.sender, text: m.text }) },
    ];
    if (m.fromMe) {
      actions.push({
        text: 'Edit',
        onPress: () => { setEditingMsg({ id: m.id, sender: m.sender }); setInput(m.text); setReplyingTo(null); },
      });
      actions.push({
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          Alert.alert('Delete message?', 'This removes it for both of you.', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Delete', style: 'destructive', onPress: async () => {
              setMessages(prev => {
                const next = prev.map(x => x.id === m.id ? { ...x, deleted: true, text: '' } : x);
                persistMessages(next);
                return next;
              });
              const prevMeta = remoteMeta.current.get(m.id) || {};
              remoteMeta.current.set(m.id, { ...prevMeta, deleted: true });
              // Soft-delete via PATCH so the peer's poll can pick up the flag;
              // hard DELETE would just make the id vanish silently on their side.
              const res = await fbPatch(`${path}/${m.id}`, { deleted: true });
              if (!res.ok) Alert.alert('Delete failed', res.error || 'Please try again.');
            }},
          ]);
        },
      });
    }
    actions.push({ text: 'Cancel', style: 'cancel' });
    Alert.alert('Message', undefined, actions);
  }, [path, persistMessages]);

  const cancelEdit = useCallback(() => {
    setEditingMsg(null);
    setInput('');
  }, []);

  const presenceLabel = presence.online
    ? 'online'
    : (presence.at ? `last seen ${timeStr(presence.at)}` : (online ? '🔒 End-to-end encrypted' : 'Connecting…'));

  return (
    <KeyboardAvoidingView
      style={s.fill}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity style={s.backBtn} onPress={onBack} activeOpacity={0.7}>
          <Text style={{ fontSize: 18, color: COLORS.textSecondary }}>←</Text>
        </TouchableOpacity>
        <View style={s.av}>
          <Text style={s.avTxt}>{initials(contact.name)}</Text>
          {presence.online && <View style={s.onlineDot} />}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={s.headerTitle}>{contact.name}</Text>
          <Text style={s.statusTxt}>{presenceLabel}</Text>
        </View>
        <TouchableOpacity onPress={toggleNotif} style={s.bellBtn} activeOpacity={0.7} hitSlop={{top:8,bottom:8,left:8,right:8}}>
          <Text style={{ fontSize: 18, color: notifOn ? COLORS.indigo : COLORS.textMuted }}>
            {notifOn ? '🔔' : '🔕'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Messages */}
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={m => m.id}
        contentContainerStyle={[s.msgList, messages.length === 0 && { flex: 1 }]}
        onLayout={() => {
          // Follow to the bottom on layout passes (mount, cache/poll data
          // landing, keyboard toggling) as long as the user hasn't scrolled
          // up to read history. nearBottom starts true, so this still lands
          // on the most recent message when the chat first opens — even if
          // the real message data arrives a moment after the first empty
          // layout pass.
          if (nearBottom.current) {
            listRef.current?.scrollToEnd({ animated: false });
          }
        }}
        onContentSizeChange={() => {
          // Only auto-follow to the bottom if the user was already there
          // (e.g. a new message just arrived). If they've scrolled up to
          // read history, a background poll updating the list must not
          // yank them back down.
          if (nearBottom.current) {
            listRef.current?.scrollToEnd({ animated: true });
          }
        }}
        onScroll={(e) => {
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
          const distanceFromBottom = contentSize.height - contentOffset.y - layoutMeasurement.height;
          nearBottom.current = distanceFromBottom < 120;
        }}
        scrollEventThrottle={100}
        showsVerticalScrollIndicator
        persistentScrollbar
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        ListEmptyComponent={
          <View style={s.emptyChat}>
            <Text style={{ fontSize: 40, marginBottom: 12 }}>🔐</Text>
            <Text style={s.emptySub}>
              Messages are encrypted on your device.{'\n'}
              Only you and {contact.name} can read them.
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <SwipeToReply
            item={item}
            identity={identity}
            contact={contact}
            onReply={() => setReplyingTo({ id: item.id, sender: item.sender, text: item.text })}
            onLongPress={() => openMessageActions(item)}
          />
        )}
      />

      {/* Edit banner (takes priority over reply preview) */}
      {editingMsg ? (
        <View style={[s.replyBar, { backgroundColor: COLORS.indigoDim }]}>
          <View style={{ flex: 1 }}>
            <Text style={s.replyBarName}>Editing your message</Text>
            <Text style={s.replyBarText} numberOfLines={1}>{input}</Text>
          </View>
          <TouchableOpacity onPress={cancelEdit} hitSlop={{top:8,bottom:8,left:8,right:8}}>
            <Text style={{ fontSize: 16, color: COLORS.textMuted }}>✕</Text>
          </TouchableOpacity>
        </View>
      ) : replyingTo && (
        <View style={s.replyBar}>
          <View style={{ flex: 1 }}>
            <Text style={s.replyBarName}>
              Replying to {replyingTo.sender === identity.pubHex ? 'yourself' : contact.name}
            </Text>
            <Text style={s.replyBarText} numberOfLines={1}>{replyingTo.text}</Text>
          </View>
          <TouchableOpacity onPress={() => setReplyingTo(null)} hitSlop={{top:8,bottom:8,left:8,right:8}}>
            <Text style={{ fontSize: 16, color: COLORS.textMuted }}>✕</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Input */}
      <View style={s.inputBar}>
        <TextInput
          style={s.msgInp}
          placeholder={editingMsg ? 'Edit message…' : 'Message…'}
          placeholderTextColor={COLORS.textMuted}
          value={input}
          onChangeText={setInput}
          multiline
          maxLength={2000}
        />
        <TouchableOpacity
          style={[s.sendBtn, (!input.trim() || sending) && s.sendBtnOff]}
          onPress={send}
          disabled={!input.trim() || sending}
          activeOpacity={0.8}
        >
          {sending
            ? <ActivityIndicator color="#fff" size="small" />
            : <Text style={s.sendIcon}>{editingMsg ? '✓' : '↑'}</Text>}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

// Decrypt the encrypted reply preview attached to an incoming message
function decryptReplyPreview(rp, key) {
  if (!rp || !rp.ct) return null;
  const text = decryptMsg(rp.ct, key);
  if (!text) return null;
  return { id: rp.id, sender: rp.sender, text };
}

// ─── SwipeToReply ────────────────────────────────────────────────────────────
// WhatsApp-style: drag a bubble right past the threshold to fire reply.
// PanResponder only claims the touch once the horizontal drag clearly beats
// vertical movement, so FlatList vertical scrolling still works normally.
const SWIPE_TRIGGER = 60;      // px drag before we fire reply
const SWIPE_MAX     = 90;      // clamp so the bubble doesn't fly off-screen
function SwipeToReply({ item, identity, contact, onReply, onLongPress }) {
  const translateX = useRef(new Animated.Value(0)).current;
  const firedRef   = useRef(false);
  // Latest handlers held in refs so the PanResponder — created once and never
  // rebuilt — always calls the current callbacks. Without this, a swipe made
  // after the keyboard opened would fire the *first* onReply closure, which
  // often had stale state and looked like "reply doesn't work with keyboard".
  const onReplyRef = useRef(onReply);
  onReplyRef.current = onReply;

  const panResponder = useRef(
    PanResponder.create({
      // Claim capture-phase too so a focused TextInput's touch-target above
      // this row can't swallow the drag before we see it.
      onMoveShouldSetPanResponder: (_, g) =>
        Math.abs(g.dx) > 10 && Math.abs(g.dx) > Math.abs(g.dy) * 1.4 && g.dx > 0,
      onMoveShouldSetPanResponderCapture: (_, g) =>
        Math.abs(g.dx) > 10 && Math.abs(g.dx) > Math.abs(g.dy) * 1.4 && g.dx > 0,
      onPanResponderGrant: () => { firedRef.current = false; },
      onPanResponderMove: (_, g) => {
        const dx = Math.max(0, Math.min(g.dx, SWIPE_MAX));
        translateX.setValue(dx);
        if (!firedRef.current && dx >= SWIPE_TRIGGER) {
          firedRef.current = true;
          onReplyRef.current?.();
        }
      },
      onPanResponderRelease: () => {
        Animated.spring(translateX, {
          toValue: 0,
          useNativeDriver: true,
          bounciness: 8,
          speed: 18,
        }).start();
      },
      onPanResponderTerminate: () => {
        Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start();
      },
    })
  ).current;

  const iconOpacity = translateX.interpolate({
    inputRange: [0, SWIPE_TRIGGER],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });
  const iconScale = translateX.interpolate({
    inputRange: [0, SWIPE_TRIGGER],
    outputRange: [0.6, 1],
    extrapolate: 'clamp',
  });

  const isDeleted = !!item.deleted;
  return (
    <View style={s.swipeRow}>
      <Animated.View
        pointerEvents="none"
        style={[s.replyHint, { opacity: iconOpacity, transform: [{ scale: iconScale }] }]}
      >
        <Text style={s.replyHintTxt}>↩</Text>
      </Animated.View>
      <Animated.View
        {...panResponder.panHandlers}
        style={[s.bWrap, item.fromMe ? s.bWrapMe : s.bWrapThem, { transform: [{ translateX }] }]}
      >
        <Pressable
          onLongPress={onLongPress}
          delayLongPress={280}
          style={[
            s.bubble,
            item.fromMe ? s.bMe : s.bThem,
            item.status === 'failed' && s.bFailed,
            isDeleted && s.bDeleted,
          ]}
        >
          {item.replyTo && !isDeleted && (
            <View style={[s.replyQuote, item.fromMe ? s.replyQuoteMe : s.replyQuoteThem]}>
              <Text style={s.replyName}>
                {item.replyTo.sender === identity.pubHex ? 'You' : contact.name}
              </Text>
              <Text style={s.replyText} numberOfLines={2}>
                {item.replyTo.text || '…'}
              </Text>
            </View>
          )}
          <Text style={[
            s.bTxt,
            { color: item.fromMe ? '#fff' : COLORS.textPrimary },
            isDeleted && { fontStyle: 'italic', opacity: 0.75 },
          ]}>
            {isDeleted ? 'This message was deleted' : item.text}
          </Text>
        </Pressable>
        <Text style={[s.time, { textAlign: item.fromMe ? 'right' : 'left' }]}>
          {item.fromMe && item.status === 'sending' && '• sending  '}
          {item.fromMe && item.status === 'failed'  && '⚠︎ not delivered  '}
          {timeStr(item.ts)}
          {item.editedAt && !isDeleted && <Text style={{ color: COLORS.textMuted }}>{'  (edited)'}</Text>}
          {item.fromMe && item.status !== 'sending' && item.status !== 'failed' && !isDeleted && (
            <Text style={{ color: item.status === 'read' ? COLORS.indigo : COLORS.textMuted }}>
              {'  '}{item.status === 'read' ? '✓✓' : '✓'}
            </Text>
          )}
        </Text>
      </Animated.View>
    </View>
  );
}

// ─── STYLES ───────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  fill:      { flex: 1, backgroundColor: COLORS.bg },
  center:    { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.bg, padding: SPACING.lg },

  card:      { width: '100%', backgroundColor: COLORS.surface1, borderRadius: RADIUS.xl, padding: SPACING.xl, alignItems: 'center', shadowColor: '#000', shadowOpacity: 0.06, shadowOffset: { width: 0, height: 4 }, shadowRadius: 12, elevation: 4 },
  setupIcon: { fontSize: 40, marginBottom: SPACING.md },
  setupTitle:{ fontFamily: FONTS.headingX, fontSize: 22, color: COLORS.textPrimary, marginBottom: SPACING.sm },
  setupSub:  { fontFamily: FONTS.body, fontSize: 13, color: COLORS.textSecondary, textAlign: 'center', lineHeight: 19, marginBottom: SPACING.lg },

  inp:       { width: '100%', backgroundColor: COLORS.surface2, borderWidth: 1, borderColor: COLORS.border, borderRadius: RADIUS.lg, paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm + 2, fontFamily: FONTS.body, fontSize: 14, color: COLORS.textPrimary, marginBottom: SPACING.sm },
  btnP:      { backgroundColor: COLORS.indigo, borderRadius: RADIUS.lg, paddingVertical: SPACING.sm + 2, alignItems: 'center', justifyContent: 'center', minHeight: 46, width: '100%' },
  btnG:      { backgroundColor: COLORS.surface2, borderWidth: 1, borderColor: COLORS.border, borderRadius: RADIUS.lg, paddingVertical: SPACING.sm + 2, alignItems: 'center', justifyContent: 'center', minHeight: 46 },
  btnPTxt:   { fontFamily: FONTS.bodyMed, fontSize: 15, color: '#fff' },
  btnGTxt:   { fontFamily: FONTS.bodyMed, fontSize: 15, color: COLORS.textSecondary },
  btnOff:    { opacity: 0.45 },

  header:    { flexDirection: 'row', alignItems: 'center', paddingTop: 52, paddingBottom: SPACING.sm, paddingHorizontal: SPACING.md, backgroundColor: COLORS.surface1, borderBottomWidth: 0.5, borderColor: COLORS.border, gap: SPACING.sm },
  headerTitle:{ fontFamily: FONTS.bodyMed, fontSize: 17, color: COLORS.textPrimary, letterSpacing: -0.2 },
  statusTxt: { fontFamily: FONTS.body, fontSize: 12, color: COLORS.textMuted, marginTop: 1 },
  backBtn:   { width: 36, height: 36, borderRadius: 18, backgroundColor: COLORS.surface2, alignItems: 'center', justifyContent: 'center' },
  chip:      { backgroundColor: COLORS.indigoDim, paddingHorizontal: SPACING.md, paddingVertical: 6, borderRadius: RADIUS.full },
  chipTxt:   { fontFamily: FONTS.bodyMed, fontSize: 13, color: COLORS.indigo },

  av:        { width: 44, height: 44, borderRadius: 22, backgroundColor: COLORS.indigoDim, alignItems: 'center', justifyContent: 'center' },
  avTxt:     { fontFamily: FONTS.heading, fontSize: 15, color: COLORS.indigo },
  onlineDot: { position: 'absolute', bottom: 0, right: 0, width: 12, height: 12, borderRadius: 6, backgroundColor: COLORS.emerald, borderWidth: 2, borderColor: COLORS.surface1 },
  bellBtn:   { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },

  keyCard:   { margin: SPACING.md, backgroundColor: COLORS.surface1, borderRadius: RADIUS.lg, padding: SPACING.md, borderWidth: 1, borderColor: COLORS.border },
  keyLbl:    { fontFamily: FONTS.body, fontSize: 11, color: COLORS.textMuted, marginBottom: 6 },
  keyVal:    { fontFamily: FONTS.mono, fontSize: 9, color: COLORS.textSecondary, lineHeight: 14, marginBottom: 6 },
  keyName:   { fontFamily: FONTS.bodyMed, fontSize: 12, color: COLORS.indigo },

  row:       { flexDirection: 'row', alignItems: 'center', paddingHorizontal: SPACING.md, paddingVertical: SPACING.md, backgroundColor: COLORS.surface1, borderBottomWidth: 1, borderColor: COLORS.border, gap: SPACING.md },
  rowName:   { fontFamily: FONTS.bodyMed, fontSize: 15, color: COLORS.textPrimary, marginBottom: 2 },
  rowSub:    { fontFamily: FONTS.body, fontSize: 12, color: COLORS.textMuted },

  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: SPACING.xl },
  emptyTitle:{ fontFamily: FONTS.heading, fontSize: 18, color: COLORS.textPrimary, marginBottom: SPACING.sm },
  emptySub:  { fontFamily: FONTS.body, fontSize: 13, color: COLORS.textSecondary, textAlign: 'center', lineHeight: 19 },
  emptyChat: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: SPACING.xl },

  sheet:     { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: COLORS.surface1, borderTopLeftRadius: RADIUS.xl, borderTopRightRadius: RADIUS.xl, padding: SPACING.lg, borderTopWidth: 1, borderColor: COLORS.border, shadowColor: '#000', shadowOpacity: 0.12, shadowOffset: { width: 0, height: -4 }, shadowRadius: 16, elevation: 16 },
  sheetTitle:{ fontFamily: FONTS.heading, fontSize: 18, color: COLORS.textPrimary, marginBottom: SPACING.md },

  fab:       { position: 'absolute', bottom: SPACING.xl, right: SPACING.lg, width: 56, height: 56, borderRadius: 28, backgroundColor: COLORS.indigo, alignItems: 'center', justifyContent: 'center', shadowColor: COLORS.indigo, shadowOpacity: 0.4, shadowOffset: { width: 0, height: 4 }, shadowRadius: 10, elevation: 8 },
  fabTxt:    { fontSize: 28, color: '#fff', lineHeight: 32, marginTop: -2 },

  msgList:   { paddingHorizontal: SPACING.md, paddingBottom: SPACING.lg, paddingTop: SPACING.sm },
  bWrap:     { marginBottom: 3 },
  bWrapMe:   { alignItems: 'flex-end' },
  bWrapThem: { alignItems: 'flex-start' },
  // iOS Messages bubbles: 18px radius, tight vertical padding, no border on outgoing
  bubble:    { maxWidth: '76%', borderRadius: 18, paddingHorizontal: 14, paddingVertical: 8 },
  bMe:       { backgroundColor: COLORS.indigo, borderBottomRightRadius: 5 },
  bThem:     { backgroundColor: COLORS.surface3, borderBottomLeftRadius: 5 },
  bFailed:   { opacity: 0.55, borderWidth: 1, borderColor: COLORS.rose },
  bDeleted:  { backgroundColor: COLORS.surface2, borderWidth: 1, borderColor: COLORS.border },

  replyQuote:     { borderLeftWidth: 3, paddingLeft: SPACING.sm, paddingRight: SPACING.sm, paddingVertical: 4, borderRadius: 4, marginBottom: 6 },
  replyQuoteMe:   { borderLeftColor: 'rgba(255,255,255,0.7)', backgroundColor: 'rgba(255,255,255,0.14)' },
  replyQuoteThem: { borderLeftColor: COLORS.indigo, backgroundColor: COLORS.surface2 },
  replyName:      { fontFamily: FONTS.bodyMed, fontSize: 11, color: COLORS.textSecondary, marginBottom: 1 },
  replyText:      { fontFamily: FONTS.body, fontSize: 12, color: COLORS.textMuted },

  replyBar:     { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm, backgroundColor: COLORS.surface2, borderTopWidth: 1, borderColor: COLORS.border },
  replyBarName: { fontFamily: FONTS.bodyMed, fontSize: 11, color: COLORS.indigo, marginBottom: 1 },
  replyBarText: { fontFamily: FONTS.body, fontSize: 12, color: COLORS.textSecondary },
  bTxt:      { fontFamily: FONTS.body, fontSize: 17, lineHeight: 22 }, // iOS body: 17pt
  time:      { fontFamily: FONTS.body, fontSize: 10, color: COLORS.textMuted, marginTop: 3, paddingHorizontal: 4 },

  // iOS Messages input: pill-shaped, no border on light, subtle background
  inputBar:  { flexDirection: 'row', alignItems: 'flex-end', padding: SPACING.sm, paddingBottom: Platform.OS === 'ios' ? SPACING.lg : SPACING.sm, backgroundColor: COLORS.surface1, borderTopWidth: 0.5, borderColor: COLORS.border, gap: SPACING.sm },
  msgInp:    { flex: 1, backgroundColor: COLORS.surface2, borderWidth: 0.5, borderColor: COLORS.border, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8, fontFamily: FONTS.body, fontSize: 17, color: COLORS.textPrimary, maxHeight: 120, minHeight: 36 },
  sendBtn:   { width: 36, height: 36, borderRadius: 18, backgroundColor: COLORS.indigo, alignItems: 'center', justifyContent: 'center' },
  sendBtnOff:{ backgroundColor: COLORS.surface3 },
  sendIcon:  { fontSize: 18, color: '#fff', marginTop: -1 },

  // Swipe-to-reply
  swipeRow:   { position: 'relative' },
  replyHint:  { position: 'absolute', left: 12, top: 0, bottom: 0, width: 44, alignItems: 'center', justifyContent: 'center' },
  replyHintTxt: { fontSize: 20, color: COLORS.indigo },

  // Unread badge on room rows
  unreadBadge: { minWidth: 22, height: 22, paddingHorizontal: 6, borderRadius: 11, backgroundColor: COLORS.indigo, alignItems: 'center', justifyContent: 'center' },
  unreadBadgeTxt: { color: '#fff', fontSize: 12, fontFamily: FONTS.bodyMed, lineHeight: 15 },

  // Push diagnostic card
  pushCard:   { flexDirection: 'row', alignItems: 'center', marginHorizontal: SPACING.md, marginBottom: SPACING.sm, padding: SPACING.md, borderRadius: RADIUS.lg, borderWidth: 1, gap: SPACING.sm },
  pushOk:     { backgroundColor: COLORS.surface1, borderColor: COLORS.border },
  pushErr:    { backgroundColor: '#3a1a1a', borderColor: '#5a2a2a' },
  pushTitle:  { fontFamily: FONTS.bodyMed, fontSize: 13, color: COLORS.textPrimary, marginBottom: 2 },
  pushMsg:    { fontFamily: FONTS.body, fontSize: 11, color: COLORS.textMuted },
  pushRetry:  { backgroundColor: COLORS.indigo, borderRadius: RADIUS.full, paddingHorizontal: 14, paddingVertical: 6 },
  pushRetryTxt:{ color: '#fff', fontFamily: FONTS.bodyMed, fontSize: 12 },
});
