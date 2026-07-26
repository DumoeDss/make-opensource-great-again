// Global vitest setup. Imports the self-initializing i18n module so every test
// (jsdom or node) gets a ready default i18n instance — `useTranslation()` then
// resolves synchronously without an `I18nextProvider` wrapper.
import './lib/i18n';
