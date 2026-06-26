<script lang="ts">
  import { cn } from '$lib/utils';
  import { badgeVariants, type Variant } from './index';

  export let variant: Variant = 'default';
  let className: string = '';
  export { className as class };
</script>

<div class={cn(badgeVariants({ variant }), className)} {...$$restProps}>
  <slot />
</div>
