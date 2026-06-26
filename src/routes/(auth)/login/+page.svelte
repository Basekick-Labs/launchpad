<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { Button } from '$lib/components/ui/button';
  import { Separator } from '$lib/components/ui/separator';
  import { Eye, EyeOff, Key } from 'lucide-svelte';
  import { mfaVerify, webauthnAuthOptions, webauthnAuthVerify } from '$lib/cloudApi';
  import { startAuthentication } from '@simplewebauthn/browser';

  const inviteEmail = $page.url.searchParams.get('email') || '';
  const inviteOrg = $page.url.searchParams.get('org') || '';
  const queryRedirect = $page.url.searchParams.get('redirectTo');
  const defaultRedirect = queryRedirect || '/dashboard';

  let email = inviteEmail;
  let password = '';
  let showPassword = false;
  let error = '';
  let loading = false;

  // MFA state
  let mfaRequired = false;
  let mfaToken = '';
  let mfaCode = '';
  let useRecoveryCode = false;
  let mfaLoading = false;

  // Passkey state
  let passkeyLoading = false;

  // Handle OAuth / verification error redirects
  $: {
    const oauthError = $page.url.searchParams.get('error');
    if (oauthError === 'oauth_failed') error = 'Authentication failed. Please try again.';
    else if (oauthError === 'no_email') error = 'Could not retrieve a verified email address. Please try again.';
    else if (oauthError === 'invalid_token') error = 'Verification link is invalid. Please request a new one.';
    else if (oauthError === 'token_expired') error = 'Verification link has expired. Please request a new one.';
    else if (oauthError === 'invite_invalid') error = 'This invitation link is invalid.';
    else if (oauthError === 'invite_expired') error = 'This invitation has expired. Please ask for a new one.';
    else if (oauthError === 'invite_wrong_account') error = 'This invitation was sent to a different email address. Please sign in with the correct account.';
    else if (oauthError === 'account_suspended') error = 'This account has been suspended. Please contact support.';
    else if (oauthError === 'email_exists') error = 'An account with this email already exists. Please sign in with your password.';
  }

  async function handleSubmit() {
    error = '';
    loading = true;

    try {
      const res = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.requiresVerification) {
          goto(`/verify-email?email=${encodeURIComponent(data.email)}`);
          return;
        }
        throw new Error(data.error || 'Login failed');
      }
      if (data.requiresMfa) {
        mfaRequired = true;
        mfaToken = data.mfaToken;
        return;
      }
      // Prefer invite redirects from API, otherwise use the query param / hostname default
      const redirectTo = data.redirectTo?.startsWith('/invite/') ? data.redirectTo : defaultRedirect;
      window.location.href = redirectTo;
    } catch (err: any) {
      error = err.message;
    } finally {
      loading = false;
    }
  }

  async function handleMfaSubmit() {
    error = '';
    mfaLoading = true;
    try {
      const data = await mfaVerify(mfaToken, mfaCode, useRecoveryCode);
      // Prefer invite redirects from API, otherwise use the query param / hostname default
      const redirectTo = data.redirectTo?.startsWith('/invite/') ? data.redirectTo : defaultRedirect;
      window.location.href = redirectTo;
    } catch (err: any) {
      error = err.message;
    } finally {
      mfaLoading = false;
    }
  }

  function backToLogin() {
    mfaRequired = false;
    mfaToken = '';
    mfaCode = '';
    error = '';
    useRecoveryCode = false;
  }

  async function handlePasskeyLogin() {
    error = '';
    passkeyLoading = true;
    try {
      const { options, challengeId } = await webauthnAuthOptions();
      const credential = await startAuthentication({ optionsJSON: options });
      const data = await webauthnAuthVerify(challengeId, credential);
      // Prefer invite redirects from API, otherwise use the query param / hostname default
      const redirectTo = data.redirectTo?.startsWith('/invite/') ? data.redirectTo : defaultRedirect;
      window.location.href = redirectTo;
    } catch (err: any) {
      if (err.name === 'NotAllowedError') return; // User cancelled
      error = err.message || 'Passkey authentication failed';
    } finally {
      passkeyLoading = false;
    }
  }
</script>

<svelte:head>
  <title>Sign In - Arc Launchpad</title>
</svelte:head>

<div class="mb-8">
  <h1 class="text-3xl font-bold">Sign in</h1>
  {#if inviteOrg}
    <p class="mt-2 text-sm text-muted-foreground">
      Sign in to join <span class="font-medium text-foreground">{inviteOrg}</span>.
    </p>
  {/if}
</div>

{#if error}
  <div class="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
{/if}

{#if mfaRequired}
  <!-- MFA Verification Step -->
  <form on:submit|preventDefault={handleMfaSubmit} class="space-y-4">
    <p class="text-sm text-muted-foreground">
      {#if useRecoveryCode}
        Enter one of your recovery codes.
      {:else}
        Enter the 6-digit code from your authenticator app.
      {/if}
    </p>

    <div>
      <label for="mfa_code" class="mb-1.5 block text-sm font-medium">
        {useRecoveryCode ? 'Recovery code' : 'Authentication code'}
      </label>
      <input
        id="mfa_code"
        type="text"
        bind:value={mfaCode}
        required
        autocomplete="one-time-code"
        inputmode={useRecoveryCode ? 'text' : 'numeric'}
        pattern={useRecoveryCode ? undefined : '[0-9]*'}
        placeholder={useRecoveryCode ? 'xxxxx-xxxxx' : '000000'}
        maxlength={useRecoveryCode ? 11 : 6}
        class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono tracking-widest ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      />
    </div>

    <Button type="submit" class="w-full" disabled={mfaLoading}>
      {mfaLoading ? 'Verifying...' : 'Verify'}
    </Button>

    <div class="flex items-center justify-between text-xs">
      <button type="button" on:click={() => { useRecoveryCode = !useRecoveryCode; mfaCode = ''; error = ''; }} class="text-primary hover:underline">
        {useRecoveryCode ? 'Use authenticator code' : 'Use a recovery code'}
      </button>
      <button type="button" on:click={backToLogin} class="text-muted-foreground hover:text-foreground">
        Back to sign in
      </button>
    </div>
  </form>
{:else}
  <!-- Normal Login Form -->
  <form on:submit|preventDefault={handleSubmit} class="space-y-4">
    <div>
      <label for="email" class="mb-1.5 block text-sm font-medium">Email</label>
      <input
        id="email"
        type="email"
        bind:value={email}
        required
        readonly={!!inviteEmail}
        autocomplete="email"
        class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 {inviteEmail ? 'opacity-60' : ''}"
      />
    </div>

    <div>
      <div class="flex items-center justify-between mb-1.5">
        <label for="password" class="block text-sm font-medium">Password</label>
        <a href="/forgot-password" class="text-xs text-primary hover:underline">Forgot password?</a>
      </div>
      <div class="relative">
        {#if showPassword}
          <input
            id="password"
            type="text"
            bind:value={password}
            required
            autocomplete="current-password"
            class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 pr-16 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          />
        {:else}
          <input
            id="password"
            type="password"
            bind:value={password}
            required
            autocomplete="current-password"
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
    </div>

    <Button type="submit" class="w-full" disabled={loading}>
      {loading ? 'Signing in...' : 'Sign in'}
    </Button>
  </form>

  <div class="relative my-6">
    <Separator />
    <span class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-background px-3 text-xs uppercase text-muted-foreground">
      or
    </span>
  </div>

  <div class="space-y-3">
    <button
      on:click={handlePasskeyLogin}
      disabled={passkeyLoading}
      class="flex h-10 w-full items-center justify-center gap-2 rounded-md border border-input bg-background text-sm font-medium ring-offset-background hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
    >
      <Key class="h-4 w-4" />
      {passkeyLoading ? 'Authenticating...' : 'Sign in with passkey'}
    </button>
  </div>
{/if}
