/**
 * Vault.js — clean rewrite
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  Image, FlatList, Dimensions, Animated, Platform, PanResponder,
  Alert, ActivityIndicator, TextInput, InteractionManager,
} from 'react-native';
import * as ImagePicker  from 'expo-image-picker';
import * as FileSystem   from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import * as Sharing      from 'expo-sharing';
import { Video, ResizeMode } from 'expo-av';
import {
  seal, sealWithKey, unseal,
  deriveKey, randomBytes,
  base64ToUint8, uint8ToBase64,
  hashStr, verifyHash,
  passphraseFingerprint,
  DEFAULT_KDF_ITERATIONS, LEGACY_KDF_ITERATIONS,
} from '../utils/crypto';
import {
  getPhotoIndex, addPhotoToIndex, removePhotoFromIndex,
  storage, KEYS, getSessionDuration, getGesture,
  getGroups, addGroup, findGroupsByFingerprint,
  getAuditLog, clearAuditLog, logEvent,
} from '../utils/storage';
import { useSession }  from '../hooks/useSession';
import { SessionBar }  from '../components/SessionBar';
import { PassSheet }   from '../components/PassSheet';
import { Sheet }       from '../components/Sheet';
import { Toast }       from '../components/Toast';
import { GroupPicker } from '../components/GroupPicker';
import { SharedTab }   from '../components/SharedTab';
import { COLORS, FONTS, RADIUS, SPACING, GROUP_PALETTES } from '../utils/theme';

const { width: SW, height: SH } = Dimensions.get('window');
const THUMB = Math.floor((SW - 48) / 3);
const VAULT_DIR = FileSystem.documentDirectory + 'vault/';
const DEFAULT_GESTURE = ['up','up','down','down'];
const ARROWS = { up:'↑', down:'↓', left:'←', right:'→' };

function pal(group) { return GROUP_PALETTES[(group?.paletteIdx ?? 0) % GROUP_PALETTES.length]; }
function colorFor(i) { return GROUP_PALETTES[i % GROUP_PALETTES.length].dot; }
function genId()  { return Date.now().toString(36) + Math.random().toString(36).slice(2,8); }
function fmt(s)   { const t=Math.max(0,s); return `${Math.floor(t/60)}:${String(t%60).padStart(2,'0')}`; }
async function ensureDir(d) {
  const i = await FileSystem.getInfoAsync(d);
  if (!i.exists) await FileSystem.makeDirectoryAsync(d,{intermediates:true});
}

export function Vault({ onLogout }) {
  const session = useSession();

  const [tab,       setTab]       = useState(0);
  const [photos,    setPhotos]    = useState([]);
  const [groups,    setGroups]    = useState([]);
  const [auditLog,  setAuditLog]  = useState([]);
  const [toast,     setToast]     = useState({visible:false,msg:'',type:'info'});
  const [proc,      setProc]      = useState('');

  const [openGroup,         setOpenGroup]         = useState(null);
  const [viewPhoto,         setViewPhoto]         = useState(null);
  const [viewVideo,         setViewVideo]         = useState(null);
  const [selectMode,        setSelectMode]        = useState(false);
  const [selected,          setSelected]          = useState(new Set());

  // Photo viewer zoom/pan state — kept here (not inside the nested PhotoViewer
  // function below) because Vault re-renders every second while the session
  // timer ticks. PhotoViewer is redefined as a new function on every Vault
  // render, so any useRef/PanResponder declared *inside* it would get wiped
  // (remounted) every second — which looked like "zoom happens then quickly
  // snaps back out". Hoisting it here keeps it tied to Vault's own stable
  // hook list instead.
  const zoomScale = useRef(new Animated.Value(1)).current;
  const zoomTX     = useRef(new Animated.Value(0)).current;
  const zoomTY     = useRef(new Animated.Value(0)).current;
  const zoomG       = useRef({sc:1,x:0,y:0,d0:0,sc0:1,x0:0,y0:0});

  useEffect(()=>{
    zoomG.current={sc:1,x:0,y:0,d0:0,sc0:1,x0:0,y0:0};
    zoomScale.setValue(1); zoomTX.setValue(0); zoomTY.setValue(0);
  },[viewPhoto?.id]); // eslint-disable-line

  const pinchDist=(t)=>{ if(!t||t.length<2) return 0; const[a,b]=t; return Math.hypot(a.pageX-b.pageX,a.pageY-b.pageY); };

  const photoPanResponder=useRef(PanResponder.create({
    onStartShouldSetPanResponder:()=>true,
    onStartShouldSetPanResponderCapture:()=>false,
    onMoveShouldSetPanResponder:(_,gs)=>Math.abs(gs.dx)>3||Math.abs(gs.dy)>3,
    onMoveShouldSetPanResponderCapture:()=>false,
    onPanResponderGrant:(e)=>{ const t=e.nativeEvent.touches; zoomG.current.d0=pinchDist(t); zoomG.current.sc0=zoomG.current.sc; zoomG.current.x0=zoomG.current.x; zoomG.current.y0=zoomG.current.y; },
    onPanResponderMove:(e,gs)=>{
      const t=e.nativeEvent.touches;
      if(t&&t.length>=2){
        const d=pinchDist(t);
        if(zoomG.current.d0===0){
          // Second finger just landed mid-gesture — grant only ever saw one
          // touch, so the pinch baseline was never set. Capture it now.
          zoomG.current.d0=d; zoomG.current.sc0=zoomG.current.sc;
        } else if(d>0){
          const n=Math.max(1,Math.min(5,zoomG.current.sc0*(d/zoomG.current.d0)));
          zoomG.current.sc=n; zoomScale.setValue(n);
        }
      }
      else if(zoomG.current.sc>1){ const nx=zoomG.current.x0+gs.dx,ny=zoomG.current.y0+gs.dy; zoomG.current.x=nx; zoomG.current.y=ny; zoomTX.setValue(nx); zoomTY.setValue(ny); }
      else { zoomG.current.d0=0; }
    },
    onPanResponderRelease:()=>{ if(zoomG.current.sc<1.1){ zoomG.current.sc=1;zoomG.current.x=0;zoomG.current.y=0; zoomScale.setValue(1);zoomTX.setValue(0);zoomTY.setValue(0); } zoomG.current.d0=0; },
    onPanResponderTerminate:()=>{ zoomG.current.d0=0; },
  })).current;

  const [showUnlock,        setShowUnlock]        = useState(false);
  const [unlockGroup,       setUnlockGroup]       = useState(null);
  const [showExtend,        setShowExtend]        = useState(false);
  const [showExport,        setShowExport]        = useState(false);
  const [exportTarget,      setExportTarget]      = useState(null);

  const [pending,           setPending]           = useState([]);
  const pendingRef = useRef([]);  // always current, no stale closure
  const [showGroupPick,     setShowGroupPick]     = useState(false);
  const [showNewLabel,      setShowNewLabel]      = useState(false);
  const [newLabel,          setNewLabel]          = useState('');
  const [showNewPass,       setShowNewPass]       = useState(false);
  const [showExistingPass,  setShowExistingPass]  = useState(null);

  const [savePending,       setSavePending]       = useState(null);
  const [saveGroup,         setSaveGroup]         = useState(null);
  const [saveViaNew,        setSaveViaNew]        = useState(false);

  const [dur,      setDur]      = useState(3);
  const [gesture,  setGesture]  = useState([...DEFAULT_GESTURE]);
  const [recMode,  setRecMode]  = useState(false);
  const [showChPw, setShowChPw] = useState(false);
  const [curPw,    setCurPw]    = useState('');
  const [newPw,    setNewPw]    = useState('');
  const [newPw2,   setNewPw2]   = useState('');
  const [pwErr,    setPwErr]    = useState('');

  const toast_ = useCallback((msg, type='info') => setToast({visible:true, msg, type}), []);

  const loadPhotos = useCallback(async () => setPhotos(await getPhotoIndex()), []);
  const loadGroups = useCallback(async () => setGroups(await getGroups()), []);
  const loadAudit  = useCallback(async () => setAuditLog(await getAuditLog()), []);

  useEffect(() => {
    Promise.all([getPhotoIndex(), getGroups(), getSessionDuration(), getGesture(), getAuditLog()])
      .then(([p,g,d,ges,a]) => { setPhotos(p); setGroups(g); setDur(d); setGesture(ges); setAuditLog(a); });
  }, []);
  useEffect(() => { if (tab===2) { loadAudit(); loadGroups(); } }, [tab]);
  useEffect(() => { if (session.showExtend) setShowExtend(true); }, [session.showExtend]);

  // ── IMPORT ────────────────────────────────────────────────────────────────
  const pickMedia = async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (perm.status==='denied') { toast_('Allow media access in Settings','error'); return; }
      const r = await ImagePicker.launchImageLibraryAsync({
        mediaTypes:['images','videos'], allowsMultipleSelection:true,
        quality:1, exif:false, base64:false, videoMaxDuration:30,
      });
      if (r.canceled || !r.assets?.length) return;
      pendingRef.current = r.assets;
      setPending(r.assets);
      setShowGroupPick(true);
    } catch(e) { toast_('Picker error: ' + e.message, 'error'); }
  };

  const takePhoto = async () => {
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (perm.status!=='granted') { toast_('Camera permission needed','error'); return; }
      const r = await ImagePicker.launchCameraAsync({quality:1, exif:false, base64:false});
      if (r.canceled || !r.assets?.length) return;
      pendingRef.current = r.assets;
      setPending(r.assets);
      setShowGroupPick(true);
    } catch(e) { toast_('Camera error: ' + e.message, 'error'); }
  };

  const encryptOne = async (asset, key, salt, group, passphrase) => {
    const b64 = await FileSystem.readAsStringAsync(asset.uri, {encoding:FileSystem.EncodingType.Base64});
    const bytes  = base64ToUint8(b64);
    const sealed = group ? await sealWithKey(bytes, key, salt) : await seal(bytes, passphrase);
    const id     = genId();
    const dir    = group ? `${VAULT_DIR}${group.id}/` : VAULT_DIR;
    const path   = `${dir}${id}.dat`;
    await FileSystem.writeAsStringAsync(path, uint8ToBase64(sealed), {encoding:FileSystem.EncodingType.Base64});
    const isVid  = asset.type==='video' || (asset.mimeType||'').startsWith('video/');
    return {
      id, filePath:path,
      mimeType:  asset.mimeType||(isVid?'video/mp4':'image/jpeg'),
      mediaType: isVid?'video':'image',
      name:      asset.fileName||`${isVid?'video':'photo'}_${id}`,
      addedAt:   Date.now(), cryptoVersion:3,
      kdfIterations: DEFAULT_KDF_ITERATIONS,
      groupId:   group?.id||null, groupLabel: group?.label||null,
    };
  };

  const runImport = async (passphrase, group, filesToEncrypt) => {
    const files = filesToEncrypt || pendingRef.current;
    console.log('[KNOT] runImport called, files:', files?.length, 'group:', group?.label);
    if (!files || files.length === 0) {
      setProc('');
      toast_('No files selected — please try again', 'error');
      return;
    }
    setProc(`Encrypting 0 of ${files.length}`);
    await ensureDir(VAULT_DIR);
    if (group) await ensureDir(`${VAULT_DIR}${group.id}/`);
    const salt = group ? base64ToUint8(group.salt) : null;
    const key  = group ? deriveKey(passphrase, salt, DEFAULT_KDF_ITERATIONS) : null;
    let count  = 0;
    for (const asset of files) {
      await new Promise(r => setTimeout(r, 0));
      try {
        setProc(`Encrypting ${count+1} of ${files.length}`);
        const entry = await encryptOne(asset, key, salt, group, passphrase);
        await addPhotoToIndex(entry);
        count++;
      } catch(e) { console.warn('Import err', e); }
    }
    await loadPhotos();
    await logEvent('import', `${count}/${files.length} -> ${group?.label||'?'}`);
    setPending([]); pendingRef.current = []; setProc('');
    toast_(count>0
      ? `${count} item${count!==1?'s':''} added to "${group?.label}"`
      : 'Encryption failed — try again',
      count>0 ? 'success' : 'error'
    );
  };

  const onPickGroup  = g  => { setShowGroupPick(false); setTimeout(() => setShowExistingPass(g), 350); };
  const onCreateNew  = () => { setShowGroupPick(false); setNewLabel(''); setTimeout(() => setShowNewLabel(true), 350); };

  const confirmExistingPass = async (pw) => {
    // Capture files and group FIRST before any state changes
    const files = pendingRef.current.slice();
    const g = showExistingPass;
    console.log('[KNOT] confirmExistingPass: files=', files.length, 'group=', g?.label, 'pw len=', pw.length);

    // Close sheet FIRST
    setShowExistingPass(null);

    try {
      setProc('Verifying…');
      const fp = await passphraseFingerprint(pw);
      if (fp !== g.fingerprint) {
        setProc('');
        toast_('Wrong passphrase for that group', 'error');
        setPending([]); pendingRef.current = [];
        return;
      }
      console.log('[KNOT] passphrase verified, running import with', files.length, 'files');
      await runImport(pw, g, files);
    } catch(e) {
      console.error('[KNOT] confirmExistingPass error:', e);
      setProc('');
      toast_('Error: ' + e.message, 'error');
    }
  };

  const confirmNewLabel = () => { if (!newLabel.trim()) return; setShowNewLabel(false); setTimeout(() => setShowNewPass(true), 350); };

  const confirmNewPass = async (pw) => {
    // Capture files FIRST before any state changes or awaits
    const files = pendingRef.current.slice();
    const labelNow = newLabel.trim();
    const paletteIdx = groups.length % GROUP_PALETTES.length;
    const color = colorFor(groups.length);
    console.log('[KNOT] confirmNewPass: files=', files.length, 'label=', labelNow, 'pw len=', pw.length);

    // Close sheet FIRST, then show progress on next tick
    setShowNewPass(false);

    try {
      setProc('Creating group…');
      const fp   = await passphraseFingerprint(pw);
      const salt = await randomBytes(16);
      const g    = {
        id:genId(), label:labelNow, fingerprint:fp,
        salt:uint8ToBase64(salt), color, paletteIdx,
        createdAt:Date.now(),
      };
      await addGroup(g);
      await loadGroups();
      await logEvent('group_created', g.label);

      if (saveViaNew) {
        setSaveViaNew(false);
        const sp = savePending; setSavePending(null);
        await saveToVault(sp, pw, g);
      } else {
        console.log('[KNOT] calling runImport with', files.length, 'files, group:', g.label);
        await runImport(pw, g, files);
      }
    } catch(e) {
      console.error('[KNOT] confirmNewPass error:', e);
      setProc('');
      toast_('Error: ' + e.message, 'error');
    }
  };

  // ── UNLOCK ────────────────────────────────────────────────────────────────
  const buildTargets = async (pw, tg) => {
    const fp = await passphraseFingerprint(pw);
    if (tg && tg.id!=='__ungrouped') {
      if (tg.fingerprint!==fp) return {targets:[],labels:[],wrong:true};
      const salt=base64ToUint8(tg.salt), key=deriveKey(pw,salt,DEFAULT_KDF_ITERATIONS);
      return { targets:photos.filter(p=>p.groupId===tg.id).map(p=>({photo:p,key})), labels:[tg.label], wrong:false };
    }
    const matching = await findGroupsByFingerprint(fp);
    const targets=[]; const labels=[];
    for (const g of matching) {
      const salt=base64ToUint8(g.salt), key=deriveKey(pw,salt,DEFAULT_KDF_ITERATIONS);
      photos.filter(p=>p.groupId===g.id).forEach(p=>targets.push({photo:p,key}));
      labels.push(g.label);
    }
    photos.filter(p=>!p.groupId).forEach(p=>targets.push({photo:p,key:null}));
    return {targets, labels, wrong:false};
  };

  const readFiles = async (targets) => {
    const out=[];
    for (const {photo,key} of targets) {
      const b64 = await FileSystem.readAsStringAsync(photo.filePath,{encoding:FileSystem.EncodingType.Base64}).catch(()=>null);
      if (b64) out.push({...photo, sealedB64:b64, key});
    }
    return out;
  };

  const handleUnlock = async (pw) => {
    const tg=unlockGroup; setShowUnlock(false); setUnlockGroup(null);
    const {targets,labels,wrong} = await buildTargets(pw,tg);
    if (wrong)          { toast_('Wrong passphrase for this group','error'); return; }
    if (!targets.length){ toast_('No items match that passphrase','error'); return; }
    setProc(`Decrypting 0 of ${targets.length}`);
    const files = await readFiles(targets);
    const count = await session.unlock(files, pw, (d,t)=>setProc(`Decrypting ${Math.min(d+1,t)} of ${t}`));
    setProc('');
    count===0 ? toast_('Wrong passphrase — nothing unlocked','error')
              : toast_(`${count} item${count!==1?'s':''} unlocked (${labels.join(', ')})`, 'success');
  };

  const handleExtend = async (pw) => {
    setShowExtend(false);
    const {targets} = await buildTargets(pw,null);
    if (!targets.length) { toast_('Wrong passphrase','error'); session.wipe(); return; }
    setProc(`Decrypting 0 of ${targets.length}`);
    const files = await readFiles(targets);
    const count = await session.extend(files, pw, (d,t)=>setProc(`Decrypting ${Math.min(d+1,t)} of ${t}`));
    setProc('');
    count>0 ? toast_('Session extended','success') : toast_('Wrong passphrase','error');
  };

  // ── EXPORT / DELETE / SHARE ───────────────────────────────────────────────
  const handleExport = async (pw) => {
    setShowExport(false);
    const targets = exportTarget ? [photos.find(p=>p.id===exportTarget)].filter(Boolean)
                                 : photos.filter(p=>selected.has(p.id));
    if (!targets.length) return;
    const {status} = await MediaLibrary.requestPermissionsAsync();
    let count=0;
    setProc(`Exporting 0 of ${targets.length}`);
    for (let i=0;i<targets.length;i++) {
      await new Promise(r=>InteractionManager.runAfterInteractions(r));
      const photo=targets[i];
      try {
        setProc(`Exporting ${i+1} of ${targets.length}`);
        const b64    = await FileSystem.readAsStringAsync(photo.filePath,{encoding:FileSystem.EncodingType.Base64});
        const plain  = await unseal(base64ToUint8(b64), pw, {iterations:photo.kdfIterations||LEGACY_KDF_ITERATIONS});
        const ext    = (photo.mimeType||'image/jpeg').split('/')[1]||'jpg';
        const out    = `${FileSystem.cacheDirectory}exp_${photo.id}.${ext}`;
        await FileSystem.writeAsStringAsync(out, uint8ToBase64(plain), {encoding:FileSystem.EncodingType.Base64});
        if (status==='granted') { await MediaLibrary.saveToLibraryAsync(out); count++; }
        await FileSystem.deleteAsync(out,{idempotent:true});
      } catch { /* wrong pass / corrupt */ }
    }
    setProc(''); setSelectMode(false); setSelected(new Set()); setExportTarget(null);
    count>0 ? toast_(`${count} item${count!==1?'s':''} saved to gallery`,'success')
            : toast_('Export failed — check passphrase','error');
    if (count>0) logEvent('export',`${count}`).catch(()=>{});
  };

  const deleteSelected = () => {
    Alert.alert('Remove',`Remove ${selected.size} item${selected.size!==1?'s':''}? Cannot be undone.`,[
      {text:'Cancel',style:'cancel'},
      {text:'Remove',style:'destructive', onPress:async()=>{
        for (const id of selected) {
          const p=photos.find(x=>x.id===id);
          if(p){ await FileSystem.deleteAsync(p.filePath,{idempotent:true}).catch(()=>{}); await removePhotoFromIndex(id); }
        }
        await loadPhotos(); setSelectMode(false); setSelected(new Set());
        toast_('Removed','warn'); logEvent('delete',`${selected.size}`).catch(()=>{});
      }},
    ]);
  };

  const shareEnc = async (id) => {
    const targets = id ? [photos.find(p=>p.id===id)].filter(Boolean) : photos.filter(p=>selected.has(p.id));
    if (!targets.length) return;
    if (!(await Sharing.isAvailableAsync())) { toast_('Sharing not available','error'); return; }
    for (const p of targets) await Sharing.shareAsync(p.filePath,{mimeType:'application/octet-stream',dialogTitle:'Share encrypted file'});
    logEvent('share_encrypted',`${targets.length}`).catch(()=>{});
    setSelectMode(false); setSelected(new Set());
  };

  // ── SAVE SHARED TO VAULT ──────────────────────────────────────────────────
  const saveToVault = async (sp, pw, g) => {
    if (!sp) return;
    setProc('Encrypting…');
    try {
      await ensureDir(VAULT_DIR); await ensureDir(`${VAULT_DIR}${g.id}/`);
      const salt=base64ToUint8(g.salt), key=deriveKey(pw,salt,DEFAULT_KDF_ITERATIONS);
      const sealed = await sealWithKey(base64ToUint8(sp.plainB64), key, salt);
      const id=genId(), path=`${VAULT_DIR}${g.id}/${id}.dat`;
      await FileSystem.writeAsStringAsync(path, uint8ToBase64(sealed), {encoding:FileSystem.EncodingType.Base64});
      await addPhotoToIndex({id,filePath:path,mimeType:sp.mime||'image/jpeg',mediaType:'image',name:sp.name||`photo_${id}`,addedAt:Date.now(),cryptoVersion:3,kdfIterations:DEFAULT_KDF_ITERATIONS,groupId:g.id,groupLabel:g.label});
      await loadPhotos(); logEvent('shared_saved_to_vault',g.label).catch(()=>{});
      sp.onDone?.();
    } catch(e){ toast_('Save failed: '+e.message,'error'); }
    finally { setProc(''); }
  };

  // ── SETTINGS ──────────────────────────────────────────────────────────────
  const saveDur = d => { setDur(d); storage.set(KEYS.SESSION_DURATION,String(d)); toast_(`Session: ${d} min`,'success'); };
  const addMove = d => { if (!recMode) return; setGesture(p=>p.length>=8?p:[...p,d]); };
  const saveGest= async()=>{ await storage.set(KEYS.GESTURE,JSON.stringify(gesture)); toast_('Sequence saved','success'); };
  const changePw= async()=>{
    setPwErr('');
    if (newPw.length<4){ setPwErr('Min 4 characters'); return; }
    if (newPw!==newPw2){ setPwErr('Passwords do not match'); return; }
    const stored=await storage.get(KEYS.VAULT_PW_HASH);
    if (!(await verifyHash(curPw,stored))){ setPwErr('Current code incorrect'); return; }
    await storage.set(KEYS.VAULT_PW_HASH,await hashStr(newPw));
    setCurPw(''); setNewPw(''); setNewPw2(''); setShowChPw(false);
    toast_('Access code updated','success');
  };

  // ── GALLERY TAB ───────────────────────────────────────────────────────────
  const GalleryTab = () => {
    const byGroup={}, ungrouped=[];
    for (const p of photos) {
      if (p.groupId){ if(!byGroup[p.groupId]) byGroup[p.groupId]=[]; byGroup[p.groupId].push(p); }
      else ungrouped.push(p);
    }

    const Folder = ({group, gPhotos}) => {
      const palette = pal(group);
      const pre = gPhotos.slice(0,4);
      const allOpen = gPhotos.length>0 && gPhotos.every(p=>session.decryptedMap[p.id]);
      const anyOpen = gPhotos.some(p=>session.decryptedMap[p.id]);
      return (
        <TouchableOpacity style={[fs.card,{backgroundColor:palette.bg}]} onPress={()=>setOpenGroup(group)} activeOpacity={0.8}>
          <View style={fs.preview}>
            {pre.length===0 ? (
              <View style={fs.preEmpty}><Text style={{fontSize:48}}>📁</Text></View>
            ) : (
              <View style={fs.preGrid}>
                {pre.map((p,i)=>{
                  const uri=session.decryptedMap[p.id];
                  return (
                    <View key={p.id} style={[fs.preCell, pre.length===1&&fs.preFull, pre.length===2&&{width:'50%',height:'100%'}]}>
                      {uri && p.mediaType!=='video'
                        ? <Image source={{uri}} style={fs.preImg} resizeMode="cover"/>
                        : <View style={[fs.preLock,{backgroundColor:palette.dot+'20'}]}><Text style={{fontSize:16}}>{p.mediaType==='video'?'🎬':'🔒'}</Text></View>
                      }
                    </View>
                  );
                })}
              </View>
            )}
          </View>
          <View style={fs.info}>
            <View style={{flexDirection:'row',alignItems:'center',gap:6}}>
              <View style={[fs.dot,{backgroundColor:palette.dot}]}/>
              <Text style={[fs.label,{color:palette.text}]} numberOfLines={1}>{group.label}</Text>
            </View>
            <View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between',marginTop:2}}>
              <Text style={[fs.count,{color:palette.icon}]}>{gPhotos.length} item{gPhotos.length!==1?'s':''}</Text>
              <View style={[fs.badge,{backgroundColor:palette.dot+'20'}]}>
                <Text style={[fs.badgeTxt,{color:palette.dot}]}>{allOpen?'✓ Open':anyOpen?'◑ Partial':'🔒 Locked'}</Text>
              </View>
            </View>
          </View>
          {!allOpen && (
            <TouchableOpacity style={[fs.unlockBtn,{backgroundColor:palette.dot}]}
              onPress={()=>{setUnlockGroup(group);setShowUnlock(true);}} activeOpacity={0.8}>
              <Text style={fs.unlockTxt}>Unlock</Text>
            </TouchableOpacity>
          )}
        </TouchableOpacity>
      );
    };

    return (
      <View style={{flex:1}}>
        {session.active && <SessionBar remaining={session.remaining} total={session.totalSecs} blurring={session.blurring}/>}
        <View style={s.toolbar}>
          <Text style={s.toolTitle}>{photos.length} item{photos.length!==1?'s':''} · {groups.length} group{groups.length!==1?'s':''}</Text>
          <View style={{flexDirection:'row',gap:8}}>
            {session.active && (
              <TouchableOpacity style={[s.outBtn,{borderColor:COLORS.rose}]} onPress={()=>session.wipe()} activeOpacity={0.7}>
                <Text style={[s.outBtnTxt,{color:COLORS.rose}]}>Lock</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={[s.outBtn,{borderColor:COLORS.purple}]} onPress={takePhoto} activeOpacity={0.7}>
              <Text style={[s.outBtnTxt,{color:COLORS.purple}]}>📷</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.solidBtn} onPress={pickMedia} activeOpacity={0.7}>
              <Text style={s.solidBtnTxt}>+ Add</Text>
            </TouchableOpacity>
          </View>
        </View>

        {photos.length===0 ? (
          <View style={s.empty}>
            <Text style={{fontSize:60,marginBottom:12}}>🗂️</Text>
            <Text style={s.emptyTitle}>No items yet</Text>
            <Text style={s.emptyDesc}>Create a group and add your first photo or video</Text>
            <TouchableOpacity style={[s.solidBtn,{marginTop:20,paddingHorizontal:32}]} onPress={pickMedia} activeOpacity={0.7}>
              <Text style={s.solidBtnTxt}>Add Photos & Videos</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <ScrollView contentContainerStyle={fs.grid} showsVerticalScrollIndicator={false}>
            <View style={fs.row}>
              {groups.filter(g=>byGroup[g.id]).map(g=>(
                <View key={g.id} style={fs.col}><Folder group={g} gPhotos={byGroup[g.id]||[]}/></View>
              ))}
              {ungrouped.length>0 && (
                <View style={fs.col}><Folder group={{id:'__ungrouped',label:'Ungrouped',paletteIdx:7}} gPhotos={ungrouped}/></View>
              )}
            </View>
          </ScrollView>
        )}

        {!!proc && (
          <View style={s.overlay}>
            <ActivityIndicator color={COLORS.indigo} size="large"/>
            <Text style={s.overlayTxt}>{proc}</Text>
          </View>
        )}
      </View>
    );
  };

  // ── GROUP DRILLDOWN ───────────────────────────────────────────────────────
  const GroupView = () => {
    if (!openGroup) return null;
    const g   = openGroup;
    const palette = pal(g);
    const gp  = photos.filter(p=>g.id==='__ungrouped'?!p.groupId:p.groupId===g.id);
    const allOpen = gp.length>0 && gp.every(p=>session.decryptedMap[p.id]);

    const onCard = (photo) => {
      if (selectMode) {
        setSelected(prev=>{const s=new Set(prev); s.has(photo.id)?s.delete(photo.id):s.add(photo.id); return s;});
        return;
      }
      const uri = session.decryptedMap[photo.id];
      if (uri) { photo.mediaType==='video' ? setViewVideo({uri,photo}) : setViewPhoto(photo); }
      else      { setUnlockGroup(g); setShowUnlock(true); }
    };

    return (
      <View style={[dv.root,{backgroundColor:COLORS.bg}]}>
        <View style={[dv.hdr,{backgroundColor:palette.bg}]}>
          <TouchableOpacity style={dv.back} onPress={()=>{setOpenGroup(null);setSelectMode(false);setSelected(new Set());}} activeOpacity={0.7}>
            <Text style={[dv.backTxt,{color:palette.text}]}>← Back</Text>
          </TouchableOpacity>
          <View style={{flex:1,flexDirection:'row',alignItems:'center',gap:8}}>
            <View style={[dv.hdot,{backgroundColor:palette.dot}]}/>
            <Text style={[dv.htitle,{color:palette.text}]}>{g.label}</Text>
          </View>
          {!allOpen && (
            <TouchableOpacity style={[dv.ulBtn,{backgroundColor:palette.dot}]} onPress={()=>{setUnlockGroup(g);setShowUnlock(true);}} activeOpacity={0.7}>
              <Text style={dv.ulTxt}>Unlock</Text>
            </TouchableOpacity>
          )}
        </View>

        {gp.length===0 ? (
          <View style={s.empty}><Text style={{fontSize:48,marginBottom:12}}>📂</Text><Text style={s.emptyTitle}>Empty group</Text><Text style={s.emptyDesc}>Add photos to this group via + Add</Text></View>
        ) : (
          <FlatList
            data={gp}
            keyExtractor={p=>p.id}
            numColumns={3}
            contentContainerStyle={{padding:12,paddingBottom:120}}
            columnWrapperStyle={{gap:8}}
            ItemSeparatorComponent={()=><View style={{height:8}}/>}
            renderItem={({item:photo})=>{
              const uri=session.decryptedMap[photo.id];
              const sel=selected.has(photo.id);
              return (
                <TouchableOpacity style={[dv.card,sel&&{borderColor:palette.dot,borderWidth:3}]}
                  onPress={()=>onCard(photo)} onLongPress={()=>{setSelectMode(true);setSelected(new Set([photo.id]));}} activeOpacity={0.8}>
                  {uri ? (
                    <>
                      {photo.mediaType==='video'
                        ? <View style={[dv.vidThumb,{backgroundColor:palette.bg}]}><Text style={{fontSize:28}}>▶</Text></View>
                        : <Image source={{uri}} style={[dv.img,session.blurring&&{opacity:0.1}]} blurRadius={session.blurring?12:0} resizeMode="cover"/>
                      }
                      <View style={dv.badge}><View style={[dv.dot2,{backgroundColor:palette.dot}]}/><Text style={[dv.badgeTxt,{color:palette.dot}]}>{fmt(session.remaining)}</Text></View>
                    </>
                  ) : (
                    <View style={[dv.locked,{backgroundColor:palette.bg}]}>
                      <Text style={{fontSize:22}}>{photo.mediaType==='video'?'🎬':'🔒'}</Text>
                      <Text style={[dv.lockedTxt,{color:palette.text}]} numberOfLines={2}>{photo.name}</Text>
                    </View>
                  )}
                  {sel && <View style={dv.selOv}><Text style={dv.selChk}>✓</Text></View>}
                </TouchableOpacity>
              );
            }}
          />
        )}

        {selectMode && selected.size>0 && (
          <View style={dv.bar}>
            <Text style={dv.barTitle}>{selected.size} selected</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{gap:8}}>
              {[
                {label:'Export', color:COLORS.sky,    fn:()=>{setExportTarget(null);setShowExport(true);}},
                {label:'Share',  color:COLORS.purple,  fn:()=>shareEnc(null)},
                {label:'Delete', color:COLORS.rose,    fn:()=>deleteSelected()},
                {label:'Cancel', color:COLORS.textMuted,fn:()=>{setSelectMode(false);setSelected(new Set());}},
              ].map(({label,color,fn})=>(
                <TouchableOpacity key={label} style={[dv.barBtn,{backgroundColor:color}]} onPress={fn} activeOpacity={0.7}>
                  <Text style={dv.barBtnTxt}>{label}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        )}

        {!!proc && <View style={s.overlay}><ActivityIndicator color={palette.dot} size="large"/><Text style={s.overlayTxt}>{proc}</Text></View>}
      </View>
    );
  };

  // ── SETTINGS TAB ──────────────────────────────────────────────────────────
  const SettingsTab = () => (
    <ScrollView contentContainerStyle={{padding:SPACING.md,paddingBottom:120,gap:SPACING.md}} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>

      <View style={s.card}>
        <Text style={s.cardTitle}>Session Duration</Text>
        <Text style={s.cardDesc}>How long items stay unlocked</Text>
        <View style={{flexDirection:'row',gap:8,flexWrap:'wrap',marginTop:4}}>
          {[1,3,5,10].map(d=>(
            <TouchableOpacity key={d} style={[s.pill, dur===d&&s.pillOn]} onPress={()=>saveDur(d)} activeOpacity={0.7}>
              <Text style={[s.pillTxt, dur===d&&s.pillOnTxt]}>{d} min</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      <View style={s.card}>
        <Text style={s.cardTitle}>Secret Sequence</Text>
        <Text style={s.cardDesc}>D-pad pattern to open vault from the game</Text>
        <View style={{flexDirection:'row',flexWrap:'wrap',gap:6,minHeight:36,alignItems:'center',marginTop:4}}>
          {gesture.length===0
            ? <Text style={{color:COLORS.textMuted,fontFamily:FONTS.body,fontSize:13}}>No moves set</Text>
            : gesture.map((g,i)=><View key={i} style={s.arrow}><Text style={s.arrowTxt}>{ARROWS[g]}</Text></View>)
          }
        </View>
        <Text style={{fontFamily:FONTS.mono,color:recMode?COLORS.emerald:COLORS.textMuted,fontSize:11,marginTop:4}}>
          {recMode?'● Recording — tap arrows':'Tap Record to set a new sequence'}
        </Text>
        <View style={{alignItems:'center',gap:3,marginVertical:10}}>
          <View style={{flexDirection:'row',justifyContent:'center',gap:3}}>
            <TouchableOpacity style={s.dpadBtn} onPress={()=>addMove('up')} activeOpacity={0.7}><Text style={s.dpadArrow}>↑</Text></TouchableOpacity>
          </View>
          <View style={{flexDirection:'row',justifyContent:'center',gap:3}}>
            <TouchableOpacity style={s.dpadBtn} onPress={()=>addMove('left')} activeOpacity={0.7}><Text style={s.dpadArrow}>←</Text></TouchableOpacity>
            <View style={{width:48}}/>
            <TouchableOpacity style={s.dpadBtn} onPress={()=>addMove('right')} activeOpacity={0.7}><Text style={s.dpadArrow}>→</Text></TouchableOpacity>
          </View>
          <View style={{flexDirection:'row',justifyContent:'center',gap:3}}>
            <TouchableOpacity style={s.dpadBtn} onPress={()=>addMove('down')} activeOpacity={0.7}><Text style={s.dpadArrow}>↓</Text></TouchableOpacity>
          </View>
        </View>
        <View style={{flexDirection:'row',gap:8,flexWrap:'wrap'}}>
          <TouchableOpacity style={[s.pill,recMode&&{borderColor:COLORS.rose}]} onPress={()=>setRecMode(r=>!r)} activeOpacity={0.7}>
            <Text style={[s.pillTxt,recMode&&{color:COLORS.rose}]}>{recMode?'Stop':'Record'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.pill} onPress={()=>setGesture([...DEFAULT_GESTURE])} activeOpacity={0.7}>
            <Text style={s.pillTxt}>↑↑↓↓ Default</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.pill,{borderColor:COLORS.rose}]} onPress={()=>setGesture([])} activeOpacity={0.7}>
            <Text style={[s.pillTxt,{color:COLORS.rose}]}>Clear</Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity style={[s.solidBtn,{marginTop:8}]} onPress={saveGest} activeOpacity={0.7}>
          <Text style={s.solidBtnTxt}>Save Sequence</Text>
        </TouchableOpacity>
      </View>

      <View style={s.card}>
        <Text style={s.cardTitle}>Access Code</Text>
        <Text style={s.cardDesc}>Change your gallery entry code</Text>
        {showChPw ? (
          <>
            {[['Current code',curPw,setCurPw],['New code',newPw,setNewPw],['Confirm new',newPw2,setNewPw2]].map(([ph,val,set])=>(
              <TextInput key={ph} style={s.input} placeholder={ph} placeholderTextColor={COLORS.textMuted}
                secureTextEntry value={val} onChangeText={t=>{set(t);setPwErr('');}} autoCapitalize="none"/>
            ))}
            {!!pwErr && <Text style={{fontFamily:FONTS.body,color:COLORS.rose,fontSize:12,marginBottom:4}}>{pwErr}</Text>}
            <View style={{flexDirection:'row',gap:8}}>
              <TouchableOpacity style={[s.solidBtn,{flex:1}]} onPress={changePw} activeOpacity={0.7}><Text style={s.solidBtnTxt}>Save</Text></TouchableOpacity>
              <TouchableOpacity style={[s.outBtn,{flex:1}]} onPress={()=>setShowChPw(false)} activeOpacity={0.7}><Text style={s.outBtnTxt}>Cancel</Text></TouchableOpacity>
            </View>
          </>
        ) : (
          <TouchableOpacity style={s.outBtn} onPress={()=>setShowChPw(true)} activeOpacity={0.7}>
            <Text style={s.outBtnTxt}>Change Code</Text>
          </TouchableOpacity>
        )}
      </View>

      <View style={s.card}>
        <Text style={s.cardTitle}>Groups</Text>
        <Text style={s.cardDesc}>Each group uses its own passphrase</Text>
        {groups.length===0 ? <Text style={{color:COLORS.textMuted,fontFamily:FONTS.body,fontSize:13}}>No groups yet</Text>
          : groups.map(g=>{
            const palette=pal(g); const n=photos.filter(p=>p.groupId===g.id).length;
            return (
              <View key={g.id} style={{flexDirection:'row',alignItems:'center',paddingVertical:8,borderBottomWidth:1,borderColor:COLORS.border,gap:8}}>
                <View style={{width:10,height:10,borderRadius:5,backgroundColor:palette.dot}}/>
                <Text style={{fontFamily:FONTS.bodyMed,color:COLORS.textPrimary,fontSize:13,flex:1}}>{g.label}</Text>
                <Text style={{fontFamily:FONTS.body,color:COLORS.textSecondary,fontSize:11}}>{n} item{n!==1?'s':''}</Text>
              </View>
            );
          })
        }
      </View>

      <View style={s.card}>
        <View style={{flexDirection:'row',justifyContent:'space-between',alignItems:'center'}}>
          <Text style={s.cardTitle}>Audit Log</Text>
          <TouchableOpacity onPress={()=>clearAuditLog().then(loadAudit)} activeOpacity={0.7}>
            <Text style={{color:COLORS.rose,fontFamily:FONTS.body,fontSize:12}}>Clear</Text>
          </TouchableOpacity>
        </View>
        <Text style={s.cardDesc}>Recent vault activity</Text>
        {auditLog.length===0 ? <Text style={{color:COLORS.textMuted,fontFamily:FONTS.body,fontSize:13}}>No activity yet</Text>
          : auditLog.slice(0,30).map((e,i)=>(
            <View key={i} style={{flexDirection:'row',alignItems:'flex-start',paddingVertical:6,borderBottomWidth:1,borderColor:COLORS.border,gap:8}}>
              <View style={{flex:1}}>
                <Text style={{fontFamily:FONTS.bodyMed,color:COLORS.textPrimary,fontSize:12}}>{e.type.replace(/_/g,' ')}</Text>
                {!!e.detail && <Text style={{fontFamily:FONTS.body,color:COLORS.textSecondary,fontSize:11}}>{e.detail}</Text>}
              </View>
              <Text style={{fontFamily:FONTS.mono,color:COLORS.textMuted,fontSize:10}}>{new Date(e.ts).toLocaleTimeString()}</Text>
            </View>
          ))
        }
      </View>

      <View style={s.card}>
        <Text style={s.cardTitle}>Vault Storage</Text>
        <Text style={s.cardDesc}>Encrypted files are stored at:</Text>
        <Text style={{fontFamily:FONTS.mono,color:COLORS.textSecondary,fontSize:11,marginTop:4}}>{VAULT_DIR}</Text>
        <Text style={{fontFamily:FONTS.body,color:COLORS.textMuted,fontSize:11,marginTop:4}}>Use the CLI tool (cli/knot.js) to decrypt files without this app.</Text>
      </View>

      <TouchableOpacity style={[s.outBtn,{borderColor:COLORS.rose}]} onPress={()=>{session.wipe();onLogout?.();}} activeOpacity={0.7}>
        <Text style={[s.outBtnTxt,{color:COLORS.rose}]}>← Back to Game</Text>
      </TouchableOpacity>
    </ScrollView>
  );

  // ── PHOTO VIEWER ──────────────────────────────────────────────────────────
  const PhotoViewer = () => {
    if (!viewPhoto) return null;
    const uri=session.decryptedMap[viewPhoto.id];
    if (!uri) return null;

    const doShare=()=>{
      const ext=(viewPhoto.mimeType||'image/jpeg').split('/')[1]||'jpg';
      const tmp=`${FileSystem.cacheDirectory}sh_${viewPhoto.id}.${ext}`;
      FileSystem.writeAsStringAsync(tmp,uri.split(',')[1],{encoding:FileSystem.EncodingType.Base64})
        .then(()=>Sharing.isAvailableAsync())
        .then(ok=>ok&&Sharing.shareAsync(tmp,{mimeType:viewPhoto.mimeType||'image/jpeg'}))
        .then(()=>logEvent('share_decrypted',viewPhoto.name).catch(()=>{}))
        .catch(e=>toast_('Share failed: '+e.message,'error'));
    };

    return (
      <View style={vw.root}>
        <TouchableOpacity style={vw.closeBtn} onPress={()=>setViewPhoto(null)} hitSlop={{top:16,bottom:16,left:16,right:16}} activeOpacity={0.7}>
          <Text style={vw.closeTxt}>✕</Text>
        </TouchableOpacity>
        <View style={vw.timer} pointerEvents="none"><Text style={vw.timerTxt}>{fmt(session.remaining)}</Text></View>
        <Animated.View style={vw.imgWrap} {...photoPanResponder.panHandlers}>
          <Animated.Image source={{uri}} style={[vw.img,{transform:[{translateX:zoomTX},{translateY:zoomTY},{scale:zoomScale}]}]} resizeMode="contain"/>
        </Animated.View>
        <View style={vw.bar}>
          <TouchableOpacity style={vw.barBtn} onPress={()=>{setExportTarget(viewPhoto.id);setViewPhoto(null);setShowExport(true);}} activeOpacity={0.7}>
            <Text style={vw.barTxt}>⬇  Export</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[vw.barBtn,vw.barBtnBlue]} onPress={doShare} activeOpacity={0.7}>
            <Text style={vw.barTxt}>↗  Share</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  // ── VIDEO VIEWER ──────────────────────────────────────────────────────────
  const VideoViewer = () => {
    if (!viewVideo) return null;
    return (
      <View style={vw.root}>
        <TouchableOpacity style={vw.closeBtn} onPress={()=>setViewVideo(null)} hitSlop={{top:16,bottom:16,left:16,right:16}} activeOpacity={0.7}>
          <Text style={vw.closeTxt}>✕</Text>
        </TouchableOpacity>
        <View style={vw.timer} pointerEvents="none"><Text style={vw.timerTxt}>{fmt(session.remaining)}</Text></View>
        <Video source={{uri:viewVideo.uri}} style={{width:SW,height:SH*0.65}} useNativeControls resizeMode={ResizeMode.CONTAIN} shouldPlay isLooping={false}/>
        <View style={vw.bar}>
          <TouchableOpacity style={vw.barBtn} onPress={()=>{setExportTarget(viewVideo.photo.id);setViewVideo(null);setShowExport(true);}} activeOpacity={0.7}>
            <Text style={vw.barTxt}>⬇  Export</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[vw.barBtn,vw.barBtnBlue]} onPress={()=>{
            Sharing.isAvailableAsync()
              .then(ok=>ok&&Sharing.shareAsync(viewVideo.uri,{mimeType:viewVideo.photo.mimeType||'video/mp4'}))
              .then(()=>logEvent('share_decrypted',viewVideo.photo.name).catch(()=>{}))
              .catch(e=>toast_('Share failed: '+e.message,'error'));
          }} activeOpacity={0.7}>
            <Text style={vw.barTxt}>↗  Share</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  // ── RENDER ────────────────────────────────────────────────────────────────
  return (
    <View style={s.root}>
      <View style={s.tabBar}>
        <View style={{flexDirection:'row',alignItems:'center',gap:10}}>
          <TouchableOpacity style={s.backCircle} onPress={()=>{session.wipe();onLogout?.();}} activeOpacity={0.7}>
            <Text style={{fontSize:18,color:COLORS.textSecondary}}>←</Text>
          </TouchableOpacity>
          <Text style={s.appName}>My Gallery</Text>
        </View>
        <View style={s.tabTrack}>
          {['Gallery','Shared','Settings'].map((label,i)=>(
            <TouchableOpacity key={label} style={[s.tabBtn,tab===i&&s.tabOn]} onPress={()=>setTab(i)} activeOpacity={0.7}>
              <Text style={[s.tabTxt,tab===i&&s.tabOnTxt]}>{label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {tab===0 && <GalleryTab/>}
      {tab===1 && <SharedTab showToast={toast_} onSaveToVault={(b64,mime,name,done)=>setSavePending({plainB64:b64,mime,name,onDone:done})}/>}
      {tab===2 && <SettingsTab/>}

      {openGroup && <GroupView/>}
      <PhotoViewer/>
      <VideoViewer/>

      <PassSheet visible={showUnlock} onClose={()=>{setShowUnlock(false);setUnlockGroup(null);}} onConfirm={handleUnlock}
        title={unlockGroup?`Unlock "${unlockGroup.label}"`:'Unlock'} subtitle="Enter the group passphrase" confirmLabel="Unlock" loading={!!proc}/>
      <PassSheet visible={showExtend} onClose={()=>{setShowExtend(false);session.wipe();}} onConfirm={handleExtend}
        title="Session Expired" subtitle="Re-enter passphrase to continue" confirmLabel="Extend" loading={!!proc}/>
      <PassSheet visible={showExport} onClose={()=>setShowExport(false)} onConfirm={handleExport}
        title="Export" subtitle="Enter passphrase to decrypt and save" confirmLabel="Export" loading={!!proc}/>

      <GroupPicker visible={showGroupPick} onClose={()=>{setShowGroupPick(false);setPending([]);}} groups={groups} count={pending.length} onPick={onPickGroup} onCreateNew={onCreateNew}/>

      <Sheet visible={showNewLabel} onClose={()=>{setShowNewLabel(false);setPending([]);setSaveViaNew(false);}}>
        <View style={{padding:SPACING.lg}}>
          <Text style={{fontFamily:FONTS.heading,color:COLORS.textPrimary,fontSize:17,marginBottom:4}}>Name this group</Text>
          <Text style={{fontFamily:FONTS.body,color:COLORS.textSecondary,fontSize:13,marginBottom:SPACING.md}}>e.g. "Goa Trip", "Personal", "Work"</Text>
          <TextInput style={s.input} placeholder="Group name" placeholderTextColor={COLORS.textMuted} value={newLabel} onChangeText={setNewLabel} autoFocus returnKeyType="next" onSubmitEditing={confirmNewLabel}/>
          <TouchableOpacity style={[s.solidBtn,{marginTop:8}]} onPress={confirmNewLabel} disabled={!newLabel.trim()} activeOpacity={0.7}>
            <Text style={s.solidBtnTxt}>Next →</Text>
          </TouchableOpacity>
        </View>
      </Sheet>

      <PassSheet visible={showNewPass} onClose={()=>{setShowNewPass(false);setPending([]);setSaveViaNew(false);}}
        onConfirm={confirmNewPass} title={`Passphrase for "${newLabel}"`} subtitle={`Encrypts ${pending.length} item${pending.length!==1?'s':''}`} confirmLabel="Encrypt & Add" withConfirm/>

      <PassSheet visible={!!showExistingPass} onClose={()=>{setShowExistingPass(null);setPending([]);}}
        onConfirm={confirmExistingPass} title={`Add to "${showExistingPass?.label}"`} subtitle="Confirm group passphrase" confirmLabel="Encrypt & Add"/>

      <GroupPicker visible={!!savePending&&!saveGroup} onClose={()=>setSavePending(null)} groups={groups} count={1}
        onPick={g=>setSaveGroup(g)} onCreateNew={()=>{setNewLabel('');setShowNewLabel(true);setSaveViaNew(true);}}/>
      <PassSheet visible={!!saveGroup} onClose={()=>setSaveGroup(null)}
        onConfirm={async pw=>{
          const g=saveGroup,sp=savePending; setSaveGroup(null); setSavePending(null);
          const fp=await passphraseFingerprint(pw);
          if(fp!==g.fingerprint){toast_('Wrong passphrase','error');return;}
          await saveToVault(sp,pw,g);
        }}
        title={`Save to "${saveGroup?.label}"`} subtitle="Confirm group passphrase" confirmLabel="Save"/>

      <Toast visible={toast.visible} message={toast.msg} type={toast.type} onHide={()=>setToast(t=>({...t,visible:false}))}/>
    </View>
  );
}


// ─── Styles ───────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  root:       { flex:1, backgroundColor:COLORS.bg },
  tabBar:     { backgroundColor:COLORS.surface1, borderBottomWidth:1, borderColor:COLORS.border, paddingTop:52, paddingHorizontal:SPACING.md, paddingBottom:SPACING.sm, gap:SPACING.sm, shadowColor:'#000', shadowOpacity:0.06, shadowOffset:{width:0,height:2}, shadowRadius:6, elevation:4 },
  backCircle: { width:36, height:36, borderRadius:18, backgroundColor:COLORS.surface3, alignItems:'center', justifyContent:'center' },
  appName:    { fontFamily:FONTS.headingX, fontSize:22, color:COLORS.textPrimary, flex:1 },
  tabTrack:   { flexDirection:'row', backgroundColor:COLORS.surface2, borderRadius:RADIUS.full, padding:3, gap:2 },
  tabBtn:     { flex:1, alignItems:'center', paddingVertical:8, borderRadius:RADIUS.full },
  tabOn:      { backgroundColor:COLORS.surface1, shadowColor:'#000', shadowOpacity:0.08, shadowOffset:{width:0,height:1}, shadowRadius:3, elevation:2 },
  tabTxt:     { fontFamily:FONTS.body,    color:COLORS.textMuted,   fontSize:13 },
  tabOnTxt:   { fontFamily:FONTS.bodyMed, color:COLORS.textPrimary, fontSize:13 },
  toolbar:    { flexDirection:'row', alignItems:'center', justifyContent:'space-between', paddingHorizontal:SPACING.md, paddingVertical:10 },
  toolTitle:  { fontFamily:FONTS.body, color:COLORS.textSecondary, fontSize:13 },
  solidBtn:   { backgroundColor:COLORS.indigo, borderRadius:RADIUS.md, paddingVertical:11, paddingHorizontal:18, alignItems:'center', justifyContent:'center' },
  solidBtnTxt:{ fontFamily:FONTS.heading, color:'#fff', fontSize:14 },
  outBtn:     { borderWidth:1.5, borderColor:COLORS.indigo, borderRadius:RADIUS.md, paddingVertical:11, paddingHorizontal:18, alignItems:'center', justifyContent:'center' },
  outBtnTxt:  { fontFamily:FONTS.bodyMed, color:COLORS.indigo, fontSize:14 },
  pill:       { borderWidth:1.5, borderColor:COLORS.border, borderRadius:RADIUS.full, paddingHorizontal:16, paddingVertical:8 },
  pillOn:     { borderColor:COLORS.indigo, backgroundColor:COLORS.indigoDim },
  pillTxt:    { fontFamily:FONTS.body,    color:COLORS.textSecondary, fontSize:13 },
  pillOnTxt:  { fontFamily:FONTS.bodyMed, color:COLORS.indigo,        fontSize:13 },
  card:       { backgroundColor:COLORS.surface1, borderRadius:RADIUS.xl, padding:SPACING.md, borderWidth:1, borderColor:COLORS.border, gap:SPACING.sm, shadowColor:'#000', shadowOpacity:0.04, shadowOffset:{width:0,height:2}, shadowRadius:8, elevation:2 },
  cardTitle:  { fontFamily:FONTS.heading, color:COLORS.textPrimary,   fontSize:15 },
  cardDesc:   { fontFamily:FONTS.body,    color:COLORS.textSecondary, fontSize:12 },
  arrow:      { backgroundColor:COLORS.indigoDim, borderRadius:6, borderWidth:1, borderColor:COLORS.indigo+'44', paddingHorizontal:8, paddingVertical:4 },
  arrowTxt:   { fontFamily:FONTS.mono, color:COLORS.indigo, fontSize:16 },
  dpadBtn:    { width:48, height:48, backgroundColor:COLORS.surface2, borderRadius:RADIUS.md, borderWidth:1.5, borderColor:COLORS.border, alignItems:'center', justifyContent:'center' },
  dpadArrow:  { fontFamily:FONTS.mono, color:COLORS.textPrimary, fontSize:20 },
  input:      { backgroundColor:COLORS.surface2, borderRadius:RADIUS.md, borderWidth:1.5, borderColor:COLORS.border, paddingHorizontal:SPACING.md, paddingVertical:13, fontFamily:FONTS.body, color:COLORS.textPrimary, fontSize:14, marginBottom:8 },
  empty:      { flex:1, alignItems:'center', justifyContent:'center', padding:SPACING.xxl },
  emptyTitle: { fontFamily:FONTS.heading, color:COLORS.textPrimary,   fontSize:20, marginBottom:6 },
  emptyDesc:  { fontFamily:FONTS.body,    color:COLORS.textSecondary, fontSize:14, textAlign:'center' },
  overlay:    { ...StyleSheet.absoluteFillObject, backgroundColor:'rgba(240,244,255,0.93)', alignItems:'center', justifyContent:'center', gap:16, zIndex:50, elevation:50 },
  overlayTxt: { fontFamily:FONTS.bodyMed, color:COLORS.textSecondary, fontSize:14 },
});

const fs = StyleSheet.create({
  grid:     { padding:SPACING.md, paddingBottom:120 },
  row:      { flexDirection:'row', flexWrap:'wrap', gap:12 },
  col:      { width:(SW-SPACING.md*2-12)/2 },
  card:     { borderRadius:RADIUS.xl, overflow:'hidden', shadowColor:'#000', shadowOpacity:0.08, shadowOffset:{width:0,height:4}, shadowRadius:12, elevation:4 },
  preview:  { height:140 },
  preEmpty: { flex:1, alignItems:'center', justifyContent:'center' },
  preGrid:  { flex:1, flexDirection:'row', flexWrap:'wrap' },
  preCell:  { width:'50%', height:'50%' },
  preFull:  { width:'100%', height:'100%' },
  preImg:   { width:'100%', height:'100%' },
  preLock:  { flex:1, alignItems:'center', justifyContent:'center' },
  info:     { padding:12 },
  dot:      { width:8, height:8, borderRadius:4 },
  label:    { fontFamily:FONTS.heading, fontSize:14, flex:1 },
  count:    { fontFamily:FONTS.body, fontSize:12 },
  badge:    { borderRadius:RADIUS.full, paddingHorizontal:8, paddingVertical:2 },
  badgeTxt: { fontFamily:FONTS.bodyMed, fontSize:10 },
  unlockBtn:{ marginHorizontal:12, marginBottom:12, borderRadius:RADIUS.md, paddingVertical:9, alignItems:'center' },
  unlockTxt:{ fontFamily:FONTS.heading, color:'#fff', fontSize:13 },
});

const dv = StyleSheet.create({
  root:     { ...StyleSheet.absoluteFillObject, zIndex:50, elevation:50, backgroundColor:COLORS.bg },
  hdr:      { flexDirection:'row', alignItems:'center', gap:10, paddingHorizontal:SPACING.md, paddingTop:56, paddingBottom:SPACING.sm, shadowColor:'#000', shadowOpacity:0.05, shadowOffset:{width:0,height:2}, shadowRadius:6, elevation:3 },
  back:     { paddingRight:4, paddingVertical:4 },
  backTxt:  { fontFamily:FONTS.bodyMed, fontSize:15 },
  hdot:     { width:10, height:10, borderRadius:5 },
  htitle:   { fontFamily:FONTS.heading, fontSize:18 },
  ulBtn:    { borderRadius:RADIUS.md, paddingHorizontal:16, paddingVertical:8 },
  ulTxt:    { fontFamily:FONTS.heading, color:'#fff', fontSize:13 },
  card:     { width:THUMB, height:THUMB, borderRadius:RADIUS.md, overflow:'hidden', backgroundColor:COLORS.surface2 },
  img:      { width:'100%', height:'100%' },
  vidThumb: { flex:1, alignItems:'center', justifyContent:'center' },
  badge:    { position:'absolute', top:4, left:4, backgroundColor:'rgba(255,255,255,0.88)', borderRadius:6, flexDirection:'row', alignItems:'center', paddingHorizontal:5, paddingVertical:2, gap:3 },
  dot2:     { width:5, height:5, borderRadius:3 },
  badgeTxt: { fontFamily:FONTS.mono, fontSize:9 },
  locked:   { flex:1, alignItems:'center', justifyContent:'center', gap:4, padding:4 },
  lockedTxt:{ fontFamily:FONTS.body, fontSize:9, textAlign:'center' },
  selOv:    { ...StyleSheet.absoluteFillObject, backgroundColor:'rgba(91,91,214,0.38)', alignItems:'center', justifyContent:'center' },
  selChk:   { fontFamily:FONTS.heading, color:'#fff', fontSize:24 },
  bar:      { position:'absolute', bottom:0, left:0, right:0, backgroundColor:COLORS.surface1, padding:SPACING.md, paddingBottom:28, gap:8, borderTopWidth:1, borderColor:COLORS.border, shadowColor:'#000', shadowOpacity:0.1, shadowOffset:{width:0,height:-2}, shadowRadius:8, elevation:8 },
  barTitle: { fontFamily:FONTS.bodyMed, color:COLORS.textSecondary, fontSize:13 },
  barBtn:   { borderRadius:RADIUS.md, paddingHorizontal:14, paddingVertical:8 },
  barBtnTxt:{ fontFamily:FONTS.heading, color:'#fff', fontSize:13 },
});

const vw = StyleSheet.create({
  root:      { ...StyleSheet.absoluteFillObject, zIndex:200, elevation:200, backgroundColor:'#000', justifyContent:'center', alignItems:'center' },
  closeBtn:  { position:'absolute', top:52, right:18, zIndex:210, elevation:210, width:44, height:44, borderRadius:22, backgroundColor:'rgba(255,255,255,0.18)', alignItems:'center', justifyContent:'center' },
  closeTxt:  { color:'#fff', fontSize:18, fontFamily:FONTS.heading },
  timer:     { position:'absolute', top:54, left:18, zIndex:210, elevation:210, backgroundColor:'rgba(0,0,0,0.45)', borderRadius:20, paddingHorizontal:12, paddingVertical:5 },
  timerTxt:  { color:'#fff', fontFamily:FONTS.mono, fontSize:12 },
  imgWrap:   { position:'absolute', top:0, left:0, right:0, bottom:90, alignItems:'center', justifyContent:'center' },
  img:       { width:SW, height:SH-90 },
  bar:       { position:'absolute', bottom:0, left:0, right:0, height:90, flexDirection:'row', alignItems:'center', justifyContent:'center', gap:16, paddingBottom:16, backgroundColor:'rgba(0,0,0,0.55)', zIndex:210, elevation:210 },
  barBtn:    { backgroundColor:'rgba(255,255,255,0.15)', borderWidth:1, borderColor:'rgba(255,255,255,0.3)', borderRadius:RADIUS.xl, paddingHorizontal:28, paddingVertical:12, minWidth:130, alignItems:'center' },
  barBtnBlue:{ backgroundColor:COLORS.sky+'CC', borderColor:COLORS.sky },
  barTxt:    { color:'#fff', fontFamily:FONTS.heading, fontSize:15 },
});
