import React, { useEffect, useRef } from 'react';
import { View, Text, Animated, StyleSheet } from 'react-native';
import { COLORS, FONTS, SPACING } from '../utils/theme';

export function SessionBar({ remaining, total, blurring }) {
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const pulseLoop = useRef(null);

  useEffect(() => {
    if (blurring) {
      pulseLoop.current = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 0.72, duration: 650, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 650, useNativeDriver: true }),
        ])
      );
      pulseLoop.current.start();
    } else {
      pulseLoop.current?.stop();
      pulseAnim.stopAnimation();
      pulseAnim.setValue(1);
    }

    return () => pulseLoop.current?.stop();
  }, [blurring, pulseAnim]);

  const fmtTime = (s) => {
    const safe = Math.max(0, s);
    const m = Math.floor(safe / 60);
    const sec = safe % 60;
    return `${m}:${String(sec).padStart(2, '0')}`;
  };

  const ratio = Math.max(0, Math.min(1, total > 0 ? remaining / total : 0));
  const barColor = ratio <= 0.2 ? COLORS.rose : ratio <= 0.5 ? COLORS.amber : COLORS.green;

  return (
    <Animated.View style={[s.container, { opacity: pulseAnim }]}>
      <View style={s.row}>
        <Text style={s.label}>Session</Text>
        <Text style={[s.time, blurring && { color: COLORS.rose }]}>
          {fmtTime(remaining)}
        </Text>
      </View>
      <View style={s.track}>
        <View style={[s.fill, { width: `${ratio * 100}%`, backgroundColor: barColor }]} />
      </View>
      {blurring && <Text style={s.warning}>Session expiring soon</Text>}
    </Animated.View>
  );
}

const s = StyleSheet.create({
  container: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    backgroundColor: '#0a0d14',
    borderBottomWidth: 1,
    borderColor: '#1e2433',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  label: {
    fontFamily: FONTS.body,
    color: COLORS.textMuted,
    fontSize: 11,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  time: {
    fontFamily: FONTS.mono,
    color: COLORS.textSecondary,
    fontSize: 11,
  },
  track: {
    height: 3,
    backgroundColor: COLORS.surface3,
    borderRadius: 2,
    overflow: 'hidden',
  },
  fill: {
    height: 3,
    borderRadius: 2,
  },
  warning: {
    fontFamily: FONTS.body,
    color: COLORS.amber,
    fontSize: 11,
    marginTop: 4,
  },
});
