import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList,
  Image, ActivityIndicator, Alert,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Video, ResizeMode } from 'expo-av';
import {
  unseal, base64ToUint8, uint8ToBase64, LEGACY_KDF_ITERATIONS,
} from '../utils/crypto';
import {
  getImportedIndex, addImportedToIndex, removeImportedFromIndex, logEvent,
} from '../utils/storage';
import { Sheet } from './Sheet';
import { PassSheet } from './PassSheet';
import { COLORS, FONTS, RADIUS, SPACING } from '../utils/theme';

const SHARED_DIR = FileSystem.documentDirectory + 'shared/';
async function ensureSharedDir() {
  const info = await FileSystem.getInfoAsync(SHARED_DIR);
  if (!info.exists) await FileSystem.makeDirectoryAsync(SHARED_DIR, { intermediates: true });
}
function genId() { return 'shared_' + Date.now().toString(36) + Math.random().toString(36).slice(2); }

function guessMime(name = '') {
  const ext = name.split('.').pop().toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  return 'image/jpeg';
}

// The filename alone is useless for this — every imported file is just
// "<id>.dat" or "<groupId>_<id>.dat", with no real extension at all, so
// guessMime() above always fell through to image/jpeg, even for videos.
// Sniffing the actual decrypted bytes' magic numbers is the only reliable
// way to know what we're looking at.
function sniffMime(bytes, fallbackName) {
  if (bytes && bytes.length >= 12) {
    if (bytes[0]===0xFF && bytes[1]===0xD8 && bytes[2]===0xFF) return 'image/jpeg';
    if (bytes[0]===0x89 && bytes[1]===0x50 && bytes[2]===0x4E && bytes[3]===0x47) return 'image/png';
    if (bytes[0]===0x47 && bytes[1]===0x49 && bytes[2]===0x46 && bytes[3]===0x38) return 'image/gif';
    if (bytes[0]===0x52 && bytes[1]===0x49 && bytes[2]===0x46 && bytes[3]===0x46 &&
        bytes[8]===0x57 && bytes[9]===0x45 && bytes[10]===0x42 && bytes[11]===0x50) return 'image/webp';
    if (bytes[4]===0x66 && bytes[5]===0x74 && bytes[6]===0x79 && bytes[7]===0x70) return 'video/mp4'; // ISO base media (mp4/mov/m4v)
  }
  return guessMime(fallbackName); // last resort
}

export function SharedTab({ onSaveToVault, showToast }) {
  const [items, setItems] = useState([]);
  const [loadingId, setLoadingId] = useState(null);
  const [decrypted, setDecrypted] = useState({}); // id -> { uri, plainB64, mime }
  const [unlockTarget, setUnlockTarget] = useState(null);
  const [viewItem, setViewItem] = useState(null);

  useEffect(() => { load(); }, []);
  const load = async () => setItems(await getImportedIndex());

  const importFile = async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true });
      if (res.canceled || !res.assets?.length) return;
      await ensureSharedDir();
      const asset = res.assets[0];
      const id = genId();
      const destPath = SHARED_DIR + id + '.dat';
      await FileSystem.copyAsync({ from: asset.uri, to: destPath });
      const entry = { id, filePath: destPath, name: asset.name || 'shared_photo.dat', addedAt: Date.now() };
      await addImportedToIndex(entry);
      await logEvent('shared_import', entry.name);
      await load();
      showToast?.('File imported — unlock with the passphrase you were given', 'success');
    } catch (e) {
      showToast?.('Import failed: ' + e.message, 'error');
    }
  };

  const handleUnlock = async (passphrase) => {
    const item = unlockTarget;
    setUnlockTarget(null);
    setLoadingId(item.id);
    try {
      const b64 = await FileSystem.readAsStringAsync(item.filePath, { encoding: FileSystem.EncodingType.Base64 });
      const sealed = base64ToUint8(b64);
      let plain;
      try {
        plain = await unseal(sealed, passphrase, {});
      } catch {
        try {
          plain = await unseal(sealed, passphrase, { iterations: 8000 });
        } catch {
          // Sender may be on the original higher-iteration version
          plain = await unseal(sealed, passphrase, { iterations: LEGACY_KDF_ITERATIONS });
        }
      }
      const plainB64 = uint8ToBase64(plain);
      const mime = sniffMime(plain, item.name);
      let uri;
      if (mime.startsWith('video/')) {
        // expo-av's Video component needs a real file path, not a data: URI
        const ext = mime.split('/')[1] || 'mp4';
        uri = `${FileSystem.cacheDirectory}shvid_${item.id}.${ext}`;
        await FileSystem.writeAsStringAsync(uri, plainB64, { encoding: FileSystem.EncodingType.Base64 });
      } else {
        uri = `data:${mime};base64,${plainB64}`;
      }
      setDecrypted(prev => ({ ...prev, [item.id]: { uri, plainB64, mime } }));
      await logEvent('shared_unlock', item.name);
      showToast?.('Unlocked', 'success');
    } catch {
      await logEvent('shared_unlock_failed', item.name);
      showToast?.('Wrong passphrase', 'error');
    } finally {
      setLoadingId(null);
    }
  };

  const shareEncrypted = async (item) => {
    const available = await Sharing.isAvailableAsync();
    if (!available) { showToast?.('Sharing not available', 'error'); return; }
    await Sharing.shareAsync(item.filePath, { mimeType: 'application/octet-stream', dialogTitle: 'Share encrypted file' });
    await logEvent('share_encrypted', item.name);
  };

  const saveToVault = (item) => {
    const dec = decrypted[item.id];
    if (!dec) return;
    onSaveToVault?.(dec.plainB64, dec.mime, item.name, async () => {
      await FileSystem.deleteAsync(item.filePath, { idempotent: true });
      if (dec.mime?.startsWith('video/')) await FileSystem.deleteAsync(dec.uri, { idempotent: true }).catch(() => {});
      await removeImportedFromIndex(item.id);
      setDecrypted(prev => { const n = { ...prev }; delete n[item.id]; return n; });
      await load();
      showToast?.('Moved into your vault', 'success');
    });
  };

  const removeItem = (item) => {
    Alert.alert('Remove file', `Remove "${item.name}"? This only deletes the encrypted file on this device.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: async () => {
        const dec = decrypted[item.id];
        await FileSystem.deleteAsync(item.filePath, { idempotent: true });
        if (dec?.mime?.startsWith('video/')) await FileSystem.deleteAsync(dec.uri, { idempotent: true }).catch(() => {});
        await removeImportedFromIndex(item.id);
        setDecrypted(prev => { const n = { ...prev }; delete n[item.id]; return n; });
        await load();
      }},
    ]);
  };

  const renderItem = ({ item }) => {
    const dec = decrypted[item.id];
    const isLoading = loadingId === item.id;
    return (
      <View style={s.card}>
        {dec ? (
          <TouchableOpacity onPress={() => setViewItem(item)}>
            {dec.mime?.startsWith('video/')
              ? <View style={[s.thumb,{alignItems:'center',justifyContent:'center'}]}><Text style={{fontSize:32}}>🎬</Text></View>
              : <Image source={{ uri: dec.uri }} style={s.thumb} resizeMode="cover" />}
          </TouchableOpacity>
        ) : (
          <View style={s.lockTile}>
            <View style={s.lockMark}><Text style={s.lockMarkTxt}>LOCK</Text></View>
            <Text style={s.lockTitle} numberOfLines={1}>{item.name}</Text>
          </View>
        )}
        <View style={s.cardFooter}>
          {isLoading ? <ActivityIndicator color={COLORS.green} size="small" /> : dec ? (
            <TouchableOpacity style={s.smallBtn} onPress={() => saveToVault(item)}>
              <Text style={s.smallBtnTxt}>Save to Vault</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={s.smallBtn} onPress={() => setUnlockTarget(item)}>
              <Text style={s.smallBtnTxt}>Unlock</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={[s.smallBtn,{borderColor:COLORS.blue}]} onPress={() => shareEncrypted(item)}>
            <Text style={[s.smallBtnTxt,{color:COLORS.blue}]}>Share</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.smallBtn,{borderColor:COLORS.rose}]} onPress={() => removeItem(item)}>
            <Text style={[s.smallBtnTxt,{color:COLORS.rose}]}>Remove</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  return (
    <View style={{ flex: 1 }}>
      <View style={s.toolbar}>
        <Text style={s.toolTitle}>{items.length} shared file{items.length !== 1 ? 's' : ''}</Text>
        <TouchableOpacity style={s.toolBtn} onPress={importFile}>
          <Text style={s.toolBtnTxt}>+ Import File</Text>
        </TouchableOpacity>
      </View>

      {items.length === 0 ? (
        <View style={s.empty}>
          <Text style={s.emptyTitle}>No shared files</Text>
          <Text style={s.emptyDesc}>
            Import an encrypted .dat file someone sent you. It stays separate from
            your personal photos until you unlock it and choose to save it into a group.
          </Text>
          <TouchableOpacity style={[s.btn,{marginTop:16}]} onPress={importFile}>
            <Text style={s.btnTxt}>Import File</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={i => i.id}
          renderItem={renderItem}
          contentContainerStyle={{ padding: SPACING.md, gap: 10 }}
          ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
        />
      )}

      <PassSheet visible={!!unlockTarget} onClose={() => setUnlockTarget(null)} onConfirm={handleUnlock}
        title="Unlock Shared Photo" subtitle="Enter the passphrase the sender gave you" confirmLabel="Unlock" />

      <Sheet visible={!!viewItem} onClose={() => setViewItem(null)}>
        {viewItem && decrypted[viewItem.id] && (
          <View style={{ alignItems: 'center', padding: SPACING.md }}>
            {decrypted[viewItem.id].mime?.startsWith('video/')
              ? <Video source={{uri:decrypted[viewItem.id].uri}} style={s.fullImage} useNativeControls resizeMode={ResizeMode.CONTAIN} shouldPlay isLooping={false}/>
              : <Image source={{ uri: decrypted[viewItem.id].uri }} style={s.fullImage} resizeMode="contain" />}
          </View>
        )}
      </Sheet>
    </View>
  );
}

const s = StyleSheet.create({
  toolbar: { flexDirection:'row', alignItems:'center', justifyContent:'space-between', paddingHorizontal:SPACING.md, paddingVertical:SPACING.sm },
  toolTitle: { fontFamily:FONTS.body, color:COLORS.textSecondary, fontSize:13 },
  toolBtn: { borderWidth:1, borderColor:COLORS.indigo, borderRadius:RADIUS.sm, paddingHorizontal:12, paddingVertical:6 },
  toolBtnTxt: { fontFamily:FONTS.bodyMed, color:COLORS.indigo, fontSize:13 },
  empty: { flex:1, alignItems:'center', justifyContent:'center', padding:SPACING.xxl },
  emptyTitle: { fontFamily:FONTS.heading, color:COLORS.textPrimary, fontSize:18, marginBottom:8 },
  emptyDesc: { fontFamily:FONTS.body, color:COLORS.textSecondary, fontSize:13, textAlign:'center' },
  btn: { backgroundColor:COLORS.indigo, borderRadius:RADIUS.md, paddingVertical:13, paddingHorizontal:24, alignItems:'center' },
  btnTxt: { fontFamily:FONTS.heading, color:'#fff', fontSize:14 },
  card: { backgroundColor:COLORS.surface1, borderRadius:RADIUS.lg, borderWidth:1, borderColor:COLORS.border, overflow:'hidden' },
  thumb: { width:'100%', height:180, backgroundColor:COLORS.surface2 },
  lockTile: { height:120, alignItems:'center', justifyContent:'center', gap:6, backgroundColor:COLORS.surface2 },
  lockMark: { width:42, height:26, borderRadius:4, borderWidth:1, borderColor:COLORS.indigo, alignItems:'center', justifyContent:'center' },
  lockMarkTxt: { fontFamily:FONTS.mono, color:COLORS.indigo, fontSize:10, letterSpacing:0.5 },
  lockTitle: { fontFamily:FONTS.body, color:COLORS.textSecondary, fontSize:12, maxWidth:'85%' },
  cardFooter: { flexDirection:'row', gap:8, padding:10, flexWrap:'wrap' },
  smallBtn: { borderWidth:1, borderColor:COLORS.indigo, borderRadius:RADIUS.sm, paddingHorizontal:10, paddingVertical:6 },
  smallBtnTxt: { fontFamily:FONTS.body, color:COLORS.indigo, fontSize:12 },
  fullImage: { width:'100%', height:400, borderRadius:RADIUS.md },
});
