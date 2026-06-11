import React, { useState, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  Animated, Dimensions, ScrollView, KeyboardAvoidingView, Platform,
} from 'react-native';
import { hashStr, passwordStrength } from '../utils/crypto';
import { storage, KEYS } from '../utils/storage';
import { COLORS, FONTS, RADIUS, SPACING } from '../utils/theme';

const { width } = Dimensions.get('window');

const ARROW_ICONS = { up:'↑', down:'↓', left:'←', right:'→' };
const DEFAULT_GESTURE = ['up','up','down','down'];

export function Onboarding({ onDone }) {
  const [step, setStep]             = useState(0); // 0-4
  const [vaultPw, setVaultPw]       = useState('');
  const [vaultPw2, setVaultPw2]     = useState('');
  const [recovery, setRecovery]     = useState('');
  const [recovery2, setRecovery2]   = useState('');
  const [gesture, setGesture]       = useState([...DEFAULT_GESTURE]);
  const [recording, setRecording]   = useState(false);
  const [error, setError]           = useState('');
  const translateX = useRef(new Animated.Value(0)).current;

  const goTo = (s) => {
    setError('');
    Animated.spring(translateX, {
      toValue: -s * width, tension: 80, friction: 15, useNativeDriver: true,
    }).start();
    setStep(s);
  };

  const strength = passwordStrength(vaultPw);

  const validateStep = () => {
    if (step === 1) {
      if (vaultPw.length < 4) { setError('Minimum 4 characters'); return false; }
      if (vaultPw !== vaultPw2) { setError('Passwords do not match'); return false; }
    }
    if (step === 2) {
      if (recovery.trim().length < 4) { setError('Minimum 4 characters'); return false; }
      if (recovery !== recovery2) { setError('Phrases do not match'); return false; }
    }
    if (step === 3) {
      if (gesture.length < 2) { setError('Enter at least 2 moves'); return false; }
    }
    return true;
  };

  const next = async () => {
    if (!validateStep()) return;
    if (step < 3) { goTo(step + 1); return; }
    // Step 3 → finish
    try {
      const [pwHash, recHash] = await Promise.all([
        hashStr(vaultPw),
        hashStr(recovery),
      ]);
      await Promise.all([
        storage.set(KEYS.VAULT_PW_HASH, pwHash),
        storage.set(KEYS.RECOVERY_HASH, recHash),
        storage.set(KEYS.GESTURE, JSON.stringify(gesture)),
        storage.set(KEYS.SESSION_DURATION, '3'),
        storage.set(KEYS.ONBOARDED, 'true'),
      ]);
      goTo(4);
    } catch (e) {
      setError('Setup failed, please try again');
    }
  };

  const addGestureMove = (dir) => {
    if (!recording) return;
    setGesture(prev => {
      if (prev.length >= 8) return prev;
      return [...prev, dir];
    });
  };

  return (
    <View style={s.root}>
      {/* Scanline overlay */}
      <View style={s.scanlines} pointerEvents="none" />

      <View style={s.header}>
        <Text style={s.logo}>Knot</Text>
        <View style={s.dots}>
          {[0,1,2,3].map(i => (
            <View key={i} style={[s.dot, i <= step && step < 4 && { backgroundColor: COLORS.green }]} />
          ))}
        </View>
      </View>

      <Animated.View style={[s.slides, { transform: [{ translateX }] }]}>
        {/* Step 0: Welcome */}
        <View style={[s.slide, { width }]}>
          <Text style={s.stepTitle}>Welcome</Text>
          <Text style={s.stepDesc}>
            Classic Snake, always ready to play.{'\n'}
            Let's take 60 seconds to set up your private space.
          </Text>
          <View style={s.iconBlock}>
            <Text style={s.bigIcon}>🐍</Text>
          </View>
          <TouchableOpacity style={s.btn} onPress={() => goTo(1)}>
            <Text style={s.btnTxt}>Get Started</Text>
          </TouchableOpacity>
        </View>

        {/* Step 1: Vault Password */}
        <View style={[s.slide, { width }]}>
          <Text style={s.stepTitle}>Access Code</Text>
          <Text style={s.stepDesc}>This is how you enter your private gallery.</Text>
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <TextInput
              style={s.input}
              placeholder="Choose a password"
              placeholderTextColor={COLORS.textMuted}
              secureTextEntry
              value={vaultPw}
              onChangeText={t => { setVaultPw(t); setError(''); }}
              autoCapitalize="none"
            />
            {vaultPw.length > 0 && (
              <View style={s.strengthRow}>
                <View style={s.strengthTrack}>
                  {[1,2,3,4,5].map(i => (
                    <View
                      key={i}
                      style={[
                        s.strengthSeg,
                        { backgroundColor: i <= strength.score ? strength.color : COLORS.surface3 },
                      ]}
                    />
                  ))}
                </View>
                <Text style={[s.strengthLabel, { color: strength.color }]}>{strength.label}</Text>
              </View>
            )}
            <TextInput
              style={s.input}
              placeholder="Confirm password"
              placeholderTextColor={COLORS.textMuted}
              secureTextEntry
              value={vaultPw2}
              onChangeText={t => { setVaultPw2(t); setError(''); }}
              autoCapitalize="none"
            />
          </KeyboardAvoidingView>
          {error ? <Text style={s.errTxt}>{error}</Text> : null}
          <TouchableOpacity style={s.btn} onPress={next}>
            <Text style={s.btnTxt}>Continue</Text>
          </TouchableOpacity>
        </View>

        {/* Step 2: Recovery phrase */}
        <View style={[s.slide, { width }]}>
          <Text style={s.stepTitle}>Recovery Phrase</Text>
          <Text style={s.stepDesc}>
            Use this to reset your access code if forgotten.{'\n'}
            It does NOT recover your photos.
          </Text>
          <TextInput
            style={s.input}
            placeholder="Choose a recovery phrase"
            placeholderTextColor={COLORS.textMuted}
            secureTextEntry
            value={recovery}
            onChangeText={t => { setRecovery(t); setError(''); }}
            autoCapitalize="none"
          />
          <TextInput
            style={s.input}
            placeholder="Confirm recovery phrase"
            placeholderTextColor={COLORS.textMuted}
            secureTextEntry
            value={recovery2}
            onChangeText={t => { setRecovery2(t); setError(''); }}
            autoCapitalize="none"
          />
          {error ? <Text style={s.errTxt}>{error}</Text> : null}
          <TouchableOpacity style={s.btn} onPress={next}>
            <Text style={s.btnTxt}>Continue</Text>
          </TouchableOpacity>
        </View>

        {/* Step 3: Gesture */}
        <View style={[s.slide, { width }]}>
          <Text style={s.stepTitle}>Secret Sequence</Text>
          <Text style={s.stepDesc}>
            Enter this D-pad sequence during the game to open your gallery.
          </Text>
          <View style={s.gestureDisplay}>
            {gesture.map((g, i) => (
              <View key={i} style={s.gBadge}>
                <Text style={s.gArrow}>{ARROW_ICONS[g]}</Text>
              </View>
            ))}
            {gesture.length === 0 && (
              <Text style={{ color: COLORS.textMuted, fontFamily: FONTS.body }}>
                No moves yet
              </Text>
            )}
          </View>
          <View style={s.dpadWrap}>
            <Text style={[s.recordLabel, recording && { color: COLORS.green }]}>
              {recording ? '● Recording…' : 'Tap Record then enter moves'}
            </Text>
            <View style={s.dpad}>
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
                style={[s.smallBtn, recording && { borderColor: COLORS.rose }]}
                onPress={() => setRecording(r => !r)}
              >
                <Text style={s.smallBtnTxt}>{recording ? 'Stop' : 'Record'}</Text>
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
          </View>
          {error ? <Text style={s.errTxt}>{error}</Text> : null}
          <TouchableOpacity style={s.btn} onPress={next}>
            <Text style={s.btnTxt}>Finish Setup</Text>
          </TouchableOpacity>
        </View>

        {/* Step 4: Done */}
        <View style={[s.slide, { width }]}>
          <Text style={s.stepTitle}>All Set!</Text>
          <Text style={s.stepDesc}>
            Your game is ready. Enter your secret sequence anytime during play to access your gallery.
          </Text>
          <View style={s.iconBlock}>
            <Text style={s.bigIcon}>🎮</Text>
          </View>
          <TouchableOpacity style={[s.btn, { backgroundColor: COLORS.green }]} onPress={onDone}>
            <Text style={s.btnTxt}>Start Playing</Text>
          </TouchableOpacity>
        </View>
      </Animated.View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg },
  scanlines: {
    ...StyleSheet.absoluteFillObject,
    backgroundImage: Platform.OS === 'web'
      ? 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.1) 2px, rgba(0,0,0,0.1) 4px)'
      : undefined,
    zIndex: 0,
    pointerEvents: 'none',
  },
  header: {
    paddingTop: 60,
    paddingHorizontal: SPACING.xl,
    paddingBottom: SPACING.lg,
    alignItems: 'center',
    borderBottomWidth: 1,
    borderColor: COLORS.border,
  },
  logo: {
    fontFamily: FONTS.headingX,
    color: COLORS.green,
    fontSize: 22,
    letterSpacing: 2,
    marginBottom: SPACING.md,
  },
  dots: { flexDirection: 'row', gap: 8 },
  dot: {
    width: 8, height: 8, borderRadius: 4,
    backgroundColor: COLORS.surface3,
    borderWidth: 1, borderColor: COLORS.border,
  },
  slides: { flexDirection: 'row', flex: 1 },
  slide: {
    paddingHorizontal: SPACING.xl,
    paddingTop: SPACING.xl,
    paddingBottom: SPACING.xl,
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
  iconBlock: {
    alignItems: 'center',
    paddingVertical: SPACING.xxl,
  },
  bigIcon: { fontSize: 80 },
  input: {
    backgroundColor: COLORS.surface2,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: SPACING.md,
    paddingVertical: 14,
    fontFamily: FONTS.body,
    color: COLORS.textPrimary,
    fontSize: 15,
    marginBottom: SPACING.sm,
  },
  strengthRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: SPACING.sm,
    gap: SPACING.sm,
  },
  strengthTrack: {
    flex: 1,
    flexDirection: 'row',
    gap: 4,
    height: 4,
  },
  strengthSeg: {
    flex: 1,
    borderRadius: 2,
    height: 4,
  },
  strengthLabel: {
    fontFamily: FONTS.body,
    fontSize: 12,
    width: 70,
    textAlign: 'right',
  },
  btn: {
    backgroundColor: COLORS.blue,
    borderRadius: RADIUS.md,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: SPACING.md,
  },
  btnTxt: {
    fontFamily: FONTS.heading,
    color: '#fff',
    fontSize: 16,
  },
  errTxt: {
    fontFamily: FONTS.body,
    color: COLORS.rose,
    fontSize: 13,
    marginBottom: SPACING.sm,
    textAlign: 'center',
  },
  gestureDisplay: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: SPACING.lg,
    minHeight: 44,
    alignItems: 'center',
  },
  gBadge: {
    backgroundColor: COLORS.surface3,
    borderRadius: RADIUS.sm,
    borderWidth: 1,
    borderColor: COLORS.green,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  gArrow: {
    fontFamily: FONTS.mono,
    color: COLORS.green,
    fontSize: 18,
  },
  dpadWrap: { alignItems: 'center', marginBottom: SPACING.lg },
  recordLabel: {
    fontFamily: FONTS.mono,
    color: COLORS.textMuted,
    fontSize: 12,
    marginBottom: SPACING.md,
    letterSpacing: 0.5,
  },
  dpad: { gap: 2, marginBottom: SPACING.md },
  dpadRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 2,
  },
  dpadBtn: {
    width: 56,
    height: 56,
    backgroundColor: COLORS.surface2,
    borderRadius: RADIUS.sm,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dpadCenter: { width: 56, height: 56 },
  dpadTxt: {
    fontFamily: FONTS.mono,
    color: COLORS.textPrimary,
    fontSize: 22,
  },
  gestureActions: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
  smallBtn: {
    borderWidth: 1,
    borderColor: COLORS.green,
    borderRadius: RADIUS.sm,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  smallBtnTxt: {
    fontFamily: FONTS.body,
    color: COLORS.green,
    fontSize: 13,
  },
});
