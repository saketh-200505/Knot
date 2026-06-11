import * as ExpoC from 'expo-crypto';
import { Platform } from 'react-native';

// ─── Hashing ──────────────────────────────────────────────────────────────────
export async function hashStr(plain) {
  // SHA-256 via expo-crypto (works on all platforms)
  return ExpoC.digestStringAsync(
    ExpoC.CryptoDigestAlgorithm.SHA256,
    plain,
    { encoding: ExpoC.CryptoEncoding.HEX }
  );
}

export async function verifyHash(plain, hash) {
  const h = await hashStr(plain);
  return h === hash;
}

// ─── PBKDF2 key derivation ─────────────────────────────────────────────────────
async function deriveKey(passphrase, saltBuf) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(passphrase),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: saltBuf,
      iterations: 310000,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// ─── Random bytes ──────────────────────────────────────────────────────────────
function randomBytes(n) {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return buf;
}

// ─── Seal (encrypt) ───────────────────────────────────────────────────────────
// Returns Uint8Array: [16-byte salt][12-byte IV][ciphertext]
export async function seal(plainBytes, passphrase) {
  const salt = randomBytes(16);
  const iv   = randomBytes(12);
  const key  = await deriveKey(passphrase, salt);
  const cipherBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    plainBytes
  );
  const cipher = new Uint8Array(cipherBuf);
  const out = new Uint8Array(16 + 12 + cipher.byteLength);
  out.set(salt, 0);
  out.set(iv, 16);
  out.set(cipher, 28);
  return out;
}

// ─── Unseal (decrypt) ─────────────────────────────────────────────────────────
// Returns Uint8Array plaintext or throws on wrong passphrase
export async function unseal(sealedBytes, passphrase) {
  const salt   = sealedBytes.slice(0, 16);
  const iv     = sealedBytes.slice(16, 28);
  const cipher = sealedBytes.slice(28);
  const key    = await deriveKey(passphrase, salt);
  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    cipher
  );
  return new Uint8Array(plainBuf);
}

// ─── Uint8Array ↔ Base64 helpers ──────────────────────────────────────────────
export function uint8ToBase64(bytes) {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function base64ToUint8(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ─── Password strength ────────────────────────────────────────────────────────
export function passwordStrength(pw) {
  if (!pw) return { score: 0, label: '', color: '#4a5568' };
  let score = 0;
  if (pw.length >= 4)  score++;
  if (pw.length >= 8)  score++;
  if (/[A-Z]/.test(pw)) score++;
  if (/[0-9]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  const levels = [
    { score: 0, label: '',         color: '#4a5568' },
    { score: 1, label: 'Weak',     color: '#f43f5e' },
    { score: 2, label: 'Fair',     color: '#f59e0b' },
    { score: 3, label: 'Good',     color: '#3b82f6' },
    { score: 4, label: 'Strong',   color: '#10b981' },
    { score: 5, label: 'Very Strong', color: '#8b5cf6' },
  ];
  return levels[Math.min(score, 5)];
}
