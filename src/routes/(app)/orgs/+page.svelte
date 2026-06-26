<script lang="ts">
  import { onMount } from 'svelte';
  import { Badge } from '$lib/components/ui/badge';
  import { Button } from '$lib/components/ui/button';
  import * as AlertDialog from '$lib/components/ui/alert-dialog';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
  import { toast } from 'svelte-sonner';
  import { MoreHorizontal, Mail, Copy, Check, ChevronRight, ChevronDown, Plus, Building2 } from 'lucide-svelte';
  import { timezone, formatDateTime } from '$lib/stores/timezone';

  export let data: any;

  // ---- Organizations ----
  let orgs: any[] = [];
  let orgsLoading = true;
  let newOrgName = '';
  let creatingOrg = false;

  // Expanded org member management
  let expandedOrgId: string | null = null;
  let members: any[] = [];
  let invitations: any[] = [];
  let membersLoading = false;
  let inviteEmail = '';
  let inviteRole = 'member';
  let inviting = false;
  let lastInviteUrl = '';
  let copied = false;

  // ---- Users ----
  let users: any[] = [];
  let usersLoading = true;
  let userInviteEmail = '';
  let userInviteSuperAdmin = false;
  let invitingUser = false;
  let lastUserInviteUrl = '';
  let userCopied = false;

  // Confirm dialog
  let confirmAction: (() => Promise<void>) | null = null;
  let confirmTitle = '';
  let confirmDescription = '';
  let confirmOpen = false;
  let confirming = false;

  function confirm(title: string, description: string, action: () => Promise<void>) {
    confirmTitle = title;
    confirmDescription = description;
    confirmAction = action;
    confirmOpen = true;
  }
  async function runConfirm() {
    if (!confirmAction) return;
    confirming = true;
    try {
      await confirmAction();
      confirmOpen = false;
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      confirming = false;
    }
  }

  async function loadOrgs() {
    orgsLoading = true;
    try {
      const res = await fetch('/api/v1/admin/orgs');
      if (!res.ok) throw new Error('Failed to load organizations');
      orgs = (await res.json()).orgs;
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      orgsLoading = false;
    }
  }

  async function loadUsers() {
    usersLoading = true;
    try {
      const res = await fetch('/api/v1/admin/users');
      if (!res.ok) throw new Error('Failed to load users');
      users = (await res.json()).users;
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      usersLoading = false;
    }
  }

  onMount(() => { loadOrgs(); loadUsers(); });

  async function createOrg() {
    const name = newOrgName.trim();
    if (!name) return;
    creatingOrg = true;
    try {
      const res = await fetch('/api/v1/admin/orgs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Failed to create organization');
      newOrgName = '';
      toast.success(`Organization "${name}" created`);
      await loadOrgs();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      creatingOrg = false;
    }
  }

  function renameOrg(org: any) {
    const name = prompt('New organization name', org.name);
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed === org.name) return;
    (async () => {
      try {
        const res = await fetch(`/api/v1/admin/orgs/${org.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: trimmed }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || 'Rename failed');
        toast.success('Organization renamed');
        await loadOrgs();
      } catch (err: any) {
        toast.error(err.message);
      }
    })();
  }

  function deleteOrg(org: any) {
    confirm(
      'Delete organization?',
      `"${org.name}" and its ${org.instance_count} instance connection(s) and ${org.member_count} membership(s) will be removed. This cannot be undone.`,
      async () => {
        const res = await fetch(`/api/v1/admin/orgs/${org.id}`, { method: 'DELETE' });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || 'Delete failed');
        toast.success('Organization deleted');
        if (expandedOrgId === org.id) expandedOrgId = null;
        await loadOrgs();
      },
    );
  }

  async function toggleExpand(org: any) {
    if (expandedOrgId === org.id) { expandedOrgId = null; return; }
    expandedOrgId = org.id;
    lastInviteUrl = '';
    inviteEmail = '';
    inviteRole = 'member';
    await loadMembers(org.id);
  }

  async function loadMembers(orgId: string) {
    membersLoading = true;
    try {
      const res = await fetch(`/api/v1/admin/orgs/${orgId}/members`);
      if (!res.ok) throw new Error('Failed to load members');
      const body = await res.json();
      members = body.members;
      invitations = body.invitations;
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      membersLoading = false;
    }
  }

  async function inviteToOrg(orgId: string) {
    const email = inviteEmail.trim();
    if (!email) return;
    inviting = true;
    lastInviteUrl = '';
    try {
      const res = await fetch(`/api/v1/admin/orgs/${orgId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, role: inviteRole }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Invite failed');
      lastInviteUrl = body.invitation.inviteUrl;
      inviteEmail = '';
      toast.success(`Invitation created for ${email}`);
      await loadMembers(orgId);
      await loadOrgs();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      inviting = false;
    }
  }

  async function copyInviteUrl() {
    try {
      await navigator.clipboard.writeText(lastInviteUrl);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      toast.error('Could not copy to clipboard');
    }
  }

  async function setMemberRole(orgId: string, m: any, role: string) {
    try {
      const res = await fetch(`/api/v1/admin/orgs/${orgId}/members/${m.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Update failed');
      toast.success('Role updated');
      await loadMembers(orgId);
      await loadOrgs();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  function removeMember(orgId: string, m: any) {
    confirm('Remove member?', `${m.email} will be removed from this organization.`, async () => {
      const res = await fetch(`/api/v1/admin/orgs/${orgId}/members/${m.id}`, { method: 'DELETE' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Remove failed');
      toast.success('Member removed');
      await loadMembers(orgId);
      await loadOrgs();
    });
  }

  // ---- Users (system-level) ----
  async function patchUser(user: any, payload: Record<string, unknown>, msg: string) {
    const res = await fetch(`/api/v1/admin/users/${user.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Update failed');
    toast.success(msg);
    await loadUsers();
  }
  function toggleSuperAdmin(user: any) {
    const make = !user.is_operator;
    confirm(
      make ? 'Grant super-admin?' : 'Revoke super-admin?',
      make ? `${user.email} will be able to manage all organizations and users.` : `${user.email} will lose super-admin access.`,
      () => patchUser(user, { is_operator: make }, 'Super-admin updated'),
    );
  }
  function toggleSuspend(user: any) {
    const suspend = !user.suspended_at;
    confirm(
      suspend ? 'Suspend user?' : 'Reactivate user?',
      suspend ? `${user.email} will be signed out and unable to log in.` : `${user.email} will be able to log in again.`,
      () => patchUser(user, { suspended: suspend }, suspend ? 'User suspended' : 'User reactivated'),
    );
  }
  function deleteUser(user: any) {
    confirm('Delete user?', `${user.email} will be permanently removed from all organizations and signed out.`, async () => {
      const res = await fetch(`/api/v1/admin/users/${user.id}`, { method: 'DELETE' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Delete failed');
      toast.success('User deleted');
      await loadUsers();
      await loadOrgs();
    });
  }

  async function inviteUser() {
    const email = userInviteEmail.trim();
    if (!email) return;
    invitingUser = true;
    lastUserInviteUrl = '';
    try {
      const res = await fetch('/api/v1/admin/users/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, super_admin: userInviteSuperAdmin }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Invite failed');
      lastUserInviteUrl = body.invitation.inviteUrl;
      userInviteEmail = '';
      toast.success(`Invitation created for ${email}`);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      invitingUser = false;
    }
  }

  async function copyUserInviteUrl() {
    try {
      await navigator.clipboard.writeText(lastUserInviteUrl);
      userCopied = true;
      setTimeout(() => (userCopied = false), 1500);
    } catch {
      toast.error('Could not copy to clipboard');
    }
  }

  function fullName(u: any): string {
    return [u.first_name, u.last_name].filter(Boolean).join(' ') || '—';
  }
</script>

<div class="p-6 lg:p-8">
  <div class="mb-6">
    <h1 class="text-2xl font-bold">Organizations</h1>
    <p class="mt-1 text-sm text-muted-foreground">Manage tenants, their members, and platform users.</p>
  </div>

  <!-- Create org -->
  <div class="mb-6 rounded-lg border bg-card p-5">
    <h2 class="mb-3 font-semibold">Create organization</h2>
    <div class="flex flex-wrap items-end gap-3">
      <div class="flex-1 min-w-[220px]">
        <label for="new-org" class="mb-1 block text-xs text-muted-foreground">Name</label>
        <input
          id="new-org"
          type="text"
          bind:value={newOrgName}
          placeholder="Acme Production"
          class="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      <Button on:click={createOrg} disabled={creatingOrg || !newOrgName.trim()}>
        <Plus class="mr-2 h-4 w-4" />
        {creatingOrg ? 'Creating...' : 'Create'}
      </Button>
    </div>
    <p class="mt-2 text-xs text-muted-foreground">You become the owner. Invite a different owner from the org's member list below.</p>
  </div>

  <!-- Orgs list -->
  <div class="mb-8 rounded-lg border bg-card">
    <div class="border-b px-4 py-3"><h2 class="font-semibold">All organizations</h2></div>
    {#if orgsLoading}
      <div class="px-4 py-8 text-center text-sm text-muted-foreground">Loading...</div>
    {:else if orgs.length === 0}
      <div class="px-4 py-8 text-center text-sm text-muted-foreground">No organizations yet.</div>
    {:else}
      <div class="divide-y">
        {#each orgs as org}
          <div>
            <div class="flex items-center justify-between px-4 py-3 hover:bg-muted/40">
              <button class="flex flex-1 items-center gap-2 text-left" on:click={() => toggleExpand(org)}>
                {#if expandedOrgId === org.id}<ChevronDown class="h-4 w-4 text-muted-foreground" />{:else}<ChevronRight class="h-4 w-4 text-muted-foreground" />{/if}
                <Building2 class="h-4 w-4 text-muted-foreground" />
                <span class="font-medium">{org.name}</span>
                <span class="text-xs text-muted-foreground">· {org.member_count} member{org.member_count === 1 ? '' : 's'} · {org.instance_count} instance{org.instance_count === 1 ? '' : 's'}</span>
              </button>
              <div class="flex items-center gap-3">
                <span class="hidden text-xs text-muted-foreground sm:inline">{org.owner_email ?? '—'}</span>
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild let:builder>
                    <Button builders={[builder]} variant="ghost" size="sm"><MoreHorizontal class="h-4 w-4" /></Button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Content align="end">
                    <DropdownMenu.Item on:click={() => renameOrg(org)}>Rename</DropdownMenu.Item>
                    <DropdownMenu.Separator />
                    <DropdownMenu.Item class="text-destructive" on:click={() => deleteOrg(org)}>Delete</DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Root>
              </div>
            </div>

            {#if expandedOrgId === org.id}
              <div class="border-t bg-muted/20 px-4 py-4">
                <!-- Invite -->
                <div class="mb-4 flex flex-wrap items-end gap-2">
                  <div class="flex-1 min-w-[200px]">
                    <label for="inv-email-{org.id}" class="mb-1 block text-xs text-muted-foreground">Invite by email</label>
                    <input
                      id="inv-email-{org.id}"
                      type="email"
                      bind:value={inviteEmail}
                      placeholder="person@example.com"
                      class="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  </div>
                  <select bind:value={inviteRole} class="h-9 rounded-md border border-input bg-background px-2 text-sm">
                    <option value="owner">Owner</option>
                    <option value="admin">Admin</option>
                    <option value="member">Member</option>
                    <option value="viewer">Viewer</option>
                  </select>
                  <Button size="sm" on:click={() => inviteToOrg(org.id)} disabled={inviting || !inviteEmail.trim()}>
                    <Mail class="mr-2 h-4 w-4" />
                    {inviting ? 'Inviting...' : 'Invite'}
                  </Button>
                </div>

                {#if lastInviteUrl}
                  <div class="mb-4 rounded-md border bg-background p-3">
                    <p class="mb-1 text-xs text-muted-foreground">Share this link with the invitee (valid 7 days):</p>
                    <div class="flex items-center gap-2">
                      <code class="flex-1 truncate rounded bg-muted px-2 py-1 text-xs">{lastInviteUrl}</code>
                      <Button variant="outline" size="sm" on:click={copyInviteUrl}>
                        {#if copied}<Check class="h-4 w-4" />{:else}<Copy class="h-4 w-4" />{/if}
                      </Button>
                    </div>
                  </div>
                {/if}

                <!-- Members -->
                {#if membersLoading}
                  <p class="text-sm text-muted-foreground">Loading members...</p>
                {:else}
                  <table class="w-full">
                    <thead>
                      <tr class="border-b text-left text-xs text-muted-foreground">
                        <th class="py-2 pr-4 font-medium">Member</th>
                        <th class="py-2 pr-4 font-medium">Role</th>
                        <th class="py-2 text-right font-medium">Actions</th>
                      </tr>
                    </thead>
                    <tbody class="divide-y">
                      {#each members as m}
                        <tr>
                          <td class="py-2 pr-4 text-sm">
                            <div class="font-medium">{m.name || m.email}</div>
                            <div class="text-xs text-muted-foreground">{m.email}</div>
                          </td>
                          <td class="py-2 pr-4">
                            <Badge variant={m.role === 'owner' ? 'default' : m.role === 'admin' ? 'secondary' : 'outline'}>{m.role}</Badge>
                          </td>
                          <td class="py-2 text-right">
                            <DropdownMenu.Root>
                              <DropdownMenu.Trigger asChild let:builder>
                                <Button builders={[builder]} variant="ghost" size="sm"><MoreHorizontal class="h-4 w-4" /></Button>
                              </DropdownMenu.Trigger>
                              <DropdownMenu.Content align="end">
                                {#each ['owner', 'admin', 'member', 'viewer'] as r}
                                  <DropdownMenu.Item disabled={m.role === r} on:click={() => setMemberRole(org.id, m, r)}>
                                    Make {r}
                                  </DropdownMenu.Item>
                                {/each}
                                <DropdownMenu.Separator />
                                <DropdownMenu.Item class="text-destructive" disabled={m.role === 'owner'} on:click={() => removeMember(org.id, m)}>
                                  Remove
                                </DropdownMenu.Item>
                              </DropdownMenu.Content>
                            </DropdownMenu.Root>
                          </td>
                        </tr>
                      {/each}
                      {#each invitations as inv}
                        <tr class="text-muted-foreground">
                          <td class="py-2 pr-4 text-sm italic">{inv.email}</td>
                          <td class="py-2 pr-4"><Badge variant="outline">{inv.role} · pending</Badge></td>
                          <td class="py-2 text-right text-xs">invited</td>
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <!-- Platform users -->
  <div class="rounded-lg border bg-card">
    <div class="border-b px-4 py-3"><h2 class="font-semibold">Platform users</h2></div>

    <!-- Invite a platform user -->
    <div class="border-b px-4 py-4">
      <div class="flex flex-wrap items-end gap-3">
        <div class="flex-1 min-w-[220px]">
          <label for="user-invite-email" class="mb-1 block text-xs text-muted-foreground">Invite a new user by email</label>
          <input
            id="user-invite-email"
            type="email"
            bind:value={userInviteEmail}
            placeholder="person@example.com"
            class="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <label class="flex h-9 items-center gap-2 text-sm">
          <input type="checkbox" bind:checked={userInviteSuperAdmin} class="h-4 w-4 rounded border-input" />
          Super-admin
        </label>
        <Button on:click={inviteUser} disabled={invitingUser || !userInviteEmail.trim()}>
          <Mail class="mr-2 h-4 w-4" />
          {invitingUser ? 'Inviting...' : 'Invite user'}
        </Button>
      </div>
      <p class="mt-2 text-xs text-muted-foreground">A personal organization is created for the new user on acceptance. Super-admins can manage all organizations.</p>

      {#if lastUserInviteUrl}
        <div class="mt-3 rounded-md border bg-muted/40 p-3">
          <p class="mb-1 text-xs text-muted-foreground">Share this link with the invitee (valid 7 days):</p>
          <div class="flex items-center gap-2">
            <code class="flex-1 truncate rounded bg-background px-2 py-1 text-xs">{lastUserInviteUrl}</code>
            <Button variant="outline" size="sm" on:click={copyUserInviteUrl}>
              {#if userCopied}<Check class="h-4 w-4" />{:else}<Copy class="h-4 w-4" />{/if}
            </Button>
          </div>
        </div>
      {/if}
    </div>

    {#if usersLoading}
      <div class="px-4 py-8 text-center text-sm text-muted-foreground">Loading...</div>
    {:else}
      <table class="w-full">
        <thead>
          <tr class="border-b text-left text-xs text-muted-foreground">
            <th class="px-4 py-3 font-medium">Name</th>
            <th class="px-4 py-3 font-medium">Email</th>
            <th class="px-4 py-3 font-medium">Access</th>
            <th class="px-4 py-3 font-medium">Status</th>
            <th class="px-4 py-3 font-medium">Created</th>
            <th class="px-4 py-3 text-right font-medium">Actions</th>
          </tr>
        </thead>
        <tbody class="divide-y">
          {#each users as user}
            <tr class="hover:bg-muted/50 transition-colors">
              <td class="px-4 py-3 text-sm font-medium">{fullName(user)}</td>
              <td class="px-4 py-3 text-sm text-muted-foreground">{user.email}</td>
              <td class="px-4 py-3">
                <Badge variant={user.is_operator ? 'default' : 'outline'}>{user.is_operator ? 'Super-admin' : 'User'}</Badge>
              </td>
              <td class="px-4 py-3">
                {#if user.suspended_at}<Badge variant="secondary">Suspended</Badge>{:else}<span class="text-sm text-muted-foreground">Active</span>{/if}
              </td>
              <td class="px-4 py-3 text-sm text-muted-foreground">{formatDateTime(user.created_at, $timezone)}</td>
              <td class="px-4 py-3 text-right">
                {#if user.id !== data.currentUserId}
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild let:builder>
                      <Button builders={[builder]} variant="ghost" size="sm"><MoreHorizontal class="h-4 w-4" /></Button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Content align="end">
                      <DropdownMenu.Item on:click={() => toggleSuperAdmin(user)}>{user.is_operator ? 'Revoke super-admin' : 'Make super-admin'}</DropdownMenu.Item>
                      <DropdownMenu.Item on:click={() => toggleSuspend(user)}>{user.suspended_at ? 'Reactivate' : 'Suspend'}</DropdownMenu.Item>
                      <DropdownMenu.Separator />
                      <DropdownMenu.Item class="text-destructive" on:click={() => deleteUser(user)}>Delete</DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Root>
                {:else}
                  <span class="text-xs text-muted-foreground">You</span>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>
</div>

<AlertDialog.Root bind:open={confirmOpen}>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>{confirmTitle}</AlertDialog.Title>
      <AlertDialog.Description>{confirmDescription}</AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel disabled={confirming}>Cancel</AlertDialog.Cancel>
      <Button variant="default" disabled={confirming} on:click={runConfirm}>{confirming ? 'Working...' : 'Confirm'}</Button>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
