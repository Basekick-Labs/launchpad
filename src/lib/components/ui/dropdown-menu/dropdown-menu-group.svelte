<script lang="ts">
  import { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";

  type $$Props = DropdownMenuPrimitive.GroupProps;
</script>

<DropdownMenuPrimitive.Group {...$$restProps}>
  <slot />
</DropdownMenuPrimitive.Group>
