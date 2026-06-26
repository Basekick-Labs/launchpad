<script lang="ts">
  import { cn } from '$lib/utils';

  export let value: string = '1h';
  export let mode: 'default' | 'alerting' = 'default';

  const defaultPresets = [
    { label: '5m', value: '5m' },
    { label: '15m', value: '15m' },
    { label: '30m', value: '30m' },
    { label: '1h', value: '1h' },
    { label: '6h', value: '6h' },
    { label: '12h', value: '12h' },
    { label: '24h', value: '24h' },
  ];

  const alertingPresets = [
    { label: '10s', value: '10s' },
    { label: '30s', value: '30s' },
    { label: '1m', value: '1m' },
    { label: '5m', value: '5m' },
    { label: '15m', value: '15m' },
    { label: '1h', value: '1h' },
  ];

  // Compute presets based on mode
  $: presets = mode === 'alerting' ? alertingPresets : defaultPresets;

  // Track custom mode state
  let isCustom = false;
  let customValue = '';

  // Check if initial value is not in presets
  $: {
    const currentPresets = mode === 'alerting' ? alertingPresets : defaultPresets;
    const isPresetValue = currentPresets.some(p => p.value === value);
    if (!isPresetValue && !isCustom) {
      isCustom = true;
      customValue = value;
    }
  }

  function selectPreset(preset: string) {
    isCustom = false;
    value = preset;
    customValue = '';
  }

  function enableCustom() {
    isCustom = true;
    if (!customValue) {
      customValue = value;
    }
  }

  function handleCustomChange(e: Event) {
    const input = e.target as HTMLInputElement;
    customValue = input.value;
    // Validate Go duration format (e.g., 5m, 1h, 30s, 2h30m)
    if (/^(\d+[smhd])+$/.test(customValue)) {
      value = customValue;
    }
  }
</script>

<div class="flex flex-col gap-2">
  <div class="flex flex-wrap gap-1">
    {#each presets as preset}
      <button
        type="button"
        class={cn(
          'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
          value === preset.value && !isCustom
            ? 'bg-primary text-primary-foreground'
            : 'bg-muted hover:bg-muted/80'
        )}
        on:click={() => selectPreset(preset.value)}
      >
        {preset.label}
      </button>
    {/each}
    <button
      type="button"
      class={cn(
        'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
        isCustom
          ? 'bg-primary text-primary-foreground'
          : 'bg-muted hover:bg-muted/80'
      )}
      on:click={enableCustom}
    >
      Custom
    </button>
  </div>

  {#if isCustom}
    <div class="flex items-center gap-2">
      <input
        type="text"
        class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
        placeholder="e.g., 2h30m"
        value={customValue}
        on:input={handleCustomChange}
      />
      <span class="text-xs text-muted-foreground whitespace-nowrap">s/m/h/d</span>
    </div>
    {#if customValue && !/^(\d+[smhd])+$/.test(customValue)}
      <p class="text-xs text-destructive">Invalid format. Use: 5m, 1h, 30s, 2h30m</p>
    {/if}
  {/if}
</div>
