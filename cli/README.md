# Knot CLI

Command-line tool to encrypt and decrypt Knot vault files outside the app.

## Requirements

- Node.js
- `libsodium-wrappers-sumo` (the **sumo** build — the plain `libsodium-wrappers`
  package does not include Argon2id and will not work)

```bash
npm install libsodium-wrappers-sumo
```

## Encrypt

```bash
node knot.js encrypt <input.jpg> <output.dat> "<passphrase>" [--strength interactive|moderate]
```

- `<input.jpg>` — file to encrypt (any file type, not just images)
- `<output.dat>` — where to write the encrypted file
- `<passphrase>` — quote it if it contains spaces
- `--strength` — Argon2id cost preset, default `moderate`
  - `interactive` — faster, less memory (~64 MiB). Matches the app's mobile default.
  - `moderate` — slower, more memory (~256 MiB), stronger protection

**Example:**

```bash
node knot.js encrypt photo.jpg photo.dat "correct horse battery staple" --strength interactive
```

Encrypting always writes the current v2 format (XChaCha20-Poly1305 + Argon2id).

## Decrypt

```bash
node knot.js decrypt <input.dat> <output.jpg> "<passphrase>" [--iter N]
```

- `<input.dat>` — encrypted file to decrypt
- `<output.jpg>` — where to write the decrypted file
- `<passphrase>` — same passphrase used to encrypt
- `--iter` — only used for legacy v1 files (see below). Ignored for v2 files.

**Example:**

```bash
node knot.js decrypt photo.dat photo.jpg "correct horse battery staple"
```

The tool auto-detects the file format (v2 or legacy v1) — you don't need to
specify which one you're decrypting.

### Legacy (v1) files

Older files encrypted before the app's v2 refactor use a different format
(AES-256-CTR + PBKDF2). These still decrypt fine, but you may need to try a
different iteration count if you see "Wrong passphrase":

```bash
node knot.js decrypt old_photo.dat old_photo.jpg "passphrase" --iter 8000
node knot.js decrypt old_photo.dat old_photo.jpg "passphrase" --iter 15000
```

Default is `2000`. If you don't know which iteration count an old file used,
just try `2000`, then `8000`, then `15000` in order.

> Legacy files can only be **decrypted**, not created. Encrypting always
> produces a new v2 file.

## Troubleshooting

| Error | Meaning |
|---|---|
| `Wrong passphrase (authentication failed)` | Wrong passphrase, or a v2 file — check spelling/case, retry |
| `Wrong passphrase (magic header mismatch / checksum mismatch)` | Wrong passphrase on a v1 file — try a different `--iter` value |
| `Refusing to decrypt: suspicious Argon2 parameters in file header` | The file's header looks corrupted or tampered with |
| `Invalid sealed file (too short)` | Not a valid Knot vault file |
