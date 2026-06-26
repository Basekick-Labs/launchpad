<script lang="ts">
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { Button } from '$lib/components/ui/button';
  import { Zap } from 'lucide-svelte';

  $: email = $page.url.searchParams.get('email') || '';

  let resending = false;
  let resendDone = false;
  let resendError = '';

  async function resendEmail() {
    resending = true;
    resendError = '';
    try {
      const res = await fetch('/api/v1/auth/resend-verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (res.ok) {
        resendDone = true;
      } else {
        resendError = 'Failed to resend. Please try again.';
      }
    } catch {
      resendError = 'Failed to resend. Please try again.';
    } finally {
      resending = false;
    }
  }

  async function signOut() {
    await fetch('/api/v1/auth/logout', { method: 'POST' });
    goto('/login');
  }
</script>

<div class="flex min-h-screen flex-col items-center justify-center bg-background p-4">
  <div class="w-full max-w-sm rounded-xl border bg-card p-8 text-center shadow-lg">
    <!-- Logo -->
    <div class="mb-6 flex justify-center">
      <div class="flex items-center justify-center rounded-full bg-primary/10 p-3">
        <Zap class="h-8 w-8 text-primary" />
      </div>
    </div>

    <h1 class="text-xl font-bold">Please verify your email</h1>

    <p class="mt-3 text-sm text-muted-foreground">
      We just sent an email to <span class="font-semibold text-foreground">{email}</span>.
      Click the link in the email to verify your account.
    </p>

    {#if resendDone}
      <p class="mt-4 text-sm text-primary">Email resent! Check your inbox.</p>
    {:else if resendError}
      <p class="mt-4 text-sm text-destructive">{resendError}</p>
    {/if}

    <div class="mt-6 flex gap-3">
      <Button variant="outline" class="flex-1" on:click={resendEmail} disabled={resending || resendDone}>
        {resending ? 'Sending...' : 'Resend email'}
      </Button>
      <Button variant="ghost" class="flex-1" on:click={signOut}>
        Sign out
      </Button>
    </div>
  </div>
</div>
