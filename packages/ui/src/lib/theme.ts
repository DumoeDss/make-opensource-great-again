/**
 * Follow-system dark-mode bootstrap. Toggles the `.dark` class on
 * <html> from `prefers-color-scheme` and subscribes to changes, so the class
 * (not a CSS @media block) is the single source of truth — slice 2's settings
 * three-state toggle overrides system preference by driving the same class.
 *
 * Idempotent and guarded for non-browser environments (the 4 component tests
 * render components directly and never import this).
 */
let initialized = false;

export function initTheme(): void {
  if (initialized) return;
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
  initialized = true;

  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const apply = (matches: boolean): void => {
    document.documentElement.classList.toggle('dark', matches);
  };
  apply(mq.matches);
  mq.addEventListener('change', (e) => apply(e.matches));
}
