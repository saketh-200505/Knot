import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
} from 'react-native';
import { Sheet } from './Sheet';
import { COLORS, FONTS, RADIUS, SPACING } from '../utils/theme';

export function PassSheet({
  visible,
  onClose,
  onConfirm,
  title = 'Enter Passphrase',
  subtitle,
  confirmLabel = 'Unlock',
  withConfirm = false,
  loading = false,
}) {
  const [pass, setPass] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPass, setShowPass] = useState(false);

  const handleClose = () => {
    setPass(''); setConfirm('');
    onClose?.();
  };

  const handleConfirm = () => {
    if (!pass.trim()) return;
    if (withConfirm && pass !== confirm) return;
    onConfirm(pass.trim());
    setPass(''); setConfirm('');
  };

  const mismatch = withConfirm && confirm.length > 0 && pass !== confirm;

  return (
    <Sheet visible={visible} onClose={handleClose}>
      <View style={s.inner}>
        <Text style={s.title}>{title}</Text>
        {subtitle ? <Text style={s.subtitle}>{subtitle}</Text> : null}

        <View style={s.inputRow}>
          <TextInput
            style={s.input}
            placeholder="••••••••"
            placeholderTextColor={COLORS.textMuted}
            secureTextEntry={!showPass}
            value={pass}
            onChangeText={setPass}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType={withConfirm ? 'next' : 'done'}
            onSubmitEditing={withConfirm ? undefined : handleConfirm}
          />
          <TouchableOpacity onPress={() => setShowPass(v => !v)} style={s.eyeBtn}>
            <Text style={s.eyeTxt}>{showPass ? '🙈' : '👁'}</Text>
          </TouchableOpacity>
        </View>

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
              onSubmitEditing={handleConfirm}
            />
          </View>
        )}
        {mismatch && <Text style={s.errTxt}>Passphrases don't match</Text>}

        <TouchableOpacity
          style={[s.btn, loading && { opacity: 0.5 }]}
          onPress={handleConfirm}
          disabled={loading || !pass.trim() || (withConfirm && pass !== confirm)}
        >
          <Text style={s.btnTxt}>{loading ? 'Working…' : confirmLabel}</Text>
        </TouchableOpacity>
      </View>
    </Sheet>
  );
}

const s = StyleSheet.create({
  inner: { paddingHorizontal: SPACING.lg, paddingTop: SPACING.sm },
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
    backgroundColor: COLORS.surface3,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    marginBottom: SPACING.sm,
    paddingHorizontal: SPACING.md,
  },
  input: {
    flex: 1,
    fontFamily: FONTS.mono,
    color: COLORS.textPrimary,
    fontSize: 15,
    paddingVertical: 14,
    letterSpacing: 1,
  },
  eyeBtn: { padding: 4 },
  eyeTxt: { fontSize: 16 },
  errTxt: {
    fontFamily: FONTS.body,
    color: COLORS.rose,
    fontSize: 12,
    marginBottom: SPACING.sm,
    marginLeft: 4,
  },
  btn: {
    backgroundColor: COLORS.green,
    borderRadius: RADIUS.md,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: SPACING.sm,
  },
  btnTxt: {
    fontFamily: FONTS.heading,
    color: '#fff',
    fontSize: 15,
  },
});
