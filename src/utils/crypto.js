/**
 * crypto.js — Pure JavaScript crypto, works in Expo Go on any platform
 * Uses: aes-js (AES-256-CTR) + @noble/hashes (PBKDF2-SHA256) + expo-crypto (random/hash)
 * No native modules. No crypto.subtle. No Web Crypto API.
 */
import * as ExpoC from 'expo-crypto';
import * as aesjs from 'aes-js';
import { pbkdf2 } from '@noble/hashes/pbkdf2';
import { sha256 } from '@noble/hashes/sha256';

export const DEFAULT_KDF_ITERATIONS = 2000;
export const LEGACY_KDF_ITERATIONS = 15000; // photos encrypted before this change

// 4-byte magic header so wrong-passphrase decrypts can be detected reliably
// (AES-CTR doesn't fail on a wrong key, it just produces garbage bytes).
// "KNT1" in ASCII.
const MAGIC = new Uint8Array([0x4b, 0x4e, 0x54, 0x31]);

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function concatBytes(...arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

// ─── SHA-256 hashing (expo-crypto) ────────────────────────────────────────────
export async function hashStr(plain) {
  return ExpoC.digestStringAsync(
    ExpoC.CryptoDigestAlgorithm.SHA256,
    plain,
    { encoding: ExpoC.CryptoEncoding.HEX }
  );
}
export async function verifyHash(plain, hash) {
  return (await hashStr(plain)) === hash;
}

// ─── Random bytes (expo-crypto) ───────────────────────────────────────────────
export async function randomBytes(n) {
  const result = await ExpoC.getRandomBytesAsync(n);
  return new Uint8Array(result);
}

// ─── PBKDF2 key derivation (pure JS) ─────────────────────────────────────────
export function deriveKey(passphrase, salt, iterations = DEFAULT_KDF_ITERATIONS) {
  const passphraseBytes = aesjs.utils.utf8.toBytes(passphrase);
  return pbkdf2(sha256, passphraseBytes, salt, { c: iterations, dkLen: 32 });
}
function deriveKeySync(passphrase, salt, iterations = DEFAULT_KDF_ITERATIONS) {
  return deriveKey(passphrase, salt, iterations);
}

// ─── Batch variants — key already derived once for a whole group ─────────────
// Format on disk is identical: [salt(16)][iv(16)][ciphertext]. The salt is
// shared across a batch (so the key can be re-derived once on decrypt too),
// but each file gets its own random IV.
export async function sealWithKey(plainBytes, key, salt) {
  const iv = await randomBytes(16);
  const checksum = sha256(plainBytes);
  const payload = concatBytes(MAGIC, checksum, plainBytes);
  const aesCtr = new aesjs.ModeOfOperation.ctr(key, new aesjs.Counter(iv));
  const encrypted = aesCtr.encrypt(payload);
  const combined = new Uint8Array(salt.length + iv.length + encrypted.length);
  combined.set(salt, 0);
  combined.set(iv, 16);
  combined.set(encrypted, 32);
  return combined;
}

export function unsealWithKey(sealedBytes, key) {
  if (sealedBytes.length < 33) throw new Error('Invalid sealed data');
  const iv         = sealedBytes.slice(16, 32);
  const ciphertext = sealedBytes.slice(32);
  const aesCtr  = new aesjs.ModeOfOperation.ctr(key, new aesjs.Counter(iv));
  const decrypted = new Uint8Array(aesCtr.decrypt(ciphertext));
  if (decrypted.length < 36 || !bytesEqual(decrypted.slice(0, 4), MAGIC)) {
    throw new Error('Wrong passphrase');
  }
  const checksum = decrypted.slice(4, 36);
  const plain    = decrypted.slice(36);
  if (!bytesEqual(checksum, sha256(plain))) {
    throw new Error('Wrong passphrase');
  }
  return plain;
}

export function getSalt(sealedBytes) {
  return sealedBytes.slice(0, 16);
}

// ─── AES-256-CTR encrypt ──────────────────────────────────────────────────────
// Format on disk: [salt(16)][iv(16)][ciphertext]
// ciphertext decrypts to: [MAGIC(4)][sha256(plain)(32)][plain]
export async function seal(plainBytes, passphrase, options = {}) {
  const iterations = options.iterations || DEFAULT_KDF_ITERATIONS;
  const salt = await randomBytes(16);
  const iv   = await randomBytes(16);
  const key  = deriveKeySync(passphrase, salt, iterations);

  const checksum = sha256(plainBytes);
  const payload = concatBytes(MAGIC, checksum, plainBytes);

  const aesCtr = new aesjs.ModeOfOperation.ctr(key, new aesjs.Counter(iv));
  const encrypted = aesCtr.encrypt(payload);

  const combined = new Uint8Array(salt.length + iv.length + encrypted.length);
  combined.set(salt, 0);
  combined.set(iv, 16);
  combined.set(encrypted, 32);
  return combined;
}

// ─── AES-256-CTR decrypt ──────────────────────────────────────────────────────
// Throws 'Wrong passphrase' if the integrity header doesn't match —
// AES-CTR never fails on its own with a wrong key, it just returns garbage,
// so we MUST check this header to detect a bad passphrase.
export async function unseal(sealedBytes, passphrase, options = {}) {
  if (sealedBytes.length < 33) throw new Error('Invalid sealed data');
  const salt       = sealedBytes.slice(0, 16);
  const iv         = sealedBytes.slice(16, 32);
  const ciphertext = sealedBytes.slice(32);

  // Try every known iteration count in most-likely-first order.
  // If the caller explicitly passes iterations, honour it and skip the loop.
  const iterList = options.iterations
    ? [options.iterations]
    : [DEFAULT_KDF_ITERATIONS, LEGACY_KDF_ITERATIONS, 8000];

  for (const iterations of iterList) {
    const key = deriveKeySync(passphrase, salt, iterations);
    const aesCtr   = new aesjs.ModeOfOperation.ctr(key, new aesjs.Counter(iv));
    const decrypted = new Uint8Array(aesCtr.decrypt(ciphertext));
    if (decrypted.length < 36 || !bytesEqual(decrypted.slice(0, 4), MAGIC)) continue;
    const checksum = decrypted.slice(4, 36);
    const plain    = decrypted.slice(36);
    if (!bytesEqual(checksum, sha256(plain))) continue;
    return plain;   // ← correct key found
  }
  throw new Error('Wrong passphrase');
}

// ─── Group fingerprint ────────────────────────────────────────────────────────
// A fast, deterministic hash of a passphrase used ONLY to cluster photos that
// share the same passphrase (so the UI can group them). It is NOT used for
// encryption, and a low iteration count is fine — it reveals nothing about the
// passphrase itself, only that two photos share one.
const FP_SALT = 'knot-group-fingerprint-v1';
export async function passphraseFingerprint(passphrase) {
  const bytes = pbkdf2(sha256, aesjs.utils.utf8.toBytes(passphrase), aesjs.utils.utf8.toBytes(FP_SALT), { c: 200, dkLen: 8 });
  return aesjs.utils.hex.fromBytes(bytes);
}

// ─── Base64 helpers ───────────────────────────────────────────────────────────
export function uint8ToBase64(bytes) {
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
export function base64ToUint8(b64) {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// ─── Password strength ────────────────────────────────────────────────────────
export function passwordStrength(pw) {
  if (!pw) return { score: 0, label: '', color: '#4a5568' };
  let sc = 0;
  if (pw.length >= 4)           sc++;
  if (pw.length >= 8)           sc++;
  if (/[A-Z]/.test(pw))         sc++;
  if (/[0-9]/.test(pw))         sc++;
  if (/[^A-Za-z0-9]/.test(pw))  sc++;
  return [
    { score:0, label:'',            color:'#4a5568' },
    { score:1, label:'Weak',        color:'#f43f5e' },
    { score:2, label:'Fair',        color:'#f59e0b' },
    { score:3, label:'Good',        color:'#3b82f6' },
    { score:4, label:'Strong',      color:'#10b981' },
    { score:5, label:'Very Strong', color:'#8b5cf6' },
  ][Math.min(sc, 5)];
}
