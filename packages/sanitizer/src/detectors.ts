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

// Pragmatic IPv6 matcher: the full 8-group form, or a `::`-compressed form with
// at least one hex group attached. Requiring 7 colons or an explicit `::` keeps
// colon-separated hex look-alikes out of the bucket — above all HH:MM:SS
// timestamps (`05:15:08` is three valid hex groups), and also MAC addresses and
// `chapter:verse` numbers. Non-blocking, so residual imprecision is acceptable.
const IPV6_RE =
  /\b(?:[A-Fa-f0-9]{1,4}:){7}[A-Fa-f0-9]{1,4}\b|\b(?:[A-Fa-f0-9]{1,4}:){1,7}:(?:[A-Fa-f0-9]{1,4}(?::[A-Fa-f0-9]{1,4}){0,5})?(?![A-Fa-f0-9:])|::(?:[A-Fa-f0-9]{1,4}(?::[A-Fa-f0-9]{1,4}){0,6})\b/g;

// Encoded project-key recognition (mosga-v02) — field-scoped to
// `session.projectKey` ONLY, never run over arbitrary message text.
// `encodeProjectPath` maps every non-alphanumeric to `-`, so a home path like
// `/Users/alice/acme` becomes the dash-encoded slug `-Users-alice-acme` that the
// slash-anchored PATH_RE/USERNAME_RE above cannot match. Recognize a
// `Users`/`home` segment sitting in dash-encoded position. Linear (no nested
// quantifiers), so it respects the ReDoS posture.
const ENCODED_HOME_SLUG_RE = /(?:^|-)(?:Users|home)-[^-\s]/;

/**
 * If `projectKey` has the shape of an encoded home path, return the decoded path
 * used as the pseudonym key; else null. Decoding replaces `-` with `/` so a slug
 * encoded from a POSIX path collapses to the SAME `<PATH_n>` the raw path is
 * mapped to when it also appears in `session.cwd` (session-consistency). The
 * decode is intentionally lossy — its only job is to be a stable, cwd-matching
 * mapper key, not to reconstruct the exact original path.
 */
export function decodeEncodedProjectKey(projectKey: string): string | null {
  if (!ENCODED_HOME_SLUG_RE.test(projectKey)) return null;
  return projectKey.replace(/-/g, '/');
}

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
