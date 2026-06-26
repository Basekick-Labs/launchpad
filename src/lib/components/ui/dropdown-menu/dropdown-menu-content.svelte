<script lang="ts">
  import { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";
  import { cn } from "$lib/utils";
  import { fly } from "svelte/transition";

  type $$Props = DropdownMenuPrimitive.ContentProps;

  let className: $$Props["class"] = undefined;
  export let sideOffset: $$Props["sideOffset"] = 4;
  export let align: $$Props["align"] = undefined;
  export let transition: $$Props["transition"] = fly;
  export let transitionConfig: $$Props["transitionConfig"] = {
    duration: 150,
    y: -8,
  };
  export { className as class };
</script>

<DropdownMenuPrimitive.Content
  {sideOffset}
  {align}
  {transition}
  {transitionConfig}
  class={cn(
    "z-50 min-w-[8rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md focus:outline-none",
    className
  )}
  {...$$restProps}
>
  <slot />
</DropdownMenuPrimitive.Content>
