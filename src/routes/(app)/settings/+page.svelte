<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { updateProfile, updateOrg, mfaSetup, mfaSetupConfirm, mfaDisable, mfaRegenerateRecoveryCodes, webauthnRegisterOptions, webauthnRegisterVerify, webauthnDeleteCredential } from '$lib/cloudApi';
  import { startRegistration } from '@simplewebauthn/browser';
  import { Button } from '$lib/components/ui/button';
  import ThemeToggle from '$lib/components/ThemeToggle.svelte';
  import { timezone, formatDateTime } from '$lib/stores/timezone';
  import { Check, Shield, Key, Trash2, Copy, Download, Globe } from 'lucide-svelte';
  import { toast } from 'svelte-sonner';

  export let data: any;

  // Profile form
  let firstName = data.user.first_name || '';
  let lastName = data.user.last_name || '';
  let email = data.user.email;
  let profileLoading = false;
  let profileSuccess = false;
  let profileError = '';
  let emailVerificationSent = false;

  // Org form
  $: org = data.activeOrg;
  let orgName = data.activeOrg?.name || '';
  let orgLoading = false;
  let orgSuccess = false;
  let orgError = '';

  // Email settings (admin only)
  let emailCfg: any = { provider: 'none' };
  let emailFrom = '';
  let smtpHost = '', smtpPort = 587, smtpSecure = false, smtpUser = '', smtpPass = '';
  let mgDomain = '', mgApiKey = '', mgApiUrl = '';
  let emailLoading = false, emailSaved = false, emailError = '';
  let emailTestTo = '', emailTesting = false, emailTestOk = false;

  async function loadEmailConfig() {
    if (!data.user.is_operator) return;
    const res = await fetch('/api/v1/admin/email');
    if (!res.ok) return;
    const { email: e } = await res.json();
    emailCfg = e;
    emailFrom = e.from || '';
    if (e.provider === 'smtp') {
      smtpHost = e.host || ''; smtpPort = e.port || 587; smtpSecure = !!e.secure; smtpUser = e.user || '';
    } else if (e.provider === 'mailgun') {
      mgDomain = e.domain || ''; mgApiUrl = e.apiUrl || '';
    }
  }
  loadEmailConfig();

  function emailPayload() {
    if (emailCfg.provider === 'smtp') {
      return { provider: 'smtp', from: emailFrom, host: smtpHost, port: smtpPort, secure: smtpSecure, user: smtpUser, pass: smtpPass || undefined };
    }
    if (emailCfg.provider === 'mailgun') {
      return { provider: 'mailgun', from: emailFrom, domain: mgDomain, apiKey: mgApiKey || undefined, apiUrl: mgApiUrl || undefined };
    }
    return { provider: 'none' };
  }

  async function saveEmail() {
    emailLoading = true; emailError = ''; emailSaved = false;
    try {
      const res = await fetch('/api/v1/admin/email', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(emailPayload()) });
      if (!res.ok) throw new Error((await res.json()).error || 'Save failed');
      emailSaved = true; mgApiKey = ''; smtpPass = '';
      setTimeout(() => (emailSaved = false), 2500);
    } catch (err: any) { emailError = err.message; }
    finally { emailLoading = false; }
  }

  async function testEmail() {
    emailTesting = true; emailError = ''; emailTestOk = false;
    try {
      const res = await fetch('/api/v1/admin/email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...emailPayload(), to: emailTestTo }) });
      if (!res.ok) throw new Error((await res.json()).error || 'Test failed');
      emailTestOk = true;
    } catch (err: any) { emailError = err.message; }
    finally { emailTesting = false; }
  }

  // MFA state
  let mfaSetupData: { qrDataUri: string; secret: string; challengeId: string } | null = null;
  let mfaCode = '';
  let mfaLoading = false;
  let recoveryCodes: string[] | null = null;
  let mfaDisableCode = '';
  let mfaDisableLoading = false;
  let mfaRegenCode = '';
  let mfaRegenLoading = false;

  // Passkey state
  let passkeyName = '';
  let passkeyLoading = false;

  async function startMfaSetup() {
    mfaLoading = true;
    try {
      mfaSetupData = await mfaSetup();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      mfaLoading = false;
    }
  }

  async function confirmMfaSetup() {
    if (!mfaSetupData || !mfaCode) return;
    mfaLoading = true;
    try {
      const result = await mfaSetupConfirm(mfaSetupData.challengeId, mfaCode);
      recoveryCodes = result.recoveryCodes;
      mfaSetupData = null;
      mfaCode = '';
      toast.success('Two-factor authentication enabled');
      await invalidateAll();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      mfaLoading = false;
    }
  }

  async function handleMfaDisable() {
    if (!mfaDisableCode) return;
    mfaDisableLoading = true;
    try {
      await mfaDisable(mfaDisableCode);
      mfaDisableCode = '';
      toast.success('Two-factor authentication disabled');
      await invalidateAll();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      mfaDisableLoading = false;
    }
  }

  async function handleRegenCodes() {
    if (!mfaRegenCode) return;
    mfaRegenLoading = true;
    try {
      const result = await mfaRegenerateRecoveryCodes(mfaRegenCode);
      recoveryCodes = result.recoveryCodes;
      mfaRegenCode = '';
      toast.success('Recovery codes regenerated');
      await invalidateAll();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      mfaRegenLoading = false;
    }
  }

  function copyRecoveryCodes() {
    if (!recoveryCodes) return;
    navigator.clipboard.writeText(recoveryCodes.join('\n'));
    toast.success('Recovery codes copied to clipboard');
  }

  function downloadRecoveryCodes() {
    if (!recoveryCodes) return;
    const blob = new Blob([recoveryCodes.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'launchpad-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  }

  function dismissRecoveryCodes() {
    recoveryCodes = null;
  }

  async function addPasskey() {
    passkeyLoading = true;
    try {
      const { options, challengeId } = await webauthnRegisterOptions();
      const credential = await startRegistration({ optionsJSON: options });
      await webauthnRegisterVerify(challengeId, credential, passkeyName || undefined);
      passkeyName = '';
      toast.success('Passkey added');
      await invalidateAll();
    } catch (err: any) {
      if (err.name === 'NotAllowedError') return; // User cancelled
      toast.error(err.message || 'Failed to add passkey');
    } finally {
      passkeyLoading = false;
    }
  }

  async function deletePasskey(id: string, name: string) {
    if (!confirm(`Delete passkey "${name}"?`)) return;
    try {
      await webauthnDeleteCredential(id);
      toast.success('Passkey deleted');
      await invalidateAll();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  async function saveProfile() {
    profileError = '';
    profileSuccess = false;
    profileLoading = true;
    try {
      const result = await updateProfile({ first_name: firstName, last_name: lastName, email });
      profileSuccess = true;
      emailVerificationSent = !!result.emailVerificationSent;
      await invalidateAll();
      setTimeout(() => profileSuccess = false, 3000);
    } catch (err: any) {
      profileError = err.message;
    } finally {
      profileLoading = false;
    }
  }

  async function saveOrg() {
    if (!org) return;
    orgError = '';
    orgSuccess = false;
    orgLoading = true;
    try {
      await updateOrg(org.id, {
        name: orgName,
      });
      orgSuccess = true;
      await invalidateAll();
      setTimeout(() => orgSuccess = false, 2000);
    } catch (err: any) {
      orgError = err.message;
    } finally {
      orgLoading = false;
    }
  }
</script>

<div class="p-6">
  <div class="mb-6">
    <h1 class="text-2xl font-bold">Settings</h1>
    <p class="text-sm text-muted-foreground">Manage your profile and organization</p>
  </div>

  <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
    <!-- Left column: Profile + Appearance -->
    <div class="space-y-6">
      <form on:submit|preventDefault={saveProfile} class="rounded-lg border bg-card p-5">
        <h2 class="mb-4 font-semibold">Profile</h2>
        {#if profileError}
          <div class="mb-3 rounded-md bg-destructive/10 p-2 text-sm text-destructive">{profileError}</div>
        {/if}
        <div class="space-y-3">
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label for="first_name" class="mb-1 block text-xs text-muted-foreground">First name</label>
              <input
                id="first_name"
                type="text"
                bind:value={firstName}
                class="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
            <div>
              <label for="last_name" class="mb-1 block text-xs text-muted-foreground">Last name</label>
              <input
                id="last_name"
                type="text"
                bind:value={lastName}
                class="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
          </div>
          <div>
            <label for="email" class="mb-1 block text-xs text-muted-foreground">Email</label>
            <input
              id="email"
              type="email"
              bind:value={email}
              required
              class="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
        </div>
        <div class="mt-4 flex items-center gap-2">
          <Button type="submit" size="sm" disabled={profileLoading}>
            {profileLoading ? 'Saving...' : 'Save profile'}
          </Button>
          {#if profileSuccess}
            <span class="flex items-center gap-1 text-xs text-green-500"><Check class="h-3 w-3" /> Saved</span>
          {/if}
        </div>
        {#if emailVerificationSent}
          <div class="mt-3 rounded-md bg-yellow-500/10 px-3 py-2 text-xs text-yellow-600">
            A verification email has been sent to <span class="font-medium">{email}</span>. Please check your inbox to confirm the new address.
          </div>
        {/if}
      </form>

      <div class="rounded-lg border bg-card p-5">
        <h2 class="mb-3 font-semibold">Preferences</h2>
        <div class="space-y-4">
          <div>
            <label class="mb-1 block text-sm text-muted-foreground">Theme</label>
            <ThemeToggle />
          </div>
          <div>
            <label class="mb-1 block text-sm text-muted-foreground">Timezone</label>
            <div class="flex items-center gap-3">
              <button
                class="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors {$timezone === 'utc' ? 'bg-accent text-accent-foreground border-accent' : 'text-muted-foreground hover:bg-muted'}"
                on:click={() => timezone.set('utc')}
              >
                <Globe class="h-3.5 w-3.5" />
                UTC
              </button>
              <button
                class="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors {$timezone === 'local' ? 'bg-accent text-accent-foreground border-accent' : 'text-muted-foreground hover:bg-muted'}"
                on:click={() => timezone.set('local')}
              >
                <Globe class="h-3.5 w-3.5" />
                Local
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Security: MFA -->
      <div class="rounded-lg border bg-card p-5">
        <h2 class="mb-4 font-semibold flex items-center gap-2"><Shield class="h-4 w-4" /> Security</h2>

        <!-- Recovery codes display (shown after setup or regeneration) -->
        {#if recoveryCodes}
          <div class="rounded-md border border-yellow-500/30 bg-yellow-500/10 p-4 mb-4">
            <p class="text-sm font-medium text-yellow-700 dark:text-yellow-300 mb-2">Save your recovery codes</p>
            <p class="text-xs text-muted-foreground mb-3">Store these codes in a safe place. Each code can only be used once.</p>
            <div class="grid grid-cols-2 gap-1 mb-3 rounded-md bg-background p-3 font-mono text-sm">
              {#each recoveryCodes as code}
                <div>{code}</div>
              {/each}
            </div>
            <div class="flex gap-2">
              <button
                on:click={copyRecoveryCodes}
                class="inline-flex items-center gap-1 rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted"
              >
                <Copy class="h-3 w-3" /> Copy
              </button>
              <button
                on:click={downloadRecoveryCodes}
                class="inline-flex items-center gap-1 rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted"
              >
                <Download class="h-3 w-3" /> Download
              </button>
              <button
                on:click={dismissRecoveryCodes}
                class="inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                I've saved them
              </button>
            </div>
          </div>
        {/if}

        <!-- TOTP MFA -->
        <h3 class="text-sm font-medium mb-2">Two-factor authentication</h3>

        {#if data.mfaEnabled}
          <div class="mb-3">
            <span class="inline-flex items-center rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300">
              Enabled
            </span>
            {#if data.mfaEnabledAt}
              <span class="ml-2 text-xs text-muted-foreground">since {formatDateTime(data.mfaEnabledAt, $timezone)}</span>
            {/if}
            <p class="mt-1 text-xs text-muted-foreground">{data.recoveryCodesRemaining} recovery code{data.recoveryCodesRemaining !== 1 ? 's' : ''} remaining</p>
          </div>
          <div class="flex flex-wrap gap-2">
            <div class="flex items-center gap-2">
              <input
                type="text"
                bind:value={mfaDisableCode}
                placeholder="Enter TOTP code"
                maxlength="6"
                class="h-8 w-28 rounded-md border border-input bg-background px-2 text-sm font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <Button size="sm" variant="destructive" on:click={handleMfaDisable} disabled={mfaDisableLoading || !mfaDisableCode}>
                {mfaDisableLoading ? 'Disabling...' : 'Disable'}
              </Button>
            </div>
            <div class="flex items-center gap-2">
              <input
                type="text"
                bind:value={mfaRegenCode}
                placeholder="TOTP code"
                maxlength="6"
                class="h-8 w-28 rounded-md border border-input bg-background px-2 text-sm font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <Button size="sm" variant="outline" on:click={handleRegenCodes} disabled={mfaRegenLoading || !mfaRegenCode}>
                {mfaRegenLoading ? 'Regenerating...' : 'Regenerate codes'}
              </Button>
            </div>
          </div>
        {:else if mfaSetupData}
          <!-- MFA Setup flow -->
          <div class="space-y-3">
            <p class="text-xs text-muted-foreground">Scan this QR code with your authenticator app (Google Authenticator, 1Password, Authy, etc.)</p>
            <div class="flex justify-center">
              <img src={mfaSetupData.qrDataUri} alt="TOTP QR Code" class="h-48 w-48 rounded-lg" />
            </div>
            <div>
              <p class="text-xs text-muted-foreground mb-1">Or enter this code manually:</p>
              <code class="block rounded-md bg-muted px-3 py-2 text-xs font-mono select-all break-all">{mfaSetupData.secret}</code>
            </div>
            <div>
              <label for="mfa_code" class="mb-1 block text-xs text-muted-foreground">Enter the 6-digit code from your app</label>
              <div class="flex items-center gap-2">
                <input
                  id="mfa_code"
                  type="text"
                  bind:value={mfaCode}
                  placeholder="000000"
                  maxlength="6"
                  autocomplete="one-time-code"
                  class="h-9 w-32 rounded-md border border-input bg-background px-3 text-sm font-mono tracking-widest focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <Button size="sm" on:click={confirmMfaSetup} disabled={mfaLoading || mfaCode.length < 6}>
                  {mfaLoading ? 'Verifying...' : 'Verify & Enable'}
                </Button>
              </div>
            </div>
            <button
              on:click={() => { mfaSetupData = null; mfaCode = ''; }}
              class="text-xs text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        {:else}
          <p class="text-xs text-muted-foreground mb-3">Add an extra layer of security to your account using a TOTP authenticator app.</p>
          <Button size="sm" variant="outline" on:click={startMfaSetup} disabled={mfaLoading}>
            {mfaLoading ? 'Setting up...' : 'Enable two-factor authentication'}
          </Button>
        {/if}

        <!-- Passkeys -->
        <div class="mt-6 border-t pt-4">
          <h3 class="text-sm font-medium mb-2 flex items-center gap-2"><Key class="h-3.5 w-3.5" /> Passkeys</h3>
          <p class="text-xs text-muted-foreground mb-3">Sign in with Touch ID, Face ID, or a security key. Passkeys replace passwords and skip two-factor authentication.</p>

          {#if data.passkeys.length > 0}
            <div class="space-y-2 mb-3">
              {#each data.passkeys as passkey}
                <div class="flex items-center justify-between rounded-md border px-3 py-2">
                  <div>
                    <p class="text-sm font-medium">{passkey.name}</p>
                    <p class="text-xs text-muted-foreground">Added {formatDateTime(passkey.created_at, $timezone)}</p>
                  </div>
                  <button
                    on:click={() => deletePasskey(passkey.id, passkey.name)}
                    class="rounded p-1 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                    title="Delete passkey"
                  >
                    <Trash2 class="h-4 w-4" />
                  </button>
                </div>
              {/each}
            </div>
          {/if}

          <div class="flex items-center gap-2">
            <input
              type="text"
              bind:value={passkeyName}
              placeholder="Passkey name (optional)"
              class="h-8 flex-1 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <Button size="sm" variant="outline" on:click={addPasskey} disabled={passkeyLoading}>
              {passkeyLoading ? 'Adding...' : 'Add a passkey'}
            </Button>
          </div>
        </div>
      </div>
    </div>

    <!-- Right column: Organization -->
    {#if org}
      <form on:submit|preventDefault={saveOrg} class="rounded-lg border bg-card p-5 h-fit">
        <h2 class="mb-4 font-semibold">Organization</h2>
        {#if orgError}
          <div class="mb-3 rounded-md bg-destructive/10 p-2 text-sm text-destructive">{orgError}</div>
        {/if}
        <div class="space-y-3">
          <div>
            <label for="org_name" class="mb-1 block text-xs text-muted-foreground">Organization name</label>
            <input
              id="org_name"
              type="text"
              bind:value={orgName}
              required
              class="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
        </div>

        <div class="mt-4 flex items-center gap-2">
          <Button type="submit" size="sm" disabled={orgLoading}>
            {orgLoading ? 'Saving...' : 'Save organization'}
          </Button>
          {#if orgSuccess}
            <span class="flex items-center gap-1 text-xs text-green-500"><Check class="h-3 w-3" /> Saved</span>
          {/if}
        </div>
      </form>
    {/if}

    {#if data.user.is_operator}
      <!-- Email (admin only) -->
      <div class="mt-6 rounded-lg border bg-card p-6">
        <h2 class="mb-1 font-semibold">Email</h2>
        <p class="mb-4 text-xs text-muted-foreground">
          Used for invitations and notifications. With no provider, emails are logged to the server console.
        </p>

        {#if emailError}
          <div class="mb-3 rounded-md bg-destructive/10 p-2 text-sm text-destructive">{emailError}</div>
        {/if}

        <div class="space-y-3">
          <div>
            <label for="email_provider" class="mb-1 block text-xs text-muted-foreground">Provider</label>
            <select id="email_provider" bind:value={emailCfg.provider}
              class="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
              <option value="none">None</option>
              <option value="smtp">SMTP</option>
              <option value="mailgun">Mailgun</option>
            </select>
          </div>

          {#if emailCfg.provider !== 'none'}
            <div>
              <label for="email_from" class="mb-1 block text-xs text-muted-foreground">From address</label>
              <input id="email_from" bind:value={emailFrom} placeholder="Arc Launchpad <noreply@example.com>"
                class="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm" />
            </div>
          {/if}

          {#if emailCfg.provider === 'smtp'}
            <div class="grid grid-cols-3 gap-2">
              <div class="col-span-2">
                <label for="smtp_host" class="mb-1 block text-xs text-muted-foreground">Host</label>
                <input id="smtp_host" bind:value={smtpHost} class="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm" />
              </div>
              <div>
                <label for="smtp_port" class="mb-1 block text-xs text-muted-foreground">Port</label>
                <input id="smtp_port" type="number" bind:value={smtpPort} class="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm" />
              </div>
            </div>
            <div class="grid grid-cols-2 gap-2">
              <div>
                <label for="smtp_user" class="mb-1 block text-xs text-muted-foreground">Username</label>
                <input id="smtp_user" bind:value={smtpUser} class="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm" />
              </div>
              <div>
                <label for="smtp_pass" class="mb-1 block text-xs text-muted-foreground">Password {#if emailCfg.passSet}<span class="text-muted-foreground">(set — leave blank to keep)</span>{/if}</label>
                <input id="smtp_pass" type="password" bind:value={smtpPass} class="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm" />
              </div>
            </div>
            <label class="flex items-center gap-2 text-sm">
              <input type="checkbox" bind:checked={smtpSecure} class="h-4 w-4 rounded border-input accent-primary" />
              <span class="text-muted-foreground">Use TLS (port 465)</span>
            </label>
          {/if}

          {#if emailCfg.provider === 'mailgun'}
            <div>
              <label for="mg_domain" class="mb-1 block text-xs text-muted-foreground">Domain</label>
              <input id="mg_domain" bind:value={mgDomain} class="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm" />
            </div>
            <div>
              <label for="mg_api_key" class="mb-1 block text-xs text-muted-foreground">API key {#if emailCfg.apiKeySet}<span class="text-muted-foreground">(set — leave blank to keep)</span>{/if}</label>
              <input id="mg_api_key" type="password" bind:value={mgApiKey} class="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm" />
            </div>
            <div>
              <label for="mg_api_url" class="mb-1 block text-xs text-muted-foreground">API base URL</label>
              <input id="mg_api_url" bind:value={mgApiUrl} placeholder="https://api.mailgun.net" class="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm" />
            </div>
          {/if}

          <div class="flex items-center gap-2 pt-1">
            <Button size="sm" on:click={saveEmail} disabled={emailLoading}>
              {emailLoading ? 'Saving...' : 'Save'}
            </Button>
            {#if emailSaved}
              <span class="flex items-center gap-1 text-xs text-green-500"><Check class="h-3 w-3" /> Saved</span>
            {/if}
          </div>

          {#if emailCfg.provider !== 'none'}
            <div class="flex items-end gap-2 border-t pt-3">
              <div class="flex-1">
                <label for="email_test_to" class="mb-1 block text-xs text-muted-foreground">Send a test to</label>
                <input id="email_test_to" type="email" bind:value={emailTestTo} placeholder="you@example.com"
                  class="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm" />
              </div>
              <Button size="sm" variant="outline" on:click={testEmail} disabled={emailTesting || !emailTestTo}>
                {emailTesting ? 'Sending...' : 'Send test'}
              </Button>
            </div>
            {#if emailTestOk}
              <span class="flex items-center gap-1 text-xs text-green-500"><Check class="h-3 w-3" /> Test sent</span>
            {/if}
          {/if}
        </div>
      </div>
    {/if}
  </div>
</div>
