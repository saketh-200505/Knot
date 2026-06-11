import AsyncStorage from '@react-native-async-storage/async-storage';

const KEYS = {
  ONBOARDED:       'av_onboarded',
  VAULT_PW_HASH:   'av_vault_pw_hash',
  RECOVERY_HASH:   'av_recovery_hash',
  GESTURE:         'av_gesture',
  SESSION_DURATION:'av_session_duration',
  PHOTO_INDEX:     'av_photo_index',
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
