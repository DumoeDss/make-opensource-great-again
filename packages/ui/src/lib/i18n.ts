/**
 * Self-initializing i18n module. Imports the four locale JSONs as static Vite
 * assets and runs `i18next.use(initReactI18next).init({...})` at module-evaluation
 * time, so `useTranslation()` resolves synchronously on first render — no
 * Suspense boundary, no HTTP backend, no async gap. Component tests render
 * translated output without an `I18nextProvider` because this module is imported
 * from the vitest `setupFiles` entry.
 *
 * Components that call `useTranslation()` do NOT import this module directly
 * (that couples them to init order and risks double-init); they rely on the
 * default instance being ready, initialized here.
 */
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

import zh from '../locales/zh.json';
import ja from '../locales/ja.json';
import en from '../locales/en.json';
import ko from '../locales/ko.json';

export const LANGUAGES = ['zh', 'ja', 'en', 'ko'] as const;
export type Language = (typeof LANGUAGES)[number];

void i18next.use(initReactI18next).init({
  resources: {
    zh: { translation: zh },
    ja: { translation: ja },
    en: { translation: en },
    ko: { translation: ko },
  },
  lng: 'zh',
  fallbackLng: 'zh',
  interpolation: { escapeValue: false },
  returnEmptyString: false,
  react: { useSuspense: false },
});

export default i18next;
