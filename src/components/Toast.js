import React, { useEffect, useRef } from 'react';
import { Animated, Text, StyleSheet, View } from 'react-native';
import { COLORS, FONTS, RADIUS, SPACING } from '../utils/theme';

export function Toast({ message, type = 'info', visible, onHide }) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(20)).current;

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(opacity, { toValue: 1, duration: 250, useNativeDriver: true }),
        Animated.timing(translateY, { toValue: 0, duration: 250, useNativeDriver: true }),
      ]).start();
      const t = setTimeout(() => {
        Animated.parallel([
          Animated.timing(opacity, { toValue: 0, duration: 300, useNativeDriver: true }),
          Animated.timing(translateY, { toValue: 20, duration: 300, useNativeDriver: true }),
        ]).start(() => onHide?.());
      }, 2500);
      return () => clearTimeout(t);
    }
  }, [visible]);

  const accent = type === 'success' ? COLORS.green
    : type === 'error' ? COLORS.rose
    : type === 'warn'  ? COLORS.amber
    : COLORS.blue;

  return (
    <Animated.View style={[s.container, { borderColor: accent, opacity, transform: [{ translateY }] }]}>
      <View style={[s.bar, { backgroundColor: accent }]} />
      <Text style={s.text}>{message}</Text>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  container: {
    position: 'absolute',
    bottom: 80,
    alignSelf: 'center',
    backgroundColor: COLORS.surface2,
    borderWidth: 1,
    borderRadius: RADIUS.md,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: SPACING.sm,
    paddingRight: SPACING.md,
    maxWidth: 320,
    zIndex: 9999,
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 12,
    elevation: 20,
  },
  bar: {
    width: 3,
    alignSelf: 'stretch',
    borderRadius: 2,
    marginLeft: SPACING.sm,
    marginRight: SPACING.sm,
  },
  text: {
    fontFamily: FONTS.body,
    color: COLORS.textPrimary,
    fontSize: 13,
    flex: 1,
    flexWrap: 'wrap',
  },
});
