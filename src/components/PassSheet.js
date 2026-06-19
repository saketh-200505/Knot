/**
 * PassSheet.js — Passphrase entry bottom sheet
 * Uses its own Modal directly (not Sheet component) to avoid 
 * Android back-press / keyboard dismiss triggering onClose.
 */
import React, { useState, useEffect, useRef } from 'react';
import {
  Modal, View, Text, TextInput, TouchableOpacity,
  Animated, StyleSheet, KeyboardAvoidingView,
  Platform, TouchableWithoutFeedback,
} from 'react-native';
import { COLORS, FONTS, RADIUS, SPACING } from '../utils/theme';

export function PassSheet({
  visible,
  onClose,
  onConfirm,
  title = 'Enter Passphrase',
  subtitle,
  confirmLabel = 'Confirm',
  withConfirm = false,
  loading = false,
}) {
  const [pass,     setPass]     = useState('');
  const [confirm,  setConfirm]  = useState('');
  const [showPass, setShowPass] = useState(false);
  const translateY = useRef(new Animated.Value(600)).current;
  const inputRef   = useRef(null);

  // Reset fields every time sheet opens
  useEffect(() => {
    if (visible) {
      setPass(''); setConfirm(''); setShowPass(false);
      Animated.spring(translateY, {
        toValue: 0, tension: 65, friction: 11, useNativeDriver: true,
      }).start(() => {
        // Focus input after animation
        setTimeout(() => inputRef.current?.focus(), 100);
      });
    } else {
      Animated.timing(translateY, {
        toValue: 600, duration: 200, useNativeDriver: true,
      }).start();
    }
  }, [visible]);

  const dismiss = () => {
    setPass(''); setConfirm('');
    onClose?.();
  };

  const submit = () => {
    if (!pass.trim()) return;
    if (withConfirm && pass !== confirm) return;
    const value = pass.trim();
    // Clear fields immediately so sheet feels responsive
    setPass(''); setConfirm('');
    // Call onConfirm — this is async but we don't await it here
    onConfirm(value);
  };

  const mismatch = withConfirm && confirm.length > 0 && pass !== confirm;

  return (
    <Modal
      transparent
      animationType="none"
      visible={visible}
      onRequestClose={dismiss}   // Android back button
      statusBarTranslucent
    >
      {/* Backdrop — tapping it dismisses */}
      <TouchableWithoutFeedback onPress={dismiss}>
        <View style={s.backdrop} />
      </TouchableWithoutFeedback>

      {/* Sheet content — separate from backdrop so taps don't propagate */}
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={s.kav}
        pointerEvents="box-none"
      >
        <Animated.View style={[s.sheet, { transform: [{ translateY }] }]}>
          <View style={s.handle} />

          <View style={s.body}>
            <Text style={s.title}>{title}</Text>
            {!!subtitle && <Text style={s.subtitle}>{subtitle}</Text>}

            {/* Passphrase input */}
            <View style={s.inputRow}>
              <TextInput
                ref={inputRef}
                style={s.input}
                placeholder="Enter passphrase"
                placeholderTextColor={COLORS.textMuted}
                secureTextEntry={!showPass}
                value={pass}
                onChangeText={setPass}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType={withConfirm ? 'next' : 'done'}
                onSubmitEditing={withConfirm ? undefined : submit}
                blurOnSubmit={false}
              />
              <TouchableOpacity
                onPress={() => setShowPass(v => !v)}
                style={s.eyeBtn}
                hitSlop={{ top:8, bottom:8, left:8, right:8 }}
              >
                <Text style={s.eyeTxt}>{showPass ? '🙈' : '👁'}</Text>
              </TouchableOpacity>
            </View>

            {/* Confirm input (for new passphrase) */}
            {withConfirm && (
              <View style={[s.inputRow, mismatch && { borderColor: COLORS.rose }]}>
                <TextInput
                  style={s.input}
                  placeholder="Confirm passphrase"
                  placeholderTextColor={COLORS.textMuted}
                  secureTextEntry={!showPass}
                  value={confirm}
                  onChangeText={setConfirm}
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="done"
                  onSubmitEditing={submit}
                  blurOnSubmit={false}
                />
              </View>
            )}
            {mismatch && <Text style={s.errTxt}>Passphrases don't match</Text>}

            {/* Submit button */}
            <TouchableOpacity
              style={[s.btn, (!pass.trim() || (withConfirm && pass !== confirm)) && s.btnDisabled]}
              onPress={submit}
              activeOpacity={0.8}
              disabled={!pass.trim() || (withConfirm && pass !== confirm)}
            >
              <Text style={s.btnTxt}>{confirmLabel}</Text>
            </TouchableOpacity>

            {/* Cancel */}
            <TouchableOpacity style={s.cancelBtn} onPress={dismiss} activeOpacity={0.7}>
              <Text style={s.cancelTxt}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  kav: {
    position: 'absolute',
    bottom: 0, left: 0, right: 0,
  },
  sheet: {
    backgroundColor: COLORS.surface1,
    borderTopLeftRadius: RADIUS.xl,
    borderTopRightRadius: RADIUS.xl,
    paddingBottom: Platform.OS === 'ios' ? 40 : 24,
    elevation: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.15,
    shadowRadius: 16,
  },
  handle: {
    width: 40, height: 4,
    backgroundColor: COLORS.border,
    borderRadius: 2,
    alignSelf: 'center',
    marginTop: 12, marginBottom: 4,
  },
  body: {
    padding: SPACING.lg,
    paddingTop: SPACING.sm,
  },
  title: {
    fontFamily: FONTS.heading,
    color: COLORS.textPrimary,
    fontSize: 18,
    marginBottom: 4,
  },
  subtitle: {
    fontFamily: FONTS.body,
    color: COLORS.textSecondary,
    fontSize: 13,
    marginBottom: SPACING.md,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surface2,
    borderRadius: RADIUS.md,
    borderWidth: 1.5,
    borderColor: COLORS.border,
    paddingHorizontal: SPACING.md,
    marginBottom: SPACING.sm,
  },
  input: {
    flex: 1,
    fontFamily: FONTS.mono,
    color: COLORS.textPrimary,
    fontSize: 16,
    paddingVertical: 14,
    letterSpacing: 1,
  },
  eyeBtn: { padding: 4 },
  eyeTxt: { fontSize: 18 },
  errTxt: {
    fontFamily: FONTS.body,
    color: COLORS.rose,
    fontSize: 12,
    marginBottom: SPACING.sm,
  },
  btn: {
    backgroundColor: COLORS.indigo,
    borderRadius: RADIUS.md,
    paddingVertical: 15,
    alignItems: 'center',
    marginTop: SPACING.sm,
  },
  btnDisabled: {
    opacity: 0.4,
  },
  btnTxt: {
    fontFamily: FONTS.heading,
    color: '#fff',
    fontSize: 15,
  },
  cancelBtn: {
    alignItems: 'center',
    paddingVertical: 12,
    marginTop: 4,
  },
  cancelTxt: {
    fontFamily: FONTS.body,
    color: COLORS.textMuted,
    fontSize: 14,
  },
});
