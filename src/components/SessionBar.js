import React, { useEffect, useRef } from 'react';
import { View, Text, Animated, StyleSheet } from 'react-native';
import { COLORS, FONTS, SPACING } from '../utils/theme';

export function SessionBar({ remaining, total, blurring }) {
  const anim = useRef(new Animated.Value(1)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const ratio = total > 0 ? remaining / total : 0;
    Animated.timing(anim, {
      toValue: ratio, duration: 800, useNativeDriver: false,
    }).start();
  }, [remaining, total]);

  useEffect(() => {
    if (blurring) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 0.4, duration: 600, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
        ])
      ).start();
    } else {
      pulseAnim.stopAnimation();
      pulseAnim.setValue(1);
    }
  }, [blurring]);

  const fmtTime = (s) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${String(sec).padStart(2, '0')}`;
  };

  const barColor = anim.interpolate({
    inputRange:  [0, 0.2, 0.5, 1],
    outputRange: [COLORS.rose, COLORS.amber, COLORS.amber, COLORS.green],
  });

  return (
    <Animated.View style={[s.container, { opacity: pulseAnim }]}>
      <View style={s.row}>
        <Text style={s.label}>Session</Text>
        <Text style={[s.time, blurring && { color: COLORS.rose }]}>
          {fmtTime(remaining)}
        </Text>
      </View>
      <View style={s.track}>
        <Animated.View style={[s.fill, { flex: anim, backgroundColor: barColor }]} />
        <View style={{ flex: Animated.subtract(1, anim) }} />
      </View>
      {blurring && (
        <Text style={s.warning}>⚠ Session expiring soon</Text>
      )}
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
    flexDirection: 'row',
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
