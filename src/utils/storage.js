import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system';

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
  SAVED_DIR_URI:     'av_saved_dir_uri',
  SHARED_SUBDIR_URI: 'av_shared_subdir_uri',
};

// Pre-1.1.7 key for the same setting, back when the folder was framed as an
// optional "backup" rather than the vault's primary storage. Read once by
// getSavedDirUri() and migrated forward, so upgrading installs don't lose the
// folder they already granted.
const LEGACY_BACKUP_DIR_KEY = 'av_backup_dir_uri';

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

// Inverse of prettyFilename(): recovers what a Knot file's name says about
// itself. Used to re-link moved files and to suggest a group name when an
// encrypted file is imported from somewhere else.
//
// Shapes produced by prettyFilename():
//   Knot_<ts>_<rand>.dat                  — vault, no group label
//   Knot_<Slug>_<ts>_<rand>.dat           — vault, grouped
//   Knot_shared_<ts>_<rand>.dat           — shared
//   Knot_shared_<Slug>_<ts>_<rand>.dat    — shared, grouped
//
// Returns null for anything that isn't ours — never guess, since a false
// positive here would invent a group the user never made.
export function parseKnotFilename(name = '') {
  const base = String(name).split('/').pop().replace(/\.[^.]+$/, '');
  // <date>_<time>_<rand> is a fixed-width tail: 8 digits, 6 digits, 4 hex.
  const m = base.match(/^Knot_(?:(shared)_)?(?:(.+)_)?(\d{8})_(\d{6})_([0-9a-f]{4})$/);
  if (!m) return null;
  return {
    kind:      m[1] ? 'shared' : 'vault',
    groupSlug: m[2] || null,
    date:      m[3],
    time:      m[4],
    rand:      m[5],
  };
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

export async function updatePhotoEntry(id, patch) {
  const idx = await getPhotoIndex();
  const i = idx.findIndex(p => p.id === id);
  if (i === -1) return null;
  idx[i] = { ...idx[i], ...patch };
  await savePhotoIndex(idx);
  return idx[i];
}

// Entries written before filenames became the stable identity only have an
// absolute filePath. Derive fileName from it once so resolveFilePath() can
// re-link them after a folder move like any newer entry. Cheap no-op after
// the first run; called from the vault's initial load.
export async function backfillPhotoFileNames() {
  const idx = await getPhotoIndex();
  let changed = false;
  for (const p of idx) {
    if (!p.fileName && p.filePath) {
      p.fileName = fileNameFromUri(p.filePath);
      changed = true;
    }
  }
  if (changed) await savePhotoIndex(idx);
  return idx;
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

// ─── Saved folder (Storage Access Framework) ────────────────────────────────
// The user-chosen public folder (e.g. Downloads, or a custom "Knot" folder)
// that encrypted .dat files are written into. This is not a backup — once
// chosen it holds the only copy, which is why encryption is gated on having
// one. Android/data, the alternative, is hidden from third-party apps on
// Android 11+, so files written there are effectively invisible to the user.
// We persist the granted SAF URI so the folder is picked only once.
export async function getSavedDirUri() {
  const uri = await storage.get(KEYS.SAVED_DIR_URI);
  if (uri) return uri;
  // One-time migration from the old "backup folder" key.
  const legacy = await storage.get(LEGACY_BACKUP_DIR_KEY);
  if (legacy) {
    await storage.set(KEYS.SAVED_DIR_URI, legacy);
    await storage.remove(LEGACY_BACKUP_DIR_KEY);
    return legacy;
  }
  return null;
}
export async function setSavedDirUri(uri) {
  // Any cached shared/ subfolder URI belongs to the *previous* root, so
  // invalidate it whenever the root changes.
  await storage.remove(KEYS.SHARED_SUBDIR_URI);
  if (uri == null) return storage.remove(KEYS.SAVED_DIR_URI);
  return storage.set(KEYS.SAVED_DIR_URI, uri);
}
export async function clearSavedDirUri() {
  await storage.remove(KEYS.SHARED_SUBDIR_URI);
  await storage.remove(LEGACY_BACKUP_DIR_KEY);
  return storage.remove(KEYS.SAVED_DIR_URI);
}

// URI of the "shared/" subfolder created inside the saved folder the first
// time a shared/imported file is written there. Cached so we don't re-create
// (or duplicate) the folder on every import.
export async function getSharedSubdirUri() {
  return storage.get(KEYS.SHARED_SUBDIR_URI);
}
export async function setSharedSubdirUri(uri) {
  return storage.set(KEYS.SHARED_SUBDIR_URI, uri);
}
export async function clearSharedSubdirUri() {
  return storage.remove(KEYS.SHARED_SUBDIR_URI);
}

// ─── Locating a file that may have moved ────────────────────────────────────
// A photo's filePath is an absolute SAF content:// URI captured at encryption
// time. It dies the moment the user re-picks the folder, moves the files in a
// file manager, or reinstalls — even though the .dat itself is perfectly
// intact. The *filename* is the stable identity (prettyFilename() makes it
// unique), so when a path stops resolving we look the file up by name in the
// current saved folder and repair the index.

// Directory listings are the expensive part (one IPC round-trip each), and a
// bulk unlock resolves dozens of files back to back. Cache the listing per
// directory and invalidate it whenever we write to that directory.
const dirListingCache = new Map(); // dirUri -> Promise<string[]>

export function invalidateDirListingCache(dirUri) {
  if (dirUri) dirListingCache.delete(dirUri);
  else dirListingCache.clear();
}

async function listDir(dirUri) {
  if (!dirListingCache.has(dirUri)) {
    dirListingCache.set(
      dirUri,
      FileSystem.StorageAccessFramework.readDirectoryAsync(dirUri).catch(() => [])
    );
  }
  return dirListingCache.get(dirUri);
}

// The tail of a SAF document URI is the percent-encoded full document id,
// e.g. ".../document/primary%3ADownload%2FKnot_Trip_20260928_211600_a1b2.dat".
// We only care about the final path segment of that id.
function fileNameFromUri(uri = '') {
  try {
    const decoded = decodeURIComponent(String(uri));
    return decoded.split(/[\/:]/).pop() || null;
  } catch {
    return String(uri).split('/').pop() || null;
  }
}

export { fileNameFromUri };

// Returns a readable URI for `entry`, repairing entry.filePath in the given
// index as a side effect when the file turns out to have moved. `indexKind`
// picks which index to write the repair back to.
// Returns null when the file genuinely can't be found.
export async function resolveFilePath(entry, savedDirUri, indexKind = 'photo') {
  if (!entry) return null;
  const stored = entry.filePath;
  const wanted = entry.fileName || fileNameFromUri(stored);

  // file:// paths (iOS, and the Android internal fallback) stat reliably, so
  // a cheap existence check settles it.
  if (stored && !stored.startsWith('content://')) {
    try {
      const info = await FileSystem.getInfoAsync(stored);
      if (info?.exists) return stored;
    } catch { /* fall through to the lookup below */ }
  }

  // SAF content:// URIs don't stat reliably — getInfoAsync's behaviour on
  // them varies by OEM and by whether the grant is still alive — so we settle
  // it against the directory listing instead. The listing is cached, so a
  // bulk unlock costs one round-trip, not one per photo.
  if (wanted && savedDirUri) {
    const candidates = [savedDirUri];
    const sharedSub = await getSharedSubdirUri();
    if (sharedSub) candidates.push(sharedSub);

    for (const dir of candidates) {
      const uris = await listDir(dir);
      const hit = uris.find(u => fileNameFromUri(u) === wanted);
      if (!hit) continue;
      // Repair the index only when the path actually changed, so a normal
      // read doesn't rewrite AsyncStorage on every photo.
      if (hit !== stored || entry.fileName !== wanted) {
        const patch = { filePath: hit, fileName: wanted };
        if (indexKind === 'imported') await updateImportedEntry(entry.id, patch);
        else                          await updatePhotoEntry(entry.id, patch);
      }
      return hit;
    }
  }

  // Nothing matched by name. If we still have a stored content:// URI its
  // grant may yet be alive (e.g. the folder setting was cleared but the
  // permission wasn't), so hand it back and let the caller's own read decide
  // — a real attempt beats guessing.
  return stored && stored.startsWith('content://') ? stored : null;
}
