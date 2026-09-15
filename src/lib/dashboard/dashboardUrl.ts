/**
 * The dashboard's query string, as pure functions over search params.
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

/** The panel being edited, or null. */
export function getEditPanel(search: URLSearchParams): string | null {
  const value = search.get('editPanel');
  return value && value.length > 0 ? value : null;
}

/** True when the page is in kiosk mode — `?kiosk` with or without a value. */
export function isKiosk(search: URLSearchParams): boolean {
  return search.has('kiosk') && search.get('kiosk') !== 'false';
}

// ---------------------------------------------------------------------------
// The rest of the query string
// ---------------------------------------------------------------------------

/**
 * Renamed from `panelUrl` when the view page landed: five parameters share this
 * string — `from`, `to`, `refresh`, `kiosk`, `viewPanel`, and `var-*` once #31
 * exists — and a second merge helper for the same string is the "two writers,
 * one string" bug this file was written to prevent.
 */
export interface DashboardParams {
  from?: string | null;
  to?: string | null;
  refresh?: string | null;
  viewPanel?: string | null;
  editPanel?: string | null;
  kiosk?: boolean | null;
}

/**
 * Merges changes into the CURRENT search string and returns the new one.
 *
 * `undefined` leaves a parameter alone; `null` removes it. Every caller must
 * re-read its base from the live URL rather than closing over a
 * `URLSearchParams`, or two writes in the same tick clobber each other.
 */
export function mergeDashboardParams(
  search: URLSearchParams,
  changes: DashboardParams,
): string {
  const next = new URLSearchParams(search);
  const set = (key: string, value: string | null | undefined) => {
    if (value === undefined) return;
    if (value === null || value === '') next.delete(key);
    else next.set(key, value);
  };
  set('from', changes.from);
  set('to', changes.to);
  set('refresh', changes.refresh);
  set('viewPanel', changes.viewPanel);
  set('editPanel', changes.editPanel);
  if (changes.kiosk !== undefined) {
    if (changes.kiosk) next.set('kiosk', '1');
    else next.delete('kiosk');
  }
  return next.toString();
}

/** A path plus a search string, with the `?` only when there is something to say. */
export function withSearch(pathname: string, search: string): string {
  return search ? `${pathname}?${search}` : pathname;
}

/**
 * The range to open with: the URL wins, then the dashboard's saved default.
 *
 * `dashboard.time` is the SAVED DEFAULT — what the dashboard opens with when the
 * URL is silent. It is not live state, and changing the range must not write to
 * it; only an explicit "save this as the default" does, which is a model edit
 * and legitimately dirties the dashboard.
 */
export function initialRange(
  search: URLSearchParams,
  saved: { from: string; to: string },
): { from: string; to: string } {
  return {
    from: search.get('from') || saved.from,
    to: search.get('to') || saved.to,
  };
}

/** Same rule for the refresh interval. Empty string means off. */
export function initialRefresh(search: URLSearchParams, saved: string): string {
  const fromUrl = search.get('refresh');
  return fromUrl === null ? saved : fromUrl;
}
