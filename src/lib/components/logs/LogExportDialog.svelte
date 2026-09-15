<script lang="ts">
  import { toCsv, rowsFromObjects } from '$lib/csv';
  import { downloadBlob } from '$lib/download';
  import { createEventDispatcher } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import * as Dialog from '$lib/components/ui/dialog';
  import { Download, FileJson, FileText, File } from 'lucide-svelte';
  import { cn } from '$lib/utils';

  export let open = false;
  export let logs: Record<string, unknown>[] = [];
  export let columns: string[] = [];

  const dispatch = createEventDispatcher();

  type ExportFormat = 'json' | 'csv' | 'ndjson';

  let selectedFormat: ExportFormat = 'json';

  const formats = [
    { id: 'json' as const, label: 'JSON', description: 'Array of log objects', icon: FileJson },
    { id: 'csv' as const, label: 'CSV', description: 'Comma-separated values', icon: FileText },
    { id: 'ndjson' as const, label: 'NDJSON', description: 'Newline-delimited JSON', icon: File },
  ];

  function exportLogs() {
    if (logs.length === 0) return;

    let content: string;
    let mimeType: string;
    let extension: string;

    switch (selectedFormat) {
      case 'json':
        content = JSON.stringify(logs, null, 2);
        mimeType = 'application/json';
        extension = 'json';
        break;

      case 'csv':
        content = convertToCSV(logs, columns);
        mimeType = 'text/csv';
        extension = 'csv';
        break;

      case 'ndjson':
        content = logs.map(log => JSON.stringify(log)).join('\n');
        mimeType = 'application/x-ndjson';
        extension = 'ndjson';
        break;
    }

    downloadBlob([content], `logs-export-${Date.now()}.${extension}`, mimeType);
    open = false;
    dispatch('exported', { format: selectedFormat, count: logs.length });
  }

  function convertToCSV(data: Record<string, unknown>[], cols: string[]): string {
    if (data.length === 0) return '';
    // One implementation, in $lib/csv. The first-record-keys fallback is
    // preserved deliberately: log records are heterogeneous, and widening it to
    // a union of all keys would change every existing export.
    const { columns, rows } = rowsFromObjects(data, cols);
    return toCsv(columns, rows);
  }


</script>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>Export Logs</Dialog.Title>
      <Dialog.Description>
        Export {logs.length} log{logs.length !== 1 ? 's' : ''} to a file
      </Dialog.Description>
    </Dialog.Header>

    <div class="grid gap-4 py-4">
      <div class="space-y-3">
        <label class="text-sm font-medium">Export Format</label>
        <div class="grid gap-2">
          {#each formats as format}
            <button
              class={cn(
                'flex items-center gap-3 rounded-lg border p-3 text-left transition-colors',
                selectedFormat === format.id
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:bg-muted/50'
              )}
              on:click={() => (selectedFormat = format.id)}
            >
              <svelte:component this={format.icon} class="h-5 w-5 text-muted-foreground" />
              <div>
                <div class="font-medium">{format.label}</div>
                <div class="text-xs text-muted-foreground">{format.description}</div>
              </div>
            </button>
          {/each}
        </div>
      </div>
    </div>

    <Dialog.Footer>
      <Button variant="outline" on:click={() => (open = false)}>Cancel</Button>
      <Button on:click={exportLogs} disabled={logs.length === 0}>
        <Download class="mr-2 h-4 w-4" />
        Export {logs.length} log{logs.length !== 1 ? 's' : ''}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
