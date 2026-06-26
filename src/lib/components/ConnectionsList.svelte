<script lang="ts">
  import { onMount } from 'svelte';
  import { ConnectionManager, type ArcConnection } from '$lib/auth';
  import { Button } from '$lib/components/ui/button';
  import { cn } from '$lib/utils';
  import { ChevronDown, ChevronRight, Plus, Pencil, Trash2, Database, Circle } from 'lucide-svelte';

  export let activeConnection: ArcConnection | null;
  export let onConnect: (connection: ArcConnection) => void;
  export let onAddConnection: () => void;
  export let onEditConnection: (connection: ArcConnection) => void;
  export let onDeleteConnection: (connection: ArcConnection) => void;

  let connections: ArcConnection[] = [];
  let collapsed = false;

  function loadConnections() {
    connections = ConnectionManager.getAllConnections();
  }

  function handleConnect(connection: ArcConnection) {
    onConnect(connection);
  }

  function handleEdit(event: MouseEvent, connection: ArcConnection) {
    event.stopPropagation();
    onEditConnection(connection);
  }

  function handleDelete(event: MouseEvent, connection: ArcConnection) {
    event.stopPropagation();
    if (confirm(`Delete connection "${connection.name}"?`)) {
      onDeleteConnection(connection);
      loadConnections();
    }
  }

  onMount(() => {
    loadConnections();
  });

  // Expose refresh method
  export function refresh() {
    loadConnections();
  }
</script>

<div class="border-b">
  <div class="flex items-center justify-between px-3 py-2">
    <button
      class="flex flex-1 items-center gap-2 rounded-md px-2 py-1 text-sm font-medium transition-colors hover:bg-muted"
      on:click={() => collapsed = !collapsed}
      title={collapsed ? 'Show connections' : 'Hide connections'}
    >
      {#if collapsed}
        <ChevronRight class="h-4 w-4 text-muted-foreground" />
      {:else}
        <ChevronDown class="h-4 w-4 text-muted-foreground" />
      {/if}
      <Database class="h-4 w-4" />
      <span>Connections</span>
    </button>
    <Button
      variant="default"
      size="icon"
      class="h-6 w-6"
      on:click={onAddConnection}
      title="Add connection"
    >
      <Plus class="h-3 w-3" />
    </Button>
  </div>

  {#if !collapsed}
    <div class="px-2 pb-2">
      {#if connections.length === 0}
        <div class="rounded-md border border-dashed p-4 text-center">
          <Database class="mx-auto mb-2 h-8 w-8 text-muted-foreground" />
          <p class="mb-3 text-sm text-muted-foreground">No connections</p>
          <Button variant="outline" size="sm" on:click={onAddConnection}>
            <Plus class="mr-2 h-4 w-4" />
            Add Connection
          </Button>
        </div>
      {:else}
        <div class="space-y-1">
          {#each connections as connection}
            <div
              class={cn(
                'group flex items-center justify-between rounded-md border p-2 transition-all cursor-pointer',
                activeConnection?.id === connection.id
                  ? 'border-primary bg-primary/5'
                  : 'border-transparent hover:border-border hover:bg-muted/50'
              )}
              on:click={() => handleConnect(connection)}
              role="button"
              tabindex="0"
              on:keydown={(e) => e.key === 'Enter' && handleConnect(connection)}
            >
              <div class="flex items-center gap-2 min-w-0 flex-1">
                <Circle
                  class={cn(
                    'h-2 w-2 shrink-0',
                    activeConnection?.id === connection.id
                      ? 'fill-green-500 text-green-500'
                      : 'fill-muted-foreground/30 text-muted-foreground/30'
                  )}
                />
                <div class="min-w-0 flex-1">
                  <div class="truncate text-sm font-medium">{connection.name}</div>
                  <div class="truncate text-xs text-muted-foreground">{connection.url}</div>
                </div>
              </div>
              <div class="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                <Button
                  variant="ghost"
                  size="icon"
                  class="h-7 w-7"
                  on:click={(e) => handleEdit(e, connection)}
                  title="Edit connection"
                >
                  <Pencil class="h-3 w-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  class="h-7 w-7 text-destructive hover:text-destructive"
                  on:click={(e) => handleDelete(e, connection)}
                  title="Delete connection"
                >
                  <Trash2 class="h-3 w-3" />
                </Button>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>
