<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { Chart, CategoryScale, LinearScale, PointElement, LineElement, BarElement, LineController, BarController, Title, Tooltip, Legend } from 'chart.js';
  import type { QueryResult, StatementResult } from '$lib/arcClient';
  import { getStatementPreview, getStatementType } from '$lib/sqlParser';
  import { Button } from '$lib/components/ui/button';
  import { Badge } from '$lib/components/ui/badge';
  import { toast } from 'svelte-sonner';
  import { Download, Copy, BarChart3, Table2, AlertCircle, FileJson, FileText, CheckCircle, XCircle, Circle, Loader2 } from 'lucide-svelte';
  import { cn } from '$lib/utils';

  // Multi-result props (preferred)
  export let results: StatementResult[] = [];

  // Legacy single-result props (backwards compatibility)
  export let result: QueryResult | null = null;
  export let query: string = '';
  export let error: string = '';

  // Convert legacy props to multi-result format if needed
  $: effectiveResults = results.length > 0 ? results :
    (result || error) ? [{
      index: 0,
      sql: query,
      status: (error ? 'error' : 'success') as 'error' | 'success',
      result: result || undefined,
      error: error || undefined
    }] : [];

  // Track active tab
  let activeTabIndex = 0;

  // Reset to first tab when results change
  $: if (effectiveResults.length > 0 && activeTabIndex >= effectiveResults.length) {
    activeTabIndex = 0;
  }

  // Current statement for display
  $: currentStatement = effectiveResults[activeTabIndex] || null;
  $: currentResult = currentStatement?.result || null;
  $: currentError = currentStatement?.error || '';

  let chartCanvas: HTMLCanvasElement;
  let chartInstance: Chart | null = null;
  let showChart = false;
  let canShowChart = false;

  // Register Chart.js components
  Chart.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, LineController, BarController, Title, Tooltip, Legend);

  $: {
    // Check if we can show a chart whenever currentResult changes
    if (currentResult) {
      canShowChart = detectChartData(currentResult);
      if (!canShowChart) {
        showChart = false;
      }
    } else {
      canShowChart = false;
      showChart = false;
    }
  }

  function detectChartData(res: QueryResult): boolean {
    // Need at least one numeric column
    const numericColumns = findNumericColumns(res);
    return numericColumns.length > 0;
  }

  function findTimeColumn(res: QueryResult): number {
    const timePatterns = ['time', 'date', 'timestamp', 't', 'created', 'updated'];
    const colIndex = res.columns.findIndex(col =>
      timePatterns.some(pattern => col.toLowerCase().includes(pattern))
    );

    if (colIndex !== -1) {
      // Verify the column has valid time-like data
      const hasValidData = res.rows.slice(0, 10).some(row => {
        const val = row[colIndex];
        return val !== null && (typeof val === 'string' || typeof val === 'number');
      });
      return hasValidData ? colIndex : -1;
    }

    return -1;
  }

  function findNumericColumns(res: QueryResult): number[] {
    const numericCols: number[] = [];
    const timeColIdx = findTimeColumn(res);

    for (let colIdx = 0; colIdx < res.columns.length; colIdx++) {
      // Skip the time column
      if (colIdx === timeColIdx) continue;

      // Check if all non-null values in this column are numeric
      const isNumeric = res.rows.every(row => {
        const val = row[colIdx];
        if (val === null) return true;
        if (typeof val === 'number') return true;
        if (typeof val === 'string') {
          // Try to parse as number
          const num = Number(val);
          return !isNaN(num);
        }
        return false;
      });

      if (isNumeric) {
        // Make sure at least one value is non-null
        const hasData = res.rows.some(row => row[colIdx] !== null);
        if (hasData) {
          numericCols.push(colIdx);
        }
      }
    }

    return numericCols;
  }

  function toggleChart() {
    showChart = !showChart;

    if (showChart && currentResult) {
      // Wait for canvas to render
      setTimeout(() => {
        createChart(currentResult);
      }, 0);
    } else if (chartInstance) {
      chartInstance.destroy();
      chartInstance = null;
    }
  }

  function createChart(res: QueryResult) {
    if (!chartCanvas || !res) {
      console.log('Chart creation aborted: canvas or result missing', { chartCanvas, res });
      return;
    }

    // Destroy existing chart
    if (chartInstance) {
      chartInstance.destroy();
      chartInstance = null;
    }

    const timeColIdx = findTimeColumn(res);
    const numericCols = findNumericColumns(res);

    console.log('Chart data detection:', {
      columns: res.columns,
      timeColIdx,
      numericCols,
      numericColNames: numericCols.map(idx => res.columns[idx])
    });

    if (numericCols.length === 0) {
      console.log('No numeric columns found, cannot create chart');
      return;
    }

    // Limit data points for performance
    const maxRows = timeColIdx !== -1 ? 100 : 20;
    const limitedRows = res.rows.slice(0, maxRows);

    // Limit number of series
    const maxSeries = timeColIdx !== -1 ? 5 : 3;
    const limitedNumericCols = numericCols.slice(0, maxSeries);

    let labels: string[];
    let chartType: 'line' | 'bar';

    if (timeColIdx !== -1) {
      // Time series chart
      chartType = 'line';
      labels = limitedRows.map(row => {
        const val = row[timeColIdx];
        if (val === null) return '';
        if (typeof val === 'string') return val;
        if (typeof val === 'number') return new Date(val).toLocaleString();
        return String(val);
      });
    } else {
      // Bar chart - use first column as labels or row numbers
      chartType = 'bar';
      const labelColIdx = res.columns.findIndex((_, idx) => !numericCols.includes(idx));
      if (labelColIdx !== -1) {
        labels = limitedRows.map(row => String(row[labelColIdx] ?? ''));
      } else {
        labels = limitedRows.map((_, idx) => `Row ${idx + 1}`);
      }
    }

    // Create datasets
    const colors = [
      'rgb(75, 192, 192)',
      'rgb(255, 99, 132)',
      'rgb(54, 162, 235)',
      'rgb(255, 206, 86)',
      'rgb(153, 102, 255)'
    ];

    const datasets = limitedNumericCols.map((colIdx, idx) => {
      const data = limitedRows.map(row => {
        const val = row[colIdx];
        return val === null ? null : Number(val);
      });

      return {
        label: res.columns[colIdx],
        data,
        borderColor: colors[idx % colors.length],
        backgroundColor: colors[idx % colors.length].replace('rgb', 'rgba').replace(')', ', 0.1)'),
        tension: 0.1
      };
    });

    // Create chart
    chartInstance = new Chart(chartCanvas, {
      type: chartType,
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'top' as const,
          },
          title: {
            display: false
          }
        },
        scales: {
          y: {
            beginAtZero: true
          }
        }
      }
    });
  }

  onDestroy(() => {
    if (chartInstance) {
      chartInstance.destroy();
      chartInstance = null;
    }
  });

  function exportAsCSV() {
    if (!currentResult) return;

    const headers = currentResult.columns.join(',');
    const rows = currentResult.rows.map(row =>
      row.map(cell => {
        const value = cell === null ? '' : String(cell);
        // Escape quotes and wrap in quotes if contains comma
        return value.includes(',') || value.includes('"') || value.includes('\n')
          ? `"${value.replace(/"/g, '""')}"`
          : value;
      }).join(',')
    );

    const csv = [headers, ...rows].join('\n');
    downloadFile(csv, 'query-results.csv', 'text/csv');
  }

  function exportAsJSON() {
    if (!currentResult) return;

    const data = currentResult.rows.map(row => {
      const obj: Record<string, any> = {};
      currentResult.columns.forEach((col, idx) => {
        obj[col] = row[idx];
      });
      return obj;
    });

    const json = JSON.stringify(data, null, 2);
    downloadFile(json, 'query-results.json', 'application/json');
  }

  function copyAsMarkdown() {
    if (!currentResult) return;

    // Create header row
    const header = '| ' + currentResult.columns.join(' | ') + ' |';
    const separator = '| ' + currentResult.columns.map(() => '---').join(' | ') + ' |';

    // Create data rows
    const rows = currentResult.rows.map(row =>
      '| ' + row.map(cell => cell === null ? 'NULL' : String(cell)).join(' | ') + ' |'
    );

    const markdown = [header, separator, ...rows].join('\n');

    navigator.clipboard.writeText(markdown).then(() => {
      toast.success('Markdown table copied to clipboard!');
    });
  }

  function downloadFile(content: string, filename: string, mimeType: string) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
</script>

<div class="flex h-full flex-col gap-4 p-6">
  <!-- Multi-statement tabs -->
  {#if effectiveResults.length > 1}
    <div class="flex items-center gap-1 overflow-x-auto border-b pb-2">
      {#each effectiveResults as stmt, idx}
        <button
          class={cn(
            "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors whitespace-nowrap",
            activeTabIndex === idx
              ? "bg-primary text-primary-foreground"
              : "bg-muted hover:bg-muted/80"
          )}
          on:click={() => { activeTabIndex = idx; showChart = false; }}
        >
          {#if stmt.status === 'running'}
            <Loader2 class="h-3.5 w-3.5 animate-spin" />
          {:else if stmt.status === 'success'}
            <CheckCircle class="h-3.5 w-3.5 text-green-500" />
          {:else if stmt.status === 'error'}
            <XCircle class="h-3.5 w-3.5 text-red-500" />
          {:else}
            <Circle class="h-3.5 w-3.5 text-muted-foreground" />
          {/if}
          <span class="max-w-[120px] truncate">{getStatementType(stmt.sql)}</span>
          <span class="text-xs opacity-60">#{idx + 1}</span>
        </button>
      {/each}
    </div>
  {/if}

  {#if currentError}
    <div class="flex items-start gap-3 rounded-lg border border-destructive/50 bg-destructive/10 p-4">
      <AlertCircle class="h-5 w-5 shrink-0 text-destructive" />
      <div class="flex-1 text-sm text-destructive">
        <strong>Error:</strong> {currentError}
        {#if currentStatement}
          <pre class="mt-2 whitespace-pre-wrap rounded bg-destructive/10 p-2 font-mono text-xs">{currentStatement.sql}</pre>
        {/if}
      </div>
    </div>
  {:else if currentResult}
    <!-- Action Buttons -->
    <div class="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" on:click={exportAsCSV}>
        <Download class="mr-2 h-4 w-4" />
        CSV
      </Button>
      <Button variant="outline" size="sm" on:click={exportAsJSON}>
        <FileJson class="mr-2 h-4 w-4" />
        JSON
      </Button>
      <Button variant="outline" size="sm" on:click={copyAsMarkdown}>
        <Copy class="mr-2 h-4 w-4" />
        Markdown
      </Button>
      {#if canShowChart}
        <Button
          variant={showChart ? "default" : "outline"}
          size="sm"
          on:click={toggleChart}
        >
          <BarChart3 class="mr-2 h-4 w-4" />
          {showChart ? 'Hide' : 'Show'} Chart
        </Button>
      {/if}
    </div>

    <!-- Chart -->
    {#if showChart && canShowChart}
      <div class="h-[400px] rounded-lg border bg-card p-4">
        <canvas bind:this={chartCanvas}></canvas>
      </div>
    {/if}

    <!-- Results Table -->
    <div class="flex-1 overflow-auto rounded-lg border">
      <table class="w-full text-sm">
        <thead class="sticky top-0 z-10 bg-muted">
          <tr>
            {#each currentResult.columns as col}
              <th class="max-w-[300px] truncate border-b-2 border-border px-4 py-3 text-left font-semibold" title={col}>
                {col}
              </th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each currentResult.rows as row}
            <tr class="transition-colors hover:bg-muted/50">
              {#each row as cell}
                <td
                  class="max-w-[300px] overflow-hidden text-ellipsis border-b border-border px-4 py-3"
                  title={cell === null ? 'NULL' : String(cell)}
                >
                  {#if cell === null}
                    <span class="text-muted-foreground">NULL</span>
                  {:else}
                    {cell}
                  {/if}
                </td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else if effectiveResults.length === 0}
    <div class="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
      <Table2 class="h-12 w-12 opacity-50" />
      <p class="text-lg font-medium">No results to display</p>
      <p class="text-sm opacity-70">Execute a query to see results here</p>
    </div>
  {/if}
</div>

