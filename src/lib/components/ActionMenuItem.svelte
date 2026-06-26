<script lang="ts">
  // A single clickable row inside ActionMenu. `destructive` styles it red.
  export let destructive = false;
  export let disabled = false;
</script>

<button
  type="button"
  role="menuitem"
  {disabled}
  on:click
  class="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 {destructive
    ? 'text-destructive'
    : ''}"
>
  <slot />
</button>
