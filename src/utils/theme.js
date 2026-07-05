// Knot — iOS Messages-inspired palette, follows system color scheme.
//
// COLORS is resolved once at module load using Appearance.getColorScheme(),
// so every existing `import { COLORS } from '../utils/theme'` re-skins
// itself without touching a single call-site or StyleSheet.create.
// The trade-off: switching system dark/light while the app is running
// requires a reopen for the new palette to take effect. Everything else
// (screens, sheets, chat bubbles) picks up the new values automatically.

import { Appearance } from 'react-native';

// ─── Base palettes ────────────────────────────────────────────────────────────
// Values are taken from Apple's iOS system colors (system gray, iOS blue,
// system separator, etc.) so the app feels native on both platforms.
const LIGHT = {
  bg:        '#F2F2F7', // iOS system background
  surface1:  '#FFFFFF',
  surface2:  '#F2F2F7',
  surface3:  '#E5E5EA', // iOS system gray 5
  border:    '#C6C6C8', // iOS separator (opaque)

  // Accent — iOS system blue
  indigo:    '#007AFF',
  indigoDim: 'rgba(0,122,255,0.12)',
  purple:    '#AF52DE',
  purpleDim: 'rgba(175,82,222,0.12)',
  teal:      '#30B0C7',
  tealDim:   'rgba(48,176,199,0.12)',
  rose:      '#FF375F',
  roseDim:   'rgba(255,55,95,0.12)',
  amber:     '#FF9500',
  amberDim:  'rgba(255,149,0,0.12)',
  sky:       '#5AC8FA',
  skyDim:    'rgba(90,200,250,0.12)',
  emerald:   '#34C759',
  emeraldDim:'rgba(52,199,89,0.12)',
  orange:    '#FF9500',
  orangeDim: 'rgba(255,149,0,0.12)',
  pink:      '#FF2D55',
  pinkDim:   'rgba(255,45,85,0.12)',
  lime:      '#32D74B',
  limeDim:   'rgba(50,215,75,0.12)',

  textPrimary:   '#000000',
  textSecondary: 'rgba(60,60,67,0.85)', // iOS secondaryLabel
  textMuted:     'rgba(60,60,67,0.50)', // iOS tertiaryLabel

  // Game palette — stays richer for readability on the game canvas
  snakeHead:  '#34C759',
  snakeBody:  '#248A3D',
  snakeEye:   '#FFFFFF',
  food:       '#FF9500',
  gridLine:   'rgba(0,0,0,0.06)',

  green:  '#34C759',
  blue:   '#007AFF',
  violet: '#AF52DE',
};

const DARK = {
  bg:        '#000000', // True black — best on OLED, matches iOS Messages dark
  surface1:  '#1C1C1E', // iOS systemGray6 (dark)
  surface2:  '#2C2C2E', // iOS systemGray5 (dark)
  surface3:  '#3A3A3C',
  border:    '#38383A', // iOS separator (dark)

  indigo:    '#0A84FF', // iOS system blue (dark)
  indigoDim: 'rgba(10,132,255,0.20)',
  purple:    '#BF5AF2',
  purpleDim: 'rgba(191,90,242,0.20)',
  teal:      '#40C8E0',
  tealDim:   'rgba(64,200,224,0.20)',
  rose:      '#FF375F',
  roseDim:   'rgba(255,55,95,0.20)',
  amber:     '#FF9F0A',
  amberDim:  'rgba(255,159,10,0.20)',
  sky:       '#64D2FF',
  skyDim:    'rgba(100,210,255,0.20)',
  emerald:   '#30D158',
  emeraldDim:'rgba(48,209,88,0.20)',
  orange:    '#FF9F0A',
  orangeDim: 'rgba(255,159,10,0.20)',
  pink:      '#FF375F',
  pinkDim:   'rgba(255,55,95,0.20)',
  lime:      '#30D158',
  limeDim:   'rgba(48,209,88,0.20)',

  textPrimary:   '#FFFFFF',
  textSecondary: 'rgba(235,235,245,0.85)',
  textMuted:     'rgba(235,235,245,0.55)',

  snakeHead:  '#30D158',
  snakeBody:  '#248A3D',
  snakeEye:   '#F0F4FF',
  food:       '#FF9F0A',
  gridLine:   'rgba(255,255,255,0.06)',

  green:  '#30D158',
  blue:   '#0A84FF',
  violet: '#BF5AF2',
};

// Resolve at import time — the app re-picks on next launch if the user
// changes their system theme.
const scheme = Appearance.getColorScheme();
export const COLORS = scheme === 'dark' ? DARK : LIGHT;
export const COLOR_SCHEME = scheme === 'dark' ? 'dark' : 'light';
// Also expose the raw palettes so components can build a palette-aware
// alternate (e.g. status bar style) without another Appearance call.
export const LIGHT_COLORS = LIGHT;
export const DARK_COLORS = DARK;

// Group folder colours — semantic accents used to differentiate photo groups.
// Kept the same across themes; the dot/text values are vivid enough to work
// on both surface1 backgrounds.
export const GROUP_PALETTES = [
  { bg: 'rgba(175,82,222,0.14)', dot: '#AF52DE', text: '#AF52DE', icon: '#AF52DE' }, // purple
  { bg: 'rgba(48,176,199,0.14)', dot: '#30B0C7', text: '#30B0C7', icon: '#30B0C7' }, // teal
  { bg: 'rgba(255,55,95,0.14)',  dot: '#FF375F', text: '#FF375F', icon: '#FF375F' }, // rose
  { bg: 'rgba(90,200,250,0.14)', dot: '#5AC8FA', text: '#5AC8FA', icon: '#5AC8FA' }, // sky
  { bg: 'rgba(255,149,0,0.14)',  dot: '#FF9500', text: '#FF9500', icon: '#FF9500' }, // amber
  { bg: 'rgba(255,45,85,0.14)',  dot: '#FF2D55', text: '#FF2D55', icon: '#FF2D55' }, // pink
  { bg: 'rgba(50,215,75,0.14)',  dot: '#32D74B', text: '#32D74B', icon: '#32D74B' }, // lime
  { bg: 'rgba(255,149,0,0.14)',  dot: '#FF9500', text: '#FF9500', icon: '#FF9500' }, // orange
];

export const FONTS = {
  heading:  'Syne_700Bold',
  headingX: 'Syne_800ExtraBold',
  body:     'DMSans_400Regular',
  bodyMed:  'DMSans_500Medium',
  mono:     'SpaceMono_400Regular',
};

// iOS-scale corner radii — chat bubbles get 18, cards 14, big sheets 24.
export const RADIUS = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 22,
  xxl: 28,
  full: 9999,
};

// Slightly tighter iOS spacing rhythm.
export const SPACING = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
};
