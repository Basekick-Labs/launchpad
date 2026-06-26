<script lang="ts">
  import { cn } from '$lib/utils';

  type $$Props = {
    class?: string;
    value?: string | number | null;
    type?: string;
    placeholder?: string;
    disabled?: boolean;
    readonly?: boolean;
    id?: string;
    autocomplete?: string;
    min?: string | number;
    max?: string | number;
    step?: string | number;
    [key: string]: any;
  };

  export let value: string | number | null = '';
  export let type: string = 'text';
  export let placeholder: string = '';
  export let id: string | undefined = undefined;
  export let autocomplete: string | undefined = undefined;
  let className: string = '';
  export { className as class };

  const baseClass = 'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';
</script>

{#if type === 'password'}
  <input
    type="password"
    {id}
    {placeholder}
    {autocomplete}
    bind:value
    class={cn(baseClass, className)}
    {...$$restProps}
    on:input
    on:change
    on:focus
    on:blur
    on:keydown
    on:keyup
  />
{:else}
  <input
    type="text"
    {id}
    {placeholder}
    {autocomplete}
    bind:value
    class={cn(baseClass, className)}
    {...$$restProps}
    on:input
    on:change
    on:focus
    on:blur
    on:keydown
    on:keyup
  />
{/if}
