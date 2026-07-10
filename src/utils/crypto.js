/**
 * crypto.js — XChaCha20-Poly1305 (AEAD) + Argon2id key derivation
 *
 * v2 file format (current — all new encryption uses this):
 *   MAGIC "KNT2" (4 bytes)
 *   memlimit      (4 bytes, uint32 LE) — Argon2id memory cost used, in bytes
 *   opslimit      (4 bytes, uint32 LE) — Argon2id iterations used
 *   salt          (16 bytes)           — crypto_pwhash_SALTBYTES
 *   nonce         (24 bytes)           — crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
 *   ciphertext + Poly1305 tag (rest)
 *
 * The header (magic + memlimit + opslimit + salt) is passed as AEAD
 * additional data, so tampering with any of those fields invalidates the
 * authentication tag on decrypt.
 *
 * v1 (legacy) format is still supported for DECRYPTION ONLY, so photos
 * encrypted before this refactor keep working:
 *   [salt(16)][iv(16)][ciphertext]  — AES-256-CTR, PBKDF2-SHA256 key
 *
 * Requires a native module (react-native-libsodium) — this app already
 * ships a custom dev client / EAS build, so that's not a new constraint.
 */
import * as ExpoC from 'expo-crypto';
import * as aesjs from 'aes-js';
import { pbkdf2 } from '@noble/hashes/pbkdf2';
import { sha256 } from '@noble/hashes/sha256';
import sodium from 'react-native-libsodium';

export const DEFAULT_KDF_ITERATIONS = 2000;   // legacy PBKDF2 only
export const LEGACY_KDF_ITERATIONS  = 15000;  // legacy PBKDF2 only

// ─── Argon2id parameter presets ───────────────────────────────────────────────
// Key is derived once per session/batch and reused with a fresh nonce per
// file, so the one-time cost of the stronger preset is negligible even when
// encrypting many photos or a video.
export const ARGON2_PRESETS = {
  INTERACTIVE: { opslimit: 2, memlimit: 64  * 1024 * 1024 }, // ~64 MiB  — low-end devices, mobile default
  MODERATE:    { opslimit: 3, memlimit: 256 * 1024 * 1024 }, // ~256 MiB — stronger, but has been seen to
                                                              // fail on some Android devices/emulators
                                                              // with a generic native error at this memlimit
};
export const DEFAULT_ARGON2_PARAMS = ARGON2_PRESETS.INTERACTIVE;

// Refuse to honour Argon2 parameters read from a file header beyond these
// ceilings — protects against a crafted file trying to force an OOM/hang.
const MAX_MEMLIMIT = 1024 * 1024 * 1024; // 1 GiB
const MAX_OPSLIMIT = 20;

const KEY_BYTES   = 32; // crypto_aead_xchacha20poly1305_ietf_KEYBYTES
export const SALT_BYTES  = 16; // crypto_pwhash_SALTBYTES (fallback if library constant is unavailable)
const NONCE_BYTES = 24; // crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
const MAGIC_V2 = new Uint8Array([0x4b, 0x4e, 0x54, 0x32]); // "KNT2"
const HEADER_BYTES = 4 + 4 + 4 + SALT_BYTES + NONCE_BYTES; // 52

// v1 legacy magic, kept only to detect/decrypt old files
const MAGIC_V1 = new Uint8Array([0x4b, 0x4e, 0x54, 0x31]); // "KNT1"

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

function u32(n) {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
}
function readU32(bytes, off) {
  return (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0;
}

async function ensureReady() {
  await sodium.ready;
}

console.log('[KNOT][crypto.js] v2 module loaded (XChaCha20-Poly1305 + Argon2id, getSaltBytes present)');

// The number of salt bytes crypto_pwhash actually expects on THIS platform's
// native binding. Ask the library itself instead of hardcoding, since the
// exact figure has been known to vary across libsodium binding versions —
// using SALT_BYTES literally elsewhere (e.g. to size a freshly generated
// salt) can silently drift out of sync with what the native side enforces.
export async function getSaltBytes() {
  await ensureReady();
  return (
    globalThis.jsi_crypto_pwhash_SALTBYTES ||
    sodium.crypto_pwhash_SALTBYTES ||
    SALT_BYTES
  );
}

// ─── SHA-256 hashing (expo-crypto) — unchanged, used for vault PIN, not files ─
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

// ─── Argon2id key derivation (current) ───────────────────────────────────────
// react-native-libsodium captures its constants at module-load time
// (`export const crypto_pwhash_SALTBYTES = global.jsi_crypto_pwhash_SALTBYTES`),
// so if the JS bundle imports the library before the native installer has run,
// the captured constant is `undefined` for the life of the process and the
// library's own `crypto_pwhash` guard throws "invalid salt length" for a
// perfectly valid 16-byte salt. Read the JSI globals at CALL time instead of
// trusting the wrapper's captured copies, and fall back to the JSI global if
// the wrapper is broken.
export async function deriveKey(passphrase, salt, params = DEFAULT_ARGON2_PARAMS) {
  await ensureReady();
  const g = globalThis;
  const nativeSaltBytes = g.jsi_crypto_pwhash_SALTBYTES;
  const nativeAlgId     = g.jsi_crypto_pwhash_ALG_ARGON2ID13;
  const wrapperSaltBytes = sodium.crypto_pwhash_SALTBYTES;
  const expected = nativeSaltBytes || wrapperSaltBytes || SALT_BYTES;
  if (!salt || salt.length !== expected) {
    throw new Error(
      `deriveKey: salt is ${salt ? salt.length : 'null'} bytes, but this platform's ` +
      `crypto_pwhash requires exactly ${expected} bytes.`
    );
  }
  const algConst =
    sodium.crypto_pwhash_ALG_ARGON2ID13 != null
      ? sodium.crypto_pwhash_ALG_ARGON2ID13
      : nativeAlgId;
  if (algConst == null) {
    throw new Error(
      'react-native-libsodium native module is not installed: ' +
      'jsi_crypto_pwhash_ALG_ARGON2ID13 is undefined. Rebuild your custom dev ' +
      'client (`npx expo prebuild --clean` then a fresh EAS/native build).'
    );
  }
  // If the wrapper captured its SALTBYTES const as undefined, its own guard
  // will reject any salt. Skip the wrapper and call the JSI global directly.
  const wrapperGuardBroken = wrapperSaltBytes == null && typeof g.jsi_crypto_pwhash === 'function';
  try {
    if (wrapperGuardBroken) {
      const toAB = (u8) =>
        u8.buffer.byteLength === u8.byteLength ? u8.buffer : u8.slice().buffer;
      const passParam = typeof passphrase === 'string' ? passphrase : toAB(passphrase);
      const result = g.jsi_crypto_pwhash(
        KEY_BYTES,
        passParam,
        toAB(salt),
        params.opslimit,
        params.memlimit,
        algConst
      );
      return new Uint8Array(result);
    }
    return sodium.crypto_pwhash(
      KEY_BYTES,
      passphrase,
      salt,
      params.opslimit,
      params.memlimit,
      algConst
    );
  } catch (e) {
    console.error('[KNOT][crypto.js] crypto_pwhash native call failed:', e?.message, {
      saltLen: salt.length,
      expected,
      wrapperSaltBytes,
      nativeSaltBytes,
      wrapperGuardBroken,
      opslimit: params.opslimit,
      memlimit: params.memlimit,
    });
    throw e;
  }
}

// ─── Legacy PBKDF2 key derivation ─────────────────────────────────────────────
// Kept ONLY so groups/photos created before this refactor keep decrypting.
// Never used to encrypt anything new — new group creation uses deriveKey().
export function deriveKeyLegacy(passphrase, salt, iterations = DEFAULT_KDF_ITERATIONS) {
  const passphraseBytes = aesjs.utils.utf8.toBytes(passphrase);
  return pbkdf2(sha256, passphraseBytes, salt, { c: iterations, dkLen: 32 });
}

// ─── AEAD primitives (XChaCha20-Poly1305) ────────────────────────────────────
// NOTE: secret_nonce (nsec) is unused by this construction and must always be
// absent. Pass `undefined`, not `null` — this binding implements only a
// subset of the libsodium-wrappers argument types, and `null` triggers an
// "input type not yet implemented" native error instead of being treated as
// "not provided".
async function aeadEncrypt(plainBytes, key, nonce, aad) {
  await ensureReady();
  return sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plainBytes, aad, undefined, nonce, key);
}
async function aeadDecrypt(ciphertext, key, nonce, aad) {
  await ensureReady();
  try {
    const plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(undefined, ciphertext, aad, nonce, key);
    if (!plain) throw new Error('Wrong passphrase');
    return plain;
  } catch (e) {
    // Don't silently relabel every failure as "wrong passphrase" -- a type
    // error or library bug would be invisible otherwise. Surface both.
    console.error('[KNOT][crypto.js] AEAD decrypt failed:', e?.message);
    throw new Error(`Wrong passphrase (or decryption error: ${e?.message || e})`);
  }
}

function packHeaderV2(memlimit, opslimit, salt, nonce) {
  return concatBytes(MAGIC_V2, u32(memlimit), u32(opslimit), salt, nonce);
}

// Returns null if sealedBytes isn't v2 format (so callers fall back to legacy).
// Throws if it IS v2 format but the embedded params are out of sane bounds.
function parseHeaderV2(sealedBytes) {
  if (sealedBytes.length < HEADER_BYTES + 16) return null; // +16 = min AEAD tag
  if (!bytesEqual(sealedBytes.slice(0, 4), MAGIC_V2)) return null;
  const memlimit = readU32(sealedBytes, 4);
  const opslimit = readU32(sealedBytes, 8);
  if (memlimit < 1 || opslimit < 1 || memlimit > MAX_MEMLIMIT || opslimit > MAX_OPSLIMIT) {
    throw new Error('Refusing to decrypt: suspicious Argon2 parameters in file header');
  }
  const salt  = sealedBytes.slice(12, 12 + SALT_BYTES);
  const nonce = sealedBytes.slice(12 + SALT_BYTES, 12 + SALT_BYTES + NONCE_BYTES);
  return {
    memlimit, opslimit, salt, nonce,
    aad: sealedBytes.slice(0, HEADER_BYTES),
    ciphertext: sealedBytes.slice(HEADER_BYTES),
  };
}

// ─── Batch variants — key already derived once for a whole group ─────────────
// On-disk format is the same v2 format as seal()/unseal(); only the key
// derivation is skipped here because the caller already has it.
export async function sealWithKey(plainBytes, key, salt, params = DEFAULT_ARGON2_PARAMS) {
  const nonce  = await randomBytes(NONCE_BYTES);
  const header = packHeaderV2(params.memlimit, params.opslimit, salt, nonce);
  const ciphertext = await aeadEncrypt(plainBytes, key, nonce, header);
  return concatBytes(header, ciphertext);
}

export async function unsealWithKey(sealedBytes, key) {
  const v2 = parseHeaderV2(sealedBytes);
  if (v2) return aeadDecrypt(v2.ciphertext, key, v2.nonce, v2.aad);
  return legacyUnsealWithKey(sealedBytes, key);
}

export function getSalt(sealedBytes) {
  try {
    const v2 = parseHeaderV2(sealedBytes);
    if (v2) return v2.salt;
  } catch { /* fall through to legacy */ }
  return sealedBytes.slice(0, 16);
}

// ─── Seal / unseal with a passphrase directly (ungrouped photos) ─────────────
export async function seal(plainBytes, passphrase, options = {}) {
  const params = options.argon2Params || DEFAULT_ARGON2_PARAMS;
  const saltLen = await getSaltBytes();
  if (saltLen !== SALT_BYTES) {
    // The v2 file format reserves a fixed SALT_BYTES-wide slot for the salt.
    // If this ever fires, the format needs a version bump — don't silently
    // write a file whose header layout won't parse back correctly.
    throw new Error(`crypto_pwhash salt length is ${saltLen}, but the v2 file format assumes ${SALT_BYTES}. Refusing to encrypt.`);
  }
  const salt = await randomBytes(saltLen);
  const key  = await deriveKey(passphrase, salt, params);
  return sealWithKey(plainBytes, key, salt, params);
}

export async function unseal(sealedBytes, passphrase, options = {}) {
  const v2 = parseHeaderV2(sealedBytes); // throws on bad params, returns null if not v2
  if (v2) {
    const key = await deriveKey(passphrase, v2.salt, { opslimit: v2.opslimit, memlimit: v2.memlimit });
    return aeadDecrypt(v2.ciphertext, key, v2.nonce, v2.aad);
  }
  return legacyUnseal(sealedBytes, passphrase, options);
}

// ─── Legacy AES-256-CTR decrypt path (v1 format, decrypt-only) ───────────────
// AES-CTR never fails on its own with a wrong key, it just returns garbage,
// so the MAGIC + checksum header is what actually detects a bad passphrase.
function legacyUnsealWithKey(sealedBytes, key) {
  if (sealedBytes.length < 33) throw new Error('Invalid sealed data');
  const iv         = sealedBytes.slice(16, 32);
  const ciphertext = sealedBytes.slice(32);
  const aesCtr = new aesjs.ModeOfOperation.ctr(key, new aesjs.Counter(iv));
  const decrypted = new Uint8Array(aesCtr.decrypt(ciphertext));
  if (decrypted.length < 36 || !bytesEqual(decrypted.slice(0, 4), MAGIC_V1)) {
    throw new Error('Wrong passphrase');
  }
  const checksum = decrypted.slice(4, 36);
  const plain    = decrypted.slice(36);
  if (!bytesEqual(checksum, sha256(plain))) {
    throw new Error('Wrong passphrase');
  }
  return plain;
}

function legacyUnseal(sealedBytes, passphrase, options = {}) {
  if (sealedBytes.length < 33) throw new Error('Invalid sealed data');
  const salt = sealedBytes.slice(0, 16);

  // Try every known iteration count in most-likely-first order.
  // If the caller explicitly passes iterations, honour it and skip the loop.
  const iterList = options.iterations
    ? [options.iterations]
    : [DEFAULT_KDF_ITERATIONS, LEGACY_KDF_ITERATIONS, 8000];

  for (const iterations of iterList) {
    const key = deriveKeyLegacy(passphrase, salt, iterations);
    try {
      return legacyUnsealWithKey(sealedBytes, key);
    } catch { /* try next iteration count */ }
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
