/**
 * The `?viewPanel=` parameter, as a pure function over search params.
 *
 * Separate from any component because it is the piece with a rule in it: every
 * writer must MERGE into the existing query string. `from`, `to`, `refresh`,
 * `kiosk` and `var-*` all live there, and a writer that rebuilds the string
 * deletes them — which is how a fullscreen toggle silently resets the time
 * range.
 *
 * The overlay itself belongs to the dashboard page, not the panel: the grid
 * iterates every panel, so a panel cannot exclude itself from the layout, and
 * twenty panels each owning a `svelte:window` key handler and a URL writer would
 * be twenty racing writers.
 */

/** The id currently shown fullscreen, or null. */
export function getViewPanel(search: URLSearchParams): string | null {
  const value = search.get('viewPanel');
  return value && value.length > 0 ? value : null;
}

/**
 * The search string with `viewPanel` set or cleared, every other parameter
 * preserved. Returns the string WITHOUT a leading `?` when empty, so a caller
 * can build `${pathname}${search ? '?' + search : ''}`.
 */
export function setViewPanel(search: URLSearchParams, id: string | null): string {
  const next = new URLSearchParams(search);
  if (id) next.set('viewPanel', id);
  else next.delete('viewPanel');
  return next.toString();
}

/** True when the page is in kiosk mode — `?kiosk` with or without a value. */
export function isKiosk(search: URLSearchParams): boolean {
  return search.has('kiosk') && search.get('kiosk') !== 'false';
}
