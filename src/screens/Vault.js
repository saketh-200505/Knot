import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  Image, FlatList, Dimensions, Modal, Animated, Platform,
  Alert, ActivityIndicator,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import { seal, unseal, base64ToUint8, uint8ToBase64 } from '../utils/crypto';
import {
  getPhotoIndex, addPhotoToIndex, removePhotoFromIndex, savePhotoIndex,
  storage, KEYS, getSessionDuration,
} from '../utils/storage';
import { useSession } from '../hooks/useSession';
import { SessionBar } from '../components/SessionBar';
import { PassSheet } from '../components/PassSheet';
import { Sheet } from '../components/Sheet';
import { Toast } from '../components/Toast';
import { COLORS, FONTS, RADIUS, SPACING } from '../utils/theme';
import { hashStr, verifyHash, passwordStrength } from '../utils/crypto';
import { TextInput } from 'react-native';
import { getGesture } from '../utils/storage';

const { width: SW } = Dimensions.get('window');
const THUMB_SIZE = (SW - 40 - 16) / 3;
const VAULT_DIR = FileSystem.documentDirectory + 'vault/';

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function ensureVaultDir() {
  const info = await FileSystem.getInfoAsync(VAULT_DIR);
  if (!info.exists) await FileSystem.makeDirectoryAsync(VAULT_DIR, { intermediates: true });
}

async function readFileAsUint8(uri) {
  const b64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  return base64ToUint8(b64);
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// ─── Tab components ────────────────────────────────────────────────────────────
const TABS = ['Gallery', 'Settings'];
const ARROW_ICONS = { up: '↑', down: '↓', left: '←', right: '→' };
const DEFAULT_GESTURE = ['up', 'up', 'down', 'down'];

// ─── Main Vault Screen ─────────────────────────────────────────────────────────
export function Vault({ onLogout }) {
  const session = useSession();
  const [tab, setTab]               = useState(0);
  const [photos, setPhotos]         = useState([]);
  const [loading, setLoading]       = useState(false);
  const [importing, setImporting]   = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected]     = useState(new Set());
  const [toast, setToast]           = useState({ visible: false, msg: '', type: 'info' });
  const [viewPhoto, setViewPhoto]   = useState(null);
  const [showUnlock, setShowUnlock] = useState(false);
  const [showImportPass, setShowImportPass] = useState(false);
  const [pendingFiles, setPendingFiles] = useState([]);
  const [importSamePass, setImportSamePass] = useState(true);
  const [showImportChoice, setShowImportChoice] = useState(false);
  const [pendingFileIdx, setPendingFileIdx] = useState(0);
  const [pendingPasses, setPendingPasses] = useState([]);
  const [showExport, setShowExport] = useState(false);
  const [exportTarget, setExportTarget] = useState(null); // null = selected
  const [showExtendSheet, setShowExtendSheet] = useState(false);
  const fadeAnim = useRef(new Animated.Value(0)).current;

  // Settings state
  const [sessionDur, setSessionDur] = useState(3);
  const [gesture, setGesture]       = useState([...DEFAULT_GESTURE]);
  const [gestureRecording, setGestureRecording] = useState(false);
  const [showChangePw, setShowChangePw] = useState(false);
  const [curPw, setCurPw]           = useState('');
  const [newPw, setNewPw]           = useState('');
  const [newPw2, setNewPw2]         = useState('');
  const [pwError, setPwError]       = useState('');

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 500, useNativeDriver: true }).start();
    loadPhotos();
    loadSettings();
  }, []);

  useEffect(() => {
    if (session.showExtend) setShowExtendSheet(true);
  }, [session.showExtend]);

  const showToast = (msg, type = 'info') => {
    setToast({ visible: true, msg, type });
  };

  const loadPhotos = async () => {
    const idx = await getPhotoIndex();
    setPhotos(idx);
  };

  const loadSettings = async () => {
    const dur = await getSessionDuration();
    setSessionDur(dur);
    const g = await getGesture();
    setGesture(g);
  };

  // ── Import ──────────────────────────────────────────────────────────────────
  const pickImages = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') { showToast('Photo access needed', 'error'); return; }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsMultipleSelection: true,
      quality: 1,
      base64: false,
    });
    if (result.canceled || !result.assets?.length) return;
    setPendingFiles(result.assets);
    if (result.assets.length > 1) {
      setShowImportChoice(true);
    } else {
      setImportSamePass(true);
      setShowImportPass(true);
    }
  };

  const doImportSamePass = async (passphrase) => {
    setShowImportPass(false);
    setImporting(true);
    await ensureVaultDir();
    let count = 0;
    for (const asset of pendingFiles) {
      try {
        const bytes = await readFileAsUint8(asset.uri);
        const sealed = await seal(bytes, passphrase);
        const id = generateId();
        const filePath = VAULT_DIR + id + '.dat';
        await FileSystem.writeAsStringAsync(filePath, uint8ToBase64(sealed), {
          encoding: FileSystem.EncodingType.Base64,
        });
        // Generate a blurred thumbnail (just store the original URI as thumb placeholder)
        // On real device we'd blur it; here we store the asset uri temporarily
        const mimeType = asset.mimeType || 'image/jpeg';
        const ext = mimeType.split('/')[1] || 'jpg';
        const entry = {
          id,
          filePath,
          thumbUri: asset.uri, // blurred in render
          mimeType,
          name: asset.fileName || `photo_${id}.${ext}`,
          addedAt: Date.now(),
        };
        await addPhotoToIndex(entry);
        count++;
      } catch (e) {
        console.warn('Import error', e);
      }
    }
    await loadPhotos();
    setImporting(false);
    setPendingFiles([]);
    showToast(`${count} photo${count !== 1 ? 's' : ''} added`, 'success');
  };

  // Per-photo passphrase import
  const doImportPerPhoto = async () => {
    setShowImportChoice(false);
    setPendingFileIdx(0);
    setPendingPasses([]);
    // Show pass sheet for first photo
    setShowImportPass(true);
    setImportSamePass(false);
  };

  const handlePerPhotoPass = async (passphrase) => {
    setShowImportPass(false);
    const newPasses = [...pendingPasses, passphrase];
    if (newPasses.length < pendingFiles.length) {
      setPendingPasses(newPasses);
      setPendingFileIdx(newPasses.length);
      setTimeout(() => setShowImportPass(true), 300);
    } else {
      // All passphrases collected — import
      setImporting(true);
      await ensureVaultDir();
      let count = 0;
      for (let i = 0; i < pendingFiles.length; i++) {
        try {
          const asset = pendingFiles[i];
          const pass  = newPasses[i];
          const bytes = await readFileAsUint8(asset.uri);
          const sealed = await seal(bytes, pass);
          const id = generateId();
          const filePath = VAULT_DIR + id + '.dat';
          await FileSystem.writeAsStringAsync(filePath, uint8ToBase64(sealed), {
            encoding: FileSystem.EncodingType.Base64,
          });
          const mimeType = asset.mimeType || 'image/jpeg';
          const ext = mimeType.split('/')[1] || 'jpg';
          const entry = {
            id, filePath,
            thumbUri: asset.uri,
            mimeType,
            name: asset.fileName || `photo_${id}.${ext}`,
            addedAt: Date.now(),
          };
          await addPhotoToIndex(entry);
          count++;
        } catch {}
      }
      await loadPhotos();
      setImporting(false);
      setPendingFiles([]);
      setPendingPasses([]);
      showToast(`${count} photo${count !== 1 ? 's' : ''} added`, 'success');
    }
  };

  // ── Unlock session ───────────────────────────────────────────────────────────
  const handleUnlock = async (passphrase) => {
    setShowUnlock(false);
    setLoading(true);
    try {
      // Load encrypted blobs from disk
      const photosWithData = await Promise.all(
        photos.map(async (p) => {
          const b64 = await FileSystem.readAsStringAsync(p.filePath, {
            encoding: FileSystem.EncodingType.Base64,
          }).catch(() => null);
          return b64 ? { ...p, sealedB64: b64 } : null;
        })
      );
      const valid = photosWithData.filter(Boolean);
      const unlocked = await session.unlock(valid, passphrase);
      if (unlocked === 0) {
        showToast('Wrong passphrase — no photos unlocked', 'error');
      } else {
        showToast(`${unlocked} photo${unlocked !== 1 ? 's' : ''} unlocked`, 'success');
      }
    } catch (e) {
      showToast('Could not unlock photos', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleExtend = async (passphrase) => {
    setShowExtendSheet(false);
    setLoading(true);
    try {
      const photosWithData = await Promise.all(
        photos.map(async (p) => {
          const b64 = await FileSystem.readAsStringAsync(p.filePath, {
            encoding: FileSystem.EncodingType.Base64,
          }).catch(() => null);
          return b64 ? { ...p, sealedB64: b64 } : null;
        })
      );
      await session.extend(photosWithData.filter(Boolean), passphrase);
      showToast('Session extended', 'success');
    } catch {
      showToast('Extension failed', 'error');
    } finally {
      setLoading(false);
    }
  };

  // ── Export ───────────────────────────────────────────────────────────────────
  const handleExport = async (passphrase) => {
    setShowExport(false);
    const targets = exportTarget
      ? [photos.find(p => p.id === exportTarget)].filter(Boolean)
      : photos.filter(p => selected.has(p.id));
    if (!targets.length) return;
    setLoading(true);
    let count = 0;
    for (const photo of targets) {
      try {
        const b64 = await FileSystem.readAsStringAsync(photo.filePath, {
          encoding: FileSystem.EncodingType.Base64,
        });
        const sealed = base64ToUint8(b64);
        const plain  = await unseal(sealed, passphrase);
        const outPath = FileSystem.cacheDirectory + photo.name;
        await FileSystem.writeAsStringAsync(outPath, uint8ToBase64(plain), {
          encoding: FileSystem.EncodingType.Base64,
        });
        const { status } = await MediaLibrary.requestPermissionsAsync();
        if (status === 'granted') {
          await MediaLibrary.saveToLibraryAsync(outPath);
          count++;
        }
        await FileSystem.deleteAsync(outPath, { idempotent: true });
      } catch {
        showToast('Wrong passphrase for one or more photos', 'error');
      }
    }
    setLoading(false);
    setSelectMode(false);
    setSelected(new Set());
    setExportTarget(null);
    if (count > 0) showToast(`${count} photo${count !== 1 ? 's' : ''} saved to library`, 'success');
  };

  // ── Delete ────────────────────────────────────────────────────────────────────
  const deleteSelected = () => {
    Alert.alert(
      'Remove Photos',
      `Remove ${selected.size} photo${selected.size !== 1 ? 's' : ''}? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove', style: 'destructive',
          onPress: async () => {
            for (const id of selected) {
              const photo = photos.find(p => p.id === id);
              if (photo) {
                await FileSystem.deleteAsync(photo.filePath, { idempotent: true });
                await removePhotoFromIndex(id);
              }
            }
            await loadPhotos();
            setSelectMode(false);
            setSelected(new Set());
            showToast('Photos removed', 'warn');
          },
        },
      ]
    );
  };

  // ── Settings ──────────────────────────────────────────────────────────────────
  const saveSessionDur = async (d) => {
    setSessionDur(d);
    await storage.set(KEYS.SESSION_DURATION, String(d));
    showToast(`Session set to ${d} min`, 'success');
  };

  const addGestureMove = (dir) => {
    if (!gestureRecording) return;
    setGesture(prev => prev.length >= 8 ? prev : [...prev, dir]);
  };

  const saveGesture = async () => {
    await storage.set(KEYS.GESTURE, JSON.stringify(gesture));
    showToast('Secret sequence updated', 'success');
  };

  const changePassword = async () => {
    setPwError('');
    if (newPw.length < 4) { setPwError('Minimum 4 characters'); return; }
    if (newPw !== newPw2)  { setPwError('Passwords do not match'); return; }
    const stored = await storage.get(KEYS.VAULT_PW_HASH);
    const ok = await verifyHash(curPw, stored);
    if (!ok) { setPwError('Current code is incorrect'); return; }
    const hash = await hashStr(newPw);
    await storage.set(KEYS.VAULT_PW_HASH, hash);
    setCurPw(''); setNewPw(''); setNewPw2('');
    setShowChangePw(false);
    showToast('Access code updated', 'success');
  };

  // ── Render Photo Card ─────────────────────────────────────────────────────────
  const renderPhoto = ({ item: photo }) => {
    const decryptedUrl = session.decryptedMap[photo.id];
    const isLive = !!decryptedUrl;
    const isSel  = selected.has(photo.id);

    const onPress = () => {
      if (selectMode) {
        setSelected(prev => {
          const s = new Set(prev);
          s.has(photo.id) ? s.delete(photo.id) : s.add(photo.id);
          return s;
        });
      } else if (isLive) {
        setViewPhoto(photo);
      } else {
        setShowUnlock(true);
      }
    };

    const onLongPress = () => {
      setSelectMode(true);
      setSelected(new Set([photo.id]));
    };

    return (
      <TouchableOpacity
        style={[s.photoCard, isSel && s.photoCardSel]}
        onPress={onPress}
        onLongPress={onLongPress}
        activeOpacity={0.8}
      >
        <Image
          source={{ uri: decryptedUrl || photo.thumbUri }}
          style={[
            s.thumb,
            !isLive && session.blurring && { opacity: 0.2 },
          ]}
          blurRadius={isLive ? (session.blurring ? 8 : 0) : 6}
          resizeMode="cover"
        />
        {isLive && (
          <View style={s.liveBadge}>
            <View style={s.liveDot} />
            <Text style={s.liveTxt}>LIVE</Text>
          </View>
        )}
        {!isLive && (
          <View style={s.lockBadge}>
            <Text style={s.lockIcon}>🔒</Text>
          </View>
        )}
        {isSel && (
          <View style={s.selOverlay}>
            <Text style={s.selCheck}>✓</Text>
          </View>
        )}
      </TouchableOpacity>
    );
  };

  // ── Gallery tab ───────────────────────────────────────────────────────────────
  const GalleryTab = () => (
    <View style={{ flex: 1 }}>
      {session.active && (
        <SessionBar
          remaining={session.remaining}
          total={session.totalSecs}
          blurring={session.blurring}
        />
      )}
      <View style={s.toolbar}>
        {selectMode ? (
          <>
            <Text style={s.toolbarTitle}>{selected.size} selected</Text>
            <View style={s.toolbarBtns}>
              <TouchableOpacity
                style={s.toolbarBtn}
                onPress={() => {
                  setExportTarget(null);
                  setShowExport(true);
                }}
                disabled={selected.size === 0}
              >
                <Text style={s.toolbarBtnTxt}>Export</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.toolbarBtn, { borderColor: COLORS.rose }]}
                onPress={deleteSelected}
                disabled={selected.size === 0}
              >
                <Text style={[s.toolbarBtnTxt, { color: COLORS.rose }]}>Delete</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.toolbarBtn, { borderColor: COLORS.textMuted }]}
                onPress={() => { setSelectMode(false); setSelected(new Set()); }}
              >
                <Text style={[s.toolbarBtnTxt, { color: COLORS.textMuted }]}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </>
        ) : (
          <>
            <Text style={s.toolbarTitle}>{photos.length} photo{photos.length !== 1 ? 's' : ''}</Text>
            <View style={s.toolbarBtns}>
              {session.active ? (
                <TouchableOpacity
                  style={[s.toolbarBtn, { borderColor: COLORS.rose }]}
                  onPress={session.wipe}
                >
                  <Text style={[s.toolbarBtnTxt, { color: COLORS.rose }]}>Lock</Text>
                </TouchableOpacity>
              ) : (
                photos.length > 0 && (
                  <TouchableOpacity style={s.toolbarBtn} onPress={() => setShowUnlock(true)}>
                    <Text style={s.toolbarBtnTxt}>Unlock</Text>
                  </TouchableOpacity>
                )
              )}
              <TouchableOpacity
                style={[s.toolbarBtn, { borderColor: COLORS.blue }]}
                onPress={pickImages}
                disabled={importing}
              >
                <Text style={[s.toolbarBtnTxt, { color: COLORS.blue }]}>
                  {importing ? '…' : '+ Add'}
                </Text>
              </TouchableOpacity>
            </View>
          </>
        )}
      </View>

      {photos.length === 0 ? (
        <View style={s.empty}>
          <Text style={s.emptyIcon}>🖼</Text>
          <Text style={s.emptyTitle}>No photos yet</Text>
          <Text style={s.emptyDesc}>Tap + Add to bring in your first photo</Text>
          <TouchableOpacity style={[s.btn, { marginTop: SPACING.md }]} onPress={pickImages}>
            <Text style={s.btnTxt}>Add Photos</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={photos}
          keyExtractor={p => p.id}
          numColumns={3}
          renderItem={renderPhoto}
          contentContainerStyle={s.grid}
          columnWrapperStyle={{ gap: 8 }}
          ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        />
      )}

      {(loading || importing) && (
        <View style={s.loadingOverlay}>
          <ActivityIndicator color={COLORS.green} size="large" />
          <Text style={s.loadingTxt}>{importing ? 'Encrypting…' : 'Decrypting…'}</Text>
        </View>
      )}
    </View>
  );

  // ── Settings tab ──────────────────────────────────────────────────────────────
  const SettingsTab = () => (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={s.settingsContent}>
      {/* Session Duration */}
      <View style={s.settingGroup}>
        <Text style={s.settingGroupTitle}>Session Duration</Text>
        <Text style={s.settingDesc}>How long to keep photos unlocked</Text>
        <View style={s.pillRow}>
          {[1, 3, 5, 10].map(d => (
            <TouchableOpacity
              key={d}
              style={[s.pill, sessionDur === d && s.pillActive]}
              onPress={() => saveSessionDur(d)}
            >
              <Text style={[s.pillTxt, sessionDur === d && s.pillTxtActive]}>
                {d} min
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* Secret Gesture */}
      <View style={s.settingGroup}>
        <Text style={s.settingGroupTitle}>Secret Sequence</Text>
        <Text style={s.settingDesc}>Enter this in-game to open the gallery</Text>
        <View style={s.gestureDisplay}>
          {gesture.map((g, i) => (
            <View key={i} style={s.gBadge}>
              <Text style={s.gArrow}>{ARROW_ICONS[g]}</Text>
            </View>
          ))}
          {gesture.length === 0 && (
            <Text style={{ color: COLORS.textMuted, fontFamily: FONTS.body, fontSize: 13 }}>
              No moves
            </Text>
          )}
        </View>
        <Text style={[s.recordLabel, gestureRecording && { color: COLORS.green }]}>
          {gestureRecording ? '● Recording — tap arrows below' : 'Tap Record to change'}
        </Text>
        <View style={s.miniDpad}>
          <View style={s.dpadRow}>
            <TouchableOpacity style={s.dpadBtn} onPress={() => addGestureMove('up')}>
              <Text style={s.dpadTxt}>↑</Text>
            </TouchableOpacity>
          </View>
          <View style={s.dpadRow}>
            <TouchableOpacity style={s.dpadBtn} onPress={() => addGestureMove('left')}>
              <Text style={s.dpadTxt}>←</Text>
            </TouchableOpacity>
            <View style={s.dpadCenter} />
            <TouchableOpacity style={s.dpadBtn} onPress={() => addGestureMove('right')}>
              <Text style={s.dpadTxt}>→</Text>
            </TouchableOpacity>
          </View>
          <View style={s.dpadRow}>
            <TouchableOpacity style={s.dpadBtn} onPress={() => addGestureMove('down')}>
              <Text style={s.dpadTxt}>↓</Text>
            </TouchableOpacity>
          </View>
        </View>
        <View style={s.gestureActions}>
          <TouchableOpacity
            style={[s.smallBtn, gestureRecording && { borderColor: COLORS.rose }]}
            onPress={() => setGestureRecording(r => !r)}
          >
            <Text style={s.smallBtnTxt}>{gestureRecording ? 'Stop' : 'Record'}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.smallBtn, { borderColor: COLORS.textMuted }]}
            onPress={() => setGesture([...DEFAULT_GESTURE])}
          >
            <Text style={[s.smallBtnTxt, { color: COLORS.textMuted }]}>Reset Default</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.smallBtn, { borderColor: COLORS.rose }]}
            onPress={() => setGesture([])}
          >
            <Text style={[s.smallBtnTxt, { color: COLORS.rose }]}>Clear</Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity style={[s.btn, { marginTop: SPACING.sm }]} onPress={saveGesture}>
          <Text style={s.btnTxt}>Save Sequence</Text>
        </TouchableOpacity>
      </View>

      {/* Change access code */}
      <View style={s.settingGroup}>
        <Text style={s.settingGroupTitle}>Access Code</Text>
        <Text style={s.settingDesc}>Change your gallery access code</Text>
        {showChangePw ? (
          <>
            <TextInput
              style={s.input}
              placeholder="Current code"
              placeholderTextColor={COLORS.textMuted}
              secureTextEntry
              value={curPw}
              onChangeText={t => { setCurPw(t); setPwError(''); }}
              autoCapitalize="none"
            />
            <TextInput
              style={s.input}
              placeholder="New code (min 4 chars)"
              placeholderTextColor={COLORS.textMuted}
              secureTextEntry
              value={newPw}
              onChangeText={t => { setNewPw(t); setPwError(''); }}
              autoCapitalize="none"
            />
            <TextInput
              style={s.input}
              placeholder="Confirm new code"
              placeholderTextColor={COLORS.textMuted}
              secureTextEntry
              value={newPw2}
              onChangeText={t => { setNewPw2(t); setPwError(''); }}
              autoCapitalize="none"
            />
            {pwError ? <Text style={s.errTxt}>{pwError}</Text> : null}
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TouchableOpacity style={[s.btn, { flex: 1 }]} onPress={changePassword}>
                <Text style={s.btnTxt}>Save</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.btn, { flex: 1, backgroundColor: COLORS.surface3 }]}
                onPress={() => { setShowChangePw(false); setPwError(''); }}
              >
                <Text style={s.btnTxt}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </>
        ) : (
          <TouchableOpacity
            style={[s.btn, { backgroundColor: COLORS.surface3 }]}
            onPress={() => setShowChangePw(true)}
          >
            <Text style={s.btnTxt}>Change Code</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Security note */}
      <View style={[s.settingGroup, { borderColor: COLORS.amber + '44', backgroundColor: '#1a1500' }]}>
        <Text style={[s.settingGroupTitle, { color: COLORS.amber }]}>⚠ Important</Text>
        <Text style={[s.settingDesc, { color: COLORS.amber + 'cc' }]}>
          Each photo's passphrase is independent of your access code.
          If you forget a photo's passphrase, that photo cannot be recovered — by anyone, ever.
          Store your passphrases safely.
        </Text>
      </View>

      {/* Logout */}
      <TouchableOpacity
        style={[s.btn, { backgroundColor: COLORS.surface3, marginTop: SPACING.md }]}
        onPress={() => { session.wipe(); onLogout?.(); }}
      >
        <Text style={[s.btnTxt, { color: COLORS.rose }]}>← Back to Game</Text>
      </TouchableOpacity>
    </ScrollView>
  );

  // ── Photo viewer ──────────────────────────────────────────────────────────────
  const PhotoViewer = () => {
    if (!viewPhoto) return null;
    const url = session.decryptedMap[viewPhoto.id];
    return (
      <Modal visible animationType="fade" onRequestClose={() => setViewPhoto(null)}>
        <View style={s.viewerRoot}>
          <TouchableOpacity style={s.viewerClose} onPress={() => setViewPhoto(null)}>
            <Text style={s.viewerCloseTxt}>✕</Text>
          </TouchableOpacity>
          <Image source={{ uri: url }} style={s.viewerImage} resizeMode="contain" />
          <View style={s.viewerActions}>
            <TouchableOpacity
              style={s.viewerBtn}
              onPress={() => { setExportTarget(viewPhoto.id); setViewPhoto(null); setShowExport(true); }}
            >
              <Text style={s.viewerBtnTxt}>Export</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    );
  };

  return (
    <Animated.View style={[s.root, { opacity: fadeAnim }]}>
      {/* Tab bar */}
      <View style={s.tabBar}>
        <Text style={s.appName}>My Gallery</Text>
        <View style={s.tabs}>
          {TABS.map((t, i) => (
            <TouchableOpacity
              key={t}
              style={[s.tabBtn, tab === i && s.tabBtnActive]}
              onPress={() => setTab(i)}
            >
              <Text style={[s.tabTxt, tab === i && s.tabTxtActive]}>{t}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {tab === 0 ? <GalleryTab /> : <SettingsTab />}

      {/* Modals */}
      <PhotoViewer />

      {/* Unlock session */}
      <PassSheet
        visible={showUnlock}
        onClose={() => setShowUnlock(false)}
        onConfirm={handleUnlock}
        title="Unlock Photos"
        subtitle="Enter your photo passphrase to view all photos"
        confirmLabel="Unlock All"
        loading={loading}
      />

      {/* Extend session */}
      <PassSheet
        visible={showExtendSheet}
        onClose={() => { setShowExtendSheet(false); session.wipe(); }}
        onConfirm={handleExtend}
        title="Session Expired"
        subtitle="Re-enter your photo passphrase to continue"
        confirmLabel="Extend Session"
        loading={loading}
      />

      {/* Import passphrase — same for all */}
      <PassSheet
        visible={showImportPass && importSamePass}
        onClose={() => { setShowImportPass(false); setPendingFiles([]); }}
        onConfirm={doImportSamePass}
        title="Set Passphrase"
        subtitle={`Encrypt ${pendingFiles.length} photo${pendingFiles.length !== 1 ? 's' : ''} with this passphrase`}
        confirmLabel="Encrypt & Add"
        withConfirm
        loading={importing}
      />

      {/* Import passphrase — per photo */}
      <PassSheet
        visible={showImportPass && !importSamePass}
        onClose={() => { setShowImportPass(false); setPendingFiles([]); setPendingPasses([]); }}
        onConfirm={handlePerPhotoPass}
        title={`Photo ${pendingFileIdx + 1} of ${pendingFiles.length}`}
        subtitle="Set a passphrase for this photo"
        confirmLabel="Next"
        withConfirm
        loading={importing}
      />

      {/* Import choice modal */}
      <Sheet visible={showImportChoice} onClose={() => setShowImportChoice(false)}>
        <View style={{ padding: SPACING.lg }}>
          <Text style={s.sheetTitle}>Adding {pendingFiles.length} photos</Text>
          <Text style={s.sheetDesc}>How would you like to set passphrases?</Text>
          <TouchableOpacity
            style={[s.btn, { marginBottom: SPACING.sm }]}
            onPress={() => {
              setShowImportChoice(false);
              setImportSamePass(true);
              setTimeout(() => setShowImportPass(true), 300);
            }}
          >
            <Text style={s.btnTxt}>Same passphrase for all</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.btn, { backgroundColor: COLORS.surface3 }]}
            onPress={() => {
              setShowImportChoice(false);
              doImportPerPhoto();
            }}
          >
            <Text style={s.btnTxt}>Different passphrase per photo</Text>
          </TouchableOpacity>
        </View>
      </Sheet>

      {/* Export passphrase */}
      <PassSheet
        visible={showExport}
        onClose={() => setShowExport(false)}
        onConfirm={handleExport}
        title="Export Photos"
        subtitle="Enter the passphrase for the selected photo(s)"
        confirmLabel="Save to Library"
        loading={loading}
      />

      {/* Toast */}
      <Toast
        visible={toast.visible}
        message={toast.msg}
        type={toast.type}
        onHide={() => setToast(t => ({ ...t, visible: false }))}
      />
    </Animated.View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg },
  tabBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACING.lg,
    paddingTop: 52,
    paddingBottom: SPACING.sm,
    backgroundColor: COLORS.surface1,
    borderBottomWidth: 1,
    borderColor: COLORS.border,
  },
  appName: {
    fontFamily: FONTS.headingX,
    color: COLORS.textPrimary,
    fontSize: 18,
  },
  tabs: { flexDirection: 'row', gap: 4 },
  tabBtn: {
    paddingHorizontal: SPACING.md,
    paddingVertical: 6,
    borderRadius: RADIUS.full,
  },
  tabBtnActive: {
    backgroundColor: COLORS.surface3,
  },
  tabTxt: {
    fontFamily: FONTS.body,
    color: COLORS.textMuted,
    fontSize: 13,
  },
  tabTxtActive: {
    color: COLORS.textPrimary,
    fontFamily: FONTS.bodyMed,
  },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
  },
  toolbarTitle: {
    fontFamily: FONTS.body,
    color: COLORS.textSecondary,
    fontSize: 13,
  },
  toolbarBtns: { flexDirection: 'row', gap: 8 },
  toolbarBtn: {
    borderWidth: 1,
    borderColor: COLORS.green,
    borderRadius: RADIUS.sm,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  toolbarBtnTxt: {
    fontFamily: FONTS.bodyMed,
    color: COLORS.green,
    fontSize: 13,
  },
  grid: { paddingHorizontal: SPACING.md, paddingBottom: 120 },
  photoCard: {
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: RADIUS.sm,
    overflow: 'hidden',
    backgroundColor: COLORS.surface2,
    position: 'relative',
  },
  photoCardSel: {
    borderWidth: 2,
    borderColor: COLORS.blue,
  },
  thumb: { width: '100%', height: '100%' },
  liveBadge: {
    position: 'absolute',
    top: 4, left: 4,
    backgroundColor: 'rgba(0,0,0,0.7)',
    borderRadius: RADIUS.sm,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 5,
    paddingVertical: 2,
    gap: 3,
  },
  liveDot: {
    width: 5, height: 5, borderRadius: 3,
    backgroundColor: COLORS.green,
  },
  liveTxt: {
    fontFamily: FONTS.mono,
    color: COLORS.green,
    fontSize: 9,
    letterSpacing: 1,
  },
  lockBadge: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lockIcon: { fontSize: 18, opacity: 0.8 },
  selOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(59,130,246,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  selCheck: {
    fontFamily: FONTS.heading,
    color: '#fff',
    fontSize: 24,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: SPACING.xxl,
  },
  emptyIcon: { fontSize: 56, marginBottom: SPACING.md },
  emptyTitle: {
    fontFamily: FONTS.heading,
    color: COLORS.textPrimary,
    fontSize: 18,
    marginBottom: 4,
  },
  emptyDesc: {
    fontFamily: FONTS.body,
    color: COLORS.textSecondary,
    fontSize: 13,
    textAlign: 'center',
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(8,10,15,0.85)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.sm,
  },
  loadingTxt: {
    fontFamily: FONTS.body,
    color: COLORS.textSecondary,
    fontSize: 13,
  },
  settingsContent: {
    padding: SPACING.lg,
    paddingBottom: 120,
    gap: SPACING.md,
  },
  settingGroup: {
    backgroundColor: COLORS.surface1,
    borderRadius: RADIUS.lg,
    padding: SPACING.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    gap: SPACING.sm,
  },
  settingGroupTitle: {
    fontFamily: FONTS.heading,
    color: COLORS.textPrimary,
    fontSize: 14,
    letterSpacing: 0.5,
  },
  settingDesc: {
    fontFamily: FONTS.body,
    color: COLORS.textSecondary,
    fontSize: 12,
  },
  pillRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  pill: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.full,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  pillActive: {
    borderColor: COLORS.green,
    backgroundColor: COLORS.greenDim,
  },
  pillTxt: {
    fontFamily: FONTS.body,
    color: COLORS.textSecondary,
    fontSize: 13,
  },
  pillTxtActive: { color: COLORS.green },
  gestureDisplay: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    minHeight: 40,
    alignItems: 'center',
  },
  gBadge: {
    backgroundColor: COLORS.surface3,
    borderRadius: RADIUS.xs,
    borderWidth: 1,
    borderColor: COLORS.green,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  gArrow: {
    fontFamily: FONTS.mono,
    color: COLORS.green,
    fontSize: 16,
  },
  recordLabel: {
    fontFamily: FONTS.mono,
    color: COLORS.textMuted,
    fontSize: 11,
    letterSpacing: 0.5,
  },
  miniDpad: { alignItems: 'center', gap: 2 },
  dpadRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 2,
  },
  dpadBtn: {
    width: 44, height: 44,
    backgroundColor: COLORS.surface2,
    borderRadius: RADIUS.sm,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dpadCenter: { width: 44, height: 44 },
  dpadTxt: {
    fontFamily: FONTS.mono,
    color: COLORS.textPrimary,
    fontSize: 18,
  },
  gestureActions: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
  },
  smallBtn: {
    borderWidth: 1,
    borderColor: COLORS.green,
    borderRadius: RADIUS.sm,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  smallBtnTxt: {
    fontFamily: FONTS.body,
    color: COLORS.green,
    fontSize: 12,
  },
  input: {
    backgroundColor: COLORS.surface2,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: SPACING.md,
    paddingVertical: 12,
    fontFamily: FONTS.body,
    color: COLORS.textPrimary,
    fontSize: 14,
    marginBottom: SPACING.xs,
  },
  btn: {
    backgroundColor: COLORS.green,
    borderRadius: RADIUS.md,
    paddingVertical: 13,
    alignItems: 'center',
  },
  btnTxt: {
    fontFamily: FONTS.heading,
    color: '#fff',
    fontSize: 14,
  },
  errTxt: {
    fontFamily: FONTS.body,
    color: COLORS.rose,
    fontSize: 12,
    marginBottom: 4,
  },
  sheetTitle: {
    fontFamily: FONTS.heading,
    color: COLORS.textPrimary,
    fontSize: 17,
    marginBottom: 4,
  },
  sheetDesc: {
    fontFamily: FONTS.body,
    color: COLORS.textSecondary,
    fontSize: 13,
    marginBottom: SPACING.md,
  },
  viewerRoot: {
    flex: 1,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  viewerClose: {
    position: 'absolute',
    top: 52, right: SPACING.lg,
    width: 36, height: 36,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: RADIUS.full,
    alignItems: 'center', justifyContent: 'center',
    zIndex: 10,
  },
  viewerCloseTxt: {
    color: '#fff', fontSize: 16,
  },
  viewerImage: {
    width: SW,
    height: SW,
  },
  viewerActions: {
    position: 'absolute',
    bottom: 60,
    flexDirection: 'row',
    gap: SPACING.md,
  },
  viewerBtn: {
    backgroundColor: COLORS.surface2,
    borderRadius: RADIUS.md,
    paddingHorizontal: SPACING.xl,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  viewerBtnTxt: {
    fontFamily: FONTS.heading,
    color: COLORS.textPrimary,
    fontSize: 14,
  },
});
