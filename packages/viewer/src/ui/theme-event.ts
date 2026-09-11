/**
 * The theme switch the debug hook and the overlay share.
 *
 * `applyTheme` (ui/tokens.ts) owns the paint: it writes `data-theme`, `color-scheme` and every `--token` on the root
 * element. What it does not do is tell the rest of the app which mode actually landed — `'system'` resolves to either
 * one. This wraps it in the announcement, so anything that draws outside CSS (Phaser tints, a canvas surface) can
 * listen for one event instead of polling `currentTheme()`.
 */
import { applyTheme, type ThemeMode } from './tokens.js';

/** Dispatched on `window` after a theme lands; `detail` is the resolved mode, never `'system'`. */
export const THEME_EVENT = 'cubicle:theme';

/**
 * Apply `mode` and announce the mode that resulted. `target` and `apply` are seams for the unit test: production
 * calls it with neither.
 */
export function setThemeAndAnnounce(
  mode: ThemeMode | 'system',
  target: EventTarget = window,
  apply: (m: ThemeMode | 'system') => ThemeMode = applyTheme,
): ThemeMode {
  const applied = apply(mode);
  target.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: applied }));
  return applied;
}
