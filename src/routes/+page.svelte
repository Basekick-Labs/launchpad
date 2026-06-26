<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';

  onMount(async () => {
    const res = await fetch('/api/v1/orgs');
    if (res.ok) {
      goto('/dashboard');
    } else {
      goto('/login');
    }
  });
</script>

<div class="flex min-h-screen items-center justify-center bg-background">
  <div class="text-muted-foreground">Loading...</div>
</div>
