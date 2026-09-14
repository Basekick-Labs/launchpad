<script lang="ts">
  import { page } from '$app/stores';
  import { Button } from '$lib/components/ui/button';
  import { AlertTriangle } from 'lucide-svelte';

  // This repo had no +error.svelte at all, so any throw from a load rendered
  // SvelteKit's built-in fallback — outside this layout, with no sidebar and no
  // way back.
  $: status = $page.status;
  $: message = $page.error?.message ?? 'Something went wrong.';
</script>

<div class="flex h-full items-center justify-center p-6">
  <div class="max-w-md rounded-lg border bg-card p-8 text-center">
    <AlertTriangle class="mx-auto mb-4 h-8 w-8 text-muted-foreground" />
    <p class="mb-1 text-lg font-medium">
      {status === 403 ? 'No access' : status === 404 ? 'Not found' : 'Something went wrong'}
    </p>
    <p class="mb-6 text-sm text-muted-foreground">{message}</p>
    <Button href="/dashboard">Back to dashboard</Button>
  </div>
</div>
