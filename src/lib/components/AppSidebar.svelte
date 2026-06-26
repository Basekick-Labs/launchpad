<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import { Tooltip, TooltipContent, TooltipTrigger } from '$lib/components/ui/tooltip';
  import { cn } from '$lib/utils';
  import {
    TerminalSquare,
    Database,
    Settings,
    HelpCircle,
    Plug,
    Activity,
    ScrollText,
    Clock,
    RefreshCcw,
    Bell,
    Key
  } from 'lucide-svelte';

  export let activeView: 'console' | 'connections' | 'monitoring' | 'logs' | 'retention' | 'continuous-queries' | 'alerts' | 'tokens' | 'settings' | 'help' = 'console';

  const dispatch = createEventDispatcher();

  const navItems = [
    { id: 'console', icon: TerminalSquare, label: 'SQL Console' },
    { id: 'monitoring', icon: Activity, label: 'Monitoring' },
    { id: 'logs', icon: ScrollText, label: 'Log Explorer' },
    { id: 'retention', icon: Clock, label: 'Retention Policies' },
    { id: 'continuous-queries', icon: RefreshCcw, label: 'Continuous Queries' },
    { id: 'alerts', icon: Bell, label: 'Alerts' },
    { id: 'tokens', icon: Key, label: 'API Tokens' },
    { id: 'connections', icon: Database, label: 'Connections' },
  ] as const;

  const bottomItems = [
    { id: 'settings', icon: Settings, label: 'Settings' },
    { id: 'help', icon: HelpCircle, label: 'Help' },
  ] as const;

  function handleNavClick(id: string) {
    dispatch('navigate', id);
  }
</script>

<aside class="flex h-full w-14 flex-col border-r bg-card">
  <!-- Logo -->
  <div class="flex h-12 items-center justify-center border-b">
    <img src="/images/arc_logo.png" alt="Arc Launchpad" class="h-8 w-8 object-contain" />
  </div>

  <!-- Main Navigation -->
  <nav class="flex flex-1 flex-col gap-1 p-2">
    {#each navItems as item}
      <Tooltip>
        <TooltipTrigger asChild let:builder>
          <Button
            builders={[builder]}
            variant={activeView === item.id ? 'secondary' : 'ghost'}
            size="icon"
            class={cn(
              'h-10 w-10',
              activeView === item.id && 'bg-primary text-primary-foreground hover:bg-primary/90'
            )}
            on:click={() => handleNavClick(item.id)}
          >
            <svelte:component this={item.icon} class="h-5 w-5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right">
          {item.label}
        </TooltipContent>
      </Tooltip>
    {/each}
  </nav>

  <!-- Bottom Navigation -->
  <div class="flex flex-col gap-1 border-t p-2">
    {#each bottomItems as item}
      <Tooltip>
        <TooltipTrigger asChild let:builder>
          <Button
            builders={[builder]}
            variant={activeView === item.id ? 'secondary' : 'ghost'}
            size="icon"
            class="h-10 w-10"
            on:click={() => handleNavClick(item.id)}
          >
            <svelte:component this={item.icon} class="h-5 w-5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right">
          {item.label}
        </TooltipContent>
      </Tooltip>
    {/each}
  </div>
</aside>
