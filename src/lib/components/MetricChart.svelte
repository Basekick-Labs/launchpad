<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import uPlot from 'uplot';
  import 'uplot/dist/uPlot.min.css';

  export let title: string;
  export let data: [number[], number[]] = [[], []]; // [timestamps, values]
  export let unit: string = '';
  export let color: string = '#A855F7'; // Arc purple
  export let height: number = 150;

  let chartContainer: HTMLDivElement;
  let chart: uPlot | null = null;

  const isDark = () => document.documentElement.classList.contains('dark');

  function getThemeColors() {
    const dark = isDark();
    return {
      background: dark ? '#1a1a1a' : '#ffffff',
      axes: dark ? '#525252' : '#d4d4d4',
      grid: dark ? '#262626' : '#f5f5f5',
      text: dark ? '#a3a3a3' : '#525252',
    };
  }

  function formatValue(value: number): string {
    if (unit === 'MB') {
      return value.toFixed(1) + ' MB';
    } else if (unit === 'ms') {
      return value.toFixed(2) + ' ms';
    } else if (unit === 'ns') {
      return (value / 1000000).toFixed(2) + ' ms';
    } else if (unit === '%') {
      return value.toFixed(1) + '%';
    }
    return Math.round(value).toLocaleString();
  }

  function createChart() {
    if (!chartContainer || data[0].length === 0) return;

    const colors = getThemeColors();
    const width = chartContainer.clientWidth;

    const opts: uPlot.Options = {
      width,
      height,
      padding: [8, 8, 0, 0],
      cursor: {
        show: true,
        points: {
          show: false,
        },
      },
      legend: {
        show: false,
      },
      scales: {
        x: {
          time: true,
        },
        y: {
          auto: true,
        },
      },
      axes: [
        {
          show: true,
          stroke: colors.text,
          grid: {
            show: true,
            stroke: colors.grid,
            width: 1,
          },
          ticks: {
            show: true,
            stroke: colors.axes,
            width: 1,
            size: 4,
          },
          font: '10px Inter, system-ui, sans-serif',
          values: (u, vals) => vals.map(v => {
            const d = new Date(v * 1000);
            return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          }),
        },
        {
          show: true,
          stroke: colors.text,
          grid: {
            show: true,
            stroke: colors.grid,
            width: 1,
          },
          ticks: {
            show: true,
            stroke: colors.axes,
            width: 1,
            size: 4,
          },
          font: '10px Inter, system-ui, sans-serif',
          size: 50,
          values: (u, vals) => vals.map(v => formatValue(v)),
        },
      ],
      series: [
        {},
        {
          stroke: color,
          width: 2,
          fill: `${color}20`,
          points: {
            show: false,
          },
        },
      ],
    };

    if (chart) {
      chart.destroy();
    }

    chart = new uPlot(opts, data, chartContainer);
  }

  function handleResize() {
    if (chart && chartContainer) {
      chart.setSize({ width: chartContainer.clientWidth, height });
    }
  }

  $: if (data && chartContainer) {
    if (chart) {
      chart.setData(data);
    } else {
      createChart();
    }
  }

  onMount(() => {
    createChart();
    window.addEventListener('resize', handleResize);

    const observer = new MutationObserver(() => {
      createChart();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    return () => {
      observer.disconnect();
    };
  });

  onDestroy(() => {
    window.removeEventListener('resize', handleResize);
    if (chart) {
      chart.destroy();
    }
  });
</script>

<div class="flex flex-col rounded-lg border bg-card p-4">
  <div class="mb-2 flex items-center justify-between">
    <h3 class="text-sm font-medium text-muted-foreground">{title}</h3>
    {#if data[1].length > 0}
      <span class="text-lg font-semibold text-foreground">
        {formatValue(data[1][data[1].length - 1])}
      </span>
    {/if}
  </div>
  <div bind:this={chartContainer} class="w-full"></div>
</div>

<style>
  :global(.u-wrap) {
    background: transparent !important;
  }
</style>
