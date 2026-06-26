<script lang="ts">
  import { Select as SelectPrimitive } from "bits-ui";
  import { cn } from "$lib/utils";
  import { fly } from "svelte/transition";

  type $$Props = SelectPrimitive.ContentProps;

  let className: $$Props["class"] = undefined;
  export let sideOffset: $$Props["sideOffset"] = 4;
  export let transition: $$Props["transition"] = fly;
  export let transitionConfig: $$Props["transitionConfig"] = {
    duration: 150,
    y: -8,
  };
  export { className as class };
</script>

<SelectPrimitive.Content
  {sideOffset}
  {transition}
  {transitionConfig}
  class={cn(
    "relative z-50 max-h-96 min-w-[8rem] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md focus:outline-none",
    className
  )}
  {...$$restProps}
>
  <div class="w-full p-1">
    <slot />
  </div>
</SelectPrimitive.Content>
