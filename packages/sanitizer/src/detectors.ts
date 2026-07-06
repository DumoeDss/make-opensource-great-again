import type { NormalizationCategory } from './schemas.js';

/**
 * L3 normalization detectors (design D5 / task 4.4). Each yields `{ start, end,
 * value }` spans within a field string. These are non-blocking, statistics-and-
 * sampling findings — the aim is pseudonymizing identifying paths / usernames /
 * emails / IPs, not blocking export.
 */
export interface RawMatch {
  start: number;
  end: number;
  value: string;
}

function collect(re: RegExp, text: string): RawMatch[] {
  const out: RawMatch[] = [];
  for (const m of text.matchAll(re)) {
    if (m.index === undefined) continue;
    out.push({ start: m.index, end: m.index + m[0].length, value: m[0] });
  }
  return out;
}

// Home-directory-bearing absolute paths (the high-signal, username-revealing
// ones), both Windows and POSIX. Kept deliberately narrow to avoid flooding on
// every relative path.
const PATH_RE =
  /(?:[A-Za-z]:\\Users\\[^\\/\s"'<>|]+(?:[\\/][^\s"'<>|]*)?|\/(?:home|Users)\/[^/\s"'<>|]+(?:\/[^\s"'<>|]*)?)/g;

// The username segment inside a home path (via lookbehind), so it gets its own
// finding + pseudonym; this is what fills meta.contributorAlias.
const USERNAME_RE = /(?<=[A-Za-z]:\\Users\\|\/home\/|\/Users\/)[^\\/\s"'<>|]+/g;

// Bounded quantifiers (RFC-shaped: local-part ≤64, domain ≤255, TLD ≤24) so the
// matcher stays LINEAR. The earlier unbounded `+` form backtracked quadratically
// on long tokenless runs (base64 blobs, minified JS, log dumps) — a ReDoS that
// froze the scanner for ~1 minute on a 200k field. Bounding removes the
// catastrophic backtracking without losing any realistic email.
const EMAIL_RE = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/g;

const IPV4_RE =
  /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;

// Pragmatic IPv6 matcher: full or `::`-compressed forms with at least one colon
// pair. Non-blocking, so occasional imprecision is acceptable.
const IPV6_RE =
  /\b(?:[A-Fa-f0-9]{1,4}:){2,7}[A-Fa-f0-9]{1,4}\b|(?:[A-Fa-f0-9]{1,4}:){1,7}:|::(?:[A-Fa-f0-9]{1,4}:){0,6}[A-Fa-f0-9]{1,4}/g;

export const L3_DETECTORS: Array<{
  category: NormalizationCategory;
  run: (text: string) => RawMatch[];
}> = [
  { category: 'path', run: (t) => collect(PATH_RE, t) },
  { category: 'username', run: (t) => collect(USERNAME_RE, t) },
  { category: 'email', run: (t) => collect(EMAIL_RE, t) },
  { category: 'ipv4', run: (t) => collect(IPV4_RE, t) },
  { category: 'ipv6', run: (t) => collect(IPV6_RE, t) },
];
