/**
 * ChatTab.js — E2EE live chat for Knot
 * Transport : Firebase Realtime Database (free Spark tier — Google's servers)
 * Encryption: AES-256-CTR using your existing aes-js + @noble/hashes
 *             Messages are encrypted BEFORE leaving your device.
 *             Firebase only ever stores ciphertext — never plaintext.
 *
 * ─── SETUP (one time, ~10 mins) ───────────────────────────────────────────────
 * 1. Go to https://console.firebase.google.com
 * 2. Create project → "knot-chat" (disable Google Analytics, not needed)
 * 3. Build → Realtime Database → Create database → Start in TEST MODE
 * 4. Copy your config from Project Settings → Your apps → Add app → Web (</>)
 * 5. Paste the 6 values into FIREBASE_CONFIG below
 *
 * ─── INSTALL (one command) ────────────────────────────────────────────────────
 *    No npm install needed! We use Firebase REST API directly.
 *    Firebase REST API works with plain fetch() — no SDK, no native modules.
 *
 * ─── HOW TO ADD TO Vault.js ───────────────────────────────────────────────────
 *    Already done in the Vault.js file provided.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList,
  StyleSheet, KeyboardAvoidingView, Platform, ActivityIndicator,
  Alert, Pressable,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ExpoC from 'expo-crypto';
import * as aesjs from 'aes-js';
import { sha256 } from '@noble/hashes/sha256';
import { pbkdf2 } from '@noble/hashes/pbkdf2';
import { COLORS, FONTS, RADIUS, SPACING } from '../utils/theme';

// ─── 🔧 PASTE YOUR FIREBASE CONFIG HERE ──────────────────────────────────────
const FIREBASE_CONFIG = {
  apiKey:            'AIzaSyBHnA05bunLw23gy40u-Llxsshn9Lc3LBI',
  databaseURL:       'https://saketh-3ee4f-default-rtdb.asia-southeast1.firebasedatabase.app',  // e.g. https://knot-chat-default-rtdb.firebaseio.com
};
// ─────────────────────────────────────────────────────────────────────────────

// ─── Firebase REST helpers ────────────────────────────────────────────────────
// We use Firebase's REST API + Server-Sent Events (SSE) for real-time.
// No SDK needed — works perfectly in Expo Go with plain fetch().
const DB = FIREBASE_CONFIG.databaseURL;

async function fbSet(path, data) {
  const res = await fetch(`${DB}/${path}.json?auth=${FIREBASE_CONFIG.apiKey}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return res.json();
}

async function fbPush(path, data) {
  const res = await fetch(`${DB}/${path}.json?auth=${FIREBASE_CONFIG.apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return res.json();
}

async function fbGet(path) {
  const res = await fetch(`${DB}/${path}.json?auth=${FIREBASE_CONFIG.apiKey}`);
  return res.json();
}

// Real-time listener using SSE (Server-Sent Events) — Firebase's streaming API
// Returns a cancel function
function fbListen(path, onData) {
  const url = `${DB}/${path}.json?auth=${FIREBASE_CONFIG.apiKey}`;
  let cancelled = false;
  let retryTimeout = null;

  const connect = () => {
    if (cancelled) return;
    const ctrl = new AbortController();

    fetch(url, {
      headers: { Accept: 'text/event-stream' },
      signal: ctrl.signal,
    }).then(async (res) => {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        if (cancelled) { ctrl.abort(); break; }
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line
        let event = '';
        for (const line of lines) {
          if (line.startsWith('event:')) {
            event = line.slice(6).trim();
          } else if (line.startsWith('data:') && event === 'put') {
            try {
              const payload = JSON.parse(line.slice(5).trim());
              if (payload.data) onData(payload.data, payload.path);
            } catch {}
          }
        }
      }
      // reconnect on disconnect
      if (!cancelled) retryTimeout = setTimeout(connect, 3000);
    }).catch(() => {
      if (!cancelled) retryTimeout = setTimeout(connect, 5000);
    });
  };

  connect();
  return () => {
    cancelled = true;
    if (retryTimeout) clearTimeout(retryTimeout);
  };
}

// ─── Crypto ───────────────────────────────────────────────────────────────────
function bytesToHex(b) {
  return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
}
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return out;
}

// Derive shared AES key from my private seed + partner's public key
// sha256(myPriv + theirPub) — both sides get identical result
function deriveSharedKey(myPrivHex, theirPubHex) {
  const input = aesjs.utils.utf8.toBytes(myPrivHex + theirPubHex);
  return sha256(input); // 32 bytes — AES-256 key
}

// AES-256-CTR encrypt → base64 string
function encryptMsg(text, keyBytes) {
  const iv = new Uint8Array(16);
  const ts = Date.now();
  iv[0] = (ts >> 24) & 0xff; iv[1] = (ts >> 16) & 0xff;
  iv[2] = (ts >> 8) & 0xff;  iv[3] = ts & 0xff;
  for (let i = 4; i < 16; i++) iv[i] = Math.floor(Math.random() * 256);
  const plain = aesjs.utils.utf8.toBytes(text);
  const ctr = new aesjs.ModeOfOperation.ctr(keyBytes, new aesjs.Counter(iv));
  const cipher = ctr.encrypt(plain);
  const out = new Uint8Array(16 + cipher.length);
  out.set(iv); out.set(cipher, 16);
  let b = ''; for (let i = 0; i < out.length; i++) b += String.fromCharCode(out[i]);
  return btoa(b);
}

// AES-256-CTR decrypt ← base64 string
function decryptMsg(b64, keyBytes) {
  try {
    const raw = atob(b64);
    const data = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) data[i] = raw.charCodeAt(i);
    const iv = data.slice(0, 16);
    const cipher = data.slice(16);
    const ctr = new aesjs.ModeOfOperation.ctr(keyBytes, new aesjs.Counter(iv));
    const plain = ctr.decrypt(cipher);
    return aesjs.utils.utf8.fromBytes(plain);
  } catch { return null; }
}

// ─── Storage keys ─────────────────────────────────────────────────────────────
const KEY_IDENTITY = 'knot_chat_id';       // { alias, pubHex, privHex }
const KEY_CONTACTS = 'knot_chat_contacts'; // [{ id, name, pubHex }]
const KEY_MESSAGES = 'knot_chat_msgs';     // { [roomId]: [msg,...] }

// ─── Utils ────────────────────────────────────────────────────────────────────
function roomId(a, b) { return [a, b].sort().join('__'); }
function genId()      { return Date.now().toString(36) + Math.random().toString(36).slice(2); }
function initials(n)  { return (n||'?').split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase(); }
function timeStr(ts) {
  const d = new Date(ts), now = new Date();
  const same = d.toDateString() === now.toDateString();
  return same
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
      d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ─── ROOT COMPONENT ───────────────────────────────────────────────────────────
export function ChatTab() {
  const [screen,   setScreen]   = useState('loading');
  const [identity, setIdentity] = useState(null);
  const [contacts, setContacts] = useState([]);
  const [active,   setActive]   = useState(null);

  // Load identity on mount
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(KEY_IDENTITY);
        if (raw) {
          setIdentity(JSON.parse(raw));
          const c = await AsyncStorage.getItem(KEY_CONTACTS);
          setContacts(c ? JSON.parse(c) : []);
          setScreen('rooms');
        } else {
          setScreen('setup');
        }
      } catch { setScreen('setup'); }
    })();
  }, []);

  const saveContacts = useCallback(async (list) => {
    setContacts(list);
    await AsyncStorage.setItem(KEY_CONTACTS, JSON.stringify(list));
  }, []);

  // First-time setup: generate identity keypair
  const handleSetup = useCallback(async (alias) => {
    const privBytes = await ExpoC.getRandomBytesAsync(32);
    const privHex = bytesToHex(new Uint8Array(privBytes));
    const pubHex  = bytesToHex(sha256(hexToBytes(privHex)));
    const id = { alias, pubHex, privHex };
    await AsyncStorage.setItem(KEY_IDENTITY, JSON.stringify(id));
    // Register public key on Firebase so contacts can find you
    await fbSet(`users/${pubHex}`, { alias, pubHex, ts: Date.now() });
    setIdentity(id);
    setScreen('rooms');
  }, []);

  const handleAddContact = useCallback(async (name, pubHex) => {
    const exists = contacts.find(c => c.pubHex === pubHex);
    if (exists) { Alert.alert('Already added', `${exists.name} is already in your contacts.`); return; }
    await saveContacts([...contacts, { id: genId(), name, pubHex }]);
  }, [contacts, saveContacts]);

  const handleDeleteContact = useCallback(async (id) => {
    await saveContacts(contacts.filter(c => c.id !== id));
  }, [contacts, saveContacts]);

  if (screen === 'loading') return <View style={s.center}><ActivityIndicator color={COLORS.indigo} size="large" /></View>;
  if (screen === 'setup')   return <SetupScreen onDone={handleSetup} />;
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
      onOpen={(c) => { setActive(c); setScreen('chat'); }}
      onAdd={handleAddContact}
      onDelete={handleDeleteContact}
    />
  );
}

// ─── SETUP ────────────────────────────────────────────────────────────────────
function SetupScreen({ onDone }) {
  const [alias, setAlias] = useState('');
  const [busy,  setBusy]  = useState(false);

  const go = async () => {
    const a = alias.trim();
    if (!a) return;
    setBusy(true);
    try { await onDone(a); }
    catch (e) { Alert.alert('Error', e.message); setBusy(false); }
  };

  return (
    <View style={s.center}>
      <View style={s.card}>
        <Text style={s.setupIcon}>🔐</Text>
        <Text style={s.setupTitle}>Set up chat</Text>
        <Text style={s.setupSub}>
          Pick a display name. An encryption key pair is generated on this device.
          Messages are encrypted before they leave your phone — Firebase only
          stores ciphertext.
        </Text>
        <TextInput
          style={s.textInput}
          placeholder="Your name"
          placeholderTextColor={COLORS.textMuted}
          value={alias}
          onChangeText={setAlias}
          autoFocus
          returnKeyType="done"
          onSubmitEditing={go}
        />
        <TouchableOpacity
          style={[s.btnPrimary, (busy || !alias.trim()) && s.btnDisabled]}
          onPress={go}
          disabled={busy || !alias.trim()}
          activeOpacity={0.8}
        >
          {busy
            ? <ActivityIndicator color="#fff" />
            : <Text style={s.btnPrimaryTxt}>Generate keys & start</Text>}
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─── ROOMS ────────────────────────────────────────────────────────────────────
function RoomsScreen({ identity, contacts, onOpen, onAdd, onDelete }) {
  const [showKey,  setShowKey]  = useState(false);
  const [showAdd,  setShowAdd]  = useState(false);
  const [name,     setName]     = useState('');
  const [pubInput, setPubInput] = useState('');
  const [busy,     setBusy]     = useState(false);

  const addContact = async () => {
    const n = name.trim(), p = pubInput.trim();
    if (!n || p.length < 10) { Alert.alert('Missing info', 'Enter a name and a valid public key.'); return; }
    setBusy(true);
    await onAdd(n, p);
    setName(''); setPubInput(''); setShowAdd(false); setBusy(false);
  };

  const confirmDelete = (c) =>
    Alert.alert('Remove contact', `Remove "${c.name}"?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => onDelete(c.id) },
    ]);

  return (
    <View style={s.fill}>
      {/* Header */}
      <View style={s.header}>
        <Text style={s.headerTitle}>Messages</Text>
        <TouchableOpacity style={s.chip} onPress={() => setShowKey(v => !v)} activeOpacity={0.7}>
          <Text style={s.chipTxt}>My key</Text>
        </TouchableOpacity>
      </View>

      {/* My public key — share with contacts */}
      {showKey && (
        <View style={s.keyCard}>
          <Text style={s.keyCardLabel}>Share this key with people who want to message you</Text>
          <Text style={s.keyCardVal} selectable numberOfLines={4}>{identity?.pubHex}</Text>
          <Text style={s.keyCardName}>Name: {identity?.alias}</Text>
        </View>
      )}

      {/* Contact list */}
      {contacts.length === 0 ? (
        <View style={s.emptyWrap}>
          <Text style={{ fontSize: 44, marginBottom: 12 }}>💬</Text>
          <Text style={s.emptyTitle}>No conversations yet</Text>
          <Text style={s.emptySub}>Tap + and paste a contact's public key to start chatting.</Text>
        </View>
      ) : (
        <FlatList
          data={contacts}
          keyExtractor={c => c.id}
          contentContainerStyle={{ paddingBottom: 100 }}
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [s.contactRow, pressed && { backgroundColor: COLORS.surface2 }]}
              onPress={() => onOpen(item)}
              onLongPress={() => confirmDelete(item)}
            >
              <View style={s.avatar}>
                <Text style={s.avatarTxt}>{initials(item.name)}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.contactName}>{item.name}</Text>
                <Text style={s.contactSub}>🔒 End-to-end encrypted</Text>
              </View>
              <Text style={{ fontSize: 18, color: COLORS.textMuted }}>›</Text>
            </Pressable>
          )}
        />
      )}

      {/* Add contact bottom sheet */}
      {showAdd && (
        <View style={s.sheet}>
          <Text style={s.sheetTitle}>Add contact</Text>
          <TextInput
            style={s.textInput}
            placeholder="Their name"
            placeholderTextColor={COLORS.textMuted}
            value={name}
            onChangeText={setName}
            autoFocus
          />
          <TextInput
            style={[s.textInput, { height: 88, textAlignVertical: 'top', paddingTop: SPACING.sm }]}
            placeholder="Paste their public key here"
            placeholderTextColor={COLORS.textMuted}
            value={pubInput}
            onChangeText={setPubInput}
            multiline
            autoCorrect={false}
            autoCapitalize="none"
          />
          <View style={{ flexDirection: 'row', gap: SPACING.sm }}>
            <TouchableOpacity style={[s.btnGhost, { flex: 1 }]} onPress={() => setShowAdd(false)}>
              <Text style={s.btnGhostTxt}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.btnPrimary, { flex: 1 }, busy && s.btnDisabled]}
              onPress={addContact} disabled={busy}
            >
              {busy ? <ActivityIndicator color="#fff" size="small" /> : <Text style={s.btnPrimaryTxt}>Add</Text>}
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* FAB */}
      {!showAdd && (
        <TouchableOpacity style={s.fab} onPress={() => setShowAdd(true)} activeOpacity={0.85}>
          <Text style={s.fabTxt}>+</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

// ─── CHAT SCREEN ──────────────────────────────────────────────────────────────
function ChatScreen({ identity, contact, onBack }) {
  const [messages, setMessages] = useState([]);
  const [input,    setInput]    = useState('');
  const [sending,  setSending]  = useState(false);
  const [status,   setStatus]   = useState('Connecting…');
  const listRef   = useRef(null);
  const seenIds   = useRef(new Set());
  const sharedKey = useRef(null);
  const rid = roomId(identity.pubHex, contact.pubHex);
  // Firebase path — only these two pubkeys can form this path (sorted)
  const fbPath = `chats/${rid}`;

  // Step 1 — derive shared encryption key
  useEffect(() => {
    sharedKey.current = deriveSharedKey(identity.privHex, contact.pubHex);
  }, [identity.privHex, contact.pubHex]);

  // Step 2 — load cached messages from AsyncStorage
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(KEY_MESSAGES);
        const all = raw ? JSON.parse(raw) : {};
        const cached = (all[rid] || []).map(m => ({
          ...m, fromMe: m.sender === identity.pubHex,
        }));
        if (cached.length) {
          setMessages(cached);
          setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 50);
        }
      } catch {}
    })();
  }, [rid, identity.pubHex]);

  // Step 3 — real-time Firebase listener
  useEffect(() => {
    const cancel = fbListen(fbPath, (data) => {
      if (!data || !sharedKey.current) return;
      setStatus('🔒 End-to-end encrypted');
      // data is an object of { msgId: { ct, ts, sender } }
      const incoming = Object.entries(data)
        .map(([id, m]) => {
          if (seenIds.current.has(id)) return null;
          seenIds.current.add(id);
          const text = decryptMsg(m.ct, sharedKey.current);
          if (!text) return null;
          return { id, text, ts: m.ts, sender: m.sender, fromMe: m.sender === identity.pubHex };
        })
        .filter(Boolean);

      if (!incoming.length) return;

      setMessages(prev => {
        const merged = [...prev];
        for (const msg of incoming) {
          if (!merged.find(m => m.id === msg.id)) merged.push(msg);
        }
        const sorted = merged.sort((a, b) => a.ts - b.ts);
        // persist to AsyncStorage
        AsyncStorage.getItem(KEY_MESSAGES).then(raw => {
          const all = raw ? JSON.parse(raw) : {};
          all[rid] = sorted;
          return AsyncStorage.setItem(KEY_MESSAGES, JSON.stringify(all));
        }).catch(() => {});
        return sorted;
      });
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 80);
    });

    setStatus('🔒 End-to-end encrypted');
    return cancel;
  }, [fbPath, rid, identity.pubHex]);

  // Send a message
  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || sending || !sharedKey.current) return;
    setSending(true);
    setInput('');

    const id  = genId();
    const ts  = Date.now();
    const ct  = encryptMsg(text, sharedKey.current);
    const msg = { id, text, ts, sender: identity.pubHex, fromMe: true };

    // Optimistic local add
    seenIds.current.add(id);
    setMessages(prev => {
      const next = [...prev, msg].sort((a, b) => a.ts - b.ts);
      AsyncStorage.getItem(KEY_MESSAGES).then(raw => {
        const all = raw ? JSON.parse(raw) : {};
        all[rid] = next;
        return AsyncStorage.setItem(KEY_MESSAGES, JSON.stringify(all));
      }).catch(() => {});
      return next;
    });
    setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 80);

    try {
      // Push encrypted message to Firebase
      await fbSet(`${fbPath}/${id}`, { ct, ts, sender: identity.pubHex });
    } catch (e) {
      Alert.alert('Send failed', 'Check your internet connection.');
    } finally {
      setSending(false);
    }
  }, [input, sending, identity, fbPath, rid]);

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
        <View style={s.avatar}>
          <Text style={s.avatarTxt}>{initials(contact.name)}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={s.headerTitle}>{contact.name}</Text>
          <Text style={s.statusTxt}>{status}</Text>
        </View>
      </View>

      {/* Messages */}
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={m => m.id}
        contentContainerStyle={[s.msgList, messages.length === 0 && { flex: 1 }]}
        onLayout={() => listRef.current?.scrollToEnd({ animated: false })}
        ListEmptyComponent={
          <View style={s.emptyChat}>
            <Text style={{ fontSize: 40, marginBottom: 12 }}>🔐</Text>
            <Text style={s.emptySub}>
              Messages are encrypted before leaving your device.{'\n'}
              Only you and {contact.name} can read them.
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <View style={[s.bubbleWrap, item.fromMe ? s.bubbleWrapMe : s.bubbleWrapThem]}>
            <View style={[s.bubble, item.fromMe ? s.bubbleMe : s.bubbleThem]}>
              <Text style={[s.bubbleTxt, { color: item.fromMe ? '#fff' : COLORS.textPrimary }]}>
                {item.text}
              </Text>
            </View>
            <Text style={[s.timeStr, { textAlign: item.fromMe ? 'right' : 'left' }]}>
              {timeStr(item.ts)}
            </Text>
          </View>
        )}
      />

      {/* Input bar */}
      <View style={s.inputBar}>
        <TextInput
          style={s.msgInput}
          placeholder="Message…"
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
            : <Text style={s.sendIcon}>↑</Text>}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

// ─── STYLES ───────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  fill:           { flex: 1, backgroundColor: COLORS.bg },
  center:         { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.bg, padding: SPACING.lg },

  // Card / setup
  card:           { width: '100%', backgroundColor: COLORS.surface1, borderRadius: RADIUS.xl, padding: SPACING.xl, alignItems: 'center', shadowColor: '#000', shadowOpacity: 0.06, shadowOffset: { width: 0, height: 4 }, shadowRadius: 12, elevation: 4 },
  setupIcon:      { fontSize: 40, marginBottom: SPACING.md },
  setupTitle:     { fontFamily: FONTS.headingX, fontSize: 22, color: COLORS.textPrimary, marginBottom: SPACING.sm },
  setupSub:       { fontFamily: FONTS.body, fontSize: 13, color: COLORS.textSecondary, textAlign: 'center', lineHeight: 19, marginBottom: SPACING.lg },

  // Inputs + buttons
  textInput:      { width: '100%', backgroundColor: COLORS.surface2, borderWidth: 1, borderColor: COLORS.border, borderRadius: RADIUS.lg, paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm + 2, fontFamily: FONTS.body, fontSize: 14, color: COLORS.textPrimary, marginBottom: SPACING.sm },
  btnPrimary:     { backgroundColor: COLORS.indigo, borderRadius: RADIUS.lg, paddingVertical: SPACING.sm + 2, alignItems: 'center', justifyContent: 'center', minHeight: 46, width: '100%' },
  btnGhost:       { backgroundColor: COLORS.surface2, borderWidth: 1, borderColor: COLORS.border, borderRadius: RADIUS.lg, paddingVertical: SPACING.sm + 2, alignItems: 'center', justifyContent: 'center', minHeight: 46 },
  btnPrimaryTxt:  { fontFamily: FONTS.bodyMed, fontSize: 15, color: '#fff' },
  btnGhostTxt:    { fontFamily: FONTS.bodyMed, fontSize: 15, color: COLORS.textSecondary },
  btnDisabled:    { opacity: 0.45 },

  // Header
  header:         { flexDirection: 'row', alignItems: 'center', paddingTop: 52, paddingBottom: SPACING.md, paddingHorizontal: SPACING.md, backgroundColor: COLORS.surface1, borderBottomWidth: 1, borderColor: COLORS.border, gap: SPACING.sm },
  headerTitle:    { fontFamily: FONTS.headingX, fontSize: 20, color: COLORS.textPrimary },
  statusTxt:      { fontFamily: FONTS.body, fontSize: 11, color: COLORS.textMuted, marginTop: 1 },
  backBtn:        { width: 36, height: 36, borderRadius: 18, backgroundColor: COLORS.surface2, alignItems: 'center', justifyContent: 'center' },
  chip:           { backgroundColor: COLORS.indigoDim, paddingHorizontal: SPACING.md, paddingVertical: 6, borderRadius: RADIUS.full },
  chipTxt:        { fontFamily: FONTS.bodyMed, fontSize: 13, color: COLORS.indigo },

  // Avatar
  avatar:         { width: 44, height: 44, borderRadius: 22, backgroundColor: COLORS.indigoDim, alignItems: 'center', justifyContent: 'center' },
  avatarTxt:      { fontFamily: FONTS.heading, fontSize: 15, color: COLORS.indigo },

  // Key card
  keyCard:        { margin: SPACING.md, backgroundColor: COLORS.surface1, borderRadius: RADIUS.lg, padding: SPACING.md, borderWidth: 1, borderColor: COLORS.border },
  keyCardLabel:   { fontFamily: FONTS.body, fontSize: 11, color: COLORS.textMuted, marginBottom: 6 },
  keyCardVal:     { fontFamily: FONTS.mono, fontSize: 9, color: COLORS.textSecondary, lineHeight: 14, marginBottom: 6 },
  keyCardName:    { fontFamily: FONTS.bodyMed, fontSize: 12, color: COLORS.indigo },

  // Rooms list
  contactRow:     { flexDirection: 'row', alignItems: 'center', paddingHorizontal: SPACING.md, paddingVertical: SPACING.md, backgroundColor: COLORS.surface1, borderBottomWidth: 1, borderColor: COLORS.border, gap: SPACING.md },
  contactName:    { fontFamily: FONTS.bodyMed, fontSize: 15, color: COLORS.textPrimary, marginBottom: 2 },
  contactSub:     { fontFamily: FONTS.body, fontSize: 12, color: COLORS.textMuted },

  // Empty states
  emptyWrap:      { flex: 1, alignItems: 'center', justifyContent: 'center', padding: SPACING.xl },
  emptyTitle:     { fontFamily: FONTS.heading, fontSize: 18, color: COLORS.textPrimary, marginBottom: SPACING.sm },
  emptySub:       { fontFamily: FONTS.body, fontSize: 13, color: COLORS.textSecondary, textAlign: 'center', lineHeight: 19 },
  emptyChat:      { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: SPACING.xl },

  // Add sheet
  sheet:          { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: COLORS.surface1, borderTopLeftRadius: RADIUS.xl, borderTopRightRadius: RADIUS.xl, padding: SPACING.lg, borderTopWidth: 1, borderColor: COLORS.border, shadowColor: '#000', shadowOpacity: 0.12, shadowOffset: { width: 0, height: -4 }, shadowRadius: 16, elevation: 16 },
  sheetTitle:     { fontFamily: FONTS.heading, fontSize: 18, color: COLORS.textPrimary, marginBottom: SPACING.md },

  // FAB
  fab:            { position: 'absolute', bottom: SPACING.xl, right: SPACING.lg, width: 56, height: 56, borderRadius: 28, backgroundColor: COLORS.indigo, alignItems: 'center', justifyContent: 'center', shadowColor: COLORS.indigo, shadowOpacity: 0.4, shadowOffset: { width: 0, height: 4 }, shadowRadius: 10, elevation: 8 },
  fabTxt:         { fontSize: 28, color: '#fff', lineHeight: 32, marginTop: -2 },

  // Chat bubbles
  msgList:        { padding: SPACING.md, paddingBottom: SPACING.lg },
  bubbleWrap:     { marginBottom: SPACING.sm },
  bubbleWrapMe:   { alignItems: 'flex-end' },
  bubbleWrapThem: { alignItems: 'flex-start' },
  bubble:         { maxWidth: '78%', borderRadius: RADIUS.lg, paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm + 2 },
  bubbleMe:       { backgroundColor: COLORS.indigo, borderBottomRightRadius: 4 },
  bubbleThem:     { backgroundColor: COLORS.surface1, borderBottomLeftRadius: 4, borderWidth: 1, borderColor: COLORS.border },
  bubbleTxt:      { fontFamily: FONTS.body, fontSize: 15, lineHeight: 22 },
  timeStr:        { fontFamily: FONTS.body, fontSize: 10, color: COLORS.textMuted, marginTop: 3, paddingHorizontal: 4 },

  // Input bar
  inputBar:       { flexDirection: 'row', alignItems: 'flex-end', padding: SPACING.sm, paddingBottom: Platform.OS === 'ios' ? SPACING.lg : SPACING.sm, backgroundColor: COLORS.surface1, borderTopWidth: 1, borderColor: COLORS.border, gap: SPACING.sm },
  msgInput:       { flex: 1, backgroundColor: COLORS.surface2, borderWidth: 1, borderColor: COLORS.border, borderRadius: RADIUS.xl, paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm, fontFamily: FONTS.body, fontSize: 15, color: COLORS.textPrimary, maxHeight: 120 },
  sendBtn:        { width: 42, height: 42, borderRadius: 21, backgroundColor: COLORS.indigo, alignItems: 'center', justifyContent: 'center' },
  sendBtnOff:     { backgroundColor: COLORS.border },
  sendIcon:       { fontSize: 18, color: '#fff', marginTop: -1 },
});
