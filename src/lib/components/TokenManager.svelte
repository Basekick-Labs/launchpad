<script lang="ts">
  import { onMount } from 'svelte';
  import type { ArcClient, TokenInfo, CreateTokenRequest } from '$lib/arcClient';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { Badge } from '$lib/components/ui/badge';
  import * as Dialog from '$lib/components/ui/dialog';
  import * as AlertDialog from '$lib/components/ui/alert-dialog';
  import * as Select from '$lib/components/ui/select';
  import { Tooltip, TooltipContent, TooltipTrigger } from '$lib/components/ui/tooltip';
  import { cn } from '$lib/utils';
  import {
    Plus,
    Key,
    RefreshCw,
    Trash2,
    Copy,
    AlertTriangle,
    Loader2,
    Ban,
    ShieldAlert,
    Clock,
    ShieldCheck,
    AlertCircle
  } from 'lucide-svelte';
  import { toast } from 'svelte-sonner';

  export let client: ArcClient;
  export let arcVersion: string = '';

  function isVersionAffected(version: string): boolean {
    if (!version) return false;
    const parts = version.split('.').map(Number);
    // Token expiry bug is fixed in 26.04.1+
    if (parts[0] < 26) return true;
    if (parts[0] > 26) return false;
    if (parts[1] < 4) return true;
    if (parts[1] > 4) return false;
    return parts[2] < 1;
  }

  $: showExpiryWarning = isVersionAffected(arcVersion);

  let tokens: TokenInfo[] = [];
  let isLoading = false;
  let error = '';
  let featureAvailable = true;
  let adminRequired = false;

  // Create token dialog
  let showCreateDialog = false;
  let newTokenName = '';
  let newTokenDescription = '';
  let newTokenPermissions: string[] = ['read', 'write'];
  let newTokenExpiration = '';
  let isCreating = false;

  // Token value display dialog
  let showTokenValue = false;
  let newTokenValue = '';
  let tokenValueTitle = 'Token Created Successfully';

  // Confirmation dialogs
  let showRotateDialog = false;
  let showRevokeDialog = false;
  let showDeleteDialog = false;
  let selectedToken: TokenInfo | null = null;
  let isProcessing = false;

  const availablePermissions = [
    { value: 'read', label: 'Read', description: 'Query data from databases' },
    { value: 'write', label: 'Write', description: 'Insert/write data to databases' },
    { value: 'delete', label: 'Delete', description: 'Delete data from databases' },
    { value: 'admin', label: 'Admin', description: 'Manage tokens, settings, and admin features' }
  ];

  const expirationOptions = [
    { value: '', label: 'Never expires' },
    { value: '24h', label: '24 hours' },
    { value: '7d', label: '7 days' },
    { value: '30d', label: '30 days' },
    { value: '90d', label: '90 days' },
    { value: '365d', label: '1 year' }
  ];

  async function loadTokens() {
    isLoading = true;
    error = '';
    featureAvailable = true;
    adminRequired = false;

    try {
      tokens = await client.listTokens();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load tokens';
      console.error('Token load error:', err);

      // Check for specific error types
      if (msg.includes('Cannot GET') || msg.includes('404') || msg.includes('not found')) {
        featureAvailable = false;
        error = 'Token management is not available in this Arc version';
      } else if (msg.includes('admin') || msg.includes('403') || msg.includes('Permission denied')) {
        adminRequired = true;
        error = 'Admin permission required to manage tokens';
      } else {
        error = msg;
      }
    } finally {
      isLoading = false;
    }
  }

  function openCreateDialog() {
    newTokenName = '';
    newTokenDescription = '';
    newTokenPermissions = ['read', 'write'];
    newTokenExpiration = '';
    showCreateDialog = true;
  }

  async function createToken() {
    if (!newTokenName.trim()) {
      toast.error('Token name is required');
      return;
    }

    isCreating = true;

    try {
      const request: CreateTokenRequest = {
        name: newTokenName.trim(),
        description: newTokenDescription.trim() || undefined,
        permissions: newTokenPermissions.length > 0 ? newTokenPermissions : undefined,
        expires_in: newTokenExpiration || undefined
      };

      const response = await client.createToken(request);
      newTokenValue = response.token;
      tokenValueTitle = 'Token Created Successfully';
      showTokenValue = true;
      showCreateDialog = false;

      await loadTokens();
      toast.success('Token created successfully');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create token';
      toast.error(msg);
    } finally {
      isCreating = false;
    }
  }

  function togglePermission(permission: string) {
    if (newTokenPermissions.includes(permission)) {
      newTokenPermissions = newTokenPermissions.filter(p => p !== permission);
    } else {
      newTokenPermissions = [...newTokenPermissions, permission];
    }
  }

  function openRotateDialog(token: TokenInfo) {
    selectedToken = token;
    showRotateDialog = true;
  }

  async function confirmRotate() {
    if (!selectedToken) return;

    isProcessing = true;

    try {
      const response = await client.rotateToken(selectedToken.id);
      newTokenValue = response.new_token;
      tokenValueTitle = 'Token Rotated Successfully';
      showTokenValue = true;
      showRotateDialog = false;

      await loadTokens();
      toast.success('Token rotated successfully');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to rotate token';
      toast.error(msg);
    } finally {
      isProcessing = false;
      selectedToken = null;
    }
  }

  function openRevokeDialog(token: TokenInfo) {
    selectedToken = token;
    showRevokeDialog = true;
  }

  async function confirmRevoke() {
    if (!selectedToken) return;

    isProcessing = true;

    try {
      await client.revokeToken(selectedToken.id);
      showRevokeDialog = false;

      await loadTokens();
      toast.success('Token revoked successfully');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to revoke token';
      toast.error(msg);
    } finally {
      isProcessing = false;
      selectedToken = null;
    }
  }

  function openDeleteDialog(token: TokenInfo) {
    selectedToken = token;
    showDeleteDialog = true;
  }

  async function confirmDelete() {
    if (!selectedToken) return;

    isProcessing = true;

    try {
      await client.deleteToken(selectedToken.id);
      showDeleteDialog = false;

      await loadTokens();
      toast.success('Token deleted successfully');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to delete token';
      toast.error(msg);
    } finally {
      isProcessing = false;
      selectedToken = null;
    }
  }

  async function enableToken(token: TokenInfo) {
    try {
      await client.updateToken(token.id, { enabled: true });
      await loadTokens();
      toast.success('Token enabled successfully');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to enable token';
      toast.error(msg);
    }
  }

  function formatRelativeTime(dateString?: string): string {
    if (!dateString) return 'Never';
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);

    if (diffSec < 60) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHour < 24) return `${diffHour}h ago`;
    if (diffDay < 30) return `${diffDay}d ago`;
    return date.toLocaleDateString();
  }

  function isExpired(token: TokenInfo): boolean {
    if (!token.expires_at) return false;
    return new Date(token.expires_at) < new Date();
  }

  function getExpiresIn(token: TokenInfo): string | null {
    if (!token.expires_at) return null;
    const expiresAt = new Date(token.expires_at);
    const now = new Date();
    const diffMs = expiresAt.getTime() - now.getTime();
    if (diffMs < 0) return 'Expired';
    const diffDay = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    if (diffDay === 1) return 'Expires tomorrow';
    if (diffDay <= 7) return `Expires in ${diffDay} days`;
    return `Expires ${expiresAt.toLocaleDateString()}`;
  }

  function copyToken() {
    navigator.clipboard.writeText(newTokenValue);
    toast.success('Token copied to clipboard');
  }

  function closeTokenDialog() {
    showTokenValue = false;
    newTokenValue = '';
  }

  function getPermissionBadgeVariant(permission: string): 'default' | 'secondary' | 'destructive' | 'outline' {
    switch (permission) {
      case 'admin':
        return 'destructive';
      case 'delete':
        return 'secondary';
      default:
        return 'outline';
    }
  }

  onMount(() => {
    loadTokens();
  });
</script>

<div class="flex h-full flex-col">
  <!-- Header -->
  <div class="flex items-center justify-between border-b bg-muted/30 px-6 py-4">
    <div>
      <h2 class="text-lg font-semibold">API Tokens</h2>
      <p class="text-sm text-muted-foreground">Manage API tokens for authentication</p>
    </div>
    <div class="flex items-center gap-2">
      <Button variant="outline" size="sm" on:click={loadTokens} disabled={isLoading}>
        <RefreshCw class={cn('mr-2 h-4 w-4', isLoading && 'animate-spin')} />
        Refresh
      </Button>
      {#if featureAvailable && !adminRequired}
        <Button size="sm" on:click={openCreateDialog} disabled={isLoading}>
          <Plus class="mr-2 h-4 w-4" />
          Create Token
        </Button>
      {/if}
    </div>
  </div>

  {#if showExpiryWarning}
    <div class="mx-6 mt-4 rounded-md border border-blue-200 bg-blue-50 p-3 dark:border-blue-800 dark:bg-blue-950">
      <div class="flex items-start gap-2">
        <AlertCircle class="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" />
        <p class="text-sm text-blue-700 dark:text-blue-300">
          Token expiration dates may display incorrectly on Arc v{arcVersion}. Your tokens are still valid. This is fixed in v26.04.1.
        </p>
      </div>
    </div>
  {/if}

  <!-- Content -->
  <div class="flex-1 overflow-auto p-6">
  {#if !featureAvailable}
    <div class="flex flex-col items-center justify-center gap-4 py-12 text-center">
      <Key class="h-12 w-12 text-muted-foreground/30" />
      <div>
        <p class="text-lg font-medium">Token Management Not Available</p>
        <p class="mt-2 text-sm text-muted-foreground max-w-md">
          This feature requires authentication to be enabled on your Arc server.
          Add the following to your Arc configuration:
        </p>
        <pre class="mt-4 rounded-md bg-muted p-4 text-left text-xs font-mono">auth:
  enabled: true</pre>
        <p class="mt-4 text-xs text-muted-foreground">
          After updating the configuration, restart the Arc server.
        </p>
      </div>
      <Button variant="outline" on:click={loadTokens}>
        <RefreshCw class="mr-2 h-4 w-4" />
        Check Again
      </Button>
    </div>
  {:else if adminRequired}
    <div class="flex flex-col items-center justify-center gap-4 py-12 text-center">
      <ShieldAlert class="h-12 w-12 text-yellow-500/50" />
      <div>
        <p class="text-lg font-medium">Admin Permission Required</p>
        <p class="mt-2 text-sm text-muted-foreground max-w-md">
          You need admin permissions to manage tokens. Please use a token with admin access.
        </p>
      </div>
    </div>
  {:else if error && !adminRequired && featureAvailable}
    <div class="flex flex-col items-center justify-center gap-4 py-12">
      <AlertCircle class="h-12 w-12 text-destructive" />
      <p class="text-destructive">{error}</p>
      <Button variant="outline" on:click={loadTokens}>Try Again</Button>
    </div>
  {:else if isLoading && tokens.length === 0}
    <div class="flex items-center justify-center py-12">
      <Loader2 class="h-8 w-8 animate-spin text-muted-foreground" />
    </div>
  {:else if tokens.length === 0}
    <div class="flex flex-col items-center justify-center gap-4 py-12 text-center">
      <Key class="h-12 w-12 text-muted-foreground/50" />
      <div>
        <p class="text-lg font-medium">No tokens configured</p>
        <p class="text-sm text-muted-foreground">Create a token for API authentication</p>
      </div>
      <Button on:click={openCreateDialog}>
        <Plus class="mr-2 h-4 w-4" />
        Create Token
      </Button>
    </div>
  {:else}
    <div class="space-y-3">
      {#each tokens as token (token.id)}
        <div class={cn(
          'rounded-lg border bg-card p-4',
          !token.enabled && 'opacity-60',
          isExpired(token) && token.enabled && 'border-yellow-500/50'
        )}>
          <div class="flex items-start justify-between gap-4">
            <div class="flex-1 space-y-2">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="font-medium">{token.name}</span>
                {#if !token.enabled}
                  <Badge variant="destructive">Disabled</Badge>
                {:else if isExpired(token) && !showExpiryWarning}
                  <Badge variant="outline" class="border-yellow-500 text-yellow-600">Expired</Badge>
                {/if}
                {#if token.permissions?.includes('admin')}
                  <Badge variant="destructive" class="gap-1">
                    <ShieldCheck class="h-3 w-3" />
                    admin
                  </Badge>
                {/if}
              </div>
              {#if token.description}
                <p class="text-sm text-muted-foreground">{token.description}</p>
              {/if}
              <div class="flex flex-wrap gap-1">
                {#each token.permissions?.filter(p => p !== 'admin') || [] as permission}
                  <Badge variant={getPermissionBadgeVariant(permission)} class="text-xs">
                    {permission}
                  </Badge>
                {/each}
              </div>
              <div class="flex flex-wrap gap-4 text-xs text-muted-foreground">
                <span>ID: {token.id}</span>
                <span>Last used: {formatRelativeTime(token.last_used_at)}</span>
                {#if token.expires_at && !showExpiryWarning}
                  <span class={cn(isExpired(token) && 'text-yellow-600')}>
                    <Clock class="mr-1 inline h-3 w-3" />
                    {getExpiresIn(token)}
                  </span>
                {/if}
              </div>
            </div>
            <div class="flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild let:builder>
                  <Button builders={[builder]} variant="ghost" size="icon" class="h-8 w-8" on:click={() => openRotateDialog(token)}>
                    <RefreshCw class="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p class="font-medium">Rotate token</p>
                  <p class="text-xs text-muted-foreground">Generate a new token value</p>
                </TooltipContent>
              </Tooltip>
              {#if token.enabled}
                <Tooltip>
                  <TooltipTrigger asChild let:builder>
                    <Button builders={[builder]} variant="ghost" size="icon" class="h-8 w-8" on:click={() => openRevokeDialog(token)}>
                      <Ban class="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p class="font-medium">Revoke token</p>
                    <p class="text-xs text-muted-foreground">Disable without deleting</p>
                  </TooltipContent>
                </Tooltip>
              {:else}
                <Tooltip>
                  <TooltipTrigger asChild let:builder>
                    <Button builders={[builder]} variant="ghost" size="icon" class="h-8 w-8" on:click={() => enableToken(token)}>
                      <Key class="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p class="font-medium">Enable token</p>
                    <p class="text-xs text-muted-foreground">Re-activate this token</p>
                  </TooltipContent>
                </Tooltip>
              {/if}
              <Tooltip>
                <TooltipTrigger asChild let:builder>
                  <Button builders={[builder]} variant="ghost" size="icon" class="h-8 w-8 text-destructive hover:text-destructive" on:click={() => openDeleteDialog(token)}>
                    <Trash2 class="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p class="font-medium">Delete token</p>
                  <p class="text-xs text-muted-foreground">Permanently remove this token</p>
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
        </div>
      {/each}
    </div>
  {/if}
  </div>
</div>

<!-- Create Token Dialog -->
<Dialog.Root bind:open={showCreateDialog}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>Create New Token</Dialog.Title>
      <Dialog.Description>
        Create a new API token for authentication
      </Dialog.Description>
    </Dialog.Header>
    <form on:submit|preventDefault={createToken} class="space-y-4">
      <div class="space-y-2">
        <Label for="token-name">Name *</Label>
        <Input
          id="token-name"
          bind:value={newTokenName}
          placeholder="e.g., Production API Key"
        />
      </div>
      <div class="space-y-2">
        <Label for="token-description">Description</Label>
        <textarea
          id="token-description"
          bind:value={newTokenDescription}
          placeholder="Optional description"
          rows="2"
          class="flex min-h-[60px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        ></textarea>
      </div>
      <div class="space-y-2">
        <Label>Permissions</Label>
        <div class="space-y-2">
          {#each availablePermissions as perm}
            <label class="flex items-center gap-3 rounded-md border p-3 cursor-pointer hover:bg-muted/50 transition-colors">
              <input
                type="checkbox"
                checked={newTokenPermissions.includes(perm.value)}
                on:change={() => togglePermission(perm.value)}
                class="h-4 w-4 rounded border-gray-300"
              />
              <div class="flex-1">
                <span class="font-medium">{perm.label}</span>
                <p class="text-xs text-muted-foreground">{perm.description}</p>
              </div>
            </label>
          {/each}
        </div>
      </div>
      <div class="space-y-2">
        <Label>Expiration</Label>
        <Select.Root
          selected={expirationOptions.find(o => o.value === newTokenExpiration)}
          onSelectedChange={(v) => newTokenExpiration = v?.value || ''}
        >
          <Select.Trigger class="w-full">
            <Select.Value placeholder="Select expiration" />
          </Select.Trigger>
          <Select.Content>
            {#each expirationOptions as option}
              <Select.Item value={option.value}>{option.label}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
      </div>
      <Dialog.Footer>
        <Button type="button" variant="outline" on:click={() => showCreateDialog = false}>
          Cancel
        </Button>
        <Button type="submit" disabled={isCreating}>
          {#if isCreating}
            <Loader2 class="mr-2 h-4 w-4 animate-spin" />
          {/if}
          Create Token
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>

<!-- Token Value Dialog -->
<Dialog.Root bind:open={showTokenValue}>
  <Dialog.Content class="sm:max-w-lg">
    <Dialog.Header>
      <Dialog.Title>{tokenValueTitle}</Dialog.Title>
    </Dialog.Header>
    <div class="rounded-md border border-yellow-500/50 bg-yellow-500/10 p-4">
      <div class="flex items-start gap-3">
        <AlertTriangle class="h-5 w-5 shrink-0 text-yellow-600" />
        <p class="text-sm text-yellow-700 dark:text-yellow-400">
          <strong>Important:</strong> Copy this token now. You won't be able to see it again!
        </p>
      </div>
    </div>
    <div class="flex items-center gap-2">
      <code class="flex-1 rounded-md border bg-muted p-3 font-mono text-sm break-all select-all">
        {newTokenValue}
      </code>
      <Button variant="outline" size="icon" on:click={copyToken} title="Copy token">
        <Copy class="h-4 w-4" />
      </Button>
    </div>
    <Dialog.Footer>
      <Button on:click={closeTokenDialog}>Done</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<!-- Rotate Confirmation Dialog -->
<AlertDialog.Root bind:open={showRotateDialog}>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>Rotate Token</AlertDialog.Title>
      <AlertDialog.Description>
        Generate a new token value for "{selectedToken?.name}"? The old token will stop working immediately.
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel disabled={isProcessing}>Cancel</AlertDialog.Cancel>
      <AlertDialog.Action on:click={confirmRotate} disabled={isProcessing}>
        {#if isProcessing}
          <Loader2 class="mr-2 h-4 w-4 animate-spin" />
        {/if}
        Rotate Token
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>

<!-- Revoke Confirmation Dialog -->
<AlertDialog.Root bind:open={showRevokeDialog}>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>Revoke Token</AlertDialog.Title>
      <AlertDialog.Description>
        Revoke "{selectedToken?.name}"? The token will be disabled but not deleted. You can re-enable it later.
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel disabled={isProcessing}>Cancel</AlertDialog.Cancel>
      <AlertDialog.Action on:click={confirmRevoke} disabled={isProcessing}>
        {#if isProcessing}
          <Loader2 class="mr-2 h-4 w-4 animate-spin" />
        {/if}
        Revoke Token
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>

<!-- Delete Confirmation Dialog -->
<AlertDialog.Root bind:open={showDeleteDialog}>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>Delete Token</AlertDialog.Title>
      <AlertDialog.Description>
        Permanently delete "{selectedToken?.name}"? This action cannot be undone.
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel disabled={isProcessing}>Cancel</AlertDialog.Cancel>
      <AlertDialog.Action
        on:click={confirmDelete}
        disabled={isProcessing}
        class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
      >
        {#if isProcessing}
          <Loader2 class="mr-2 h-4 w-4 animate-spin" />
        {/if}
        Delete Token
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
