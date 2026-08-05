import React, { useState, useCallback, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Sheet } from './Sheet';
import { COLORS, FONTS, RADIUS, SPACING } from '../utils/theme';

// Drop-in themed replacement for React Native's Alert.alert(title, message, buttons).
// Same call signature, but renders as our own bottom Sheet instead of the
// native OS dialog, so it matches the rest of the app.
//
// Usage: showAlert('Remove', 'Remove this item?', [
//   { text: 'Cancel', style: 'cancel' },
//   { text: 'Remove', style: 'destructive', onPress: () => ... },
// ]);
//
// Mount <AlertHost /> once near the root of the app (App.js) — every
// showAlert() call anywhere in the tree renders into that single instance.

let _show = null;

export function showAlert(title, message, buttons) {
  const list = buttons && buttons.length ? buttons : [{ text: 'OK' }];
  if (_show) _show(title, message, list);
  else console.warn('[ThemedAlert] showAlert called before <AlertHost/> mounted');
}

export function AlertHost() {
  const [state, setState] = useState(null); // { title, message, buttons }

  useEffect(() => {
    _show = (title, message, buttons) => setState({ title, message, buttons });
    return () => { _show = null; };
  }, []);

  const close = useCallback(() => setState(null), []);

  // Close the sheet first, then fire the button's handler — matches how
  // the native Alert dismisses before running its callback, and avoids the
  // handler triggering another sheet mid-close-animation.
  const press = useCallback((btn) => {
    close();
    setTimeout(() => btn.onPress?.(), 200);
  }, [close]);

  return (
    <Sheet visible={!!state} onClose={close}>
      {state && (
        <View style={s.wrap}>
          {!!state.title && <Text style={s.title}>{state.title}</Text>}
          {!!state.message && <Text style={s.message}>{state.message}</Text>}
          <View style={s.btns}>
            {state.buttons.map((b, i) => (
              <TouchableOpacity
                key={i}
                style={[
                  s.btn,
                  b.style === 'cancel' && s.btnCancel,
                  b.style === 'destructive' && s.btnDestructive,
                  (!b.style || b.style === 'default') && s.btnDefault,
                ]}
                onPress={() => press(b)}
                activeOpacity={0.8}
              >
                <Text style={[
                  s.btnTxt,
                  b.style === 'cancel' && s.btnTxtCancel,
                  b.style === 'destructive' && s.btnTxtDestructive,
                ]}>
                  {b.text}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      )}
    </Sheet>
  );
}

const s = StyleSheet.create({
  wrap:    { paddingHorizontal: SPACING.lg, paddingTop: SPACING.sm },
  title:   { fontFamily: FONTS.heading, color: COLORS.textPrimary, fontSize: 18, marginBottom: 6 },
  message: { fontFamily: FONTS.body, color: COLORS.textSecondary, fontSize: 14, lineHeight: 20, marginBottom: SPACING.md },
  btns:    { gap: 8 },
  btn:     { borderRadius: RADIUS.md, paddingVertical: 14, alignItems: 'center', borderWidth: 1, borderColor: COLORS.border },
  btnDefault:      { backgroundColor: COLORS.indigo, borderColor: COLORS.indigo },
  btnCancel:       { backgroundColor: COLORS.surface3 },
  btnDestructive:  { backgroundColor: COLORS.surface3, borderColor: '#e5484d' },
  btnTxt:          { fontFamily: FONTS.bodyMed, color: '#fff', fontSize: 15 },
  btnTxtCancel:      { color: COLORS.textSecondary },
  btnTxtDestructive: { color: '#e5484d' },
});
