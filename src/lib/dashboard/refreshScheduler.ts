/**
 * One timer per dashboard, emitting a bare tick.
 *
 * A tick carries no data: the page resolves the time range once per tick and
 * passes the same instants to every panel, because `queryRunner` keys its cache
 * on those instants and per-panel resolution makes two panels a millisecond
 * apart key differently. So this emits, and the page resolves.
 *
 * It lives in a module rather than inside the page for the same reason as
 * everything else in this directory: vitest runs node with no jsdom, so a timer
 * inside a `.svelte` file is untestable, and this one has three behaviours worth
 * asserting.
 *
 * #27 owns the PICKER; this is the mechanism it drives.
 */

import { durationToMs } from './duration';
import { LIMITS } from './model';

export interface RefreshSchedulerOptions {
  onTick: () => void;
  /** Injected so tests need not wait, and so a hidden tab can be simulated. */
  now?: () => number;
  isHidden?: () => boolean;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export function createRefreshScheduler(opts: RefreshSchedulerOptions) {
  const now = opts.now ?? (() => Date.now());
  const isHidden = opts.isHidden ?? (() => false);
  const setTimer = opts.setTimer ?? ((fn, ms) => setInterval(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));

  let handle: unknown = null;
  let intervalMs = 0;
  /** When a tick was skipped because the tab was hidden. */
  let missed = false;
  let lastTick = 0;

  function stop(): void {
    if (handle !== null) clearTimer(handle);
    handle = null;
  }

  function fire(): void {
    // A hidden tab must not query: a wall display in a background tab would
    // otherwise hammer Arc for nothing, and the browser throttles the timer
    // anyway so the interval stops meaning what it says.
    if (isHidden()) {
      missed = true;
      return;
    }
    missed = false;
    lastTick = now();
    opts.onTick();
  }

  return {
    /**
     * `''` turns refresh off. Anything below the floor is CLAMPED rather than
     * rejected: an imported dashboard with an aggressive interval must still
     * open, and a shared dashboard at `0ms` would make every viewer's browser
     * poll the proxy as fast as it can — with the admin token attached.
     */
    set(interval: string): void {
      stop();
      const parsed = interval ? durationToMs(interval) : null;
      intervalMs = parsed === null ? 0 : Math.max(parsed, LIMITS.minRefreshMs);
      if (intervalMs > 0) handle = setTimer(fire, intervalMs);
    },

    /**
     * Call when the tab becomes visible. Fires immediately if a tick was missed,
     * so a wall display that was backgrounded shows current data at once rather
     * than after a full interval of staleness.
     */
    resume(): void {
      if (missed && intervalMs > 0 && !isHidden()) fire();
    },

    /** Paused while the range is absolute: re-running it returns the same rows. */
    pause(): void {
      stop();
    },

    stop,
    get intervalMs(): number {
      return intervalMs;
    },
    get lastTickAt(): number {
      return lastTick;
    },
    get running(): boolean {
      return handle !== null;
    },
  };
}

export type RefreshScheduler = ReturnType<typeof createRefreshScheduler>;
