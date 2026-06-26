import { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";
import Content from "./dropdown-menu-content.svelte";
import Item from "./dropdown-menu-item.svelte";
import Label from "./dropdown-menu-label.svelte";
import Separator from "./dropdown-menu-separator.svelte";
import Shortcut from "./dropdown-menu-shortcut.svelte";
import SubContent from "./dropdown-menu-sub-content.svelte";
import SubTrigger from "./dropdown-menu-sub-trigger.svelte";
import CheckboxItem from "./dropdown-menu-checkbox-item.svelte";
import RadioItem from "./dropdown-menu-radio-item.svelte";
import Group from "./dropdown-menu-group.svelte";

const Root = DropdownMenuPrimitive.Root;
const Trigger = DropdownMenuPrimitive.Trigger;
const Sub = DropdownMenuPrimitive.Sub;
const RadioGroup = DropdownMenuPrimitive.RadioGroup;

export {
  Root,
  Trigger,
  Sub,
  RadioGroup,
  Content,
  Item,
  Label,
  Separator,
  Shortcut,
  SubContent,
  SubTrigger,
  CheckboxItem,
  RadioItem,
  Group,
  //
  Root as DropdownMenu,
  Trigger as DropdownMenuTrigger,
  Content as DropdownMenuContent,
  Item as DropdownMenuItem,
  Label as DropdownMenuLabel,
  Separator as DropdownMenuSeparator,
  Shortcut as DropdownMenuShortcut,
  Sub as DropdownMenuSub,
  SubContent as DropdownMenuSubContent,
  SubTrigger as DropdownMenuSubTrigger,
  CheckboxItem as DropdownMenuCheckboxItem,
  RadioItem as DropdownMenuRadioItem,
  RadioGroup as DropdownMenuRadioGroup,
  Group as DropdownMenuGroup,
};
