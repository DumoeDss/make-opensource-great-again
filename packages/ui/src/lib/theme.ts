/**
 * Three-state theme store (light / dark / system). The `.dark` class on <html>
 * is the single source of truth; `system` subscribes to `prefers-color-scheme`
 * so it tracks the OS live, while `light`/`dark` pin the class regardless.
 * The chosen mode persists to localStorage; `initTheme()` (called from
 * `main.tsx`) reads it and applies, defaulting to `system`.
 *
 * Idempotent and guarded for non-browser environments (the component tests
 * render components directly and never import this).
 */
export type ThemeChoice = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'mosga-theme';

let current: ThemeChoice = 'system';
let systemMq: MediaQueryList | null = null;
let systemListener: ((e: MediaQueryListEvent) => void) | null = null;
const subscribers = new Set<(choice: ThemeChoice) => void>();

function hasWindow(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function';
}

function systemPrefersDark(): boolean {
  if (!hasWindow()) return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function applyClass(choice: ThemeChoice): void {
  if (typeof document === 'undefined') return;
  const dark = choice === 'dark' || (choice === 'system' && systemPrefersDark());
  document.documentElement.classList.toggle('dark', dark);
}

/** Wire (or tear down) the `prefers-color-scheme` subscription for `system`. */
function syncSystemSubscription(choice: ThemeChoice): void {
  if (!hasWindow()) return;
  if (choice === 'system') {
    if (!systemMq) {
      systemMq = window.matchMedia('(prefers-color-scheme: dark)');
      systemListener = () => applyClass('system');
      systemMq.addEventListener('change', systemListener);
    }
  } else if (systemMq && systemListener) {
    systemMq.removeEventListener('change', systemListener);
    systemMq = null;
    systemListener = null;
  }
}

/** Apply a theme choice: toggles the class, (un)subscribes to system, persists. */
export function applyTheme(choice: ThemeChoice): void {
  current = choice;
  applyClass(choice);
  syncSystemSubscription(choice);
  if (hasWindow()) {
    try {
      window.localStorage.setItem(STORAGE_KEY, choice);
    } catch {
      // Persistence is best-effort (private mode / disabled storage).
    }
  }
}

export function getTheme(): ThemeChoice {
  return current;
}

export function setTheme(choice: ThemeChoice): void {
  applyTheme(choice);
  for (const fn of subscribers) fn(choice);
}

/** Subscribe to theme changes; returns an unsubscribe fn. */
export function subscribe(fn: (choice: ThemeChoice) => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function initTheme(): void {
  if (!hasWindow()) return;
  let stored: ThemeChoice = 'system';
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') stored = raw;
  } catch {
    // Ignore storage read failures — fall back to system.
  }
  applyTheme(stored);
}
