/**
 * Manoeuvre arrows.
 *
 * Drawn in the same hand-rolled SVG style as `ui/icons.tsx` — one stroke
 * weight, one 24x24 grid — so a turn arrow sits beside the rest of the
 * interface rather than looking imported from somewhere else.
 *
 * Every arrow reads as "the road you are on, then where you go", with the
 * stem always entering from the bottom, so the glyph is legible at a glance at
 * driving speed without reading the instruction text underneath it.
 */
import Svg, { Circle, Path } from 'react-native-svg';

import { useColors, type ThemeColors } from '@/theme';
import type { ManeuverKind } from '@/types';

const stroke = {
  strokeWidth: 2.2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  fill: 'none',
};

/** Path data per manoeuvre: [road/turn path, arrow head]. */
const PATHS: Record<ManeuverKind, string[]> = {
  depart: ['M12 21V8', 'M6.5 13.5L12 8l5.5 5.5'],
  straight: ['M12 21V5', 'M6.5 10.5L12 5l5.5 5.5'],
  'slight-left': ['M13 21v-7.5L8 8.5', 'M8 14V8h6'],
  left: ['M15 21v-8a3 3 0 00-3-3H6', 'M10 5.5L4.5 10l5.5 4.5'],
  'sharp-left': ['M15 21v-6a4 4 0 00-4-4H6.5', 'M11 6L5.5 11l5.5 5'],
  'slight-right': ['M11 21v-7.5L16 8.5', 'M16 14V8h-6'],
  right: ['M9 21v-8a3 3 0 013-3h6', 'M14 5.5l5.5 4.5-5.5 4.5'],
  'sharp-right': ['M9 21v-6a4 4 0 014-4h4.5', 'M13 6l5.5 5-5.5 5'],
  uturn: ['M8 21v-9a4 4 0 018 0v4', 'M12.5 13.5L16 17l3.5-3.5'],
  roundabout: ['M12 21v-4.2', 'M17.5 6.5L18 11l-4-.6'],
  merge: ['M12 21v-7c0-3 2-4 5.5-5.5', 'M13.5 6.5l4.5 1.2-1.4 4.3'],
  fork: ['M12 21v-8l5-5', 'M17 13V8h-5'],
  arrive: ['M12 21V9', 'M8 9a4 4 0 118 0'],
};

/** The second sub-path of a roundabout is its arrow; the ring is drawn too. */
export function ManeuverIcon({
  kind,
  size = 34,
  color = 'text',
  tint,
}: {
  kind: ManeuverKind;
  size?: number;
  color?: keyof ThemeColors;
  tint?: string;
}) {
  const c = useColors();
  const t = tint ?? c[color];
  const [primary, secondary] = PATHS[kind] ?? PATHS.straight;

  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" accessibilityRole="image">
      {kind === 'roundabout' ? <Circle cx="12" cy="11" r="5" stroke={t} {...stroke} /> : null}
      {kind === 'arrive' ? <Circle cx="12" cy="9" r="2" fill={t} /> : null}
      <Path d={primary} stroke={t} {...stroke} />
      <Path d={secondary} stroke={t} {...stroke} />
    </Svg>
  );
}
