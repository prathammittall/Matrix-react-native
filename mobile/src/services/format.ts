/** Unit-aware formatting. Pure functions, unit tested. */
import type { Units } from './storage';

export function formatDistance(metres: number, units: Units = 'metric'): string {
  if (!Number.isFinite(metres)) return '—';
  if (units === 'imperial') {
    const feet = metres * 3.28084;
    if (feet < 1000) return `${Math.round(feet)} ft`;
    return `${(metres / 1609.344).toFixed(metres < 16093 ? 2 : 1)} mi`;
  }
  if (Math.abs(metres) < 1000) return `${Math.round(metres)} m`;
  return `${(metres / 1000).toFixed(metres < 10000 ? 2 : 1)} km`;
}

export function formatSpeed(mps: number | null, units: Units = 'metric'): string {
  if (mps === null || !Number.isFinite(mps)) return '—';
  return units === 'imperial'
    ? `${(mps * 2.236936).toFixed(0)} mph`
    : `${(mps * 3.6).toFixed(0)} km/h`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function formatDate(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function formatSigned(value: number | null, digits = 2, unit = ''): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}${unit ? ` ${unit}` : ''}`;
}

export function formatPercent(fraction: number): string {
  if (!Number.isFinite(fraction)) return '—';
  return `${Math.round(fraction * 100)}%`;
}

export function degToCardinal(deg: number | null): string {
  if (deg === null || !Number.isFinite(deg)) return '—';
  const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return names[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}
