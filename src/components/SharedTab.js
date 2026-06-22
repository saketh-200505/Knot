import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList,
  Image, ActivityIndicator, Alert, Dimensions,
  Animated, PanResponder,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Video, ResizeMode } from 'expo-av';
import {
  unseal, base64ToUint8, uint8ToBase64,
} from '../utils/crypto';
import {
  getImportedIndex, addImportedToIndex, removeImportedFromIndex, logEvent,
} from '../utils/storage';
import { PassSheet } from './PassSheet';
import { COLORS, FONTS, RADIUS, SPACING } from '../utils/theme';

const { width: SW, height: SH } = Dimensions.get('window');
const THUMB = Math.floor((SW - SPACING.md * 2 - 8) / 3);

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
function sniffMime(bytes, fallbackName) {
  if (bytes && bytes.length >= 12) {
    if (bytes[0]===0xFF && bytes[1]===0xD8 && bytes[2]===0xFF) return 'image/jpeg';
    if (bytes[0]===0x89 && bytes[1]===0x50 && bytes[2]===0x4E && bytes[3]===0x47) return 'image/png';
    if (bytes[0]===0x47 && bytes[1]===0x49 && bytes[2]===0x46 && bytes[3]===0x38) return 'image/gif';
    if (bytes[0]===0x52 && bytes[1]===0x49 && bytes[2]===0x46 && bytes[3]===0x46 &&
        bytes[8]===0x57 && bytes[9]===0x45 && bytes[10]===0x42 && bytes[11]===0x50) return 'image/webp';
    if (bytes[4]===0x66 && bytes[5]===0x74 && bytes[6]===0x79 && bytes[7]===0x70) return 'video/mp4';
  }
  return guessMime(fallbackName);
}

// ── Full-screen viewer with pinch-zoom ────────────────────────────────────────
function Viewer({ item, dec, onClose, onSave, onShare }) {
  const sa = useRef(new Animated.Value(1)).current;
  const tx = useRef(new Animated.Value(0)).current;
  const ty = useRef(new Animated.Value(0)).current;
  const g  = useRef({sc:1,x:0,y:0,d0:0,sc0:1,x0:0,y0:0});

  const pd = (t) => {
    if (!t || t.length < 2) return 0;
    const [a, b] = t;
    return Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
  };

  const pr = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_, gs) => Math.abs(gs.dx) > 3 || Math.abs(gs.dy) > 3,
    onPanResponderGrant: (e) => {
      const t = e.nativeEvent.touches;
      g.current.d0 = pd(t); g.current.sc0 = g.current.sc;
      g.current.x0 = g.current.x; g.current.y0 = g.current.y;
    },
    onPanResponderMove: (e, gs) => {
      const t = e.nativeEvent.touches;
      if (t && t.length >= 2) {
        const d = pd(t);
        if (g.current.d0 === 0) { g.current.d0 = d; g.current.sc0 = g.current.sc; }
        else if (d > 0) {
          const n = Math.max(1, Math.min(5, g.current.sc0 * (d / g.current.d0)));
          g.current.sc = n; sa.setValue(n);
        }
      } else if (g.current.sc > 1) {
        const nx = g.current.x0 + gs.dx, ny = g.current.y0 + gs.dy;
        g.current.x = nx; g.current.y = ny; tx.setValue(nx); ty.setValue(ny);
      } else { g.current.d0 = 0; }
    },
    onPanResponderRelease: () => {
      if (g.current.sc < 1.1) {
        g.current.sc = 1; g.current.x = 0; g.current.y = 0;
        sa.setValue(1); tx.setValue(0); ty.setValue(0);
      }
      g.current.d0 = 0;
    },
    onPanResponderTerminate: () => { g.current.d0 = 0; },
  })).current;

  const isVideo = dec.mime?.startsWith('video/');

  return (
    <View style={v.root}>
      <TouchableOpacity style={v.closeBtn} onPress={onClose} hitSlop={{top:16,bottom:16,left:16,right:16}} activeOpacity={0.7}>
        <Text style={v.closeTxt}>✕</Text>
      </TouchableOpacity>

      <Animated.View style={v.imgWrap} {...pr.panHandlers}>
        {isVideo
          ? <Video source={{uri:dec.uri}} style={{width:SW,height:SH*0.65}} useNativeControls resizeMode={ResizeMode.CONTAIN} shouldPlay isLooping={false}/>
          : <Animated.Image source={{uri:dec.uri}} style={[v.img,{transform:[{translateX:tx},{translateY:ty},{scale:sa}]}]} resizeMode="contain"/>
        }
      </Animated.View>

      <View style={v.bar}>
        <TouchableOpacity style={v.btn} onPress={onSave} activeOpacity={0.8}>
          <Text style={v.btnTxt}>⬇  Save to Vault</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[v.btn,v.btnBlue]} onPress={onShare} activeOpacity={0.8}>
          <Text style={v.btnTxt}>↗  Share</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ── Main SharedTab ─────────────────────────────────────────────────────────────
export function SharedTab({ onSaveToVault, showToast }) {
  const [items, setItems]           = useState([]);
  const [loadingId, setLoadingId]   = useState(null);
  const [decrypted, setDecrypted]   = useState({});
  const [unlockTarget, setUnlock]   = useState(null);
  const [viewItem, setViewItem]     = useState(null);

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
      showToast?.('Imported — tap the tile to unlock', 'success');
    } catch (e) {
      showToast?.('Import failed: ' + e.message, 'error');
    }
  };

  const handleUnlock = async (passphrase) => {
    const item = unlockTarget;
    setUnlock(null);
    setLoadingId(item.id);
    try {
      const b64   = await FileSystem.readAsStringAsync(item.filePath, { encoding: FileSystem.EncodingType.Base64 });
      const plain = await unseal(base64ToUint8(b64), passphrase);
      const mime  = sniffMime(plain, item.name);
      let uri;
      if (mime.startsWith('video/')) {
        const ext = mime.split('/')[1] || 'mp4';
        uri = `${FileSystem.cacheDirectory}shvid_${item.id}.${ext}`;
        await FileSystem.writeAsStringAsync(uri, uint8ToBase64(plain), { encoding: FileSystem.EncodingType.Base64 });
      } else {
        uri = `data:${mime};base64,${uint8ToBase64(plain)}`;
      }
      setDecrypted(prev => ({ ...prev, [item.id]: { uri, plainB64: uint8ToBase64(plain), mime } }));
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
    if (!(await Sharing.isAvailableAsync())) { showToast?.('Sharing not available', 'error'); return; }
    await Sharing.shareAsync(item.filePath, { mimeType: 'application/octet-stream', dialogTitle: 'Share encrypted file' });
    await logEvent('share_encrypted', item.name);
  };

  const doSaveToVault = (item) => {
    const dec = decrypted[item.id];
    if (!dec) return;
    setViewItem(null);
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
    Alert.alert('Remove', `Remove "${item.name}" from Shared?`, [
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

  const renderTile = ({ item }) => {
    const dec = decrypted[item.id];
    const isLoading = loadingId === item.id;
    const isVideo = dec?.mime?.startsWith('video/');
    return (
      <TouchableOpacity
        style={s.tile}
        onPress={() => dec ? setViewItem(item) : setUnlock(item)}
        onLongPress={() => Alert.alert(item.name, 'What would you like to do?', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Share Encrypted', onPress: () => shareEncrypted(item) },
          { text: 'Remove', style: 'destructive', onPress: () => removeItem(item) },
        ])}
        activeOpacity={0.85}
      >
        {isLoading ? (
          <View style={s.tileLock}><ActivityIndicator color={COLORS.indigo} size="large"/></View>
        ) : dec ? (
          <>
            {isVideo
              ? <View style={s.tileImg}><Text style={{fontSize:34}}>🎬</Text></View>
              : <Image source={{uri:dec.uri}} style={s.tileImg} resizeMode="cover"/>
            }
            <View style={s.tileOpen}><Text style={s.tileOpenTxt}>✓</Text></View>
          </>
        ) : (
          <View style={s.tileLock}>
            <Text style={{fontSize:26}}>🔒</Text>
            <Text style={s.tileLockTxt} numberOfLines={2}>{item.name}</Text>
          </View>
        )}
      </TouchableOpacity>
    );
  };

  const activeViewer = viewItem && decrypted[viewItem.id];

  return (
    <View style={{ flex: 1, backgroundColor: COLORS.bg }}>
      {/* Toolbar */}
      <View style={s.toolbar}>
        <Text style={s.toolTitle}>{items.length} file{items.length !== 1 ? 's' : ''}</Text>
        <TouchableOpacity style={s.toolBtn} onPress={importFile} activeOpacity={0.8}>
          <Text style={s.toolBtnTxt}>+ Import File</Text>
        </TouchableOpacity>
      </View>

      {items.length === 0 ? (
        <View style={s.empty}>
          <Text style={{fontSize:52,marginBottom:16}}>📥</Text>
          <Text style={s.emptyTitle}>No imported files</Text>
          <Text style={s.emptyDesc}>Import an encrypted .dat file — from your backup folder or shared by a friend — then unlock it with the passphrase.</Text>
          <TouchableOpacity style={s.emptyBtn} onPress={importFile} activeOpacity={0.8}>
            <Text style={s.emptyBtnTxt}>Import File</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={i => i.id}
          numColumns={3}
          contentContainerStyle={s.grid}
          columnWrapperStyle={s.row}
          renderItem={renderTile}
        />
      )}

      <PassSheet
        visible={!!unlockTarget}
        onClose={() => setUnlock(null)}
        onConfirm={handleUnlock}
        title="Unlock File"
        subtitle="Enter the passphrase from the sender (or your own group passphrase for your backups)"
        confirmLabel="Unlock"
      />

      {activeViewer && (
        <Viewer
          item={viewItem}
          dec={decrypted[viewItem.id]}
          onClose={() => setViewItem(null)}
          onSave={() => doSaveToVault(viewItem)}
          onShare={() => shareEncrypted(viewItem)}
        />
      )}
    </View>
  );
}

const v = StyleSheet.create({
  root:     { ...StyleSheet.absoluteFillObject, zIndex:200, elevation:200, backgroundColor:'#000', justifyContent:'center', alignItems:'center' },
  closeBtn: { position:'absolute', top:52, right:18, zIndex:210, elevation:210, width:44, height:44, borderRadius:22, backgroundColor:'rgba(255,255,255,0.18)', alignItems:'center', justifyContent:'center' },
  closeTxt: { color:'#fff', fontSize:18, fontFamily:FONTS.heading },
  imgWrap:  { flex:1, width:SW, justifyContent:'center', alignItems:'center' },
  img:      { width:SW, height:SH * 0.75 },
  bar:      { position:'absolute', bottom:0, left:0, right:0, height:90, flexDirection:'row', alignItems:'center', justifyContent:'center', gap:16, paddingBottom:16, backgroundColor:'rgba(0,0,0,0.55)', zIndex:210, elevation:210 },
  btn:      { borderRadius:RADIUS.lg, paddingHorizontal:22, paddingVertical:12, backgroundColor:'rgba(255,255,255,0.15)', borderWidth:1, borderColor:'rgba(255,255,255,0.25)' },
  btnBlue:  { backgroundColor:COLORS.indigo+'cc', borderColor:COLORS.indigo },
  btnTxt:   { fontFamily:FONTS.bodyMed, color:'#fff', fontSize:14 },
});

const s = StyleSheet.create({
  toolbar:     { flexDirection:'row', alignItems:'center', justifyContent:'space-between', paddingHorizontal:SPACING.md, paddingVertical:10 },
  toolTitle:   { fontFamily:FONTS.body, color:COLORS.textSecondary, fontSize:13 },
  toolBtn:     { borderWidth:1.5, borderColor:COLORS.indigo, borderRadius:RADIUS.md, paddingHorizontal:14, paddingVertical:7, backgroundColor:COLORS.indigo+'14' },
  toolBtnTxt:  { fontFamily:FONTS.bodyMed, color:COLORS.indigo, fontSize:13 },
  grid:        { padding:SPACING.md, paddingBottom:100 },
  row:         { gap:4, marginBottom:4 },
  tile:        { width:THUMB, height:THUMB, borderRadius:RADIUS.md, overflow:'hidden', backgroundColor:COLORS.surface2 },
  tileImg:    { width:THUMB, height:THUMB, alignItems:'center', justifyContent:'center', backgroundColor:COLORS.surface2 },
  tileLock:   { flex:1, alignItems:'center', justifyContent:'center', gap:6, padding:6 },
  tileLockTxt:{ fontFamily:FONTS.body, color:COLORS.textMuted, fontSize:10, textAlign:'center' },
  tileOpen:   { position:'absolute', top:6, right:6, width:20, height:20, borderRadius:10, backgroundColor:COLORS.indigo, alignItems:'center', justifyContent:'center' },
  tileOpenTxt:{ color:'#fff', fontSize:11, fontFamily:FONTS.bodyMed },
  empty:       { flex:1, alignItems:'center', justifyContent:'center', padding:SPACING.xxl },
  emptyTitle:  { fontFamily:FONTS.heading, color:COLORS.textPrimary, fontSize:20, marginBottom:8 },
  emptyDesc:   { fontFamily:FONTS.body, color:COLORS.textSecondary, fontSize:13, textAlign:'center', lineHeight:20 },
  emptyBtn:    { marginTop:20, backgroundColor:COLORS.indigo, borderRadius:RADIUS.lg, paddingVertical:14, paddingHorizontal:28 },
  emptyBtnTxt: { fontFamily:FONTS.heading, color:'#fff', fontSize:15 },
});
