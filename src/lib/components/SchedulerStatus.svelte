<script lang="ts">
  import { cn } from '$lib/utils';
  import { CheckCircle, AlertCircle } from 'lucide-svelte';
  import { schedulerNotice, type CapabilityView } from '$lib/capabilities';

  /** Arc's CQ or retention scheduler, from capability discovery; null while unknown. */
  export let scheduler: CapabilityView | null = null;
  /** Renders the next run in the viewer's locale. */
  export let formatTime: ((iso: string) => string) | undefined = undefined;

  $: notice = schedulerNotice(scheduler, formatTime);
</script>

{#if notice}
  <div
    role="status"
    class={cn(
      'mb-4 flex items-start gap-2 rounded-lg border px-4 py-3 text-sm',
      notice.running
        ? 'bg-card text-muted-foreground'
        : 'border-yellow-200 bg-yellow-50 text-yellow-900 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-100'
    )}
  >
    {#if notice.running}
      <CheckCircle class="mt-0.5 h-4 w-4 flex-shrink-0 text-green-500" />
    {:else}
      <AlertCircle class="mt-0.5 h-4 w-4 flex-shrink-0" />
    {/if}
    <p>{notice.message}</p>
  </div>
{/if}
