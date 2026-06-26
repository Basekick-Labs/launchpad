<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { Tab } from '$lib/tabManager';
  import { Button } from '$lib/components/ui/button';
  import { cn } from '$lib/utils';
  import { FileText, BarChart3, Key, X, Plus, PanelLeftClose, PanelLeft } from 'lucide-svelte';

  export let tabs: Tab[] = [];
  export let activeTabId: string | null = null;
  export let sidebarCollapsed: boolean = false;

  const dispatch = createEventDispatcher();

  function handleTabClick(tabId: string) {
    dispatch('tabSelect', tabId);
  }

  function handleCloseTab(event: MouseEvent, tabId: string) {
    event.stopPropagation();
    dispatch('tabClose', tabId);
  }

  function handleNewTab() {
    dispatch('newTab');
  }

  function handleToggleSidebar() {
    dispatch('toggleSidebar');
  }
</script>

<div class="flex items-center gap-2 border-b bg-muted/30 px-3 py-2">
  <Button
    variant="ghost"
    size="icon"
    class="h-8 w-8 shrink-0"
    on:click={handleToggleSidebar}
    title="Toggle sidebar"
  >
    {#if sidebarCollapsed}
      <PanelLeft class="h-4 w-4" />
    {:else}
      <PanelLeftClose class="h-4 w-4" />
    {/if}
  </Button>

  <div class="flex flex-1 gap-1 overflow-x-auto">
    {#each tabs as tab}
      <button
        class={cn(
          'group flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition-all',
          tab.id === activeTabId
            ? 'border-primary/20 bg-background text-foreground shadow-sm'
            : 'border-transparent bg-transparent text-muted-foreground hover:bg-background/50 hover:text-foreground'
        )}
        on:click={() => handleTabClick(tab.id)}
      >
        <span class="shrink-0">
          {#if tab.type === 'query'}
            <FileText class="h-4 w-4 text-muted-foreground" />
          {:else if tab.type === 'results'}
            <BarChart3 class="h-4 w-4 text-muted-foreground" />
          {:else if tab.type === 'tokens'}
            <Key class="h-4 w-4 text-muted-foreground" />
          {/if}
        </span>
        <span class="max-w-[120px] truncate">{tab.title}</span>
        <button
          class="ml-1 rounded p-0.5 opacity-0 transition-opacity hover:bg-muted group-hover:opacity-100"
          on:click={(e) => handleCloseTab(e, tab.id)}
          title="Close tab"
        >
          <X class="h-3 w-3" />
        </button>
      </button>
    {/each}
  </div>

  <Button
    variant="ghost"
    size="icon"
    class="h-8 w-8 shrink-0"
    on:click={handleNewTab}
    title="New query tab"
  >
    <Plus class="h-4 w-4" />
  </Button>
</div>
