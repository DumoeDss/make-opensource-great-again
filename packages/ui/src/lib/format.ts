/**
 * Presentation-only formatters for the session picker. Both are pure and take an
 * injectable "now" so tests are deterministic (no wall-clock flakiness).
 *
 * Relative time uses the platform `Intl.RelativeTimeFormat` — no third-party date
 * library (zero new dependency, design decision). `numeric: 'auto'` yields the
 * locale's idiomatic phrasing (中文环境 → 「10 小时前 / 前天」).
 */

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/**
 * A signed timestamp (epoch ms) rendered relative to `nowMs`. Thresholds:
 * <60s → seconds, <60m → minutes, <24h → hours, <7d → days; ≥7d falls back to an
 * absolute `toLocaleDateString()` (a relative "3 weeks ago" reads worse than a date).
 */
export function formatRelativeTime(ms: number, nowMs: number = Date.now()): string {
  const diff = ms - nowMs; // negative for the past, which is the common case
  const abs = Math.abs(diff);
  if (abs < MINUTE) return rtf.format(Math.round(diff / 1000), 'second');
  if (abs < HOUR) return rtf.format(Math.round(diff / MINUTE), 'minute');
  if (abs < DAY) return rtf.format(Math.round(diff / HOUR), 'hour');
  if (abs < WEEK) return rtf.format(Math.round(diff / DAY), 'day');
  return new Date(ms).toLocaleDateString();
}

const BYTE_UNITS = ['KB', 'MB', 'GB', 'TB'] as const;

/** Humanized byte count: `<1024` stays bytes, otherwise 1 decimal in KB/MB/GB/TB. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}
