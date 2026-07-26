// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '../lib/i18n';
import { getLanguage, initLanguage, setLanguage } from '../lib/lang';

const STORAGE_KEY = 'mosga-lang';

// `lang.ts` keeps the active language in a module-level `current` (no pub/sub —
// react-i18next re-renders on `languageChanged`), so reset it to the default and
// clear storage before every case to keep these unit tests independent.
beforeEach(() => {
  setLanguage('zh');
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('lib/lang — persistence + i18n notify', () => {
  it('setLanguage stores the choice under mosga-lang and updates getLanguage', () => {
    setLanguage('ja');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('ja');
    expect(getLanguage()).toBe('ja');
  });

  it('setLanguage notifies react-i18next via changeLanguage so bound surfaces re-render', () => {
    const spy = vi.spyOn(i18n, 'changeLanguage');
    setLanguage('ko');
    expect(spy).toHaveBeenCalledWith('ko');
  });

  it('initLanguage applies a valid stored language on startup', () => {
    window.localStorage.setItem(STORAGE_KEY, 'en');
    initLanguage();
    expect(getLanguage()).toBe('en');
  });

  it('initLanguage falls back to zh when storage holds an unsupported value', () => {
    window.localStorage.setItem(STORAGE_KEY, 'fr');
    initLanguage();
    expect(getLanguage()).toBe('zh');
  });

  it('initLanguage defaults to zh when nothing is stored', () => {
    initLanguage();
    expect(getLanguage()).toBe('zh');
  });
});
