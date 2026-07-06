/**
 * Go RE2 → JS `RegExp` translation behind a compatibility validator (design D3).
 *
 * Applies known-safe transforms, then constructs the `RegExp` in a try/catch:
 * the constructor IS the ultimate validator. A construction failure or a
 * known-unsupported construct never throws out of here — it returns
 * `{ ok: false, reason }` so the ingest layer can degrade the rule (never a
 * silent drop). RE2's linear-time guarantee is lost under JS backtracking; the
 * scanner's ReDoS guard (a scan-time ceiling) compensates.
 */

export type TranslateResult =
  | {
      ok: true;
      status: 'native' | 'translated';
      regexSource: string;
      flags: string;
      notes: string;
    }
  | { ok: false; reason: string };

/** POSIX bracket classes → explicit character-class bodies (used inside `[…]`). */
const POSIX_CLASSES: Record<string, string> = {
  alpha: 'a-zA-Z',
  digit: '0-9',
  alnum: 'a-zA-Z0-9',
  upper: 'A-Z',
  lower: 'a-z',
  space: '\\s',
  blank: ' \\t',
  word: '\\w',
  xdigit: '0-9a-fA-F',
  punct: '!-/:-@\\[-`{-~',
  cntrl: '\\x00-\\x1f\\x7f',
  graph: '\\x21-\\x7e',
  print: '\\x20-\\x7e',
};

export function translateRe2ToJs(pattern: string): TranslateResult {
  let src = pattern;
  let flags = '';
  const notes: string[] = [];

  // 1. Hoist inline flag directives `(?i)`, `(?s)`, `(?m)` — whether leading or
  //    mid-pattern — to RegExp flags. JS has no mid-pattern flag directives, so
  //    a scoped `(?i)…` is approximated by applying the flag globally: this can
  //    only WIDEN what matches (a case-sensitive prefix becomes case-insensitive
  //    too), which is recall-biased and safe for a secret scanner. Flag GROUPS
  //    `(?i:…)` (with a colon) are NOT matched here and fall through to the
  //    RegExp constructor. `s` maps to JS dotAll `s`; `U` (ungreedy) has no JS
  //    equivalent and is dropped with a note.
  if (/\(\?[imsU]+\)/.test(src)) {
    src = src.replace(/\(\?([imsU]+)\)/g, (_whole, fl: string) => {
      for (const f of fl) {
        if (f === 'i' && !flags.includes('i')) flags += 'i';
        else if (f === 's' && !flags.includes('s')) flags += 's';
        else if (f === 'm' && !flags.includes('m')) flags += 'm';
        else if (f === 'U') notes.push('dropped ungreedy (?U) flag (no JS equivalent)');
      }
      return '';
    });
    notes.push('hoisted inline flag directives to RegExp flags');
  }

  // 2. Named-capture / named-backref syntax. `(?P<n>…)` → `(?<n>…)`.
  //    `(?P=n)` is a back-reference with no JS-RegExp equivalent → cannot translate.
  if (/\(\?P=/.test(src)) {
    return { ok: false, reason: 'named back-reference (?P=name) has no JS RegExp equivalent' };
  }
  if (src.includes('(?P<')) {
    src = src.replace(/\(\?P</g, '(?<');
    notes.push('named capture (?P<n>) → (?<n>)');
  }

  // 3. POSIX bracket classes `[[:alpha:]]` → explicit classes.
  if (/\[:\^?[a-z]+:\]/.test(src)) {
    src = src.replace(/\[:(\^?)([a-z]+):\]/g, (whole, neg: string, name: string) => {
      const body = POSIX_CLASSES[name];
      if (body === undefined) return whole; // leave unknown; try/catch will judge
      return neg ? `^${body}` : body;
    });
    notes.push('expanded POSIX character classes');
  }

  // 4. Anchors `\A` → `^`, `\z`/`\Z` → `$`.
  if (/\\A/.test(src)) {
    src = src.replace(/\\A/g, '^');
    notes.push('anchor \\A → ^');
  }
  if (/\\[zZ]/.test(src)) {
    src = src.replace(/\\[zZ]/g, '$');
    notes.push('anchor \\z/\\Z → $');
  }

  // 5. Atomic groups `(?>…)` → non-capturing `(?:…)` (relaxes atomicity to
  //    greedy — behavior-preserving for matching, not for backtracking bounds).
  if (src.includes('(?>')) {
    src = src.replace(/\(\?>/g, '(?:');
    notes.push('atomic group (?>…) relaxed to (?:…)');
  }

  // 6. Possessive quantifiers `*+` `++` `?+` `}+` → plain greedy.
  if (/[*+?}]\+/.test(src)) {
    src = src
      .replace(/\*\+/g, '*')
      .replace(/\+\+/g, '+')
      .replace(/\?\+/g, '?')
      .replace(/\}\+/g, '}');
    notes.push('possessive quantifiers relaxed to greedy');
  }

  // 7. Unicode property escapes require the `u` flag.
  const needUnicode = /\\p\{/i.test(src) || /\\u\{/.test(src);
  if (needUnicode && !flags.includes('u')) flags += 'u';

  const changed = src !== pattern || flags !== '' ;

  try {
    // eslint-disable-next-line no-new
    new RegExp(src, flags);
  } catch (err) {
    return {
      ok: false,
      reason: `RegExp construction failed: ${(err as Error).message}`,
    };
  }

  return {
    ok: true,
    status: changed ? 'translated' : 'native',
    regexSource: src,
    flags,
    notes: notes.join('; '),
  };
}
