// UI Components - shadcn-svelte style
// Explicit re-exports to avoid ambiguity between modules that export Root, Content, etc.

export { Button, buttonVariants } from './button';
export type { Variant as ButtonVariant, Size as ButtonSize } from './button';

export { Input } from './input';

export { Label } from './label';

export {
  Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle,
} from './card';

export {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader,
  DialogTitle, DialogTrigger, DialogClose, DialogOverlay,
} from './dialog';

export {
  Tabs, TabsContent, TabsList, TabsTrigger,
} from './tabs';

export { Badge, badgeVariants } from './badge';
export type { Variant as BadgeVariant } from './badge';

export { Separator } from './separator';

export { Tooltip, TooltipTrigger, TooltipContent } from './tooltip';
