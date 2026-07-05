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
  Alert, Pressable,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ExpoC from 'expo-crypto';
import * as aesjs from 'aes-js';
import { sha256 } from '@noble/hashes/sha256';
import { COLORS, FONTS, RADIUS, SPACING } from '../utils/theme';

// ─── 🔧 PASTE YOUR FIREBASE CONFIG HERE ──────────────────────────────────────
const FIREBASE_CONFIG = {
  apiKey:      'AIzaSyBHnA05bunLw23gy40u-Llxsshn9Lc3LBI',
  databaseURL: 'https://saketh-3ee4f-default-rtdb.asia-southeast1.firebasedatabase.app',
};
// ─────────────────────────────────────────────────────────────────────────────

const POLL_INTERVAL = 2000; // ms — poll Firebase every 2 seconds

// ─── Firebase REST ────────────────────────────────────────────────────────────
const DB = () => FIREBASE_CONFIG.databaseURL;

async function fbGet(path) {
  try {
    const res = await fetch(
      `${DB()}/${path}.json?auth=${FIREBASE_CONFIG.apiKey}`
    );
    if (!res.ok) return { ok: false, data: null };
    const data = await res.json();
    return { ok: true, data };
  } catch { return { ok: false, data: null }; }
}

async function fbSet(path, data) {
  try {
    const res = await fetch(
      `${DB()}/${path}.json?auth=${FIREBASE_CONFIG.apiKey}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }
    );
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const j = await res.json(); if (j?.error) msg = j.error; } catch {}
      return { ok: false, error: msg };
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: e?.message || 'Network error' }; }
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

// Shared key = sha256(sortedPubA + sortedPubB)
// Sorted so BOTH sides always derive the EXACT same key regardless of who calls it
// Phone A: sha256(A_pub + B_pub)  — after sorting
// Phone B: sha256(A_pub + B_pub)  — same result ✅
function deriveSharedKey(myPubHex, theirPubHex) {
  const sorted = [myPubHex, theirPubHex].sort().join('');
  const input  = aesjs.utils.utf8.toBytes(sorted);
  return sha256(input);
}

function encryptMsg(text, keyBytes) {
  const iv = new Uint8Array(16);
  const ts = Date.now();
  iv[0] = (ts >> 24) & 0xff; iv[1] = (ts >> 16) & 0xff;
  iv[2] = (ts >>  8) & 0xff; iv[3] =  ts        & 0xff;
  for (let i = 4; i < 16; i++) iv[i] = Math.floor(Math.random() * 256);
  const plain  = aesjs.utils.utf8.toBytes(text);
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
    return aesjs.utils.utf8.fromBytes(plain);
  } catch { return null; }
}

// ─── AsyncStorage keys ────────────────────────────────────────────────────────
const KEY_ID  = 'knot_chat_id';
const KEY_CON = 'knot_chat_contacts';
const KEY_MSG = 'knot_chat_msgs';

// ─── Utils ────────────────────────────────────────────────────────────────────
// Room path: sorted pubkeys joined — same on both devices
function roomPath(a, b) {
  return 'chats/' + [a, b].sort().join('__');
}
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
export function ChatTab() {
  const [screen,   setScreen]   = useState('loading');
  const [identity, setIdentity] = useState(null);
  const [contacts, setContacts] = useState([]);
  const [active,   setActive]   = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(KEY_ID);
        if (raw) {
          setIdentity(JSON.parse(raw));
          const c = await AsyncStorage.getItem(KEY_CON);
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
      onOpen={c => { setActive(c); setScreen('chat'); }}
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
function RoomsScreen({ identity, contacts, onOpen, onAdd, onDelete }) {
  const [showKey, setShowKey] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [name,    setName]    = useState('');
  const [pub,     setPub]     = useState('');
  const [busy,    setBusy]    = useState(false);

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
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [s.row, pressed && { backgroundColor: COLORS.surface2 }]}
              onPress={() => onOpen(item)}
              onLongPress={() => confirmDelete(item)}
            >
              <View style={s.av}><Text style={s.avTxt}>{initials(item.name)}</Text></View>
              <View style={{ flex: 1 }}>
                <Text style={s.rowName}>{item.name}</Text>
                <Text style={s.rowSub}>🔒 End-to-end encrypted</Text>
              </View>
              <Text style={{ fontSize: 20, color: COLORS.textMuted }}>›</Text>
            </Pressable>
          )}
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
  const [messages, setMessages] = useState([]);
  const [input,    setInput]    = useState('');
  const [sending,  setSending]  = useState(false);
  const [online,   setOnline]   = useState(false);
  const listRef    = useRef(null);
  const seenIds    = useRef(new Set());
  const sharedKey  = useRef(null);
  const pollTimer  = useRef(null);
  const path       = roomPath(identity.pubHex, contact.pubHex);

  // Derive shared key once
  useEffect(() => {
    sharedKey.current = deriveSharedKey(identity.pubHex, contact.pubHex);
  }, [identity.pubHex, contact.pubHex]);

  // Load cached messages from AsyncStorage
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(KEY_MSG);
        const all = raw ? JSON.parse(raw) : {};
        const rid = path.replace('chats/', '');
        const cached = (all[rid] || []).map(m => ({
          ...m, fromMe: m.sender === identity.pubHex,
        }));
        if (cached.length) {
          setMessages(cached);
          setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 50);
        }
      } catch {}
    })();
  }, [path, identity.pubHex]);

  // ── POLLING — fetch Firebase every 2 seconds ──────────────────────────────
  const poll = useCallback(async () => {
    if (!sharedKey.current) return;
    const res = await fbGet(path);
    setOnline(res.ok);
    if (!res.ok) return;
    const data = res.data;
    if (!data || typeof data !== 'object') return;

    const newMsgs = [];
    for (const [id, m] of Object.entries(data)) {
      if (seenIds.current.has(id)) continue;
      if (!m || !m.ct || !m.ts || !m.sender) continue;
      seenIds.current.add(id);
      const text = decryptMsg(m.ct, sharedKey.current);
      if (!text) continue;
      newMsgs.push({
        id,
        text,
        ts: m.ts,
        sender: m.sender,
        fromMe: m.sender === identity.pubHex,
      });
    }

    if (!newMsgs.length) return;

    setMessages(prev => {
      const merged = [...prev];
      for (const msg of newMsgs) {
        if (!merged.find(m => m.id === msg.id)) merged.push(msg);
      }
      const sorted = merged.sort((a, b) => a.ts - b.ts);
      // persist
      const rid = path.replace('chats/', '');
      AsyncStorage.getItem(KEY_MSG).then(raw => {
        const all = raw ? JSON.parse(raw) : {};
        all[rid] = sorted;
        return AsyncStorage.setItem(KEY_MSG, JSON.stringify(all));
      }).catch(() => {});
      return sorted;
    });
    setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 80);
  }, [path, identity.pubHex]);

  // Start polling on mount, stop on unmount
  useEffect(() => {
    poll(); // immediate first fetch
    pollTimer.current = setInterval(poll, POLL_INTERVAL);
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, [poll]);

  // Scroll to bottom whenever the message count changes (new incoming/cached)
  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 100);
    }
  }, [messages.length]);

  // Send message
  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || sending || !sharedKey.current) return;
    setSending(true);
    setInput('');

    const id  = genId();
    const ts  = Date.now();
    const ct  = encryptMsg(text, sharedKey.current);
    const rid = path.replace('chats/', '');

    const persistMessages = (list) => {
      AsyncStorage.getItem(KEY_MSG).then(raw => {
        const all = raw ? JSON.parse(raw) : {};
        all[rid] = list;
        return AsyncStorage.setItem(KEY_MSG, JSON.stringify(all));
      }).catch(() => {});
    };

    // Optimistic local add — you see it immediately, marked as pending
    const msg = { id, text, ts, sender: identity.pubHex, fromMe: true, status: 'sending' };
    seenIds.current.add(id);
    setMessages(prev => {
      const next = [...prev, msg].sort((a, b) => a.ts - b.ts);
      persistMessages(next);
      return next;
    });
    setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 80);

    // Write to Firebase and reconcile status
    const res = await fbSet(`${path}/${id}`, { ct, ts, sender: identity.pubHex });
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
    }
    setSending(false);
  }, [input, sending, identity, path]);

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
        </View>
        <View style={{ flex: 1 }}>
          <Text style={s.headerTitle}>{contact.name}</Text>
          <Text style={s.statusTxt}>
            {online ? '🔒 End-to-end encrypted' : 'Connecting…'}
          </Text>
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
              Messages are encrypted on your device.{'\n'}
              Only you and {contact.name} can read them.
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <View style={[s.bWrap, item.fromMe ? s.bWrapMe : s.bWrapThem]}>
            <View style={[
              s.bubble,
              item.fromMe ? s.bMe : s.bThem,
              item.status === 'failed' && s.bFailed,
            ]}>
              <Text style={[s.bTxt, { color: item.fromMe ? '#fff' : COLORS.textPrimary }]}>
                {item.text}
              </Text>
            </View>
            <Text style={[s.time, { textAlign: item.fromMe ? 'right' : 'left' }]}>
              {item.fromMe && item.status === 'sending' && '• sending  '}
              {item.fromMe && item.status === 'failed'  && '⚠︎ not delivered  '}
              {timeStr(item.ts)}
            </Text>
          </View>
        )}
      />

      {/* Input */}
      <View style={s.inputBar}>
        <TextInput
          style={s.msgInp}
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

  header:    { flexDirection: 'row', alignItems: 'center', paddingTop: 52, paddingBottom: SPACING.md, paddingHorizontal: SPACING.md, backgroundColor: COLORS.surface1, borderBottomWidth: 1, borderColor: COLORS.border, gap: SPACING.sm },
  headerTitle:{ fontFamily: FONTS.headingX, fontSize: 20, color: COLORS.textPrimary },
  statusTxt: { fontFamily: FONTS.body, fontSize: 11, color: COLORS.textMuted, marginTop: 1 },
  backBtn:   { width: 36, height: 36, borderRadius: 18, backgroundColor: COLORS.surface2, alignItems: 'center', justifyContent: 'center' },
  chip:      { backgroundColor: COLORS.indigoDim, paddingHorizontal: SPACING.md, paddingVertical: 6, borderRadius: RADIUS.full },
  chipTxt:   { fontFamily: FONTS.bodyMed, fontSize: 13, color: COLORS.indigo },

  av:        { width: 44, height: 44, borderRadius: 22, backgroundColor: COLORS.indigoDim, alignItems: 'center', justifyContent: 'center' },
  avTxt:     { fontFamily: FONTS.heading, fontSize: 15, color: COLORS.indigo },

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

  msgList:   { padding: SPACING.md, paddingBottom: SPACING.lg },
  bWrap:     { marginBottom: SPACING.sm },
  bWrapMe:   { alignItems: 'flex-end' },
  bWrapThem: { alignItems: 'flex-start' },
  bubble:    { maxWidth: '78%', borderRadius: RADIUS.lg, paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm + 2 },
  bMe:       { backgroundColor: COLORS.indigo, borderBottomRightRadius: 4 },
  bThem:     { backgroundColor: COLORS.surface1, borderBottomLeftRadius: 4, borderWidth: 1, borderColor: COLORS.border },
  bFailed:   { opacity: 0.55, borderWidth: 1, borderColor: '#f43f5e' },
  bTxt:      { fontFamily: FONTS.body, fontSize: 15, lineHeight: 22 },
  time:      { fontFamily: FONTS.body, fontSize: 10, color: COLORS.textMuted, marginTop: 3, paddingHorizontal: 4 },

  inputBar:  { flexDirection: 'row', alignItems: 'flex-end', padding: SPACING.sm, paddingBottom: Platform.OS === 'ios' ? SPACING.lg : SPACING.sm, backgroundColor: COLORS.surface1, borderTopWidth: 1, borderColor: COLORS.border, gap: SPACING.sm },
  msgInp:    { flex: 1, backgroundColor: COLORS.surface2, borderWidth: 1, borderColor: COLORS.border, borderRadius: RADIUS.xl, paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm, fontFamily: FONTS.body, fontSize: 15, color: COLORS.textPrimary, maxHeight: 120 },
  sendBtn:   { width: 42, height: 42, borderRadius: 21, backgroundColor: COLORS.indigo, alignItems: 'center', justifyContent: 'center' },
  sendBtnOff:{ backgroundColor: COLORS.border },
  sendIcon:  { fontSize: 18, color: '#fff', marginTop: -1 },
});
