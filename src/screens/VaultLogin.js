import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, Animated, KeyboardAvoidingView, Platform,
} from 'react-native';
import { hashStr, verifyHash } from '../utils/crypto';
import { storage, KEYS } from '../utils/storage';
import { COLORS, FONTS, RADIUS, SPACING } from '../utils/theme';

export function VaultLogin({ onSuccess, onBack }) {
  const [mode, setMode]         = useState('login'); // login | forgot
  const [pw, setPw]             = useState('');
  const [recovery, setRecovery] = useState('');
  const [newPw, setNewPw]       = useState('');
  const [newPw2, setNewPw2]     = useState('');
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);

  const shakeAnim = useRef(new Animated.Value(0)).current;
  const fadeAnim  = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 400, useNativeDriver: true }).start();
  }, []);

  const shake = () => {
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: 10, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -10, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 6, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 0, duration: 60, useNativeDriver: true }),
    ]).start();
  };

  const handleLogin = async () => {
    setLoading(true); setError('');
    try {
      const stored = await storage.get(KEYS.VAULT_PW_HASH);
      const ok = await verifyHash(pw, stored);
      if (ok) {
        onSuccess?.();
      } else {
        setError('Incorrect access code');
        shake();
      }
    } catch {
      setError('Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  const handleForgot = async () => {
    if (newPw.length < 4)       { setError('Minimum 4 characters'); return; }
    if (newPw !== newPw2)        { setError('Passwords do not match'); return; }
    setLoading(true); setError('');
    try {
      const storedRecovery = await storage.get(KEYS.RECOVERY_HASH);
      const ok = await verifyHash(recovery, storedRecovery);
      if (!ok) { setError('Recovery phrase incorrect'); shake(); setLoading(false); return; }
      const newHash = await hashStr(newPw);
      await storage.set(KEYS.VAULT_PW_HASH, newHash);
      setMode('login');
      setPw(''); setRecovery(''); setNewPw(''); setNewPw2('');
      setError('');
    } catch {
      setError('Reset failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={s.root}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <Animated.View style={[s.card, { opacity: fadeAnim, transform: [{ translateX: shakeAnim }] }]}>
        <View style={s.iconWrap}>
          <Text style={s.icon}>🖼</Text>
        </View>
        <Text style={s.title}>My Gallery</Text>
        <Text style={s.subtitle}>
          {mode === 'login' ? 'Enter your access code' : 'Reset access code'}
        </Text>

        {mode === 'login' ? (
          <>
            <TextInput
              style={s.input}
              placeholder="Access code"
              placeholderTextColor={COLORS.textMuted}
              secureTextEntry
              value={pw}
              onChangeText={t => { setPw(t); setError(''); }}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={handleLogin}
              autoFocus
            />
            {error ? <Text style={s.errTxt}>{error}</Text> : null}
            <TouchableOpacity
              style={[s.btn, loading && { opacity: 0.5 }]}
              onPress={handleLogin}
              disabled={loading || !pw}
            >
              <Text style={s.btnTxt}>{loading ? 'Checking…' : 'Open Gallery'}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { setMode('forgot'); setError(''); }}>
              <Text style={s.link}>Forgot access code?</Text>
            </TouchableOpacity>
          </>
        ) : (
          <>
            <TextInput
              style={s.input}
              placeholder="Recovery phrase"
              placeholderTextColor={COLORS.textMuted}
              secureTextEntry
              value={recovery}
              onChangeText={t => { setRecovery(t); setError(''); }}
              autoCapitalize="none"
              autoFocus
            />
            <TextInput
              style={s.input}
              placeholder="New access code"
              placeholderTextColor={COLORS.textMuted}
              secureTextEntry
              value={newPw}
              onChangeText={t => { setNewPw(t); setError(''); }}
              autoCapitalize="none"
            />
            <TextInput
              style={s.input}
              placeholder="Confirm new code"
              placeholderTextColor={COLORS.textMuted}
              secureTextEntry
              value={newPw2}
              onChangeText={t => { setNewPw2(t); setError(''); }}
              autoCapitalize="none"
            />
            {error ? <Text style={s.errTxt}>{error}</Text> : null}
            <TouchableOpacity
              style={[s.btn, loading && { opacity: 0.5 }]}
              onPress={handleForgot}
              disabled={loading}
            >
              <Text style={s.btnTxt}>{loading ? 'Saving…' : 'Reset Code'}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { setMode('login'); setError(''); }}>
              <Text style={s.link}>← Back to login</Text>
            </TouchableOpacity>
          </>
        )}

        <TouchableOpacity onPress={onBack} style={s.backBtn}>
          <Text style={s.backTxt}>← Back to Game</Text>
        </TouchableOpacity>
      </Animated.View>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: COLORS.bg,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.xl,
  },
  card: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: COLORS.surface1,
    borderRadius: RADIUS.xl,
    padding: SPACING.xl,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
  },
  iconWrap: {
    width: 64, height: 64,
    backgroundColor: COLORS.surface2,
    borderRadius: RADIUS.full,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: SPACING.md,
    borderWidth: 1, borderColor: COLORS.border,
  },
  icon: { fontSize: 28 },
  title: {
    fontFamily: FONTS.headingX,
    color: COLORS.textPrimary,
    fontSize: 22,
    marginBottom: 4,
  },
  subtitle: {
    fontFamily: FONTS.body,
    color: COLORS.textSecondary,
    fontSize: 13,
    marginBottom: SPACING.xl,
    textAlign: 'center',
  },
  input: {
    width: '100%',
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
    letterSpacing: 1,
  },
  btn: {
    width: '100%',
    backgroundColor: COLORS.green,
    borderRadius: RADIUS.md,
    paddingVertical: 15,
    alignItems: 'center',
    marginTop: SPACING.sm,
  },
  btnTxt: {
    fontFamily: FONTS.heading,
    color: '#fff',
    fontSize: 15,
  },
  errTxt: {
    fontFamily: FONTS.body,
    color: COLORS.rose,
    fontSize: 13,
    marginBottom: SPACING.sm,
    alignSelf: 'flex-start',
  },
  link: {
    fontFamily: FONTS.body,
    color: COLORS.blue,
    fontSize: 13,
    marginTop: SPACING.md,
  },
  backBtn: {
    marginTop: SPACING.lg,
  },
  backTxt: {
    fontFamily: FONTS.body,
    color: COLORS.textMuted,
    fontSize: 13,
  },
});
