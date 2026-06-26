<script lang="ts">
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

    downloadFile(content, `logs-export-${Date.now()}.${extension}`, mimeType);
    open = false;
    dispatch('exported', { format: selectedFormat, count: logs.length });
  }

  function convertToCSV(data: Record<string, unknown>[], cols: string[]): string {
    if (data.length === 0) return '';

    // Use provided columns or extract from first row
    const headers = cols.length > 0 ? cols : Object.keys(data[0]);

    // Escape CSV values
    const escapeCSV = (value: unknown): string => {
      if (value === null || value === undefined) return '';
      const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
      // Escape quotes and wrap in quotes if contains comma, quote, or newline
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const headerRow = headers.map(escapeCSV).join(',');
    const dataRows = data.map(row =>
      headers.map(col => escapeCSV(row[col])).join(',')
    );

    return [headerRow, ...dataRows].join('\n');
  }

  function downloadFile(content: string, filename: string, mimeType: string) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
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
