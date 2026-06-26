<script lang="ts">
  import { Button } from '$lib/components/ui/button';

  let email = '';
  let error = '';
  let loading = false;
  let submitted = false;

  async function handleSubmit() {
    error = '';
    loading = true;

    try {
      const res = await fetch('/api/v1/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Something went wrong');
      }

      submitted = true;
    } catch (err: any) {
      error = err.message;
    } finally {
      loading = false;
    }
  }
</script>

<svelte:head>
  <title>Forgot Password - Arc Launchpad</title>
</svelte:head>

<div class="mb-8">
  <h1 class="text-3xl font-bold">Forgot password</h1>
  <p class="mt-2 text-sm text-muted-foreground">
    Remember your password? <a href="/login" class="text-primary hover:underline">Sign in</a>.
  </p>
</div>

{#if submitted}
  <div class="rounded-md bg-green-500/10 p-4 text-sm text-green-600 dark:text-green-400">
    If an account exists with that email, we've sent a reset link. Please check your inbox.
  </div>
  <div class="mt-4">
    <a href="/login" class="text-sm text-primary hover:underline">Back to sign in</a>
  </div>
{:else}
  {#if error}
    <div class="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
  {/if}

  <form on:submit|preventDefault={handleSubmit} class="space-y-4">
    <div>
      <label for="email" class="mb-1.5 block text-sm font-medium">Email</label>
      <input
        id="email"
        type="email"
        bind:value={email}
        required
        autocomplete="email"
        class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      />
    </div>

    <Button type="submit" class="w-full" disabled={loading}>
      {loading ? 'Sending...' : 'Send reset link'}
    </Button>
  </form>
{/if}
