<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { logout } from '$lib/cloudApi';
  import ThemeToggle from '$lib/components/ThemeToggle.svelte';
  import { Button } from '$lib/components/ui/button';
  import { invalidateAll } from '$app/navigation';
  import {
    LayoutDashboard, Server, Users, Settings, LogOut, BookOpen, Building2, ChevronsUpDown
  } from 'lucide-svelte';

  export let data: any;

  $: currentPath = $page.url.pathname;

  $: orgs = (data.organizations ?? []) as Array<{ id: string; name: string }>;
  $: activeOrgId = data.activeOrg?.id ?? '';

  $: navItems = [
    { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { href: '/instances', label: 'Instances', icon: Server },
    { href: '/team', label: 'Team', icon: Users },
    ...(data.user?.is_operator ? [{ href: '/orgs', label: 'Orgs', icon: Building2 }] : []),
    { href: '/settings', label: 'Settings', icon: Settings },
    { href: 'https://docs.basekick.net', label: 'Docs', icon: BookOpen, external: true },
  ];

  let switching = false;
  async function switchOrg(e: Event) {
    const orgId = (e.target as HTMLSelectElement).value;
    if (!orgId || orgId === activeOrgId || switching) return;
    switching = true;
    try {
      const res = await fetch('/api/v1/active-org', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id: orgId }),
      });
      if (res.ok) {
        // Re-run all load functions so every page re-scopes to the new org.
        await invalidateAll();
        await goto('/dashboard', { invalidateAll: true });
      }
    } finally {
      switching = false;
    }
  }

  async function handleLogout() {
    await logout();
    goto('/login');
  }
</script>

<div class="flex h-screen bg-background">
  <!-- Sidebar -->
  <aside class="flex w-60 flex-col border-r bg-card">
    <!-- Logo -->
    <div class="flex h-14 items-center gap-2 border-b px-4">
      <img src="/images/archie-logo.png" alt="Archie" class="h-8 w-8 object-contain" />
      <span class="text-lg font-bold">Arc</span>
    </div>

    <!-- Org switcher -->
    {#if data.activeOrg}
      <div class="border-b px-3 py-2.5">
        <label for="org-switcher" class="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          <Building2 class="h-3 w-3" />
          Organization
        </label>
        <div class="relative">
          <select
            id="org-switcher"
            value={activeOrgId}
            on:change={switchOrg}
            disabled={switching || orgs.length <= 1}
            class="w-full appearance-none rounded-md border border-input bg-background px-2.5 py-1.5 pr-7 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-100 disabled:cursor-default"
          >
            {#each orgs as org}
              <option value={org.id}>{org.name}</option>
            {/each}
          </select>
          {#if orgs.length > 1}
            <ChevronsUpDown class="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          {/if}
        </div>
      </div>
    {/if}

    <!-- Nav -->
    <nav class="flex-1 space-y-1 p-3">
      {#each navItems as item}
        <a
          href={item.href}
          target={item.external ? '_blank' : undefined}
          rel={item.external ? 'noopener noreferrer' : undefined}
          class="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors
            {!item.external && currentPath.startsWith(item.href) ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'}"
        >
          <svelte:component this={item.icon} class="h-4 w-4" />
          {item.label}
        </a>
      {/each}
    </nav>

    <!-- User -->
    <div class="border-t p-3">
      <div class="flex items-center justify-between">
        <div class="min-w-0">
          <p class="truncate text-sm font-medium">{[data.user.first_name, data.user.last_name].filter(Boolean).join(' ') || data.user.email}</p>
          <p class="truncate text-xs text-muted-foreground">{data.user.email}</p>
        </div>
        <div class="flex items-center gap-1">
          <ThemeToggle />
          <Button variant="ghost" size="sm" on:click={handleLogout}>
            <LogOut class="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  </aside>

  <!-- Main Content -->
  <main class="flex-1 overflow-auto">
    <slot />
  </main>
</div>
