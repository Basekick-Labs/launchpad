<script lang="ts">
  import { Badge } from '$lib/components/ui/badge';
  import { Button } from '$lib/components/ui/button';
  import * as AlertDialog from '$lib/components/ui/alert-dialog';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
  import * as Tooltip from '$lib/components/ui/tooltip';
  import { toast } from 'svelte-sonner';
  import { MoreHorizontal, Mail, Shield, User, Crown, Eye, X, Info } from 'lucide-svelte';
  import { onMount } from 'svelte';
  import { timezone, formatDateTime } from '$lib/stores/timezone';

  export let data: any;

  const canManageTeam = data.currentRole === 'owner' || data.currentRole === 'admin';
  const isOwner = data.currentRole === 'owner';

  let members: any[] = [];
  let invitations: any[] = [];
  let inviteEmail = '';
  let inviteRole = 'member';
  let inviting = false;
  let loadingMembers = true;

  // Confirmation dialog state
  let confirmAction: (() => Promise<void>) | null = null;
  let confirmTitle = '';
  let confirmDescription = '';
  let confirmOpen = false;
  let confirming = false;

  async function loadMembers() {
    try {
      const res = await fetch(`/api/v1/orgs/${data.orgId}/members`);
      const json = await res.json();
      if (res.ok) members = json.members;
      else toast.error('Failed to load members');
    } catch {
      toast.error('Failed to load members');
    }
    loadingMembers = false;
  }

  async function loadInvitations() {
    if (!canManageTeam) return;
    try {
      const res = await fetch(`/api/v1/orgs/${data.orgId}/invitations`);
      const json = await res.json();
      if (res.ok) invitations = json.invitations;
      else toast.error('Failed to load invitations');
    } catch {
      toast.error('Failed to load invitations');
    }
  }

  async function sendInvite() {
    if (!inviteEmail.trim()) return;
    inviting = true;
    try {
      const res = await fetch(`/api/v1/orgs/${data.orgId}/invitations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      toast.success(`Invitation sent to ${inviteEmail}`);
      inviteEmail = '';
      inviteRole = 'member';
      await loadInvitations();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      inviting = false;
    }
  }

  function confirmRevoke(inv: any) {
    confirmTitle = 'Revoke invitation';
    confirmDescription = `Revoke the invitation sent to ${inv.email}?`;
    confirmAction = async () => {
      const res = await fetch(`/api/v1/orgs/${data.orgId}/invitations/${inv.id}`, { method: 'DELETE' });
      if (res.ok) {
        toast.success('Invitation revoked');
        await loadInvitations();
      } else {
        const json = await res.json();
        toast.error(json.error);
      }
    };
    confirmOpen = true;
  }

  function confirmRemove(member: any) {
    confirmTitle = 'Remove member';
    confirmDescription = `Remove ${member.name || member.email} from the organization? They will lose access immediately.`;
    confirmAction = async () => {
      const res = await fetch(`/api/v1/orgs/${data.orgId}/members/${member.id}`, { method: 'DELETE' });
      if (res.ok) {
        toast.success('Member removed');
        await loadMembers();
      } else {
        const json = await res.json();
        toast.error(json.error);
      }
    };
    confirmOpen = true;
  }

  async function changeRole(member: any, newRole: string) {
    const res = await fetch(`/api/v1/orgs/${data.orgId}/members/${member.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: newRole }),
    });
    if (res.ok) {
      toast.success(`${member.name || member.email} is now ${newRole}`);
      await loadMembers();
    } else {
      const json = await res.json();
      toast.error(json.error);
    }
  }

  function roleBadgeVariant(role: string) {
    if (role === 'owner') return 'default';
    if (role === 'admin') return 'secondary';
    return 'outline';
  }

  onMount(() => {
    loadMembers();
    loadInvitations();
  });
</script>

<div class="p-6">
  <div class="mb-6 flex items-start justify-between">
    <div>
      <h1 class="text-2xl font-bold">Team</h1>
      <p class="text-sm text-muted-foreground">Manage members and invitations for {data.orgName}</p>
    </div>
    <Tooltip.Root>
      <Tooltip.Trigger>
        <button class="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground">
          <Info class="h-4 w-4" />
        </button>
      </Tooltip.Trigger>
      <Tooltip.Content side="left" class="max-w-xs">
        <div class="space-y-2 text-xs">
          <div><span class="font-semibold">Owner</span> — Full access. Manage instances, team, and roles.</div>
          <div><span class="font-semibold">Admin</span> — Connect and remove instances. Invite members and viewers.</div>
          <div><span class="font-semibold">Member</span> — Connect and remove instances. View team.</div>
          <div><span class="font-semibold">Viewer</span> — Read-only. View instances and team. Cannot connect or modify instances.</div>
        </div>
      </Tooltip.Content>
    </Tooltip.Root>
  </div>

  <div class="space-y-6">
    <!-- Invite form (owner/admin only) -->
    {#if canManageTeam}
      <div class="rounded-lg border bg-card p-4">
        <h2 class="mb-3 font-semibold">Invite teammate</h2>
        <form on:submit|preventDefault={sendInvite} class="flex items-end gap-3">
          <div class="flex-1">
            <label for="invite-email" class="mb-1.5 block text-xs text-muted-foreground">Email address</label>
            <input
              id="invite-email"
              type="email"
              bind:value={inviteEmail}
              placeholder="teammate@company.com"
              required
              class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            />
          </div>
          <div class="w-32">
            <label for="invite-role" class="mb-1.5 block text-xs text-muted-foreground">Role</label>
            <select
              id="invite-role"
              bind:value={inviteRole}
              class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <option value="viewer">Viewer</option>
              <option value="member">Member</option>
              {#if isOwner}
                <option value="admin">Admin</option>
              {/if}
            </select>
          </div>
          <Button type="submit" size="sm" disabled={inviting}>
            {inviting ? 'Sending...' : 'Send invite'}
          </Button>
        </form>
      </div>
    {/if}

    <!-- Pending invitations (owner/admin only) -->
    {#if canManageTeam && invitations.length > 0}
      <div class="rounded-lg border bg-card">
        <div class="border-b px-4 py-3">
          <h2 class="font-semibold text-sm">Pending invitations</h2>
        </div>
        <div class="divide-y">
          {#each invitations as inv}
            <div class="flex items-center justify-between px-4 py-3">
              <div class="flex items-center gap-3">
                <div class="flex h-8 w-8 items-center justify-center rounded-full bg-muted">
                  <Mail class="h-4 w-4 text-muted-foreground" />
                </div>
                <div>
                  <p class="text-sm">{inv.email}</p>
                  <p class="text-xs text-muted-foreground">
                    Invited by {inv.invited_by_name} · Expires {formatDateTime(inv.expires_at, $timezone)}
                  </p>
                </div>
              </div>
              <div class="flex items-center gap-2">
                <Badge variant={roleBadgeVariant(inv.role)}>{inv.role}</Badge>
                <button
                  on:click={() => confirmRevoke(inv)}
                  class="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  title="Revoke invitation"
                >
                  <X class="h-4 w-4" />
                </button>
              </div>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Member list -->
    <div class="rounded-lg border bg-card">
      <div class="border-b px-4 py-3">
        <h2 class="font-semibold text-sm">Members</h2>
      </div>
      {#if loadingMembers}
        <div class="px-4 py-6 text-center text-sm text-muted-foreground">Loading...</div>
      {:else}
        <div class="divide-y">
          {#each members as member}
            <div class="flex items-center justify-between px-4 py-3">
              <div class="flex items-center gap-3">
                <div class="flex h-8 w-8 items-center justify-center rounded-full bg-muted">
                  {#if member.role === 'owner'}
                    <Crown class="h-4 w-4 text-amber-500" />
                  {:else if member.role === 'admin'}
                    <Shield class="h-4 w-4 text-muted-foreground" />
                  {:else if member.role === 'viewer'}
                    <Eye class="h-4 w-4 text-muted-foreground" />
                  {:else}
                    <User class="h-4 w-4 text-muted-foreground" />
                  {/if}
                </div>
                <div>
                  <p class="text-sm font-medium">
                    {member.name || member.email}
                    {#if member.id === data.user.id}
                      <span class="text-xs text-muted-foreground">(you)</span>
                    {/if}
                  </p>
                  {#if member.name}
                    <p class="text-xs text-muted-foreground">{member.email}</p>
                  {/if}
                </div>
              </div>
              <div class="flex items-center gap-2">
                <Badge variant={roleBadgeVariant(member.role)}>{member.role}</Badge>
                {#if isOwner && member.role !== 'owner' && member.id !== data.user.id}
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger>
                      <button class="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
                        <MoreHorizontal class="h-4 w-4" />
                      </button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Content align="end">
                      {#if member.role === 'viewer'}
                        <DropdownMenu.Item on:click={() => changeRole(member, 'member')}>
                          Make member
                        </DropdownMenu.Item>
                        <DropdownMenu.Item on:click={() => changeRole(member, 'admin')}>
                          Make admin
                        </DropdownMenu.Item>
                      {:else if member.role === 'member'}
                        <DropdownMenu.Item on:click={() => changeRole(member, 'viewer')}>
                          Make viewer
                        </DropdownMenu.Item>
                        <DropdownMenu.Item on:click={() => changeRole(member, 'admin')}>
                          Make admin
                        </DropdownMenu.Item>
                      {:else if member.role === 'admin'}
                        <DropdownMenu.Item on:click={() => changeRole(member, 'viewer')}>
                          Make viewer
                        </DropdownMenu.Item>
                        <DropdownMenu.Item on:click={() => changeRole(member, 'member')}>
                          Make member
                        </DropdownMenu.Item>
                      {/if}
                      <DropdownMenu.Separator />
                      <DropdownMenu.Item class="text-destructive" on:click={() => confirmRemove(member)}>
                        Remove from org
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Root>
                {:else if data.currentRole === 'admin' && (member.role === 'member' || member.role === 'viewer') && member.id !== data.user.id}
                  <button
                    on:click={() => confirmRemove(member)}
                    class="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
                    title="Remove member"
                  >
                    <X class="h-4 w-4" />
                  </button>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>
</div>

<!-- Confirmation dialog -->
<AlertDialog.Root bind:open={confirmOpen}>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>{confirmTitle}</AlertDialog.Title>
      <AlertDialog.Description>{confirmDescription}</AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel disabled={confirming}>Cancel</AlertDialog.Cancel>
      <Button
        variant="default"
        disabled={confirming}
        on:click={async () => {
          if (confirmAction) {
            confirming = true;
            try {
              await confirmAction();
            } finally {
              confirming = false;
              confirmOpen = false;
            }
          }
        }}
      >
        {confirming ? 'Confirming...' : 'Confirm'}
      </Button>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
