#!/usr/bin/env node
/**
 * Knot CLI — decrypt/encrypt vault files outside the app.
 *
 * Format of a .dat file:
 *   [ salt (16 bytes) ][ iv (16 bytes) ][ ciphertext ]
 *
 * ciphertext = AES-256-CTR(key, iv) applied to:
 *   [ MAGIC "KNT1" (4 bytes) ][ sha256(plaintext) (32 bytes) ][ plaintext ]
 *
 * key = PBKDF2-HMAC-SHA256(passphrase, salt, iterations, 32 bytes)
 *
 * Default iterations = 2000 (matches the app's current DEFAULT_KDF_ITERATIONS).
 * Older files used 8000, and the very first version used 15000 — pass
 * --iter 8000 or --iter 15000 if a decrypt fails with "wrong passphrase".
 *
 * NOTE: since v4, all photos in the same group share one `salt` (so the app
 * derives the key once per group instead of once per photo). Each file still
 * stores its own salt+iv header, so this tool works unchanged per-file —
 * just note that several files from the same group will have the same salt.
 *
 * Usage:
 *   node knot.js decrypt <input.dat> <output.jpg> "<passphrase>" [--iter 8000]
 *   node knot.js encrypt <input.jpg> <output.dat> "<passphrase>" [--iter 8000]
 *
 * No dependencies — uses only Node's built-in `crypto` and `fs`.
 */

const fs = require('fs');
const crypto = require('crypto');

const MAGIC = Buffer.from([0x4b, 0x4e, 0x54, 0x31]); // "KNT1"
const DEFAULT_ITER = 2000;

function deriveKey(passphrase, salt, iterations) {
  return crypto.pbkdf2Sync(Buffer.from(passphrase, 'utf8'), salt, iterations, 32, 'sha256');
}

function decryptFile(inPath, outPath, passphrase, iterations) {
  const data = fs.readFileSync(inPath);
  if (data.length < 33) throw new Error('Invalid sealed file (too short)');

  const salt = data.subarray(0, 16);
  const iv = data.subarray(16, 32);
  const ciphertext = data.subarray(32);

  const key = deriveKey(passphrase, salt, iterations);
  const decipher = crypto.createDecipheriv('aes-256-ctr', key, iv);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  if (decrypted.length < 36 || !decrypted.subarray(0, 4).equals(MAGIC)) {
    throw new Error('Wrong passphrase (magic header mismatch)');
  }

  const checksum = decrypted.subarray(4, 36);
  const plain = decrypted.subarray(36);
  const actual = crypto.createHash('sha256').update(plain).digest();

  if (!checksum.equals(actual)) {
    throw new Error('Wrong passphrase (checksum mismatch)');
  }

  fs.writeFileSync(outPath, plain);
  console.log(`Decrypted ${data.length} bytes -> ${outPath} (${plain.length} bytes)`);
}

function encryptFile(inPath, outPath, passphrase, iterations) {
  const plain = fs.readFileSync(inPath);
  const checksum = crypto.createHash('sha256').update(plain).digest();
  const payload = Buffer.concat([MAGIC, checksum, plain]);

  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(16);
  const key = deriveKey(passphrase, salt, iterations);

  const cipher = crypto.createCipheriv('aes-256-ctr', key, iv);
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);

  const out = Buffer.concat([salt, iv, encrypted]);
  fs.writeFileSync(outPath, out);
  console.log(`Encrypted ${plain.length} bytes -> ${outPath} (${out.length} bytes, iterations=${iterations})`);
}

function main() {
  const [, , cmd, inPath, outPath, passphrase, ...rest] = process.argv;

  if (!cmd || !inPath || !outPath || passphrase === undefined) {
    console.log(`Usage:
  node knot.js decrypt <input.dat> <output.jpg> "<passphrase>" [--iter N]
  node knot.js encrypt <input.jpg> <output.dat> "<passphrase>" [--iter N]

Default iterations: ${DEFAULT_ITER} (older files may need --iter 8000 or --iter 15000)`);
    process.exit(1);
  }

  let iterations = DEFAULT_ITER;
  const iterFlagIdx = rest.indexOf('--iter');
  if (iterFlagIdx !== -1 && rest[iterFlagIdx + 1]) {
    iterations = parseInt(rest[iterFlagIdx + 1], 10);
  }

  try {
    if (cmd === 'decrypt') {
      decryptFile(inPath, outPath, passphrase, iterations);
    } else if (cmd === 'encrypt') {
      encryptFile(inPath, outPath, passphrase, iterations);
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
