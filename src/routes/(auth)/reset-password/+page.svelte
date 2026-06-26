<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { Button } from '$lib/components/ui/button';

  const token = $page.url.searchParams.get('token') || '';

  let password = '';
  let confirmPassword = '';
  let showPassword = false;
  let error = '';
  let loading = false;
  let success = false;

  async function handleSubmit() {
    error = '';

    if (password !== confirmPassword) {
      error = 'Passwords do not match.';
      return;
    }

    loading = true;

    try {
      const res = await fetch('/api/v1/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Something went wrong');
      }

      success = true;
      setTimeout(() => goto('/login'), 3000);
    } catch (err: any) {
      error = err.message;
    } finally {
      loading = false;
    }
  }
</script>

<svelte:head>
  <title>Reset Password - Arc Launchpad</title>
</svelte:head>

<div class="mb-8">
  <h1 class="text-3xl font-bold">Reset password</h1>
  <p class="mt-2 text-sm text-muted-foreground">Enter your new password below.</p>
</div>

{#if !token}
  <div class="rounded-md bg-destructive/10 p-4 text-sm text-destructive">
    Invalid reset link. Please <a href="/forgot-password" class="underline">request a new one</a>.
  </div>
{:else if success}
  <div class="rounded-md bg-green-500/10 p-4 text-sm text-green-600 dark:text-green-400">
    Your password has been reset. Redirecting to sign in...
  </div>
  <div class="mt-4">
    <a href="/login" class="text-sm text-primary hover:underline">Sign in now</a>
  </div>
{:else}
  {#if error}
    <div class="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
  {/if}

  <form on:submit|preventDefault={handleSubmit} class="space-y-4">
    <div>
      <label for="password" class="mb-1.5 block text-sm font-medium">New password</label>
      <div class="relative">
        {#if showPassword}
          <input
            id="password"
            type="text"
            bind:value={password}
            required
            autocomplete="new-password"
            class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 pr-16 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          />
        {:else}
          <input
            id="password"
            type="password"
            bind:value={password}
            required
            autocomplete="new-password"
            class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 pr-16 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          />
        {/if}
        <button
          type="button"
          on:click={() => showPassword = !showPassword}
          class="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground"
        >
          {showPassword ? 'hide' : 'show'}
        </button>
      </div>
      <p class="mt-1 text-xs text-muted-foreground">At least 8 characters, with an uppercase letter and a number or symbol.</p>
    </div>

    <div>
      <label for="confirm-password" class="mb-1.5 block text-sm font-medium">Confirm password</label>
      {#if showPassword}
        <input
          id="confirm-password"
          type="text"
          bind:value={confirmPassword}
          required
          autocomplete="new-password"
          class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        />
      {:else}
        <input
          id="confirm-password"
          type="password"
          bind:value={confirmPassword}
          required
          autocomplete="new-password"
          class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        />
      {/if}
    </div>

    <Button type="submit" class="w-full" disabled={loading}>
      {loading ? 'Resetting...' : 'Reset password'}
    </Button>
  </form>
{/if}
