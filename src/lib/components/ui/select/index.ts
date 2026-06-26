import { Select as SelectPrimitive } from "bits-ui";
import Content from "./select-content.svelte";
import Item from "./select-item.svelte";
import Label from "./select-label.svelte";
import Separator from "./select-separator.svelte";
import Trigger from "./select-trigger.svelte";

const Root = SelectPrimitive.Root;
const Group = SelectPrimitive.Group;
const Input = SelectPrimitive.Input;
const Value = SelectPrimitive.Value;

export {
  Root,
  Group,
  Input,
  Value,
  Content,
  Item,
  Label,
  Separator,
  Trigger,
  //
  Root as Select,
  Group as SelectGroup,
  Input as SelectInput,
  Value as SelectValue,
  Content as SelectContent,
  Item as SelectItem,
  Label as SelectLabel,
  Separator as SelectSeparator,
  Trigger as SelectTrigger,
};
