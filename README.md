# ArcadeVault

A fully functional Snake arcade game with a hidden AES-256-GCM encrypted photo vault.
To anyone who opens the app, it's just Snake. The vault is invisible unless you know the secret gesture.

---

## Project Structure

```
ArcadeVault/
├── App.js                          Root navigator / route state
├── app.json                        Expo config + permissions
├── eas.json                        EAS Build profiles
├── package.json                    Dependencies
├── babel.config.js
├── plugins/
│   └── withFlagSecure.js           Android FLAG_SECURE config plugin
├── MainActivity.java.example       Reference for bare workflow
└── src/
    ├── utils/
    │   ├── theme.js                Color tokens, fonts, spacing
    │   ├── storage.js              AsyncStorage wrapper + photo index
    │   └── crypto.js               AES-256-GCM seal/unseal, PBKDF2, hashing
    ├── hooks/
    │   └── useSession.js           Ephemeral session — RAM-only decrypted state
    ├── components/
    │   ├── Toast.js                Animated toast notifications
    │   ├── Sheet.js                Bottom sheet modal
    │   ├── PassSheet.js            Passphrase entry bottom sheet
    │   ├── SessionBar.js           Countdown session timer bar
    │   └── SSBlock.js              Screenshot block overlay (web/iOS)
    └── screens/
        ├── Onboarding.js           5-step first-launch setup
        ├── SnakeGame.js            Playable Snake with hidden gesture detection
        ├── VaultLogin.js           Access code + forgot password flow
        └── Vault.js                Gallery, import, export, settings, session
```

---

## Prerequisites

- **Node.js** 18+ (LTS recommended)
- **npm** 9+ or **yarn** 1.22+
- **Expo CLI**: `npm install -g expo-cli`
- **EAS CLI** (for production builds): `npm install -g eas-cli`
- For Android: Android Studio + SDK, or a physical Android device with Expo Go
- For iOS: Xcode 15+, or a physical iOS device with Expo Go

---

## Quick Start — Development

```bash
# 1. Clone / place the project folder
cd ArcadeVault

# 2. Install dependencies
npm install

# 3. Start the dev server
npx expo start

# 4. Scan the QR code with Expo Go (iOS or Android)
#    OR press 'a' for Android emulator / 'i' for iOS simulator
#    OR press 'w' for browser (web preview, full feature parity)
```

> **First launch:** The onboarding wizard runs once. Complete all 5 steps to start playing.

---

## Production Build (APK / IPA)

### Android APK (sideload / internal test)

```bash
# 1. Login to Expo account
eas login

# 2. Configure project (one-time)
eas build:configure

# 3. Build APK
eas build --platform android --profile preview

# 4. Download APK from the EAS dashboard link printed in the terminal
#    Or: https://expo.dev/accounts/<you>/projects/arcadevault/builds
```

### Android AAB (Google Play)

```bash
eas build --platform android --profile production
```

### iOS IPA

```bash
eas build --platform ios --profile production
```

---

## FLAG_SECURE (Android Screenshot Block)

FLAG_SECURE blocks hardware screenshot, ADB screencap, and the recents thumbnail.

### Option A — Managed workflow (recommended)

Add the plugin to `app.json`:

```json
"plugins": [
  ["./plugins/withFlagSecure"],
  ... other plugins ...
]
```

Then rebuild: `eas build --platform android`.

### Option B — Bare workflow

Copy `MainActivity.java.example` to:
`android/app/src/main/java/com/arcadevault/app/MainActivity.java`

---

## Encryption Details

| Property            | Value                              |
|---------------------|------------------------------------|
| Algorithm           | AES-256-GCM (authenticated)        |
| Key derivation      | PBKDF2-SHA256, 310,000 iterations  |
| Salt                | 16 bytes, random per photo         |
| IV                  | 12 bytes, random per photo         |
| Storage format      | `[salt(16)][iv(12)][ciphertext]`   |
| Hashing             | SHA-256 (passwords, recovery)      |
| Crypto provider     | Web Crypto API (`crypto.subtle`)   |

**Photo passphrases are independent of the vault access code.** If a photo passphrase is forgotten, the photo is permanently unrecoverable by design — no backdoor exists.

---

---

# USER MANUAL

---

## 1. First Launch — Setup Wizard

When you open ArcadeVault for the first time, a 5-step setup runs. It only runs once.

### Step 1 — Welcome
Tap **Get Started**.

### Step 2 — Access Code
This is the code you'll enter to open the gallery.
- Minimum 4 characters
- Strength indicator shows: Weak / Fair / Good / Strong / Very Strong
- Confirm the code before continuing

### Step 3 — Recovery Phrase
If you ever forget your access code, this phrase lets you reset it.
- The recovery phrase **does NOT** recover your photos (each photo has its own passphrase)
- Minimum 4 characters — use something memorable but not obvious
- Confirm before continuing

### Step 4 — Secret Sequence
This is the D-pad pattern you'll tap during the game to open the gallery.

**Default:** ↑ ↑ ↓ ↓

To customize:
1. Tap **Record**
2. Tap the arrow buttons (up to 8 moves)
3. Tap **Stop**
4. Tap **Reset Default** to go back to ↑↑↓↓, or **Clear** to start blank

### Step 5 — Done
Tap **Start Playing**. Setup is complete and never repeats.

---

## 2. Playing Snake

The app opens directly to a fully functional Snake game.

### Controls
| Method      | How                          |
|-------------|------------------------------|
| On-screen   | Tap the D-pad arrows         |
| Swipe       | Swipe on the game board      |
| Keyboard    | Arrow keys or W/A/S/D        |
| Start/Retry | Tap Play button or Spacebar  |

### Scoring
- +10 points per food eaten
- Speed increases every 50 points (Level up)
- High score saved locally for the session

---

## 3. Opening the Gallery

While on the game screen, enter your **secret sequence** using the D-pad buttons (or keyboard arrows / swipe).

**Default sequence: ↑ ↑ ↓ ↓**

The app silently navigates to the login screen — no animation, no indicator, nothing visible to a bystander.

### Gallery Login
1. Enter your **access code** (set during onboarding)
2. Tap **Open Gallery**

The gallery opens. It looks like a normal photo app.

### Forgot Access Code
1. On the login screen, tap **Forgot access code?**
2. Enter your **recovery phrase**
3. Enter and confirm a **new access code**
4. Tap **Reset Code**

> ⚠ Recovery phrase does NOT reset photo passphrases.

---

## 4. Adding Photos

### Import from Photo Library
1. In the gallery, tap **+ Add**
2. Select one or multiple photos from your library
3. If you selected multiple, choose:
   - **Same passphrase for all** — one passphrase encrypts all selected photos
   - **Different passphrase per photo** — you'll be prompted once per photo

4. Enter (and confirm) the passphrase(s)
5. Tap **Encrypt & Add**

Photos are encrypted on-device and the original is never stored in the vault folder.

> ⚠ **Write down your photo passphrases.** They cannot be recovered if forgotten — not by you, not by anyone.

---

## 5. Unlocking the Session

Photos in the gallery show a blurred thumbnail with a 🔒 icon until you start a session.

### Unlock All Photos
1. Tap **Unlock** (top toolbar) or tap any locked photo
2. Enter the passphrase you used when importing
3. Tap **Unlock All**

All photos encrypted with that passphrase will become visible simultaneously. Photos with a different passphrase stay locked.

### LIVE Badge
When a photo is successfully decrypted, a green **● LIVE** badge appears on the thumbnail.

### Session Timer
A progress bar at the top shows remaining session time.
- Default: 3 minutes
- Configurable: 1 / 3 / 5 / 10 minutes (in Settings)
- At **30 seconds** remaining: photos begin to blur out and a warning appears
- At **0 seconds**: a modal appears to extend or close

### Extend Session
1. When the "Session Expired" modal appears, enter your passphrase
2. Tap **Extend Session** — the full session restarts

### Lock Manually
Tap **Lock** in the toolbar at any time. All decrypted photos are immediately wiped from RAM.

---

## 6. Viewing Photos

With a session active, tap any live photo (● LIVE) to open it full-screen.

### Export from viewer
Tap **Export** → enter the photo's passphrase → photo saves to your device's photo library.

---

## 7. Exporting Photos

You can export photos back to your device's photo library at any time — no session required.

### Single export
1. Open a photo in full-screen
2. Tap **Export**
3. Enter the photo's passphrase
4. Tap **Save to Library**

### Bulk export
1. Long-press any photo to enter **Select mode**
2. Tap photos to select them (blue border = selected)
3. Tap **Export** in the toolbar
4. Enter the shared passphrase for those photos
5. Tap **Save to Library**

> The export is byte-for-byte identical to the original — zero quality loss.

---

## 8. Deleting Photos

1. Long-press any photo to enter **Select mode**
2. Select the photos to delete
3. Tap **Delete**
4. Confirm the alert

Deletion removes both the encrypted file and the index entry. This is **permanent and unrecoverable**.

---

## 9. Settings (inside gallery)

Tap the **Settings** tab in the gallery.

### Session Duration
Choose how long each session stays active: **1 / 3 / 5 / 10 minutes**.
Takes effect on the next unlock.

### Secret Sequence
Change the D-pad pattern used to open the gallery from the game screen.

1. Tap **Record**
2. Enter your new sequence (2–8 moves)
3. Tap **Stop**
4. Tap **Save Sequence**

Changes take effect immediately in the game — no restart needed.

### Access Code
Change your gallery access code:
1. Enter current code
2. Enter and confirm new code
3. Tap **Save**

### Security Warning
Each photo's passphrase is permanent and independent. If forgotten, photos are unrecoverable. Store passphrases safely.

---

## 10. Screenshot Protection

### Android
FLAG_SECURE blocks:
- Hardware screenshot button
- ADB screencap command
- Recents / app switcher thumbnail

Requires a production build (not Expo Go). Apply the `withFlagSecure` plugin before building.

### iOS / Web
A black overlay intercepts PrintScreen and Meta+Shift+S keyboard shortcuts. iOS screenshot blocking is limited by platform constraints.

---

## 11. Security Architecture

| Layer               | Mechanism                                              |
|---------------------|--------------------------------------------------------|
| Vault access        | SHA-256 hash stored; plaintext never saved             |
| Recovery phrase     | SHA-256 hash stored; plaintext never saved             |
| Photo encryption    | AES-256-GCM + PBKDF2 × 310,000 rounds                 |
| Key in RAM only     | Derived at unlock time; never persisted                |
| Decrypted data      | Blob URLs in JS heap; revoked on lock/expire           |
| Disk storage        | `.dat` files = [salt][iv][ciphertext] only             |
| Thumbnails          | Stored blurred; source URI from import (not re-stored) |
| Session expiry      | Hard timer; 30s blur warning; auto-wipe at 0           |

---

## 12. Troubleshooting

| Symptom | Fix |
|---------|-----|
| Fonts look wrong in dev | Fonts load async; wait 1–2 seconds on first launch |
| Photos don't unlock | Wrong passphrase. Each photo's passphrase is set at import time |
| "Photo access needed" | Go to Settings → Privacy → Photos → ArcadeVault → Allow |
| Export fails | Ensure "Save Photos" permission is granted |
| Game doesn't respond to keyboard | Click the game board first to give it focus (web only) |
| Gesture not triggering | Confirm sequence in gallery Settings, then re-enter exactly |
| Build fails on EAS | Run `eas build:configure` first; ensure `eas.json` projectId is set |

---

## 13. Key Design Decisions

- **No encryption labels in UI.** The gallery looks like a standard photo app — "Add Photos", "Export", "Gallery". No visible security terminology.
- **Photo passphrases ≠ vault password.** Intentional — even if someone obtains your access code, they still cannot view encrypted photos without each photo's passphrase.
- **Ephemeral only.** Decrypted bytes exist in RAM as Blob object URLs. `URL.revokeObjectURL()` is called on every URL at session end.
- **No cloud.** Everything stays on-device. No sync, no backup, no server.

---

## 14. Building for Production

```bash
# Install EAS
npm install -g eas-cli

# Login
eas login

# Initialize project (first time)
eas build:configure

# Android APK (internal distribution)
eas build --platform android --profile preview

# Android AAB (Play Store)
eas build --platform android --profile production

# iOS (TestFlight / App Store)
eas build --platform ios --profile production
```

After building, download the artifact from the EAS dashboard or the URL printed in your terminal.

---

## 15. Font Credits

- **Syne** — Display / headings (Google Fonts, OFL)
- **DM Sans** — Body text (Google Fonts, OFL)
- **Space Mono** — Scores, codes, monospace (Google Fonts, OFL)
