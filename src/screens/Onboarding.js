import React, { useState, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  Animated, Dimensions, ScrollView, Platform,
} from 'react-native';
import { hashStr, passwordStrength } from '../utils/crypto';
import { storage, KEYS } from '../utils/storage';
import { COLORS, FONTS, RADIUS, SPACING } from '../utils/theme';

const { width: SW } = Dimensions.get('window');
const ARROW_ICONS = { up:'↑', down:'↓', left:'←', right:'→' };
const DEFAULT_GESTURE = ['up','up','down','down'];

// ── Reusable password field with eye toggle ───────────────────────────────────
function PwInput({ placeholder, value, onChangeText, returnKeyType, onSubmitEditing }) {
  const [show, setShow] = useState(false);
  return (
    <View style={pi.wrap}>
      <TextInput
        style={pi.input}
        placeholder={placeholder}
        placeholderTextColor={COLORS.textMuted}
        secureTextEntry={!show}
        value={value}
        onChangeText={onChangeText}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType={returnKeyType || 'next'}
        onSubmitEditing={onSubmitEditing}
      />
      <TouchableOpacity onPress={() => setShow(v => !v)} style={pi.eye} hitSlop={{top:8,bottom:8,left:8,right:8}}>
        <Text style={pi.eyeTxt}>{show ? '🙈' : '👁️'}</Text>
      </TouchableOpacity>
    </View>
  );
}
const pi = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surface2,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    marginBottom: SPACING.sm,
    paddingRight: SPACING.sm,
  },
  input: {
    flex: 1,
    fontFamily: FONTS.body,
    color: COLORS.textPrimary,
    fontSize: 15,
    paddingHorizontal: SPACING.md,
    paddingVertical: 14,
  },
  eye: { padding: 6 },
  eyeTxt: { fontSize: 18 },
});

// ── Main Onboarding ───────────────────────────────────────────────────────────
export function Onboarding({ onDone }) {
  const [step, setStep]           = useState(0);
  const [vaultPw, setVaultPw]     = useState('');
  const [vaultPw2, setVaultPw2]   = useState('');
  const [recovery, setRecovery]   = useState('');
  const [recovery2, setRecovery2] = useState('');
  const [gesture, setGesture]     = useState([...DEFAULT_GESTURE]);
  const [recording, setRecording] = useState(false);
  const [error, setError]         = useState('');
  const [saving, setSaving]       = useState(false);
  const slideAnim = useRef(new Animated.Value(0)).current;

  const goTo = (s) => {
    setError('');
    Animated.spring(slideAnim, {
      toValue: -s * SW,
      tension: 80, friction: 15,
      useNativeDriver: true,
    }).start();
    setStep(s);
  };

  const strength = passwordStrength(vaultPw);

  const validate = () => {
    if (step === 1) {
      if (vaultPw.length < 4)   { setError('Minimum 4 characters'); return false; }
      if (vaultPw !== vaultPw2) { setError('Passwords do not match'); return false; }
    }
    if (step === 2) {
      if (recovery.trim().length < 4) { setError('Minimum 4 characters'); return false; }
      if (recovery !== recovery2)     { setError('Phrases do not match'); return false; }
    }
    if (step === 3) {
      if (gesture.length < 2) { setError('Enter at least 2 moves'); return false; }
    }
    return true;
  };

  const next = async () => {
    if (!validate()) return;
    if (step < 3) { goTo(step + 1); return; }
    setSaving(true);
    try {
      const [pwHash, recHash] = await Promise.all([hashStr(vaultPw), hashStr(recovery)]);
      await Promise.all([
        storage.set(KEYS.VAULT_PW_HASH, pwHash),
        storage.set(KEYS.RECOVERY_HASH, recHash),
        storage.set(KEYS.GESTURE, JSON.stringify(gesture)),
        storage.set(KEYS.SESSION_DURATION, '3'),
        storage.set(KEYS.ONBOARDED, 'true'),
      ]);
      goTo(4);
    } catch { setError('Setup failed — please try again'); }
    finally { setSaving(false); }
  };

  const addMove = (dir) => {
    if (!recording) return;
    setGesture(prev => prev.length >= 8 ? prev : [...prev, dir]);
  };

  // ── Step content ────────────────────────────────────────────────────────────
  const steps = [
    // 0: Welcome
    <ScrollView key="s0" style={s.slide} contentContainerStyle={s.slideContent} keyboardShouldPersistTaps="handled">
      <Text style={s.stepTitle}>Welcome</Text>
      <Text style={s.stepDesc}>Classic Snake, always ready to play.{'\n'}Let's set up your private space.</Text>
      <View style={s.iconBlock}><Text style={s.bigIcon}>🐍</Text></View>
      <TouchableOpacity style={s.btn} onPress={() => goTo(1)}>
        <Text style={s.btnTxt}>Get Started</Text>
      </TouchableOpacity>
    </ScrollView>,

    // 1: Access Code
    <ScrollView key="s1" style={s.slide} contentContainerStyle={s.slideContent} keyboardShouldPersistTaps="handled">
      <Text style={s.stepTitle}>Access Code</Text>
      <Text style={s.stepDesc}>This is how you open your private gallery.</Text>
      <PwInput placeholder="Choose a password" value={vaultPw} onChangeText={t => { setVaultPw(t); setError(''); }} />
      {vaultPw.length > 0 && (
        <View style={s.strengthRow}>
          <View style={s.strengthTrack}>
            {[1,2,3,4,5].map(i => (
              <View key={i} style={[s.strengthSeg, { backgroundColor: i <= strength.score ? strength.color : COLORS.surface3 }]} />
            ))}
          </View>
          <Text style={[s.strengthLabel, { color: strength.color }]}>{strength.label}</Text>
        </View>
      )}
      <PwInput placeholder="Confirm password" value={vaultPw2} onChangeText={t => { setVaultPw2(t); setError(''); }} returnKeyType="done" />
      {error ? <Text style={s.err}>{error}</Text> : null}
      <TouchableOpacity style={s.btn} onPress={next}><Text style={s.btnTxt}>Continue</Text></TouchableOpacity>
    </ScrollView>,

    // 2: Recovery Phrase
    <ScrollView key="s2" style={s.slide} contentContainerStyle={s.slideContent} keyboardShouldPersistTaps="handled">
      <Text style={s.stepTitle}>Recovery Phrase</Text>
      <Text style={s.stepDesc}>Resets your access code if forgotten.{'\n'}Does NOT recover photos.</Text>
      <PwInput placeholder="Choose a recovery phrase" value={recovery} onChangeText={t => { setRecovery(t); setError(''); }} />
      <PwInput placeholder="Confirm recovery phrase" value={recovery2} onChangeText={t => { setRecovery2(t); setError(''); }} returnKeyType="done" />
      {error ? <Text style={s.err}>{error}</Text> : null}
      <TouchableOpacity style={s.btn} onPress={next}><Text style={s.btnTxt}>Continue</Text></TouchableOpacity>
    </ScrollView>,

    // 3: Gesture
    <ScrollView key="s3" style={s.slide} contentContainerStyle={s.slideContent} keyboardShouldPersistTaps="handled">
      <Text style={s.stepTitle}>Secret Sequence</Text>
      <Text style={s.stepDesc}>Enter this D-pad pattern during the game to open your gallery.</Text>
      <View style={s.gestureDisplay}>
        {gesture.length === 0
          ? <Text style={{ color: COLORS.textMuted, fontFamily: FONTS.body, fontSize: 13 }}>No moves yet</Text>
          : gesture.map((g, i) => (
            <View key={i} style={s.gBadge}><Text style={s.gArrow}>{ARROW_ICONS[g]}</Text></View>
          ))
        }
      </View>
      <View style={s.dpadWrap}>
        <Text style={[s.recLabel, recording && { color: COLORS.green }]}>
          {recording ? '● Recording — tap arrows' : 'Tap Record then enter your moves'}
        </Text>
        <View style={s.dpad}>
          <View style={s.dpadRow}>
            <TouchableOpacity style={s.dpadBtn} onPress={() => addMove('up')}><Text style={s.dpadTxt}>↑</Text></TouchableOpacity>
          </View>
          <View style={s.dpadRow}>
            <TouchableOpacity style={s.dpadBtn} onPress={() => addMove('left')}><Text style={s.dpadTxt}>←</Text></TouchableOpacity>
            <View style={s.dpadCenter} />
            <TouchableOpacity style={s.dpadBtn} onPress={() => addMove('right')}><Text style={s.dpadTxt}>→</Text></TouchableOpacity>
          </View>
          <View style={s.dpadRow}>
            <TouchableOpacity style={s.dpadBtn} onPress={() => addMove('down')}><Text style={s.dpadTxt}>↓</Text></TouchableOpacity>
          </View>
        </View>
        <View style={s.gActions}>
          <TouchableOpacity style={[s.smallBtn, recording && { borderColor: COLORS.rose }]} onPress={() => setRecording(r => !r)}>
            <Text style={[s.smallBtnTxt, recording && { color: COLORS.rose }]}>{recording ? 'Stop' : 'Record'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.smallBtn, { borderColor: COLORS.textMuted }]} onPress={() => setGesture([...DEFAULT_GESTURE])}>
            <Text style={[s.smallBtnTxt, { color: COLORS.textMuted }]}>↑↑↓↓ Default</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.smallBtn, { borderColor: COLORS.rose }]} onPress={() => setGesture([])}>
            <Text style={[s.smallBtnTxt, { color: COLORS.rose }]}>Clear</Text>
          </TouchableOpacity>
        </View>
      </View>
      {error ? <Text style={s.err}>{error}</Text> : null}
      <TouchableOpacity style={[s.btn, saving && { opacity: 0.5 }]} onPress={next} disabled={saving}>
        <Text style={s.btnTxt}>{saving ? 'Saving…' : 'Finish Setup'}</Text>
      </TouchableOpacity>
    </ScrollView>,

    // 4: Done
    <ScrollView key="s4" style={s.slide} contentContainerStyle={s.slideContent}>
      <Text style={s.stepTitle}>All Set! 🎉</Text>
      <Text style={s.stepDesc}>Your game is ready. Enter your secret sequence during play to open your gallery.</Text>
      <View style={s.iconBlock}><Text style={s.bigIcon}>🎮</Text></View>
      <View style={s.summaryBox}>
        <Text style={s.summaryRow}>🔑  Access code set</Text>
        <Text style={s.summaryRow}>🛡️  Recovery phrase set</Text>
        <Text style={s.summaryRow}>🎮  Sequence: {gesture.map(g => ARROW_ICONS[g]).join(' ')}</Text>
      </View>
      <TouchableOpacity style={[s.btn, { backgroundColor: COLORS.green }]} onPress={onDone}>
        <Text style={s.btnTxt}>Start Playing</Text>
      </TouchableOpacity>
    </ScrollView>,
  ];

  return (
    <View style={s.root}>
      {/* Header */}
      <View style={s.header}>
        <Text style={s.logo}>Knot</Text>
        <View style={s.dots}>
          {[0,1,2,3].map(i => (
            <View key={i} style={[s.dot, step > i && { backgroundColor: COLORS.green }]} />
          ))}
        </View>
      </View>

      {/* Slider — overflow:hidden clips the other slides */}
      <View style={s.sliderClip}>
        <Animated.View style={[s.sliderTrack, { transform: [{ translateX: slideAnim }] }]}>
          {steps}
        </Animated.View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg },

  header: {
    paddingTop: 56,
    paddingHorizontal: SPACING.xl,
    paddingBottom: SPACING.md,
    alignItems: 'center',
    borderBottomWidth: 1,
    borderColor: COLORS.border,
  },
  logo: {
    fontFamily: FONTS.headingX,
    color: COLORS.green,
    fontSize: 26,
    letterSpacing: 3,
    marginBottom: SPACING.sm,
  },
  dots: { flexDirection: 'row', gap: 8 },
  dot: {
    width: 8, height: 8, borderRadius: 4,
    backgroundColor: COLORS.surface3,
    borderWidth: 1, borderColor: COLORS.border,
  },

  // ── THE FIX: clip the row of slides to exactly one screen width ──
  sliderClip: {
    flex: 1,
    width: SW,
    overflow: 'hidden',   // ← this is what was missing
  },
  sliderTrack: {
    flex: 1,
    flexDirection: 'row',
    width: SW * 5,        // 5 slides × screen width
  },
  slide: {
    width: SW,
    flex: 1,
  },
  slideContent: {
    paddingHorizontal: SPACING.xl,
    paddingTop: SPACING.xl,
    paddingBottom: 60,
  },

  stepTitle: {
    fontFamily: FONTS.headingX,
    color: COLORS.textPrimary,
    fontSize: 28,
    marginBottom: SPACING.sm,
  },
  stepDesc: {
    fontFamily: FONTS.body,
    color: COLORS.textSecondary,
    fontSize: 14,
    lineHeight: 22,
    marginBottom: SPACING.xl,
  },
  iconBlock: { alignItems: 'center', paddingVertical: SPACING.xxl },
  bigIcon: { fontSize: 80 },

  strengthRow: { flexDirection: 'row', alignItems: 'center', marginBottom: SPACING.sm, gap: 8 },
  strengthTrack: { flex: 1, flexDirection: 'row', gap: 4, height: 4 },
  strengthSeg: { flex: 1, borderRadius: 2, height: 4 },
  strengthLabel: { fontFamily: FONTS.body, fontSize: 12, width: 80, textAlign: 'right' },

  btn: {
    backgroundColor: COLORS.blue,
    borderRadius: RADIUS.md,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: SPACING.md,
  },
  btnTxt: { fontFamily: FONTS.heading, color: '#fff', fontSize: 16 },
  err: { fontFamily: FONTS.body, color: COLORS.rose, fontSize: 13, marginBottom: 8, textAlign: 'center' },

  gestureDisplay: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 8,
    marginBottom: SPACING.md, minHeight: 44, alignItems: 'center',
  },
  gBadge: {
    backgroundColor: COLORS.surface3, borderRadius: RADIUS.sm,
    borderWidth: 1, borderColor: COLORS.green, paddingHorizontal: 10, paddingVertical: 6,
  },
  gArrow: { fontFamily: FONTS.mono, color: COLORS.green, fontSize: 18 },

  dpadWrap: { alignItems: 'center', marginBottom: SPACING.md },
  recLabel: { fontFamily: FONTS.mono, color: COLORS.textMuted, fontSize: 12, marginBottom: SPACING.sm, letterSpacing: 0.5 },
  dpad: { gap: 3, marginBottom: SPACING.sm },
  dpadRow: { flexDirection: 'row', justifyContent: 'center', gap: 3 },
  dpadBtn: {
    width: 58, height: 58, backgroundColor: COLORS.surface2,
    borderRadius: RADIUS.sm, borderWidth: 1, borderColor: COLORS.border,
    alignItems: 'center', justifyContent: 'center',
  },
  dpadCenter: { width: 58, height: 58 },
  dpadTxt: { fontFamily: FONTS.mono, color: COLORS.textPrimary, fontSize: 24 },
  gActions: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', justifyContent: 'center' },
  smallBtn: {
    borderWidth: 1, borderColor: COLORS.green, borderRadius: RADIUS.sm,
    paddingHorizontal: 12, paddingVertical: 8,
  },
  smallBtnTxt: { fontFamily: FONTS.body, color: COLORS.green, fontSize: 13 },

  summaryBox: {
    backgroundColor: COLORS.surface2, borderRadius: RADIUS.md,
    borderWidth: 1, borderColor: COLORS.border,
    padding: SPACING.md, marginBottom: SPACING.md, gap: 10,
  },
  summaryRow: { fontFamily: FONTS.body, color: COLORS.textPrimary, fontSize: 14 },
});
