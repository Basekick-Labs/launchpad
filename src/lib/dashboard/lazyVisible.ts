/**
 * A Svelte action that reports when a panel enters the viewport, so a dashboard
 * taller than the screen does not query every panel on load.
 *
 * Deliberately NOT part of the query runner. `IntersectionObserver` is DOM, and
 * `vitest.config.ts` runs node with no jsdom — folding this in would make the
 * runner, where all the concurrency and cancellation logic lives, untestable.
 * The runner takes a gate; this is one way to drive it.
 *
 * ```svelte
 * <div use:lazyVisible={{ onVisible: () => runner.runPanel(...) }}>
 * ```
 *
 * Or bind the state and let a reactive statement decide:
 *
 * ```svelte
 * <div use:lazyVisible={{ onChange: (v) => (visible = v) }}>
 * {#if visible}...{/if}
 * ```
 */

export interface LazyVisibleOptions {
  /** Fired once, the first time the element becomes visible. */
  onVisible?: () => void;
  /** Fired on every transition, for panels that should pause when scrolled away. */
  onChange?: (visible: boolean) => void;
  /**
   * Start loading slightly before the panel is on screen, so scrolling does not
   * reveal an empty box. A viewport-height margin is roughly one screen of
   * lookahead.
   */
  rootMargin?: string;
}

export function lazyVisible(node: HTMLElement, options: LazyVisibleOptions = {}) {
  let opts = options;
  let fired = false;

  // No observer (SSR, or an ancient browser): treat the panel as visible rather
  // than leaving it permanently blank. Failing open is right here — the cost is
  // a query that was not strictly needed, and the alternative is a dashboard
  // that renders nothing at all.
  if (typeof IntersectionObserver === 'undefined') {
    opts.onChange?.(true);
    opts.onVisible?.();
    return {
      update(next: LazyVisibleOptions) {
        opts = next;
      },
      destroy() {},
    };
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        opts.onChange?.(entry.isIntersecting);
        if (entry.isIntersecting && !fired) {
          fired = true;
          opts.onVisible?.();
        }
      }
    },
    { rootMargin: opts.rootMargin ?? '200px' },
  );
  observer.observe(node);

  return {
    update(next: LazyVisibleOptions) {
      opts = next;
    },
    destroy() {
      observer.disconnect();
    },
  };
}
