/**
 * useSession.js — Ephemeral session manager
 * Decrypted bytes live in RAM only. Auto-locks on background.
 * All heavy work yields to UI thread via InteractionManager.
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { AppState, InteractionManager } from 'react-native';
import * as FileSystem from 'expo-file-system';
import {
  unseal, unsealWithKey, base64ToUint8, uint8ToBase64, LEGACY_KDF_ITERATIONS,
} from '../utils/crypto';
import { getSessionDuration, logEvent } from '../utils/storage';

// Yields to the JS event loop after pending interactions are flushed.
// This lets button presses / UI updates render between heavy operations.
function yieldUI() {
  return new Promise(resolve =>
    InteractionManager.runAfterInteractions(() => setTimeout(resolve, 16))
  );
}

export function useSession() {
  const [active,       setActive]       = useState(false);
  const [decryptedMap, setDecryptedMap] = useState({}); // id → uri/data-uri
  const [remaining,    setRemaining]    = useState(0);
  const [totalSecs,    setTotalSecs]    = useState(180);
  const [blurring,     setBlurring]     = useState(false);
  const [showExtend,   setShowExtend]   = useState(false);
  const timerRef = useRef(null);

  // ── Wipe ──────────────────────────────────────────────────────────────────
  const wipe = useCallback((reason) => {
    clearInterval(timerRef.current);
    timerRef.current = null;
    setDecryptedMap(prev => {
      // Clean up temp video cache files
      Object.values(prev).forEach(v => {
        if (typeof v === 'string' && v.includes('/vid_') && !v.startsWith('data:')) {
          FileSystem.deleteAsync(v, { idempotent: true }).catch(() => {});
        }
      });
      return {};
    });
    setActive(false);
    setBlurring(false);
    setShowExtend(false);
    setRemaining(0);
    if (reason) logEvent('lock', reason).catch(() => {});
  }, []);

  // ── Timer ──────────────────────────────────────────────────────────────────
  const startTimer = useCallback((secs) => {
    clearInterval(timerRef.current);
    setTotalSecs(secs);
    setRemaining(secs);
    setBlurring(false);
    setShowExtend(false);
    timerRef.current = setInterval(() => {
      setRemaining(prev => {
        const next = prev - 1;
        if (next === 30) setBlurring(true);
        if (next <= 0) {
          clearInterval(timerRef.current);
          timerRef.current = null;
          // Can't call wipe() here (stale closure) — clear map directly
          setDecryptedMap({});
          setActive(false);
          setBlurring(false);
          setShowExtend(true);
          logEvent('session_expired').catch(() => {});
          return 0;
        }
        return next;
      });
    }, 1000);
  }, []);

  // ── Unlock ─────────────────────────────────────────────────────────────────
  // `photos` each have: { id, sealedB64, key?, mimeType, mediaType, kdfIterations }
  // key is pre-derived (batch) — if null, falls back to per-photo PBKDF2 (legacy).
  const unlock = useCallback(async (photos, passphrase, onProgress) => {
    const newMap = {};
    let count = 0;

    for (const photo of photos) {
      await yieldUI(); // keep UI responsive between each photo
      try {
        onProgress?.(count, photos.length);

        const sealed = base64ToUint8(photo.sealedB64);
        const plain  = photo.key
          ? unsealWithKey(sealed, photo.key)
          : await unseal(sealed, passphrase, {
              iterations: photo.kdfIterations || LEGACY_KDF_ITERATIONS,
            });

        const mime    = photo.mimeType || 'image/jpeg';
        const isVideo = photo.mediaType === 'video' || mime.startsWith('video/');

        if (isVideo) {
          // Write video to cache file — expo-av needs a real path, not data URI
          const ext     = mime.split('/')[1] || 'mp4';
          const tmpPath = `${FileSystem.cacheDirectory}vid_${photo.id}.${ext}`;
          await FileSystem.writeAsStringAsync(
            tmpPath,
            uint8ToBase64(plain),
            { encoding: FileSystem.EncodingType.Base64 }
          );
          newMap[photo.id] = tmpPath;
        } else {
          newMap[photo.id] = `data:${mime};base64,${uint8ToBase64(plain)}`;
        }

        count++;
        onProgress?.(count, photos.length);
      } catch {
        // Wrong passphrase or corrupted file — skip silently
      }
    }

    setDecryptedMap(prev => ({ ...prev, ...newMap }));
    setActive(true);
    const durMin = await getSessionDuration();
    startTimer(durMin * 60);
    logEvent(count > 0 ? 'unlock' : 'unlock_failed', `${count}/${photos.length}`).catch(() => {});
    return count;
  }, [startTimer]);

  const extend = useCallback(async (photos, passphrase, onProgress) => {
    setShowExtend(false);
    return unlock(photos, passphrase, onProgress);
  }, [unlock]);

  // ── Cleanup on unmount ─────────────────────────────────────────────────────
  useEffect(() => () => {
    clearInterval(timerRef.current);
    // Don't call wipe() — just clear interval; GC handles memory
  }, []);

  // ── Auto-lock on background ────────────────────────────────────────────────
  useEffect(() => {
    const sub = AppState.addEventListener('change', nextState => {
      if ((nextState === 'background' || nextState === 'inactive') && active) {
        wipe('app_background');
      }
    });
    return () => sub.remove();
  }, [active, wipe]);

  return {
    active, decryptedMap, remaining, totalSecs,
    blurring, showExtend, unlock, extend, wipe,
  };
}
