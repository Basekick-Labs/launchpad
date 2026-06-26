<script lang="ts">
  import { cn } from '$lib/utils';
  import { buttonVariants, type Variant, type Size } from './index';

  type $$Props = {
    class?: string;
    variant?: Variant;
    size?: Size;
    type?: 'button' | 'submit' | 'reset';
    disabled?: boolean;
    href?: string;
    title?: string;
    builders?: any[];
    onclick?: (e: MouseEvent) => void;
    [key: string]: any;
  };

  export let variant: Variant = 'default';
  export let size: Size = 'default';
  export let type: 'button' | 'submit' | 'reset' = 'button';
  export let href: string | undefined = undefined;
  let className: string = '';
  export { className as class };
</script>

{#if href}
  <a
    {href}
    class={cn(buttonVariants({ variant, size }), className)}
    {...$$restProps}
    on:click
    on:keydown
    on:keyup
  >
    <slot />
  </a>
{:else}
  <button
    {type}
    class={cn(buttonVariants({ variant, size }), className)}
    {...$$restProps}
    on:click
    on:keydown
    on:keyup
  >
    <slot />
  </button>
{/if}
