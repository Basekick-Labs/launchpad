<script lang="ts">
  import SchemaExplorer from './SchemaExplorer.svelte';
  import QueryHistory from './QueryHistory.svelte';
  import ConnectionsList from './ConnectionsList.svelte';
  import type { ArcClient } from '$lib/arcClient';
  import type { ArcConnection } from '$lib/auth';
  import { Button } from '$lib/components/ui/button';
  import { Key } from 'lucide-svelte';

  export let client: ArcClient;
  export let activeConnection: ArcConnection | null;
  export let onTableSelect: (tableName: string) => void;
  export let onQuerySelect: (sql: string) => void;
  export let onTokensClick: () => void;
  export let onConnectionSwitch: (connection: ArcConnection) => void;
  export let onAddConnection: () => void;
  export let onEditConnection: (connection: ArcConnection) => void;
  export let onDeleteConnection: (connection: ArcConnection) => void;

  let connectionsList: ConnectionsList;

  export function refreshConnections() {
    if (connectionsList) {
      connectionsList.refresh();
    }
  }
</script>

<div class="flex h-full flex-col">
  <ConnectionsList
    bind:this={connectionsList}
    {activeConnection}
    onConnect={onConnectionSwitch}
    {onAddConnection}
    {onEditConnection}
    {onDeleteConnection}
  />
  <SchemaExplorer {client} {onTableSelect} />
  <QueryHistory {onQuerySelect} />

  <div class="mt-auto border-t p-3">
    <Button variant="outline" class="w-full justify-start" on:click={onTokensClick}>
      <Key class="mr-2 h-4 w-4 text-muted-foreground" />
      Token Management
    </Button>
  </div>
</div>
