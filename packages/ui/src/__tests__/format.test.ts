import { describe, expect, it } from 'vitest';

import { formatBytes, formatRelativeTime } from '../lib/format';

// A fixed "now" so every case is deterministic regardless of when the suite runs.
const NOW = Date.UTC(2026, 6, 9, 12, 0, 0);
const ago = (ms: number): number => NOW - ms;

// Assert against the SAME platform formatter the implementation uses — the test
// verifies which unit/rounding a delta selects, not the runtime's locale strings.
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

describe('formatRelativeTime', () => {
  it('renders sub-minute deltas in seconds', () => {
    expect(formatRelativeTime(ago(5_000), NOW)).toBe(rtf.format(-5, 'second'));
  });

  it('crosses into minutes exactly at 60s', () => {
    expect(formatRelativeTime(ago(60_000), NOW)).toBe(rtf.format(-1, 'minute'));
  });

  it('renders minutes below the hour boundary', () => {
    expect(formatRelativeTime(ago(59 * 60_000), NOW)).toBe(rtf.format(-59, 'minute'));
  });

  it('crosses into hours exactly at 60m', () => {
    expect(formatRelativeTime(ago(60 * 60_000), NOW)).toBe(rtf.format(-1, 'hour'));
  });

  it('renders hours below the day boundary', () => {
    expect(formatRelativeTime(ago(23 * 60 * 60_000), NOW)).toBe(rtf.format(-23, 'hour'));
  });

  it('crosses into days exactly at 24h', () => {
    expect(formatRelativeTime(ago(24 * 60 * 60_000), NOW)).toBe(rtf.format(-1, 'day'));
  });

  it('renders days below the week boundary', () => {
    expect(formatRelativeTime(ago(6 * 24 * 60 * 60_000), NOW)).toBe(rtf.format(-6, 'day'));
  });

  it('falls back to an absolute date at or beyond 7 days', () => {
    const seven = ago(7 * 24 * 60 * 60_000);
    expect(formatRelativeTime(seven, NOW)).toBe(new Date(seven).toLocaleDateString());
  });
});

describe('formatBytes', () => {
  it('keeps sub-KB values in bytes', () => {
    expect(formatBytes(512)).toBe('512 B');
  });

  it('rounds KB to one decimal', () => {
    expect(formatBytes(1536)).toBe('1.5 KB');
  });

  it('scales up to MB', () => {
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('scales up to GB', () => {
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.0 GB');
  });
});
