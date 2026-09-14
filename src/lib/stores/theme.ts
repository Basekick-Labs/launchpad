import { readable } from 'svelte/store';
import { browser } from '$app/environment';

/**
 * The resolved colour scheme, for code that has to *compute* a colour rather
 * than name a CSS variable.
 *
 * Tailwind handles the ordinary case: `dark:` variants resolve against the
 * `.dark` class and nothing needs to know which mode is active. Canvas does
 * not. A uPlot stroke, a heatmap cell, a threshold fill — those are literal
 * colour strings chosen in JS, and `$lib/dashboard/colors` needs to be told
 * which set to draw from.
 *
 * Three components already answer that question by calling
 * `document.documentElement.classList.contains('dark')` at draw time, each
 * with its own observer or none at all. This is that question asked once.
 *
 * `ThemeToggle.svelte` remains the writer: it owns the `arc-theme` preference
 * and puts the class on `<html>`. This store only reads.
 */
export type ColorScheme = 'light' | 'dark';

const THEME_KEY = 'arc-theme';

function systemScheme(): ColorScheme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * What the class on `<html>` says, or — before `ThemeToggle` mounts and puts it
 * there — what it is about to say. Reading the saved preference rather than
 * defaulting to light means a chart drawn during that window is already correct
 * instead of flashing and repainting.
 */
function currentScheme(): ColorScheme {
  const el = document.documentElement;
  if (el.classList.contains('dark')) return 'dark';
  if (el.classList.contains('light')) return 'light';

  let saved: string | null = null;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch {
    // Storage can throw outright in a locked-down browser context.
  }
  if (saved === 'light' || saved === 'dark') return saved;
  return systemScheme();
}

/**
 * Light on the server. SSR has no scheme to resolve — there is no class, no
 * media query and no storage — and guessing dark would make every server-
 * rendered chart repaint on hydration for the majority of users.
 *
 * Subscribing attaches the observer; the last unsubscribe detaches it, so a
 * page with no charts carries no listener.
 */
export const colorScheme = readable<ColorScheme>(browser ? currentScheme() : 'light', (set) => {
  if (!browser) return;

  const sync = () => set(currentScheme());
  sync();

  // ThemeToggle swaps the class on <html> for an explicit choice.
  const observer = new MutationObserver(sync);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

  // And under the 'system' preference the class changes only because the OS
  // did, which the observer sees — but this also covers the pre-mount window
  // where no class is present yet.
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', sync);

  return () => {
    observer.disconnect();
    media.removeEventListener('change', sync);
  };
});

/**
 * For imperative draw code that runs outside a reactive statement — a uPlot
 * `stroke` callback, say, which fires during a redraw and cannot subscribe.
 * Prefer `$colorScheme` anywhere Svelte is watching.
 */
export function readColorScheme(): ColorScheme {
  return browser ? currentScheme() : 'light';
}
