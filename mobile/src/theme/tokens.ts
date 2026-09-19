/**
 * MATRIX design tokens.
 *
 * One spacing scale, one type scale, one palette per scheme. Screens and
 * components read from here and never hard-code a colour or a pixel gap.
 *
 * The palette is deliberately restrained: a deep neutral ground, a single
 * signal blue for the product, and four semantic status colours that carry the
 * navigation state. Status colour is always paired with a label and a shape, so
 * the interface never depends on colour alone.
 */

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

export const Radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  pill: 999,
} as const;

export const Type = {
  display: { fontSize: 34, lineHeight: 40, fontWeight: '700' },
  title: { fontSize: 24, lineHeight: 30, fontWeight: '700' },
  heading: { fontSize: 18, lineHeight: 24, fontWeight: '600' },
  body: { fontSize: 15, lineHeight: 22, fontWeight: '400' },
  bodyStrong: { fontSize: 15, lineHeight: 22, fontWeight: '600' },
  label: { fontSize: 13, lineHeight: 18, fontWeight: '600' },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '500' },
  micro: { fontSize: 11, lineHeight: 14, fontWeight: '600' },
  metric: { fontSize: 28, lineHeight: 32, fontWeight: '700' },
  metricSm: { fontSize: 20, lineHeight: 24, fontWeight: '700' },
} as const;

/** Status colours are shared across schemes so a state reads the same everywhere. */
const status = {
  /** GNSS ACTIVE */
  ok: '#22C55E',
  /** GNSS WEAK */
  warn: '#F59E0B',
  /** GNSS OUTAGE */
  danger: '#EF4444',
  /** AI DEAD RECKONING ACTIVE */
  ai: '#3B82F6',
  /** service offline / unknown */
  idle: '#8B93A1',
} as const;

export const Palette = {
  dark: {
    background: '#0B0E14',
    surface: '#141922',
    surfaceRaised: '#1C222D',
    surfaceSunken: '#0F131A',
    border: '#252C38',
    borderStrong: '#333C4B',
    text: '#F2F5F9',
    textSecondary: '#9AA4B4',
    textTertiary: '#6B7585',
    accent: '#4C8DFF',
    accentSoft: 'rgba(76,141,255,0.16)',
    overlay: 'rgba(11,14,20,0.88)',
    /** map trajectory colours */
    trackGnss: '#4C8DFF',
    trackDr: '#F59E0B',
    trackTruth: '#22C55E',
    ...status,
  },
  light: {
    background: '#F6F8FB',
    surface: '#FFFFFF',
    surfaceRaised: '#FFFFFF',
    surfaceSunken: '#EEF1F6',
    border: '#DFE4EC',
    borderStrong: '#C6CEDA',
    text: '#0C1220',
    textSecondary: '#525E72',
    textTertiary: '#7C8798',
    accent: '#1F6FEB',
    accentSoft: 'rgba(31,111,235,0.12)',
    overlay: 'rgba(246,248,251,0.92)',
    trackGnss: '#1F6FEB',
    trackDr: '#C2740A',
    trackTruth: '#15803D',
    ...status,
  },
} as const;

export type ColorScheme = keyof typeof Palette;
/** Widened so both schemes satisfy one type (the literals differ per scheme). */
export type ThemeColors = Record<keyof (typeof Palette)['dark'], string>;

export const Elevation = {
  card: {
    shadowColor: '#000',
    shadowOpacity: 0.14,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 4,
  },
  sheet: {
    shadowColor: '#000',
    shadowOpacity: 0.22,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: -6 },
    elevation: 12,
  },
} as const;

/** Minimum touch target, per WCAG 2.1 AA target-size guidance. */
export const HIT_SLOP = { top: 8, bottom: 8, left: 8, right: 8 } as const;
export const MIN_TOUCH = 44;
