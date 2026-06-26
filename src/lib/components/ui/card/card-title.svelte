<script lang="ts">
  import { cn } from '$lib/utils';

  let className: string = '';
  export { className as class };
</script>

<h3
  class={cn('text-2xl font-semibold leading-none tracking-tight', className)}
  {...$$restProps}
>
  <slot />
</h3>
