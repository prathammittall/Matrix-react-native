/**
 * A small hand-rolled icon set.
 *
 * Drawn with react-native-svg rather than pulled from an icon font: the app
 * needs about a dozen glyphs, they must match the stroke weight of the type
 * scale, and they must render identically on Android, iOS and web.
 */
import Svg, { Circle, Path, Polyline, Rect } from 'react-native-svg';

import { useColors, type ThemeColors } from '@/theme';

export interface IconProps {
  size?: number;
  color?: keyof ThemeColors;
  /** explicit colour wins over the token */
  tint?: string;
}

function useTint({ color = 'text', tint }: IconProps) {
  const c = useColors();
  return tint ?? c[color];
}

const stroke = { strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

export function IconNavigate(p: IconProps) {
  const s = p.size ?? 22;
  const t = useTint(p);
  return (
    <Svg width={s} height={s} viewBox="0 0 24 24" fill="none">
      <Path d="M3 11l18-8-8 18-2-8-8-2z" stroke={t} {...stroke} />
    </Svg>
  );
}

export function IconHome(p: IconProps) {
  const s = p.size ?? 22;
  const t = useTint(p);
  return (
    <Svg width={s} height={s} viewBox="0 0 24 24" fill="none">
      <Path d="M3 10.5L12 3l9 7.5V20a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1z" stroke={t} {...stroke} />
    </Svg>
  );
}

export function IconHistory(p: IconProps) {
  const s = p.size ?? 22;
  const t = useTint(p);
  return (
    <Svg width={s} height={s} viewBox="0 0 24 24" fill="none">
      <Path d="M3.5 12a8.5 8.5 0 103-6.5M3.5 4v4h4" stroke={t} {...stroke} />
      <Polyline points="12,7.5 12,12 15,14" stroke={t} {...stroke} />
    </Svg>
  );
}

export function IconSettings(p: IconProps) {
  const s = p.size ?? 22;
  const t = useTint(p);
  return (
    <Svg width={s} height={s} viewBox="0 0 24 24" fill="none">
      <Circle cx="12" cy="12" r="3" stroke={t} {...stroke} />
      <Path
        d="M19.4 15a1.6 1.6 0 00.32 1.77l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.6 1.6 0 00-2.73 1.14V21a2 2 0 11-4 0v-.1A1.6 1.6 0 007 19.4a1.6 1.6 0 00-1.77.32l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.6 1.6 0 002.6 14H2.5a2 2 0 110-4h.1A1.6 1.6 0 004.6 7a1.6 1.6 0 00-.32-1.77l-.06-.06a2 2 0 112.83-2.83l.06.06A1.6 1.6 0 0010 2.6V2.5a2 2 0 114 0v.1a1.6 1.6 0 002.73 1.14l.06-.06a2 2 0 112.83 2.83l-.06.06A1.6 1.6 0 0021.4 10h.1a2 2 0 110 4h-.1a1.6 1.6 0 00-1.4 1z"
        stroke={t}
        strokeWidth={1.4}
      />
    </Svg>
  );
}

export function IconSatellite(p: IconProps) {
  const s = p.size ?? 22;
  const t = useTint(p);
  return (
    <Svg width={s} height={s} viewBox="0 0 24 24" fill="none">
      <Circle cx="12" cy="12" r="2.5" stroke={t} {...stroke} />
      <Path d="M12 4.5a7.5 7.5 0 017.5 7.5M12 8a4 4 0 014 4" stroke={t} {...stroke} />
      <Path d="M4.5 12A7.5 7.5 0 0112 4.5" stroke={t} {...stroke} opacity={0.4} />
      <Path d="M5 19l3-3M19 5l-3 3" stroke={t} {...stroke} opacity={0.55} />
    </Svg>
  );
}

export function IconChip(p: IconProps) {
  const s = p.size ?? 22;
  const t = useTint(p);
  return (
    <Svg width={s} height={s} viewBox="0 0 24 24" fill="none">
      <Rect x="7" y="7" width="10" height="10" rx="2" stroke={t} {...stroke} />
      <Path
        d="M10 4v3M14 4v3M10 17v3M14 17v3M4 10h3M4 14h3M17 10h3M17 14h3"
        stroke={t}
        {...stroke}
      />
    </Svg>
  );
}

export function IconWave(p: IconProps) {
  const s = p.size ?? 22;
  const t = useTint(p);
  return (
    <Svg width={s} height={s} viewBox="0 0 24 24" fill="none">
      <Path d="M2 12c2.5-6 4.5 6 7 0s4.5 6 7 0 4.5 6 6 0" stroke={t} {...stroke} />
    </Svg>
  );
}

export function IconPlay(p: IconProps) {
  const s = p.size ?? 22;
  const t = useTint(p);
  return (
    <Svg width={s} height={s} viewBox="0 0 24 24" fill="none">
      <Path d="M7 4.5l12 7.5-12 7.5z" stroke={t} fill={t} {...stroke} />
    </Svg>
  );
}

export function IconPause(p: IconProps) {
  const s = p.size ?? 22;
  const t = useTint(p);
  return (
    <Svg width={s} height={s} viewBox="0 0 24 24" fill="none">
      <Rect x="6.5" y="5" width="3.6" height="14" rx="1.2" fill={t} />
      <Rect x="13.9" y="5" width="3.6" height="14" rx="1.2" fill={t} />
    </Svg>
  );
}

export function IconReset(p: IconProps) {
  const s = p.size ?? 22;
  const t = useTint(p);
  return (
    <Svg width={s} height={s} viewBox="0 0 24 24" fill="none">
      <Path d="M20.5 12a8.5 8.5 0 11-3-6.5M20.5 4v4h-4" stroke={t} {...stroke} />
    </Svg>
  );
}

export function IconStethoscope(p: IconProps) {
  const s = p.size ?? 22;
  const t = useTint(p);
  return (
    <Svg width={s} height={s} viewBox="0 0 24 24" fill="none">
      <Path d="M6 3v5a4 4 0 008 0V3" stroke={t} {...stroke} />
      <Path d="M10 12v3a5 5 0 0010 0v-1" stroke={t} {...stroke} />
      <Circle cx="20" cy="11" r="2" stroke={t} {...stroke} />
    </Svg>
  );
}

export function IconCrosshair(p: IconProps) {
  const s = p.size ?? 22;
  const t = useTint(p);
  return (
    <Svg width={s} height={s} viewBox="0 0 24 24" fill="none">
      <Circle cx="12" cy="12" r="7" stroke={t} {...stroke} />
      <Path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke={t} {...stroke} />
      <Circle cx="12" cy="12" r="1.6" fill={t} />
    </Svg>
  );
}

export function IconLayers(p: IconProps) {
  const s = p.size ?? 22;
  const t = useTint(p);
  return (
    <Svg width={s} height={s} viewBox="0 0 24 24" fill="none">
      <Path d="M12 3l9 5-9 5-9-5z" stroke={t} {...stroke} />
      <Path d="M3 13l9 5 9-5" stroke={t} {...stroke} opacity={0.6} />
    </Svg>
  );
}

export function IconChevronRight(p: IconProps) {
  const s = p.size ?? 18;
  const t = useTint(p);
  return (
    <Svg width={s} height={s} viewBox="0 0 24 24" fill="none">
      <Path d="M9 5l7 7-7 7" stroke={t} {...stroke} />
    </Svg>
  );
}

export function IconWarning(p: IconProps) {
  const s = p.size ?? 22;
  const t = useTint(p);
  return (
    <Svg width={s} height={s} viewBox="0 0 24 24" fill="none">
      <Path d="M12 3.5l9.5 16.5H2.5z" stroke={t} {...stroke} />
      <Path d="M12 9.5v5M12 17.2v.2" stroke={t} {...stroke} />
    </Svg>
  );
}
