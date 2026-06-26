<script lang="ts">
  import { Separator as SeparatorPrimitive } from 'bits-ui';
  import { cn } from '$lib/utils';

  export let orientation: 'horizontal' | 'vertical' = 'horizontal';
  export let decorative: boolean = true;
  let className: string = '';
  export { className as class };
</script>

<SeparatorPrimitive.Root
  {orientation}
  {decorative}
  class={cn(
    'shrink-0 bg-border',
    orientation === 'horizontal' ? 'h-[1px] w-full' : 'h-full w-[1px]',
    className
  )}
  {...$$restProps}
/>
