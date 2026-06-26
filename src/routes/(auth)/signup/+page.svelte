<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { onMount } from 'svelte';
  import { signup } from '$lib/cloudApi';
  import { Button } from '$lib/components/ui/button';
  import { Eye, EyeOff } from 'lucide-svelte';
  import { env } from '$env/dynamic/public';

  const inviteEmail = $page.url.searchParams.get('email') || '';
  const inviteOrg = $page.url.searchParams.get('org') || '';
  const turnstileSiteKey = env.PUBLIC_TURNSTILE_SITE_KEY || '';

  let email = inviteEmail;
  let password = '';
  let confirmPassword = '';
  let showPassword = false;
  let showConfirm = false;
  let tosAgreed = false;
  let error = '';
  let loading = false;
  let captchaToken = '';
  let captchaWidgetId: string | null = null;
  let captchaContainer: HTMLDivElement;

  onMount(() => {
    if (!turnstileSiteKey) return;
    // Load Turnstile script if not already present
    if (!document.querySelector('script[src*="turnstile"]')) {
      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.onload = renderWidget;
      document.head.appendChild(script);
    } else {
      renderWidget();
    }
  });

  function renderWidget() {
    if (!captchaContainer || !turnstileSiteKey) return;
    const w = (window as any).turnstile;
    if (!w) return;
    captchaWidgetId = w.render(captchaContainer, {
      sitekey: turnstileSiteKey,
      callback: (token: string) => { captchaToken = token; },
      'expired-callback': () => { captchaToken = ''; },
      'error-callback': () => { captchaToken = ''; },
      theme: 'auto',
    });
  }

  function resetCaptcha() {
    captchaToken = '';
    if (captchaWidgetId !== null) {
      (window as any).turnstile?.reset(captchaWidgetId);
    }
  }

  type Strength = { label: string; color: string; width: string } | null;

  // Only penalize if 6+ consecutive sequential chars (e.g. "123456", "abcdef")
  function longestSequentialRun(p: string): number {
    const s = p.toLowerCase();
    let max = 1, run = 1;
    for (let i = 1; i < s.length; i++) {
      const diff = s.charCodeAt(i) - s.charCodeAt(i - 1);
      run = (diff === 1 || diff === -1) ? run + 1 : 1;
      if (run > max) max = run;
    }
    return max;
  }

  function passwordStrength(p: string): Strength {
    if (!p) return null;
    if (p.length < 8) return { label: 'Too short', color: 'bg-destructive', width: 'w-1/4' };

    const hasUpper = /[A-Z]/.test(p);
    const hasLower = /[a-z]/.test(p);
    const hasNumber = /[0-9]/.test(p);
    const hasSymbol = /[!@#$%^&*()_\-+=\[\]{};':"\\|,.<>\/?]/.test(p);
    const long = p.length >= 12;
    const veryLong = p.length >= 20;
    const purelySequential = longestSequentialRun(p) >= 6;

    if (purelySequential) return { label: 'Weak', color: 'bg-orange-500', width: 'w-1/4' };

    const variety = [hasUpper, hasLower, hasNumber, hasSymbol].filter(Boolean).length;

    if (variety < 2) return { label: 'Weak', color: 'bg-orange-500', width: 'w-1/4' };
    if (variety === 2 && !long) return { label: 'Fair', color: 'bg-yellow-500', width: 'w-2/4' };
    if ((variety === 2 && long) || (variety === 3 && !long)) return { label: 'Good', color: 'bg-blue-500', width: 'w-3/4' };
    if (variety >= 3 && long || veryLong) return { label: 'Strong', color: 'bg-green-500', width: 'w-full' };
    return { label: 'Good', color: 'bg-blue-500', width: 'w-3/4' };
  }

  $: strength = passwordStrength(password);
  $: isStrong = strength?.label === 'Good' || strength?.label === 'Strong';

  async function handleSubmit() {
    error = '';

    if (password !== confirmPassword) {
      error = 'Passwords do not match';
      return;
    }

    if (!isStrong) {
      error = 'Password must be at least 8 characters and include an uppercase letter and a number or symbol.';
      return;
    }

    if (!tosAgreed) {
      error = 'You must agree to the Terms of Service';
      return; // button is disabled but guard anyway
    }

    if (turnstileSiteKey && !captchaToken) {
      error = 'Please complete the captcha verification.';
      return;
    }

    loading = true;

    try {
      const result = await signup(email, password, '', captchaToken);
      if (result.redirectTo) {
        window.location.href = result.redirectTo;
      } else {
        goto(`/verify-email?email=${encodeURIComponent(email)}`);
      }
    } catch (err: any) {
      error = err.message;
      resetCaptcha();
    } finally {
      loading = false;
    }
  }
</script>

<svelte:head>
  <title>Sign Up - Arc Launchpad</title>
</svelte:head>

<div class="mb-8">
  <h1 class="text-3xl font-bold">Sign up</h1>
  {#if inviteOrg}
    <p class="mt-2 text-sm text-muted-foreground">
      You've been invited to join <span class="font-medium text-foreground">{inviteOrg}</span>. Create your account to get started.
    </p>
  {/if}
</div>

{#if !inviteOrg}
  <!-- Self-service signup is disabled. Accounts are created by an administrator
       invitation; invited users reach this page with an org context and see the
       form below. Public visitors get this notice. -->
  <div class="rounded-md border border-input bg-card p-6 text-center">
    <p class="text-sm text-muted-foreground">
      Registration is by invitation only. Please contact your administrator for access.
    </p>
    <a href="/login" class="mt-4 inline-block text-sm text-primary hover:underline">
      Back to sign in
    </a>
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
      readonly={!!inviteEmail}
      autocomplete="email"
      class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 {inviteEmail ? 'opacity-60' : ''}"
    />
  </div>

  <div>
    <label for="password" class="mb-1.5 block text-sm font-medium">Password</label>
    <div class="relative">
      {#if showPassword}
        <input
          id="password"
          type="text"
          bind:value={password}
          required
          minlength="8"
          autocomplete="new-password"
          class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 pr-16 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        />
      {:else}
        <input
          id="password"
          type="password"
          bind:value={password}
          required
          minlength="8"
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
    {#if strength}
      <div class="mt-2 flex items-center gap-2">
        <div class="h-1 flex-1 rounded-full bg-muted overflow-hidden">
          <div class="h-full rounded-full transition-all duration-300 {strength.color} {strength.width}"></div>
        </div>
        <span class="text-xs text-muted-foreground w-16 text-right">{strength.label}</span>
      </div>
    {/if}
  </div>

  <div>
    <label for="confirm" class="mb-1.5 block text-sm font-medium">Password confirmation</label>
    <div class="relative">
      {#if showConfirm}
        <input
          id="confirm"
          type="text"
          bind:value={confirmPassword}
          required
          autocomplete="new-password"
          class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 pr-16 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        />
      {:else}
        <input
          id="confirm"
          type="password"
          bind:value={confirmPassword}
          required
          autocomplete="new-password"
          class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 pr-16 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        />
      {/if}
      <button
        type="button"
        on:click={() => showConfirm = !showConfirm}
        class="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground"
      >
        {showConfirm ? 'hide' : 'show'}
      </button>
    </div>
  </div>

  <p class="text-xs leading-relaxed text-muted-foreground">
    By registering, you agree to the processing of your personal data
    by Arc Launchpad as described in the <a href="/privacy" class="text-primary hover:underline">Privacy Policy</a>.
  </p>

  <label class="flex items-start gap-2.5 text-sm">
    <input
      type="checkbox"
      bind:checked={tosAgreed}
      class="mt-0.5 h-4 w-4 rounded border-input accent-primary"
    />
    <span class="text-muted-foreground">
      I've read and agree to the <a href="/terms" class="text-primary hover:underline">Terms of Service</a>
    </span>
  </label>

  {#if turnstileSiteKey}
    <div bind:this={captchaContainer}></div>
  {/if}

  <Button type="submit" class="w-full" disabled={loading || !tosAgreed || !isStrong || (!!turnstileSiteKey && !captchaToken)}>
    {loading ? 'Signing up...' : 'Sign up'}
  </Button>
</form>
{/if}
