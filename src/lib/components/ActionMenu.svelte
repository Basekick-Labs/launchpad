<script lang="ts">
  import { MoreHorizontal } from 'lucide-svelte';
  import { tick } from 'svelte';

  // A minimal action (kebab) menu: a button that toggles a positioned panel.
  // Deliberately dependency-free (no bits-ui/melt-ui/floating-ui) so it can't
  // be broken by their interactions — the items are just rendered via a slot.
  export let align: 'start' | 'end' = 'end';

  let open = false;
  let root: HTMLDivElement;

  async function toggle() {
    open = !open;
    if (open) {
      await tick();
    }
  }

  function close() {
    open = false;
  }

  function onWindowClick(e: MouseEvent) {
    if (open && root && !root.contains(e.target as Node)) close();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') close();
  }
</script>

<svelte:window on:click={onWindowClick} on:keydown={onKey} />

<div class="relative inline-block" bind:this={root}>
  <button
    type="button"
    aria-haspopup="menu"
    aria-expanded={open}
    on:click|stopPropagation={toggle}
    class="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
  >
    <MoreHorizontal class="h-4 w-4" />
    <span class="sr-only">Open menu</span>
  </button>

  {#if open}
    <!-- Close after any item is activated. Items are <button>s, so this
         click delegation is keyboard-accessible via the buttons themselves. -->
    <div
      role="menu"
      tabindex="-1"
      class="absolute z-50 mt-1 min-w-[10rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md {align === 'end' ? 'right-0' : 'left-0'}"
      on:click={close}
      on:keydown={(e) => e.key === 'Enter' && close()}
    >
      <slot />
    </div>
  {/if}
</div>
