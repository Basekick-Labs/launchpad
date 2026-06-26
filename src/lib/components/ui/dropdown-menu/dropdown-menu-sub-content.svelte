<script lang="ts">
  import { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";
  import { cn } from "$lib/utils";
  import { fly } from "svelte/transition";

  type $$Props = DropdownMenuPrimitive.SubContentProps;

  let className: $$Props["class"] = undefined;
  export let transition: $$Props["transition"] = fly;
  export let transitionConfig: $$Props["transitionConfig"] = {
    x: -10,
    duration: 150,
  };
  export { className as class };
</script>

<DropdownMenuPrimitive.SubContent
  {transition}
  {transitionConfig}
  class={cn(
    "z-50 min-w-[8rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-lg focus:outline-none",
    className
  )}
  {...$$restProps}
>
  <slot />
</DropdownMenuPrimitive.SubContent>
