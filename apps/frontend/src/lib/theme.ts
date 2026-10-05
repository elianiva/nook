/**
 * The Mochi appearance theme: which pastel tint the app wears.
 *
 * Single learner device, no per-account storage, no backend: the choice lives
 * in `localStorage` under `THEME_STORAGE_KEY`. The theme is a `data-theme`
 * attribute on `<html>`; `styles.css` maps each value to the CSS variables
 * the dashboard and settings blocks read. `entry.ts` applies the stored value
 * before the first render, so a reload never flashes the default.
 */

export const THEME_STORAGE_KEY = 'nook:theme'

export const themeKeys = [
  'mochi-pink',
  'mochi-peach',
  'mochi-sage',
  'mochi-sky',
  'mochi-lilac',
] as const
export type ThemeKey = (typeof themeKeys)[number]

export const DEFAULT_THEME: ThemeKey = 'mochi-pink'

export const themeMeta: Readonly<Record<ThemeKey, { name: string; tint: string }>> = {
  'mochi-pink': { name: 'Mochi Pink', tint: '#fbb4c6' },
  'mochi-peach': { name: 'Mochi Peach', tint: '#f6c177' },
  'mochi-sage': { name: 'Mochi Sage', tint: '#a8c3a0' },
  'mochi-sky': { name: 'Mochi Sky', tint: '#a8cdf0' },
  'mochi-lilac': { name: 'Mochi Lilac', tint: '#c9b8f0' },
}

const isThemeKey = (value: string): value is ThemeKey =>
  (themeKeys as ReadonlyArray<string>).includes(value)

/** Read the stored theme. Unknown or missing values fall back to the default. */
export const readTheme = (): ThemeKey => {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    if (stored !== null && isThemeKey(stored)) return stored
  } catch {
    // Storage can refuse (private mode); the default still renders.
  }
  return DEFAULT_THEME
}

/** Apply a theme now (writes `data-theme` on `<html>`) and remember it. */
export const applyTheme = (theme: ThemeKey): void => {
  document.documentElement.dataset['theme'] = theme
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // The attribute above already applied it for this load.
  }
}
