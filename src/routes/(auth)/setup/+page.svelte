<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button } from '$lib/components/ui/button';
  import { Check } from 'lucide-svelte';
  import type { ActionData } from './$types';

  export let form: ActionData;

  let step = 1;
  let submitting = false;

  // All fields are bound so their values survive any re-render (notably the
  // "Send test" round-trip, which previously wiped unbound inputs).
  let firstName = '';
  let lastName = '';
  let email = '';
  let password = '';

  let provider: 'none' | 'smtp' | 'mailgun' = 'none';
  let from = '';
  let smtpHost = '';
  let smtpPort = 587;
  let smtpSecure = false;
  let smtpUser = '';
  let smtpPass = '';
  let mgDomain = '';
  let mgApiKey = '';
  let mgApiUrl = '';

  // Test email is a pure client-side call — it never submits the form, so the
  // entered data is preserved.
  let testTo = '';
  let testing = false;
  let testError = '';
  let testOk = false;

  function emailPayload() {
    if (provider === 'smtp') {
      return { provider, from, host: smtpHost, port: smtpPort, secure: smtpSecure, user: smtpUser, pass: smtpPass };
    }
    if (provider === 'mailgun') {
      return { provider, from, domain: mgDomain, apiKey: mgApiKey, apiUrl: mgApiUrl };
    }
    return { provider: 'none' };
  }

  async function sendTest() {
    testing = true;
    testError = '';
    testOk = false;
    try {
      const res = await fetch('/setup/test-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...emailPayload(), to: testTo }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Test failed');
      testOk = true;
    } catch (err: any) {
      testError = err.message;
    } finally {
      testing = false;
    }
  }

  // Shared input styling — matches the login/signup fields.
  const inputClass =
    'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';
</script>

<svelte:head>
  <title>Set up Arc Launchpad</title>
</svelte:head>

<div class="mb-8">
  <h1 class="text-3xl font-bold">
    {step === 1 ? 'Create your admin account' : 'Configure email'}
  </h1>
  <p class="mt-2 text-sm text-muted-foreground">
    {#if step === 1}
      Welcome to Arc Launchpad. This is a one-time setup — your first account becomes the administrator.
    {:else}
      Optional. Set this up so you can send invitations and notifications. You can change it later in Settings.
    {/if}
  </p>

  <!-- Step indicator -->
  <div class="mt-5 flex items-center gap-3">
    <div class="flex items-center gap-2">
      <span class="flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold {step >= 1 ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}">
        {#if step > 1}<Check class="h-3.5 w-3.5" />{:else}1{/if}
      </span>
      <span class="text-sm {step === 1 ? 'font-medium text-foreground' : 'text-muted-foreground'}">Account</span>
    </div>
    <div class="h-px w-8 bg-border"></div>
    <div class="flex items-center gap-2">
      <span class="flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold {step >= 2 ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}">2</span>
      <span class="text-sm {step === 2 ? 'font-medium text-foreground' : 'text-muted-foreground'}">Email</span>
    </div>
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
  <div class={step === 1 ? 'space-y-4' : 'hidden'}>
    <div class="grid grid-cols-2 gap-3">
      <div>
        <label for="first_name" class="mb-1.5 block text-sm font-medium">First name</label>
        <input id="first_name" name="first_name" bind:value={firstName} autocomplete="given-name" class={inputClass} />
      </div>
      <div>
        <label for="last_name" class="mb-1.5 block text-sm font-medium">Last name</label>
        <input id="last_name" name="last_name" bind:value={lastName} autocomplete="family-name" class={inputClass} />
      </div>
    </div>
    <div>
      <label for="email" class="mb-1.5 block text-sm font-medium">Email</label>
      <input id="email" name="email" type="email" required bind:value={email} autocomplete="email" class={inputClass} />
    </div>
    <div>
      <label for="password" class="mb-1.5 block text-sm font-medium">Password</label>
      <input id="password" name="password" type="password" required minlength="8" bind:value={password} autocomplete="new-password" class={inputClass} />
      <p class="mt-1.5 text-xs text-muted-foreground">At least 8 characters, with an uppercase letter and a number or symbol.</p>
    </div>
    <Button type="button" class="w-full" on:click={() => (step = 2)}>Continue</Button>
  </div>

  <!-- Step 2: email config -->
  <div class={step === 2 ? 'space-y-4' : 'hidden'}>
    <div>
      <label for="email_provider" class="mb-1.5 block text-sm font-medium">Email provider</label>
      <select id="email_provider" name="email_provider" bind:value={provider} class={inputClass}>
        <option value="none">None — skip for now (emails log to the console)</option>
        <option value="smtp">SMTP</option>
        <option value="mailgun">Mailgun</option>
      </select>
    </div>

    {#if provider !== 'none'}
      <div>
        <label for="from" class="mb-1.5 block text-sm font-medium">From address</label>
        <input id="from" name="from" bind:value={from} placeholder="Arc Launchpad <noreply@example.com>" class={inputClass} />
      </div>
    {/if}

    {#if provider === 'smtp'}
      <div class="grid grid-cols-3 gap-3">
        <div class="col-span-2">
          <label for="smtp_host" class="mb-1.5 block text-sm font-medium">Host</label>
          <input id="smtp_host" name="smtp_host" bind:value={smtpHost} placeholder="smtp.example.com" class={inputClass} />
        </div>
        <div>
          <label for="smtp_port" class="mb-1.5 block text-sm font-medium">Port</label>
          <input id="smtp_port" name="smtp_port" type="number" bind:value={smtpPort} class={inputClass} />
        </div>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label for="smtp_user" class="mb-1.5 block text-sm font-medium">Username</label>
          <input id="smtp_user" name="smtp_user" bind:value={smtpUser} autocomplete="off" class={inputClass} />
        </div>
        <div>
          <label for="smtp_pass" class="mb-1.5 block text-sm font-medium">Password</label>
          <input id="smtp_pass" name="smtp_pass" type="password" bind:value={smtpPass} autocomplete="off" class={inputClass} />
        </div>
      </div>
      <label class="flex items-center gap-2 text-sm">
        <input type="checkbox" name="smtp_secure" bind:checked={smtpSecure} class="h-4 w-4 rounded border-input accent-primary" />
        <span class="text-muted-foreground">Use TLS (port 465)</span>
      </label>
    {/if}

    {#if provider === 'mailgun'}
      <div>
        <label for="mg_domain" class="mb-1.5 block text-sm font-medium">Mailgun domain</label>
        <input id="mg_domain" name="mg_domain" bind:value={mgDomain} placeholder="mg.example.com" class={inputClass} />
      </div>
      <div>
        <label for="mg_api_key" class="mb-1.5 block text-sm font-medium">API key</label>
        <input id="mg_api_key" name="mg_api_key" type="password" bind:value={mgApiKey} autocomplete="off" class={inputClass} />
      </div>
      <div>
        <label for="mg_api_url" class="mb-1.5 block text-sm font-medium">API base URL</label>
        <input id="mg_api_url" name="mg_api_url" bind:value={mgApiUrl} placeholder="https://api.mailgun.net" class={inputClass} />
      </div>
    {/if}

    {#if provider !== 'none'}
      {#if testError}
        <div class="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{testError}</div>
      {/if}
      {#if testOk}
        <div class="flex items-center gap-1.5 rounded-md bg-green-500/10 p-3 text-sm text-green-600">
          <Check class="h-4 w-4" /> Test email sent — check the inbox.
        </div>
      {/if}
      <div class="flex items-end gap-2">
        <div class="flex-1">
          <label for="test_to" class="mb-1.5 block text-sm font-medium">Send a test to</label>
          <input id="test_to" type="email" bind:value={testTo} placeholder="you@example.com" class={inputClass} />
        </div>
        <Button type="button" variant="outline" disabled={testing || !testTo} on:click={sendTest}>
          {testing ? 'Sending…' : 'Send test'}
        </Button>
      </div>
    {/if}

    <div class="flex gap-2 pt-2">
      <Button type="button" variant="outline" on:click={() => (step = 1)}>Back</Button>
      <Button type="submit" class="flex-1" disabled={submitting}>
        {submitting ? 'Creating…' : 'Finish setup'}
      </Button>
    </div>
  </div>
</form>
