<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button } from '$lib/components/ui/button';
  import type { ActionData } from './$types';

  export let form: ActionData;

  let step = 1;
  let provider: 'none' | 'smtp' | 'mailgun' = 'none';
  let submitting = false;
  let testing = false;

  // Carry-over field values so the email step keeps state across the test action.
  let email = '';
  let firstName = '';
  let lastName = '';
</script>

<svelte:head>
  <title>Set up Arc Launchpad</title>
</svelte:head>

<div class="mb-8">
  <h1 class="text-3xl font-bold">Welcome to Arc Launchpad</h1>
  <p class="mt-2 text-sm text-muted-foreground">
    {#if step === 1}
      Let's create your administrator account. This is a one-time setup.
    {:else}
      Optionally configure email so you can send invitations and notifications.
    {/if}
  </p>
  <div class="mt-4 flex gap-2 text-xs text-muted-foreground">
    <span class={step === 1 ? 'font-semibold text-foreground' : ''}>1. Admin account</span>
    <span>→</span>
    <span class={step === 2 ? 'font-semibold text-foreground' : ''}>2. Email (optional)</span>
  </div>
</div>

{#if form?.error}
  <div class="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">{form.error}</div>
{/if}

<!-- Single form spanning both steps; step 1 fields stay in the DOM (hidden) so
     they submit with the final "complete" action. -->
<form
  method="POST"
  action="?/complete"
  use:enhance={() => {
    submitting = true;
    return async ({ update }) => {
      await update();
      submitting = false;
    };
  }}
  class="space-y-4"
>
  <!-- Step 1: admin account -->
  <div class={step === 1 ? '' : 'hidden'}>
    <div class="grid grid-cols-2 gap-3">
      <div>
        <label for="first_name" class="mb-1.5 block text-sm font-medium">First name</label>
        <input id="first_name" name="first_name" bind:value={firstName}
          class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
      </div>
      <div>
        <label for="last_name" class="mb-1.5 block text-sm font-medium">Last name</label>
        <input id="last_name" name="last_name" bind:value={lastName}
          class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
      </div>
    </div>
    <div class="mt-4">
      <label for="email" class="mb-1.5 block text-sm font-medium">Email</label>
      <input id="email" name="email" type="email" required bind:value={email}
        class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
    </div>
    <div class="mt-4">
      <label for="password" class="mb-1.5 block text-sm font-medium">Password</label>
      <input id="password" name="password" type="password" required minlength="8"
        class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
      <p class="mt-1 text-xs text-muted-foreground">At least 8 characters, with an uppercase letter and a number or symbol.</p>
    </div>
    <Button type="button" class="mt-6 w-full" on:click={() => (step = 2)}>Continue</Button>
  </div>

  <!-- Step 2: email config (also rendered hidden in step 1 so values submit) -->
  <div class={step === 2 ? '' : 'hidden'}>
    <div>
      <label for="email_provider" class="mb-1.5 block text-sm font-medium">Email provider</label>
      <select id="email_provider" name="email_provider" bind:value={provider}
        class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
        <option value="none">None (skip — emails are logged to the server console)</option>
        <option value="smtp">SMTP</option>
        <option value="mailgun">Mailgun</option>
      </select>
    </div>

    {#if provider !== 'none'}
      <div class="mt-4">
        <label for="from" class="mb-1.5 block text-sm font-medium">From address</label>
        <input id="from" name="from" placeholder="Arc Launchpad <noreply@example.com>"
          class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
      </div>
    {/if}

    {#if provider === 'smtp'}
      <div class="mt-4 grid grid-cols-3 gap-3">
        <div class="col-span-2">
          <label for="smtp_host" class="mb-1.5 block text-sm font-medium">Host</label>
          <input id="smtp_host" name="smtp_host" placeholder="smtp.example.com"
            class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
        </div>
        <div>
          <label for="smtp_port" class="mb-1.5 block text-sm font-medium">Port</label>
          <input id="smtp_port" name="smtp_port" type="number" value="587"
            class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
        </div>
      </div>
      <div class="mt-4 grid grid-cols-2 gap-3">
        <div>
          <label for="smtp_user" class="mb-1.5 block text-sm font-medium">Username</label>
          <input id="smtp_user" name="smtp_user"
            class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
        </div>
        <div>
          <label for="smtp_pass" class="mb-1.5 block text-sm font-medium">Password</label>
          <input id="smtp_pass" name="smtp_pass" type="password"
            class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
        </div>
      </div>
      <label class="mt-4 flex items-center gap-2 text-sm">
        <input type="checkbox" name="smtp_secure" class="h-4 w-4 rounded border-input accent-primary" />
        <span class="text-muted-foreground">Use TLS (port 465)</span>
      </label>
    {/if}

    {#if provider === 'mailgun'}
      <div class="mt-4">
        <label for="mg_domain" class="mb-1.5 block text-sm font-medium">Mailgun domain</label>
        <input id="mg_domain" name="mg_domain" placeholder="mg.example.com"
          class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
      </div>
      <div class="mt-4">
        <label for="mg_api_key" class="mb-1.5 block text-sm font-medium">API key</label>
        <input id="mg_api_key" name="mg_api_key" type="password"
          class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
      </div>
      <div class="mt-4">
        <label for="mg_api_url" class="mb-1.5 block text-sm font-medium">API base URL</label>
        <input id="mg_api_url" name="mg_api_url" placeholder="https://api.mailgun.net"
          class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
      </div>
    {/if}

    {#if provider !== 'none'}
      {#if form?.emailError}
        <div class="mt-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">{form.emailError}</div>
      {/if}
      {#if form?.emailTested}
        <div class="mt-4 rounded-md bg-green-500/10 p-3 text-sm text-green-600">Test email sent — check the inbox.</div>
      {/if}
      <div class="mt-4 flex items-end gap-2">
        <div class="flex-1">
          <label for="test_to" class="mb-1.5 block text-sm font-medium">Send a test to</label>
          <input id="test_to" name="test_to" type="email" placeholder="you@example.com"
            class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
        </div>
        <button type="submit" formaction="?/testEmail" disabled={testing}
          class="inline-flex h-10 items-center justify-center rounded-md border border-input bg-background px-4 text-sm font-medium hover:bg-accent disabled:opacity-50">
          {testing ? 'Sending…' : 'Send test'}
        </button>
      </div>
    {/if}

    <div class="mt-6 flex gap-2">
      <Button type="button" variant="outline" on:click={() => (step = 1)}>Back</Button>
      <Button type="submit" class="flex-1" disabled={submitting}>
        {submitting ? 'Creating…' : 'Finish setup'}
      </Button>
    </div>
  </div>
</form>
