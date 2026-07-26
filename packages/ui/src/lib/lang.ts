/**
 * Language store mirroring `lib/theme.ts`: `STORAGE_KEY`/`hasWindow()`/silent
 * try/catch/whitelist shape, but WITHOUT a `subscribers` Set — react-i18next
 * re-renders bound components automatically when `i18n.changeLanguage()` fires
 * its `languageChanged` event, so a manual pub/sub is redundant. `setLanguage`
 * persists to localStorage AND calls `i18n.changeLanguage`; `initLanguage` is
 * called from `main.tsx` next to `initTheme()`.
 *
 * Idempotent and guarded for non-browser environments (the component tests
 * render components directly and the vitest setup initializes i18n to `zh`).
 */
import i18n from './i18n';
import { LANGUAGES, type Language } from './i18n';

const STORAGE_KEY = 'mosga-lang';

let current: Language = 'zh';

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);
}

export function getLanguage(): Language {
  return current;
}

/** Persist the choice and notify react-i18next (which re-renders bound surfaces). */
export function setLanguage(lang: Language): void {
  current = lang;
  if (hasWindow()) {
    try {
      window.localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      // Persistence is best-effort (private mode / disabled storage).
    }
  }
  void i18n.changeLanguage(lang);
}

/** Read the stored language (default `zh`, validated against the whitelist) and apply it. */
export function initLanguage(): void {
  if (!hasWindow()) return;
  let stored: Language = 'zh';
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (isLanguage(raw)) stored = raw;
  } catch {
    // Ignore storage read failures — fall back to zh.
  }
  setLanguage(stored);
}
