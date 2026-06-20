import { requireNativeModule } from 'expo-modules-core';

let KnotVaultDir = null;
try {
  KnotVaultDir = requireNativeModule('KnotVaultDir');
} catch (e) {
  // Not linked — e.g. running in Expo Go, or a dev client built before
  // this module was added. Callers must fall back to documentDirectory.
  KnotVaultDir = null;
}

/**
 * Returns a file:// URI to Android/data/<package>/files/vault/ (creating it
 * if needed), or null if unavailable (Expo Go, iOS, no external storage
 * mounted). Always check for null and fall back to FileSystem.documentDirectory.
 */
export function getExternalVaultDir() {
  if (!KnotVaultDir) return null;
  try {
    return KnotVaultDir.getExternalVaultDir() || null;
  } catch (e) {
    return null;
  }
}
