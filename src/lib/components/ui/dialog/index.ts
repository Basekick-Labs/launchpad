import { Dialog as DialogPrimitive } from 'bits-ui';

import Root from './dialog.svelte';
import Content from './dialog-content.svelte';
import Description from './dialog-description.svelte';
import Footer from './dialog-footer.svelte';
import Header from './dialog-header.svelte';
import Title from './dialog-title.svelte';
import Overlay from './dialog-overlay.svelte';

const Trigger = DialogPrimitive.Trigger;
const Close = DialogPrimitive.Close;

export {
  Root,
  Content,
  Description,
  Footer,
  Header,
  Title,
  Trigger,
  Close,
  Overlay,
  Root as Dialog,
  Content as DialogContent,
  Description as DialogDescription,
  Footer as DialogFooter,
  Header as DialogHeader,
  Title as DialogTitle,
  Trigger as DialogTrigger,
  Close as DialogClose,
  Overlay as DialogOverlay,
};
