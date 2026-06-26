<script lang="ts">
  import { Dialog as DialogPrimitive } from 'bits-ui';

  export let open: boolean = false;
</script>

<DialogPrimitive.Root bind:open {...$$restProps}>
  <slot />
</DialogPrimitive.Root>
