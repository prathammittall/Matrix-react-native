/**
 * MATRIX design tokens.
 *
 * One spacing scale, one type scale, one palette per scheme. Screens and
 * components read from here and never hard-code a colour or a pixel gap.
 *
 * ## Monochrome by default
 *
 * The ground is black, the type is white, and the chrome is built from grey
 * steps of that same neutral — no tinted surfaces, no brand blue on furniture.
 * Colour is a signal, not decoration: the only saturated pixels in the app mark
 * navigation state (GNSS good / weak / lost / AI) and the two map trajectories.
 * That is what makes the GNSS→AI handover impossible to miss. If buttons, cards
 * and icons were also blue, the one thing the driver must notice would be
 * competing with the furniture for attention.
 *
 * Status colour is always paired with a label and a shape, so the interface
 * never depends on colour alone.
 *
 * Contrast: text on `background` and on `surface` clears WCAG AA (4.5:1) in
 * both schemes; `textTertiary` is reserved for non-essential labels at 3:1+.
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
  ok: '#30D158',
  /** GNSS WEAK */
  warn: '#FFD60A',
  /** GNSS OUTAGE / position held */
  danger: '#FF453A',
  /** AI DEAD RECKONING ACTIVE */
  ai: '#0A84FF',
  /** service offline / unknown */
  idle: '#8E8E93',
} as const;

export const Palette = {
  dark: {
    background: '#000000',
    surface: '#111111',
    surfaceRaised: '#1C1C1E',
    surfaceSunken: '#0A0A0A',
    border: '#242426',
    borderStrong: '#3A3A3C',
    text: '#FFFFFF',
    textSecondary: '#A1A1A6',
    textTertiary: '#6E6E73',
    /** the neutral "interactive" colour: white on black, not a brand hue */
    accent: '#FFFFFF',
    accentSoft: 'rgba(255,255,255,0.10)',
    overlay: 'rgba(0,0,0,0.82)',
    /** map trajectory colours — the only place two hues must be told apart at
     *  a glance, so they stay saturated even in the monochrome scheme */
    trackGnss: '#FFFFFF',
    trackDr: '#0A84FF',
    trackTruth: '#30D158',
    ...status,
  },
  light: {
    background: '#FFFFFF',
    surface: '#FFFFFF',
    surfaceRaised: '#FFFFFF',
    surfaceSunken: '#F2F2F7',
    border: '#E5E5EA',
    borderStrong: '#C7C7CC',
    text: '#000000',
    textSecondary: '#5B5B60',
    textTertiary: '#8E8E93',
    accent: '#000000',
    accentSoft: 'rgba(0,0,0,0.06)',
    overlay: 'rgba(255,255,255,0.88)',
    trackGnss: '#000000',
    trackDr: '#0A6DD4',
    trackTruth: '#1D9E4B',
    ...status,
    // the two status colours that fail on white at their dark-scheme values
    ok: '#1D9E4B',
    warn: '#9A6B00',
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
