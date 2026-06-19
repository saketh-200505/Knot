import AsyncStorage from '@react-native-async-storage/async-storage';

const KEYS = {
  ONBOARDED:       'av_onboarded',
  VAULT_PW_HASH:   'av_vault_pw_hash',
  RECOVERY_HASH:   'av_recovery_hash',
  GESTURE:         'av_gesture',
  SESSION_DURATION:'av_session_duration',
  PHOTO_INDEX:     'av_photo_index',
  GROUPS:          'av_groups',
  AUDIT_LOG:       'av_audit_log',
  IMPORTED_INDEX:  'av_imported_index',
};

export { KEYS };

export const storage = {
  async get(key) {
    try { return await AsyncStorage.getItem(key); }
    catch { return null; }
  },
  async set(key, value) {
    try { await AsyncStorage.setItem(key, String(value)); return true; }
    catch { return false; }
  },
  async getJSON(key) {
    try {
      const v = await AsyncStorage.getItem(key);
      return v ? JSON.parse(v) : null;
    } catch { return null; }
  },
  async setJSON(key, value) {
    try { await AsyncStorage.setItem(key, JSON.stringify(value)); return true; }
    catch { return false; }
  },
  async remove(key) {
    try { await AsyncStorage.removeItem(key); return true; }
    catch { return false; }
  },
};

// Photo index helpers
export async function getPhotoIndex() {
  return (await storage.getJSON(KEYS.PHOTO_INDEX)) || [];
}

export async function savePhotoIndex(index) {
  return storage.setJSON(KEYS.PHOTO_INDEX, index);
}

export async function addPhotoToIndex(entry) {
  const idx = await getPhotoIndex();
  idx.push(entry);
  return savePhotoIndex(idx);
}

export async function removePhotoFromIndex(id) {
  const idx = await getPhotoIndex();
  const filtered = idx.filter(p => p.id !== id);
  return savePhotoIndex(filtered);
}

export async function isOnboarded() {
  return (await storage.get(KEYS.ONBOARDED)) === 'true';
}

export async function getGesture() {
  const raw = await storage.get(KEYS.GESTURE);
  if (!raw) return ['up','up','down','down'];
  try { return JSON.parse(raw); } catch { return ['up','up','down','down']; }
}

export async function getSessionDuration() {
  const v = await storage.get(KEYS.SESSION_DURATION);
  return v ? parseInt(v, 10) : 3;
}

// ─── Groups ────────────────────────────────────────────────────────────────
// A group is { id, label, fingerprint } — fingerprint is a fast hash of the
// group's passphrase used to recognize "this passphrase belongs to group X"
// without ever storing the passphrase itself.
export async function getGroups() {
  return (await storage.getJSON(KEYS.GROUPS)) || [];
}
export async function saveGroups(groups) {
  return storage.setJSON(KEYS.GROUPS, groups);
}
export async function addGroup(group) {
  const groups = await getGroups();
  groups.push(group);
  await saveGroups(groups);
  return group;
}
export async function findGroupByFingerprint(fingerprint) {
  const groups = await getGroups();
  return groups.find(g => g.fingerprint === fingerprint) || null;
}
export async function findGroupsByFingerprint(fingerprint) {
  const groups = await getGroups();
  return groups.filter(g => g.fingerprint === fingerprint);
}
export async function updateGroup(id, patch) {
  const groups = await getGroups();
  const idx = groups.findIndex(g => g.id === id);
  if (idx === -1) return null;
  groups[idx] = { ...groups[idx], ...patch };
  await saveGroups(groups);
  return groups[idx];
}
export async function removeGroup(id) {
  const groups = (await getGroups()).filter(g => g.id !== id);
  return saveGroups(groups);
}

// ─── Audit log ─────────────────────────────────────────────────────────────
// Append-only-ish list of recent security-relevant events, capped at 200.
const AUDIT_CAP = 200;
export async function getAuditLog() {
  return (await storage.getJSON(KEYS.AUDIT_LOG)) || [];
}
export async function logEvent(type, detail = '') {
  const log = await getAuditLog();
  log.unshift({ type, detail, ts: Date.now() });
  if (log.length > AUDIT_CAP) log.length = AUDIT_CAP;
  await storage.setJSON(KEYS.AUDIT_LOG, log);
}
export async function clearAuditLog() {
  return storage.setJSON(KEYS.AUDIT_LOG, []);
}

// ─── Imported (shared from others) index ────────────────────────────────────
export async function getImportedIndex() {
  return (await storage.getJSON(KEYS.IMPORTED_INDEX)) || [];
}
export async function saveImportedIndex(index) {
  return storage.setJSON(KEYS.IMPORTED_INDEX, index);
}
export async function addImportedToIndex(entry) {
  const idx = await getImportedIndex();
  idx.push(entry);
  return saveImportedIndex(idx);
}
export async function removeImportedFromIndex(id) {
  const idx = (await getImportedIndex()).filter(p => p.id !== id);
  return saveImportedIndex(idx);
}
export async function updateImportedEntry(id, patch) {
  const idx = await getImportedIndex();
  const i = idx.findIndex(p => p.id === id);
  if (i === -1) return null;
  idx[i] = { ...idx[i], ...patch };
  await saveImportedIndex(idx);
  return idx[i];
}
