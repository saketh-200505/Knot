import { useState, useRef, useEffect, useCallback } from 'react';
import { unseal, base64ToUint8 } from '../utils/crypto';
import { getSessionDuration } from '../utils/storage';

// Map of id → { objectUrl, mimeType } — lives only in this hook's closure
let _urlMap = {};

export function useSession() {
  const [active, setActive]           = useState(false);
  const [decryptedMap, setDecryptedMap] = useState({}); // id → objectUrl
  const [remaining, setRemaining]     = useState(0);     // seconds
  const [totalSecs, setTotalSecs]     = useState(180);
  const [blurring, setBlurring]       = useState(false);
  const [showExtend, setShowExtend]   = useState(false);
  const timerRef = useRef(null);

  const wipe = useCallback(() => {
    // Revoke all object URLs to free memory
    Object.values(_urlMap).forEach(({ objectUrl }) => {
      try { URL.revokeObjectURL(objectUrl); } catch {}
    });
    _urlMap = {};
    setDecryptedMap({});
    setActive(false);
    setBlurring(false);
    setShowExtend(false);
    setRemaining(0);
    clearInterval(timerRef.current);
  }, []);

  const startTimer = useCallback((secs) => {
    clearInterval(timerRef.current);
    setTotalSecs(secs);
    setRemaining(secs);
    setBlurring(false);
    setShowExtend(false);
    timerRef.current = setInterval(() => {
      setRemaining(prev => {
        const next = prev - 1;
        if (next <= 30 && next > 0) setBlurring(true);
        if (next <= 0) {
          clearInterval(timerRef.current);
          setShowExtend(true);
          return 0;
        }
        return next;
      });
    }, 1000);
  }, []);

  // Unlock: decrypt all photos with passphrase, return count or throw
  const unlock = useCallback(async (photos, passphrase) => {
    wipe(); // clear any previous session first
    const newMap = {};
    const newUrlMap = {};

    for (const photo of photos) {
      try {
        const sealedBytes = base64ToUint8(photo.sealedB64);
        const plain = await unseal(sealedBytes, passphrase);
        const blob = new Blob([plain], { type: photo.mimeType || 'image/jpeg' });
        const url = URL.createObjectURL(blob);
        newMap[photo.id] = url;
        newUrlMap[photo.id] = { objectUrl: url, mimeType: photo.mimeType };
      } catch {
        // Wrong passphrase for this photo — skip silently; mark as locked
      }
    }

    _urlMap = newUrlMap;
    setDecryptedMap(newMap);
    setActive(true);

    const durMin = await getSessionDuration();
    startTimer(durMin * 60);

    return Object.keys(newMap).length;
  }, [wipe, startTimer]);

  const extend = useCallback(async (photos, passphrase) => {
    setShowExtend(false);
    await unlock(photos, passphrase);
  }, [unlock]);

  // Cleanup on unmount
  useEffect(() => () => { wipe(); }, [wipe]);

  return {
    active,
    decryptedMap,
    remaining,
    totalSecs,
    blurring,
    showExtend,
    unlock,
    extend,
    wipe,
  };
}
