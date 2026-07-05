import AsyncStorage from '@react-native-async-storage/async-storage';

const KEYS = {
  ONBOARDED:         'av_onboarded',
  VAULT_PW_HASH:     'av_vault_pw_hash',
  RECOVERY_HASH:     'av_recovery_hash',
  GESTURE:           'av_gesture',
  SESSION_DURATION:  'av_session_duration',
  PHOTO_INDEX:       'av_photo_index',
  GROUPS:            'av_groups',
  AUDIT_LOG:         'av_audit_log',
  IMPORTED_INDEX:    'av_imported_index',
  BACKUP_DIR_URI:    'av_backup_dir_uri',
  SHARED_SUBDIR_URI: 'av_shared_subdir_uri',
};

export { KEYS };

// Human-readable on-disk filename: sortable by date, filter-able by "Knot"
// or by group name in any file manager, and self-identifying when shared
// out to another app. The internal id (metadata key) is unchanged; only the
// filename on disk changes.
export function prettyFilename({ kind = 'vault', groupLabel = '', ext = 'dat' } = {}) {
  const p2 = n => String(n).padStart(2, '0');
  const d  = new Date();
  const ts =
    d.getFullYear() + p2(d.getMonth()+1) + p2(d.getDate()) + '_' +
    p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
  const slug = String(groupLabel || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 20);
  const rand = Math.random().toString(16).slice(2, 6).padStart(4, '0');
  const parts = ['Knot'];
  if (kind === 'shared') parts.push('shared');
  if (slug) parts.push(slug);
  parts.push(ts, rand);
  return parts.join('_') + '.' + ext;
}

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

// ─── Visible backup folder (Storage Access Framework) ───────────────────────
// A user-chosen public folder (e.g. Downloads, or a custom "Knot" folder)
// that encrypted .dat files can be copied into, so they're actually
// browsable in any file manager — unlike Android/data, which the OS hides
// from third-party apps on Android 11+. We persist the granted SAF URI so
// the user only has to pick the folder once.
export async function getBackupDirUri() {
  return storage.get(KEYS.BACKUP_DIR_URI);
}
export async function setBackupDirUri(uri) {
  // Any cached shared/ subfolder URI belongs to the *previous* backup root,
  // so invalidate it whenever the root changes.
  await storage.remove(KEYS.SHARED_SUBDIR_URI);
  return storage.set(KEYS.BACKUP_DIR_URI, uri);
}
export async function clearBackupDirUri() {
  await storage.remove(KEYS.SHARED_SUBDIR_URI);
  return storage.remove(KEYS.BACKUP_DIR_URI);
}

// URI of the "shared/" subfolder created inside the user's backup dir the
// first time a shared/imported file is written there. Cached so we don't
// re-create (or duplicate) the folder on every import.
export async function getSharedSubdirUri() {
  return storage.get(KEYS.SHARED_SUBDIR_URI);
}
export async function setSharedSubdirUri(uri) {
  return storage.set(KEYS.SHARED_SUBDIR_URI, uri);
}
export async function clearSharedSubdirUri() {
  return storage.remove(KEYS.SHARED_SUBDIR_URI);
}
