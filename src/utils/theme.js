// Knot — Colorful light theme
export const COLORS = {
  // Backgrounds
  bg:        '#F0F4FF',
  surface1:  '#FFFFFF',
  surface2:  '#F5F7FF',
  surface3:  '#EDF0FF',
  border:    '#DDE3F5',

  // Accent palette — vibrant but harmonious
  indigo:    '#5B5BD6',
  indigoDim: '#E8E8FF',
  purple:    '#8B5CF6',
  purpleDim: '#EDE9FE',
  teal:      '#0D9488',
  tealDim:   '#CCFBF1',
  rose:      '#F43F5E',
  roseDim:   '#FFE4E8',
  amber:     '#F59E0B',
  amberDim:  '#FEF3C7',
  sky:       '#0EA5E9',
  skyDim:    '#E0F2FE',
  emerald:   '#10B981',
  emeraldDim:'#D1FAE5',
  orange:    '#F97316',
  orangeDim: '#FFEDD5',
  pink:      '#EC4899',
  pinkDim:   '#FCE7F3',
  lime:      '#84CC16',
  limeDim:   '#F7FEE7',

  // Text
  textPrimary:   '#1E1B4B',
  textSecondary: '#4B5563',
  textMuted:     '#9CA3AF',

  // Game (keep dark for game screen)
  snakeHead:  '#10b981',
  snakeBody:  '#059669',
  snakeEye:   '#f0f4ff',
  food:       '#f59e0b',
  gridLine:   '#0d1320',

  // Aliases for backward compat
  green:   '#10B981',
  blue:    '#0EA5E9',
  violet:  '#8B5CF6',
};

// Group folder colours — each gets a unique vibrant combo
export const GROUP_PALETTES = [
  { bg: '#EDE9FE', dot: '#8B5CF6', text: '#5B21B6', icon: '#7C3AED' }, // purple
  { bg: '#CCFBF1', dot: '#0D9488', text: '#0F766E', icon: '#14B8A6' }, // teal
  { bg: '#FFE4E8', dot: '#F43F5E', text: '#BE123C', icon: '#E11D48' }, // rose
  { bg: '#E0F2FE', dot: '#0EA5E9', text: '#0369A1', icon: '#0284C7' }, // sky
  { bg: '#FEF3C7', dot: '#F59E0B', text: '#B45309', icon: '#D97706' }, // amber
  { bg: '#FCE7F3', dot: '#EC4899', text: '#9D174D', icon: '#DB2777' }, // pink
  { bg: '#F7FEE7', dot: '#84CC16', text: '#4D7C0F', icon: '#65A30D' }, // lime
  { bg: '#FFEDD5', dot: '#F97316', text: '#C2410C', icon: '#EA580C' }, // orange
];

export const FONTS = {
  heading:  'Syne_700Bold',
  headingX: 'Syne_800ExtraBold',
  body:     'DMSans_400Regular',
  bodyMed:  'DMSans_500Medium',
  mono:     'SpaceMono_400Regular',
};

export const RADIUS = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  full: 9999,
};

export const SPACING = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
};
