/**
 * Small charts, drawn with react-native-svg.
 *
 * Deliberately minimal: one accent line, one muted reference line, an axis pair
 * and nothing else. A chart on this screen exists to show a shape (error
 * growing, velocity tracking), not to be read off to three decimal places —
 * the exact numbers are in the metric tiles beside it.
 */
import { useMemo } from 'react';
import { View } from 'react-native';
import Svg, { Line, Path, Rect, Text as SvgText } from 'react-native-svg';

import { Spacing, useColors } from '@/theme';
import { Row, Txt } from './ui/primitives';

export interface Series {
  label: string;
  color: string;
  points: { x: number; y: number }[];
  dashed?: boolean;
}

function buildPath(points: { x: number; y: number }[], sx: (v: number) => number, sy: (v: number) => number) {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
}

export function LineChart({
  series,
  height = 160,
  width,
  xLabel,
  yLabel,
  yUnit = '',
  zeroBaseline = true,
}: {
  series: Series[];
  height?: number;
  /** omit to fill the parent; SVG scales to this viewBox either way */
  width?: number;
  xLabel?: string;
  yLabel?: string;
  yUnit?: string;
  zeroBaseline?: boolean;
}) {
  const c = useColors();
  const W = width ?? 320;
  const H = height;
  const pad = { left: 38, right: 8, top: 10, bottom: 22 };

  const bounds = useMemo(() => {
    const all = series.flatMap((s) => s.points);
    if (!all.length) return null;
    const xs = all.map((p) => p.x);
    const ys = all.map((p) => p.y);
    const minY = zeroBaseline ? Math.min(0, ...ys) : Math.min(...ys);
    const maxY = Math.max(...ys);
    return {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY,
      maxY: maxY === minY ? minY + 1 : maxY,
    };
  }, [series, zeroBaseline]);

  if (!bounds) {
    return (
      <View style={{ height, alignItems: 'center', justifyContent: 'center' }}>
        <Txt variant="caption" color="textTertiary">
          No data
        </Txt>
      </View>
    );
  }

  const sx = (v: number) =>
    pad.left + ((v - bounds.minX) / (bounds.maxX - bounds.minX || 1)) * (W - pad.left - pad.right);
  const sy = (v: number) =>
    H - pad.bottom - ((v - bounds.minY) / (bounds.maxY - bounds.minY || 1)) * (H - pad.top - pad.bottom);

  const ticks = [bounds.minY, (bounds.minY + bounds.maxY) / 2, bounds.maxY];

  return (
    <View style={{ gap: Spacing.sm }}>
      <Svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`}>
        <Rect x={pad.left} y={pad.top} width={W - pad.left - pad.right} height={H - pad.top - pad.bottom} fill="transparent" />
        {ticks.map((t, i) => (
          <Line
            key={i}
            x1={pad.left}
            x2={W - pad.right}
            y1={sy(t)}
            y2={sy(t)}
            stroke={c.border}
            strokeWidth={0.8}
            strokeDasharray={i === 0 ? undefined : '3,4'}
          />
        ))}
        {ticks.map((t, i) => (
          <SvgText key={`l${i}`} x={pad.left - 6} y={sy(t) + 3.5} fontSize="9" fill={c.textTertiary} textAnchor="end">
            {formatTick(t)}
          </SvgText>
        ))}
        {series.map((s) => (
          <Path
            key={s.label}
            d={buildPath(s.points, sx, sy)}
            stroke={s.color}
            strokeWidth={s.dashed ? 1.6 : 2.2}
            strokeDasharray={s.dashed ? '5,4' : undefined}
            fill="none"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
        {xLabel ? (
          <SvgText x={W - pad.right} y={H - 5} fontSize="9" fill={c.textTertiary} textAnchor="end">
            {xLabel}
          </SvgText>
        ) : null}
        {yLabel ? (
          <SvgText x={pad.left - 30} y={pad.top + 4} fontSize="9" fill={c.textTertiary}>
            {yUnit || yLabel}
          </SvgText>
        ) : null}
      </Svg>
      <Row gap={Spacing.lg} style={{ flexWrap: 'wrap' }}>
        {series.map((s) => (
          <Row key={s.label} gap={6}>
            <View style={{ width: 12, height: 3, borderRadius: 2, backgroundColor: s.color, opacity: s.dashed ? 0.7 : 1 }} />
            <Txt variant="micro" color="textSecondary">
              {s.label}
            </Txt>
          </Row>
        ))}
      </Row>
    </View>
  );
}

export function BarChart({
  bars,
  height = 170,
  width,
  unit = '',
}: {
  bars: { label: string; value: number; color?: string }[];
  height?: number;
  width?: number;
  unit?: string;
}) {
  const c = useColors();
  const W = width ?? 320;
  const H = height;
  const pad = { left: 8, right: 8, top: 18, bottom: 24 };
  const max = Math.max(1, ...bars.map((b) => b.value));
  const slot = (W - pad.left - pad.right) / Math.max(bars.length, 1);
  const barW = Math.min(slot * 0.56, 42);

  return (
    <Svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`}>
      {bars.map((b, i) => {
        const h = ((b.value / max) * (H - pad.top - pad.bottom)) || 0;
        const x = pad.left + slot * i + (slot - barW) / 2;
        const y = H - pad.bottom - h;
        return (
          <Rect key={b.label} x={x} y={y} width={barW} height={Math.max(h, 2)} rx={4} fill={b.color ?? c.accent} />
        );
      })}
      {bars.map((b, i) => {
        const h = ((b.value / max) * (H - pad.top - pad.bottom)) || 0;
        const x = pad.left + slot * i + slot / 2;
        return (
          <SvgText key={`v${b.label}`} x={x} y={H - pad.bottom - h - 5} fontSize="9" fill={c.textSecondary} textAnchor="middle">
            {formatTick(b.value)}
            {unit}
          </SvgText>
        );
      })}
      {bars.map((b, i) => (
        <SvgText
          key={`t${b.label}`}
          x={pad.left + slot * i + slot / 2}
          y={H - 8}
          fontSize="9"
          fill={c.textTertiary}
          textAnchor="middle">
          {b.label}
        </SvgText>
      ))}
      <Line x1={pad.left} x2={W - pad.right} y1={H - pad.bottom} y2={H - pad.bottom} stroke={c.border} strokeWidth={1} />
    </Svg>
  );
}

function formatTick(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)}k`;
  if (Math.abs(v) >= 100) return v.toFixed(0);
  if (Math.abs(v) >= 10) return v.toFixed(0);
  return v.toFixed(1);
}
