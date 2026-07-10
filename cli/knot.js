#!/usr/bin/env node
/**
 * Knot CLI — decrypt/encrypt vault files outside the app.
 *
 * Supports two on-disk formats, auto-detected on decrypt:
 *
 * v2 (current — used for all new encryption):
 *   [ MAGIC "KNT2" (4 bytes) ]
 *   [ memlimit (4 bytes, uint32 LE) ]
 *   [ opslimit (4 bytes, uint32 LE) ]
 *   [ salt (16 bytes) ]
 *   [ nonce (24 bytes) ]
 *   [ ciphertext + Poly1305 tag ]
 *
 *   key    = Argon2id(passphrase, salt, opslimit, memlimit, 32 bytes)
 *   cipher = XChaCha20-Poly1305(key, nonce), AAD = header bytes (magic+memlimit+opslimit+salt)
 *
 * v1 (legacy — decrypt only):
 *   [ salt (16 bytes) ][ iv (16 bytes) ][ ciphertext ]
 *   ciphertext = AES-256-CTR(key, iv) applied to:
 *     [ MAGIC "KNT1" (4 bytes) ][ sha256(plaintext) (32 bytes) ][ plaintext ]
 *   key = PBKDF2-HMAC-SHA256(passphrase, salt, iterations, 32 bytes)
 *   Default iterations = 2000. Older files used 8000 or 15000 — pass
 *   --iter 8000 or --iter 15000 if a v1 decrypt fails with "wrong passphrase".
 *
 * Encrypting with this tool always writes the current v2 format.
 *
 * Dependencies: `libsodium-wrappers` (npm install libsodium-wrappers) for
 * Argon2id + XChaCha20-Poly1305. Node's built-in `crypto` is still used for
 * the legacy v1 AES-CTR/PBKDF2 path.
 *
 * Usage:
 *   node knot.js decrypt <input.dat> <output.jpg> "<passphrase>" [--iter 8000]
 *   node knot.js encrypt <input.jpg> <output.dat> "<passphrase>" [--strength interactive|moderate]
 */

const fs = require('fs');
const crypto = require('crypto');
const sodium = require('libsodium-wrappers');

const MAGIC_V1 = Buffer.from([0x4b, 0x4e, 0x54, 0x31]); // "KNT1"
const MAGIC_V2 = Buffer.from([0x4b, 0x4e, 0x54, 0x32]); // "KNT2"
const DEFAULT_ITER = 2000; // legacy v1 only

const SALT_BYTES = 16;
const NONCE_BYTES = 24;
const HEADER_BYTES = 4 + 4 + 4 + SALT_BYTES + NONCE_BYTES; // 52

const ARGON2_PRESETS = {
  interactive: { opslimit: 2, memlimit: 64 * 1024 * 1024 },
  moderate:    { opslimit: 3, memlimit: 256 * 1024 * 1024 },
};

// ─── v1 legacy (decrypt-only) ─────────────────────────────────────────────────
function legacyDeriveKey(passphrase, salt, iterations) {
  return crypto.pbkdf2Sync(Buffer.from(passphrase, 'utf8'), salt, iterations, 32, 'sha256');
}

function decryptV1(data, passphrase, iterations) {
  const salt = data.subarray(0, 16);
  const iv = data.subarray(16, 32);
  const ciphertext = data.subarray(32);

  const key = legacyDeriveKey(passphrase, salt, iterations);
  const decipher = crypto.createDecipheriv('aes-256-ctr', key, iv);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  if (decrypted.length < 36 || !decrypted.subarray(0, 4).equals(MAGIC_V1)) {
    throw new Error('Wrong passphrase (magic header mismatch)');
  }
  const checksum = decrypted.subarray(4, 36);
  const plain = decrypted.subarray(36);
  const actual = crypto.createHash('sha256').update(plain).digest();
  if (!checksum.equals(actual)) {
    throw new Error('Wrong passphrase (checksum mismatch)');
  }
  return plain;
}

// ─── v2 (current) ─────────────────────────────────────────────────────────────
async function decryptV2(data, passphrase) {
  await sodium.ready;
  const memlimit = data.readUInt32LE(4);
  const opslimit = data.readUInt32LE(8);
  const salt  = data.subarray(12, 12 + SALT_BYTES);
  const nonce = data.subarray(12 + SALT_BYTES, 12 + SALT_BYTES + NONCE_BYTES);
  const header = data.subarray(0, HEADER_BYTES);
  const ciphertext = data.subarray(HEADER_BYTES);

  if (memlimit > 1024 * 1024 * 1024 || opslimit > 20) {
    throw new Error('Refusing to decrypt: suspicious Argon2 parameters in file header');
  }

  const key = sodium.crypto_pwhash(
    32, passphrase, salt, opslimit, memlimit, sodium.crypto_pwhash_ALG_ARGON2ID13
  );

  try {
    const plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null, ciphertext, header, nonce, key
    );
    return Buffer.from(plain);
  } catch {
    throw new Error('Wrong passphrase (authentication failed)');
  }
}

async function encryptV2(plain, passphrase, strength) {
  await sodium.ready;
  const params = ARGON2_PRESETS[strength] || ARGON2_PRESETS.moderate;
  const salt  = sodium.randombytes_buf(SALT_BYTES);
  const nonce = sodium.randombytes_buf(NONCE_BYTES);
  const key = sodium.crypto_pwhash(
    32, passphrase, salt, params.opslimit, params.memlimit, sodium.crypto_pwhash_ALG_ARGON2ID13
  );

  const header = Buffer.alloc(HEADER_BYTES);
  MAGIC_V2.copy(header, 0);
  header.writeUInt32LE(params.memlimit, 4);
  header.writeUInt32LE(params.opslimit, 8);
  Buffer.from(salt).copy(header, 12);
  Buffer.from(nonce).copy(header, 12 + SALT_BYTES);

  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plain, header, null, nonce, key
  );
  return Buffer.concat([header, Buffer.from(ciphertext)]);
}

// ─── Commands ──────────────────────────────────────────────────────────────
async function decryptFile(inPath, outPath, passphrase, iterations) {
  const data = fs.readFileSync(inPath);
  if (data.length < 33) throw new Error('Invalid sealed file (too short)');

  let plain, formatUsed;
  if (data.length >= HEADER_BYTES + 16 && data.subarray(0, 4).equals(MAGIC_V2)) {
    plain = await decryptV2(data, passphrase);
    formatUsed = 'v2 (XChaCha20-Poly1305 + Argon2id)';
  } else {
    plain = decryptV1(data, passphrase, iterations);
    formatUsed = `v1 legacy (AES-256-CTR + PBKDF2, iterations=${iterations})`;
  }

  fs.writeFileSync(outPath, plain);
  console.log(`Decrypted ${data.length} bytes -> ${outPath} (${plain.length} bytes) [${formatUsed}]`);
}

async function encryptFile(inPath, outPath, passphrase, strength) {
  const plain = fs.readFileSync(inPath);
  const out = await encryptV2(plain, passphrase, strength);
  fs.writeFileSync(outPath, out);
  console.log(`Encrypted ${plain.length} bytes -> ${outPath} (${out.length} bytes, argon2=${strength})`);
}

async function main() {
  const [, , cmd, inPath, outPath, passphrase, ...rest] = process.argv;

  if (!cmd || !inPath || !outPath || passphrase === undefined) {
    console.log(`Usage:
  node knot.js decrypt <input.dat> <output.jpg> "<passphrase>" [--iter N]
  node knot.js encrypt <input.jpg> <output.dat> "<passphrase>" [--strength interactive|moderate]

--iter only affects decrypting legacy v1 files (default ${DEFAULT_ITER}; older files may need 8000 or 15000).
--strength only affects encrypting new v2 files (default moderate).`);
    process.exit(1);
  }

  let iterations = DEFAULT_ITER;
  const iterFlagIdx = rest.indexOf('--iter');
  if (iterFlagIdx !== -1 && rest[iterFlagIdx + 1]) {
    iterations = parseInt(rest[iterFlagIdx + 1], 10);
  }

  let strength = 'moderate';
  const strengthFlagIdx = rest.indexOf('--strength');
  if (strengthFlagIdx !== -1 && rest[strengthFlagIdx + 1]) {
    strength = rest[strengthFlagIdx + 1];
  }

  try {
    if (cmd === 'decrypt') {
      await decryptFile(inPath, outPath, passphrase, iterations);
    } else if (cmd === 'encrypt') {
      await encryptFile(inPath, outPath, passphrase, strength);
    } else {
      console.error(`Unknown command: ${cmd}. Use "decrypt" or "encrypt".`);
      process.exit(1);
    }
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
}

main();
