<script lang="ts">
  import { Circle, Clock, Rows3, Columns3 } from 'lucide-svelte';

  export let connectionName: string = '';
  export let connectionUrl: string = '';
  export let rowCount: number | null = null;
  export let columnCount: number | null = null;
  export let executionTime: number | null = null;
  export let isConnected: boolean = false;
</script>

<div class="flex h-6 items-center justify-between border-t bg-muted/30 px-3 text-xs text-muted-foreground">
  <div class="flex items-center gap-4">
    <!-- Connection Status -->
    <div class="flex items-center gap-1.5">
      <Circle
        class="h-2 w-2 {isConnected ? 'fill-green-500 text-green-500' : 'fill-red-500 text-red-500'}"
      />
      <span class="font-medium">{connectionName || 'Disconnected'}</span>
      {#if connectionUrl}
        <span class="text-muted-foreground/60">• {connectionUrl}</span>
      {/if}
    </div>
  </div>

  <div class="flex items-center gap-4">
    <!-- Query Stats -->
    {#if rowCount !== null}
      <div class="flex items-center gap-1.5">
        <Rows3 class="h-3 w-3" />
        <span>{rowCount.toLocaleString()} rows</span>
      </div>
    {/if}

    {#if columnCount !== null}
      <div class="flex items-center gap-1.5">
        <Columns3 class="h-3 w-3" />
        <span>{columnCount} columns</span>
      </div>
    {/if}

    {#if executionTime !== null}
      <div class="flex items-center gap-1.5">
        <Clock class="h-3 w-3" />
        <span>{executionTime.toFixed(2)}ms</span>
      </div>
    {/if}
  </div>
</div>
