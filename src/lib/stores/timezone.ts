import { writable } from 'svelte/store';
import { browser } from '$app/environment';

const STORAGE_KEY = 'arc-timezone';

function createTimezoneStore() {
  const initial = browser ? (localStorage.getItem(STORAGE_KEY) || 'utc') : 'utc';
  const { subscribe, set, update } = writable<'utc' | 'local'>(initial as 'utc' | 'local');

  return {
    subscribe,
    toggle() {
      update(v => {
        const next = v === 'utc' ? 'local' : 'utc';
        if (browser) localStorage.setItem(STORAGE_KEY, next);
        return next;
      });
    },
    set(value: 'utc' | 'local') {
      set(value);
      if (browser) localStorage.setItem(STORAGE_KEY, value);
    },
  };
}

export const timezone = createTimezoneStore();

/** Full date+time: "2026-03-24 21:08:30 UTC" or "Mar 24, 2026, 05:08:30 PM" */
export function formatDateTime(iso: string, tz: 'utc' | 'local'): string {
  const d = new Date(iso);
  if (tz === 'utc') {
    return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  }
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

/** Date only: "2026-03-24 UTC" or "Mar 24, 2026" */
export function formatDate(iso: string, tz: 'utc' | 'local'): string {
  const d = new Date(iso);
  if (tz === 'utc') {
    return d.toISOString().split('T')[0] + ' UTC';
  }
  return d.toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

/** Date from unix timestamp (seconds): "Mar 24, 2026" or "2026-03-24 UTC" */
export function formatUnixDate(ts: number, tz: 'utc' | 'local'): string {
  return formatDate(new Date(ts * 1000).toISOString(), tz);
}

/** Long date from unix timestamp: "March 24, 2026" or "2026-03-24 UTC" */
export function formatUnixDateLong(ts: number, tz: 'utc' | 'local'): string {
  const d = new Date(ts * 1000);
  if (tz === 'utc') {
    return d.toISOString().split('T')[0] + ' UTC';
  }
  return d.toLocaleDateString(undefined, {
    year: 'numeric', month: 'long', day: 'numeric',
  });
}
