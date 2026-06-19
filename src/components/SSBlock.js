import React, { useEffect, useRef } from 'react';
import { View, StyleSheet, Platform, Animated } from 'react-native';
import { COLORS } from '../utils/theme';

// Web/iOS screenshot interception
export function SSBlock({ active }) {
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const block = () => {
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 0, useNativeDriver: true }),
        Animated.delay(800),
        Animated.timing(opacity, { toValue: 0, duration: 300, useNativeDriver: true }),
      ]).start();
    };
    const handler = (e) => {
      if (e.key === 'PrintScreen' || (e.metaKey && e.shiftKey && e.key === 's')) {
        e.preventDefault();
        block();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  if (!active) return null;

  return (
    <Animated.View style={[StyleSheet.absoluteFill, s.overlay, { opacity }]}
      pointerEvents="none"
    />
  );
}

const s = StyleSheet.create({
  overlay: {
    backgroundColor: COLORS.bg,
    zIndex: 99999,
  },
});
