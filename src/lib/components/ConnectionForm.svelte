<script lang="ts">
  import { ConnectionManager, type ArcConnection } from '$lib/auth';
  import { createEventDispatcher } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '$lib/components/ui/card';
  import { Database, Loader2 } from 'lucide-svelte';

  const dispatch = createEventDispatcher<{
    connected: ArcConnection;
    cancel: void;
  }>();

  export let editConnection: ArcConnection | null = null;
  export let showCancel: boolean = false;

  let name = '';
  let url = 'http://localhost:8000';
  let token = '';
  let isConnecting = false;
  let error = '';

  // Initialize form with edit connection or defaults
  if (editConnection) {
    name = editConnection.name;
    url = editConnection.url;
    token = editConnection.token;
  }

  async function handleSave() {
    error = '';

    if (!name.trim()) {
      error = 'Connection name is required';
      return;
    }

    if (!url.trim()) {
      error = 'Server URL is required';
      return;
    }

    if (!token.trim()) {
      error = 'Token is required';
      return;
    }

    isConnecting = true;

    try {
      const connectionData = {
        name: name.trim(),
        url: url.trim(),
        token: token.trim()
      };

      // Validate connection
      const tempConn: ArcConnection = { id: 'temp', ...connectionData };
      const isValid = await ConnectionManager.validateConnection(tempConn);

      if (!isValid) {
        error = 'Connection failed. Please check your URL and token.';
        return;
      }

      let connection: ArcConnection;

      if (editConnection) {
        // Update existing connection
        ConnectionManager.updateConnection(editConnection.id, connectionData);
        connection = { ...editConnection, ...connectionData };
      } else {
        // Add new connection
        connection = ConnectionManager.addConnection(connectionData);
        ConnectionManager.setActiveConnection(connection.id);
      }

      dispatch('connected', connection);
    } catch (err) {
      error = err instanceof Error ? err.message : 'Unknown error occurred';
    } finally {
      isConnecting = false;
    }
  }

  function handleCancel() {
    dispatch('cancel');
  }

  function handleKeyPress(event: KeyboardEvent) {
    if (event.key === 'Enter' && !isConnecting) {
      handleSave();
    }
  }
</script>

<div class="flex min-h-screen items-center justify-center p-4">
  <Card class="w-full max-w-md">
    <CardHeader class="text-center">
      <div class="mx-auto mb-2 flex h-16 w-16 items-center justify-center">
        <img src="/images/arc_logo.png" alt="Arc Launchpad" class="h-16 w-16 object-contain" />
      </div>
      <CardTitle class="text-2xl">Archie</CardTitle>
      <CardDescription>
        {editConnection ? 'Edit connection details' : 'Connect to Arc'}
      </CardDescription>
    </CardHeader>
    <CardContent>
      <form on:submit|preventDefault={handleSave} class="space-y-4">
        <div class="space-y-2">
          <Label for="name">Connection Name</Label>
          <Input
            id="name"
            type="text"
            bind:value={name}
            placeholder="Production, Staging, Local..."
            disabled={isConnecting}
            on:keydown={handleKeyPress}
            autocomplete="off"
          />
        </div>

        <div class="space-y-2">
          <Label for="url">Arc Server URL</Label>
          <Input
            id="url"
            type="text"
            bind:value={url}
            placeholder="http://localhost:8000"
            disabled={isConnecting}
            on:keydown={handleKeyPress}
            autocomplete="url"
          />
        </div>

        <div class="space-y-2">
          <Label for="token">Authentication Token</Label>
          <Input
            id="token"
            type="password"
            bind:value={token}
            placeholder="Enter your Arc token"
            disabled={isConnecting}
            on:keydown={handleKeyPress}
            autocomplete="off"
          />
        </div>

        {#if error}
          <div class="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        {/if}

        <div class="flex gap-3 pt-2">
          {#if showCancel}
            <Button
              type="button"
              variant="outline"
              class="flex-1"
              on:click={handleCancel}
              disabled={isConnecting}
            >
              Cancel
            </Button>
          {/if}
          <Button
            type="submit"
            class={showCancel ? 'flex-[2]' : 'w-full'}
            disabled={isConnecting || !name || !url || !token}
          >
            {#if isConnecting}
              <Loader2 class="mr-2 h-4 w-4 animate-spin" />
            {/if}
            {isConnecting ? (editConnection ? 'Saving...' : 'Connecting...') : (editConnection ? 'Save' : 'Connect')}
          </Button>
        </div>
      </form>
    </CardContent>
  </Card>
</div>
