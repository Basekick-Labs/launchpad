<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type {
    ArcClient,
    MqttSubscription,
    MqttSubscriptionStats,
    MqttHealth,
    CreateMqttSubscription,
    UpdateMqttSubscription,
  } from '$lib/arcClient';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { Badge } from '$lib/components/ui/badge';
  import * as Dialog from '$lib/components/ui/dialog';
  import { toast } from 'svelte-sonner';
  import {
    Plus,
    Pencil,
    Trash2,
    Play,
    Square,
    Pause,
    RotateCw,
    Loader2,
    RefreshCw,
    ChevronDown,
    ChevronRight,
    Radio,
    Lock,
    AlertTriangle,
    ChevronsUpDown,
  } from 'lucide-svelte';

  export let client: ArcClient;
  export let currentRole: string = 'viewer';

  $: canManage = currentRole === 'owner' || currentRole === 'admin';

  let subscriptions: MqttSubscription[] = [];
  let statsById: Record<string, MqttSubscriptionStats> = {};
  let health: MqttHealth | null = null;
  let loading = false;
  let expandedId: string | null = null;

  // Dialog state
  let showFormDialog = false;
  let showDeleteDialog = false;
  let editing: MqttSubscription | null = null;
  let deleting: MqttSubscription | null = null;

  // Per-row lifecycle action in flight (id -> action)
  let actionInFlight: Record<string, string> = {};

  // Form state
  let fName = '';
  let fBroker = '';
  let fClientId = '';
  let fTopics = ''; // one topic per line in the textarea
  let fQos = 1;
  let fDatabase = '';
  let fUsername = '';
  let fPassword = '';
  let fClearPassword = false;
  let fAutoStart = true;
  let fCleanSession = false;
  // Advanced (TLS + tuning)
  let showAdvanced = false;
  let fTlsEnabled = false;
  let fTlsCertPath = '';
  let fTlsKeyPath = '';
  let fTlsCaPath = '';
  let fTlsInsecure = false;
  let fTopicMapping = ''; // "topic = database" lines
  let fKeepAlive = 60;
  let fConnectTimeout = 30;
  let fReconnectMin = 1;
  let fReconnectMax = 60;

  let formError = '';
  let isSaving = false;
  let isDeleting = false;

  const BROKER_SCHEMES = ['tcp://', 'ssl://', 'ws://', 'wss://', 'mqtt://', 'mqtts://'];

  // Live-stats poll: refresh the in-memory counters for running subscriptions
  // once a second so "messages received / bytes" tick in near-real-time,
  // without re-fetching health + the full subscription list every tick.
  const STATS_POLL_MS = 1000;
  let statsTimer: ReturnType<typeof setInterval> | null = null;
  let statsInFlight = false;

  onMount(() => { if (canManage) refresh(); });
  onDestroy(() => stopStatsPoll());

  function startStatsPoll() {
    if (statsTimer || !canManage) return;
    statsTimer = setInterval(refreshStats, STATS_POLL_MS);
  }

  function stopStatsPoll() {
    if (statsTimer) {
      clearInterval(statsTimer);
      statsTimer = null;
    }
  }

  // Cheap poll: only the live counters for currently-running subscriptions.
  // No health/list re-fetch and no `loading` spinner, so it can run every second.
  async function refreshStats() {
    if (!canManage || statsInFlight) return;
    const running = subscriptions.filter((s) => s.status === 'running');
    if (running.length === 0) {
      stopStatsPoll();
      return;
    }
    statsInFlight = true;
    try {
      const results = await Promise.allSettled(running.map((s) => client.getMqttSubscriptionStats(s.id)));
      const next: Record<string, MqttSubscriptionStats> = {};
      running.forEach((s, i) => {
        const r = results[i];
        if (r.status === 'fulfilled') next[s.id] = r.value;
      });
      statsById = next;
    } catch {
      // Transient stats fetch failures are non-fatal; keep the last values and
      // retry on the next tick rather than toasting once a second.
    } finally {
      statsInFlight = false;
    }
  }

  async function refresh() {
    if (!canManage) return;
    loading = true;
    try {
      health = await client.getMqttHealth();
      if (health.status === 'disabled') {
        subscriptions = [];
        stopStatsPoll();
        return;
      }
      subscriptions = await client.listMqttSubscriptions();
      // Pull live stats once now, then let the poller keep them fresh.
      await refreshStats();
      if (subscriptions.some((s) => s.status === 'running')) {
        startStatsPoll();
      } else {
        stopStatsPoll();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load MQTT subscriptions');
    } finally {
      loading = false;
    }
  }

  function parseTopics(raw: string): string[] {
    // One topic per line. (Not comma-split: a comma is a legal MQTT topic
    // character, so splitting on it would corrupt such a topic.) De-dupe so a
    // copy-paste duplicate doesn't double-subscribe.
    const topics = raw
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean);
    return [...new Set(topics)];
  }

  function parseTopicMapping(raw: string): Record<string, string> | undefined {
    const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return undefined;
    const map: Record<string, string> = {};
    for (const line of lines) {
      // Split on the LAST '=' — a database name can't contain '=', but a topic
      // legally can, so the tail is unambiguously the database.
      const idx = line.lastIndexOf('=');
      if (idx === -1) continue;
      const topic = line.slice(0, idx).trim();
      const db = line.slice(idx + 1).trim();
      if (topic && db) map[topic] = db;
    }
    return Object.keys(map).length ? map : undefined;
  }

  function openCreate() {
    editing = null;
    fName = '';
    fBroker = 'tcp://';
    fClientId = '';
    fTopics = '';
    fQos = 1;
    fDatabase = '';
    fUsername = '';
    fPassword = '';
    fClearPassword = false;
    fAutoStart = true;
    fCleanSession = false;
    showAdvanced = false;
    fTlsEnabled = false;
    fTlsCertPath = '';
    fTlsKeyPath = '';
    fTlsCaPath = '';
    fTlsInsecure = false;
    fTopicMapping = '';
    fKeepAlive = 60;
    fConnectTimeout = 30;
    fReconnectMin = 1;
    fReconnectMax = 60;
    formError = '';
    showFormDialog = true;
  }

  function openEdit(sub: MqttSubscription) {
    editing = sub;
    fName = sub.name;
    fBroker = sub.broker;
    fClientId = sub.client_id;
    fTopics = sub.topics.join('\n');
    fQos = sub.qos;
    fDatabase = sub.database;
    fUsername = sub.username ?? '';
    fPassword = '';
    fClearPassword = false;
    fAutoStart = sub.auto_start;
    fCleanSession = sub.clean_session;
    fTlsEnabled = sub.tls_enabled;
    fTlsCertPath = sub.tls_cert_path ?? '';
    fTlsKeyPath = sub.tls_key_path ?? '';
    fTlsCaPath = sub.tls_ca_path ?? '';
    fTlsInsecure = sub.tls_insecure_skip_verify;
    fTopicMapping = sub.topic_mapping
      ? Object.entries(sub.topic_mapping).map(([t, d]) => `${t} = ${d}`).join('\n')
      : '';
    fKeepAlive = sub.keep_alive_seconds;
    fConnectTimeout = sub.connect_timeout_seconds;
    fReconnectMin = sub.reconnect_min_seconds;
    fReconnectMax = sub.reconnect_max_seconds;
    showAdvanced = sub.tls_enabled || !!sub.topic_mapping;
    formError = '';
    showFormDialog = true;
  }

  function openDelete(sub: MqttSubscription) {
    deleting = sub;
    showDeleteDialog = true;
  }

  // Number inputs are bound through the text-based Input wrapper, so their
  // values arrive as strings once edited. Coerce to a non-negative integer
  // (fallback to the default) before validating/sending — Arc's contract wants
  // integers, and string comparisons like "9" > "60" are lexicographic. Use a
  // strict digits-only parse: parseInt would silently accept "60abc"→60 or
  // truncate "1e9"→1 / "1.5"→1, sending a value the user never intended.
  function toInt(value: number | string, fallback: number): number {
    if (typeof value === 'number') return Number.isInteger(value) && value >= 0 ? value : fallback;
    const s = value.trim();
    return /^\d+$/.test(s) ? parseInt(s, 10) : fallback;
  }

  function validateForm(): string | null {
    if (!fName.trim()) return 'Name is required';
    if (!fBroker.trim()) return 'Broker URL is required';
    if (!BROKER_SCHEMES.some((s) => fBroker.trim().toLowerCase().startsWith(s))) {
      return `Broker must start with one of: ${BROKER_SCHEMES.join(', ')}`;
    }
    if (parseTopics(fTopics).length === 0) return 'At least one topic is required';
    if (!fDatabase.trim()) return 'Target database is required';
    if (![0, 1, 2].includes(Number(fQos))) return 'QoS must be 0, 1, or 2';
    const rMin = toInt(fReconnectMin, 1);
    const rMax = toInt(fReconnectMax, 60);
    if (rMax > 0 && rMin > rMax) {
      return 'Reconnect min must not exceed reconnect max';
    }
    return null;
  }

  async function handleSave() {
    const problem = validateForm();
    if (problem) { formError = problem; return; }

    isSaving = true;
    formError = '';
    try {
      // Numeric fields are coerced from the text inputs; the edit form is
      // pre-filled with the current config so a submit is a full assertion of
      // every visible field.
      const tuning = {
        qos: Number(fQos),
        keep_alive_seconds: toInt(fKeepAlive, 60),
        connect_timeout_seconds: toInt(fConnectTimeout, 30),
        reconnect_min_seconds: toInt(fReconnectMin, 1),
        reconnect_max_seconds: toInt(fReconnectMax, 60),
      };
      if (editing) {
        // Arc rejects updates while running (409) — guard in the UI too.
        const body: UpdateMqttSubscription = {
          name: fName.trim(),
          broker: fBroker.trim(),
          client_id: fClientId.trim() || undefined,
          topics: parseTopics(fTopics),
          database: fDatabase.trim(),
          username: fUsername.trim(),
          tls_enabled: fTlsEnabled,
          tls_cert_path: fTlsCertPath.trim(),
          tls_key_path: fTlsKeyPath.trim(),
          tls_ca_path: fTlsCaPath.trim(),
          tls_insecure_skip_verify: fTlsInsecure,
          auto_start: fAutoStart,
          topic_mapping: parseTopicMapping(fTopicMapping) ?? {},
          clean_session: fCleanSession,
          ...tuning,
        };
        // Only send password when the user typed a new one or explicitly cleared it.
        if (fClearPassword) body.password = '';
        else if (fPassword) body.password = fPassword;
        await client.updateMqttSubscription(editing.id, body);
        toast.success('Subscription updated');
      } else {
        const body: CreateMqttSubscription = {
          name: fName.trim(),
          broker: fBroker.trim(),
          client_id: fClientId.trim() || undefined,
          topics: parseTopics(fTopics),
          database: fDatabase.trim(),
          username: fUsername.trim() || undefined,
          password: fPassword || undefined,
          tls_enabled: fTlsEnabled,
          tls_cert_path: fTlsCertPath.trim() || undefined,
          tls_key_path: fTlsKeyPath.trim() || undefined,
          tls_ca_path: fTlsCaPath.trim() || undefined,
          tls_insecure_skip_verify: fTlsInsecure,
          auto_start: fAutoStart,
          topic_mapping: parseTopicMapping(fTopicMapping),
          clean_session: fCleanSession,
          ...tuning,
        };
        await client.createMqttSubscription(body);
        toast.success('Subscription created');
      }
      showFormDialog = false;
      await refresh();
    } catch (err) {
      formError = err instanceof Error ? err.message : 'Failed to save subscription';
    } finally {
      isSaving = false;
    }
  }

  async function handleDelete() {
    if (!deleting) return;
    isDeleting = true;
    try {
      await client.deleteMqttSubscription(deleting.id);
      toast.success('Subscription deleted');
      showDeleteDialog = false;
      deleting = null;
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete subscription');
    } finally {
      isDeleting = false;
    }
  }

  async function runLifecycle(sub: MqttSubscription, action: 'start' | 'stop' | 'pause' | 'restart') {
    actionInFlight = { ...actionInFlight, [sub.id]: action };
    try {
      if (action === 'start') await client.startMqttSubscription(sub.id);
      else if (action === 'stop') await client.stopMqttSubscription(sub.id);
      else if (action === 'pause') await client.pauseMqttSubscription(sub.id);
      else await client.restartMqttSubscription(sub.id);
      const past = { start: 'started', stop: 'stopped', pause: 'paused', restart: 'restarted' }[action];
      toast.success(`Subscription ${past}`);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Failed to ${action} subscription`);
    } finally {
      const { [sub.id]: _, ...rest } = actionInFlight;
      actionInFlight = rest;
    }
  }

  function statusVariant(status: string): 'success' | 'secondary' | 'destructive' | 'outline' {
    if (status === 'running') return 'success';
    if (status === 'error') return 'destructive';
    if (status === 'paused') return 'outline';
    return 'secondary';
  }

  function fmtBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  function toggleExpanded(id: string) {
    expandedId = expandedId === id ? null : id;
  }
</script>

<div class="flex h-full flex-col">
  <!-- Header -->
  <div class="flex items-center justify-between border-b bg-muted/30 px-6 py-4">
    <div>
      <h2 class="text-lg font-semibold">MQTT Subscriptions</h2>
      <p class="text-sm text-muted-foreground">Ingest MQTT topics into Arc databases</p>
    </div>
    <div class="flex items-center gap-2">
      <Button variant="outline" size="sm" on:click={refresh} disabled={loading}>
        <RefreshCw class="mr-2 h-4 w-4 {loading ? 'animate-spin' : ''}" />
        Refresh
      </Button>
      {#if canManage && health?.status !== 'disabled'}
        <Button size="sm" on:click={openCreate}>
          <Plus class="mr-2 h-4 w-4" />
          Add Subscription
        </Button>
      {/if}
    </div>
  </div>

  <!-- Content -->
  <div class="flex-1 overflow-auto p-6">
    {#if !canManage}
      <div class="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed py-12 text-center">
        <Lock class="h-12 w-12 text-muted-foreground/30" />
        <div>
          <p class="text-lg font-medium">MQTT management requires admin access</p>
          <p class="text-sm text-muted-foreground">Ask an organization owner or admin to manage MQTT subscriptions.</p>
        </div>
      </div>
    {:else if health?.status === 'disabled'}
      <div class="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed py-12 text-center">
        <Radio class="h-12 w-12 text-muted-foreground/30" />
        <div>
          <p class="text-lg font-medium">MQTT is disabled on this instance</p>
          <p class="text-sm text-muted-foreground">
            Enable it by setting <code class="rounded bg-muted px-1 py-0.5 font-mono text-xs">[mqtt] enabled = true</code>
            in the instance's <code class="rounded bg-muted px-1 py-0.5 font-mono text-xs">arc.toml</code>, then restart Arc.
          </p>
        </div>
      </div>
    {:else if subscriptions.length === 0 && !loading}
      <div class="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed py-12 text-center">
        <Radio class="h-12 w-12 text-muted-foreground/30" />
        <div>
          <p class="text-lg font-medium">No MQTT subscriptions</p>
          <p class="text-sm text-muted-foreground">Add a subscription to stream MQTT topics into an Arc database</p>
        </div>
        {#if canManage}
          <Button on:click={openCreate}>
            <Plus class="mr-2 h-4 w-4" />
            Add Subscription
          </Button>
        {/if}
      </div>
    {:else}
      <div class="space-y-3">
        {#each subscriptions as sub (sub.id)}
          {@const stats = statsById[sub.id]}
          {@const busy = actionInFlight[sub.id]}
          <div class="rounded-lg border bg-card">
            <button
              class="flex w-full items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-muted/50"
              on:click={() => toggleExpanded(sub.id)}
            >
              <div class="flex-shrink-0">
                {#if expandedId === sub.id}
                  <ChevronDown class="h-4 w-4 text-muted-foreground" />
                {:else}
                  <ChevronRight class="h-4 w-4 text-muted-foreground" />
                {/if}
              </div>

              <Radio class="h-5 w-5 flex-shrink-0 {sub.status === 'running' ? 'text-primary' : 'text-muted-foreground'}" />

              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span class="font-medium">{sub.name}</span>
                  <Badge variant={statusVariant(sub.status)}>{sub.status}</Badge>
                  {#if sub.has_password}
                    <Lock class="h-3.5 w-3.5 text-muted-foreground" />
                  {/if}
                </div>
                <div class="mt-1 flex items-center gap-4 text-sm text-muted-foreground">
                  <span class="truncate font-mono text-xs">{sub.broker}</span>
                  <span>→ {sub.database}</span>
                  <span>{sub.topics.length} topic{sub.topics.length === 1 ? '' : 's'}</span>
                </div>
              </div>

              {#if stats}
                <div class="hidden flex-shrink-0 items-center gap-4 text-xs text-muted-foreground sm:flex">
                  <span>{stats.messages_received.toLocaleString()} msgs</span>
                  <span>{fmtBytes(stats.bytes_received)}</span>
                </div>
              {/if}
            </button>

            {#if expandedId === sub.id}
              <div class="border-t bg-muted/30 px-4 py-4">
                {#if sub.status === 'error' && sub.error_message}
                  <div class="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                    <AlertTriangle class="mb-1 inline h-4 w-4" />
                    {sub.error_message}
                  </div>
                {/if}

                <div class="mb-4">
                  <p class="mb-2 text-sm font-medium">Topics</p>
                  <div class="flex flex-wrap gap-1.5">
                    {#each sub.topics as topic}
                      <code class="rounded bg-muted px-2 py-0.5 font-mono text-xs">{topic}</code>
                    {/each}
                  </div>
                </div>

                <div class="mb-4 grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
                  <div>
                    <p class="text-muted-foreground">QoS</p>
                    <p class="font-medium">{sub.qos}</p>
                  </div>
                  <div>
                    <p class="text-muted-foreground">Client ID</p>
                    <p class="truncate font-mono text-xs">{sub.client_id}</p>
                  </div>
                  <div>
                    <p class="text-muted-foreground">Auto-start</p>
                    <p class="font-medium">{sub.auto_start ? 'Yes' : 'No'}</p>
                  </div>
                  <div>
                    <p class="text-muted-foreground">TLS</p>
                    <p class="font-medium">{sub.tls_enabled ? 'Enabled' : 'Off'}</p>
                  </div>
                </div>

                {#if stats}
                  <div class="mb-4">
                    <p class="mb-2 text-sm font-medium text-muted-foreground">Live stats (current session)</p>
                    <div class="grid grid-cols-2 gap-4 text-sm md:grid-cols-5">
                      <div>
                        <p class="text-muted-foreground">Received</p>
                        <p class="font-medium">{stats.messages_received.toLocaleString()}</p>
                      </div>
                      <div>
                        <p class="text-muted-foreground">Failed</p>
                        <p class="font-medium">{stats.messages_failed.toLocaleString()}</p>
                      </div>
                      <div>
                        <p class="text-muted-foreground">Bytes</p>
                        <p class="font-medium">{fmtBytes(stats.bytes_received)}</p>
                      </div>
                      <div>
                        <p class="text-muted-foreground">Reconnects</p>
                        <p class="font-medium">{stats.reconnects.toLocaleString()}</p>
                      </div>
                      <div>
                        <p class="text-muted-foreground">Last message</p>
                        <p class="font-medium">{stats.last_message_at ? new Date(stats.last_message_at).toLocaleTimeString() : '—'}</p>
                      </div>
                    </div>
                  </div>
                {/if}

                {#if canManage}
                  <div class="flex flex-wrap items-center gap-2">
                    {#if sub.status === 'running'}
                      <Button variant="outline" size="sm" on:click={() => runLifecycle(sub, 'stop')} disabled={!!busy}>
                        {#if busy === 'stop'}<Loader2 class="mr-2 h-4 w-4 animate-spin" />{:else}<Square class="mr-2 h-4 w-4" />{/if}
                        Stop
                      </Button>
                      <Button variant="outline" size="sm" on:click={() => runLifecycle(sub, 'pause')} disabled={!!busy}>
                        {#if busy === 'pause'}<Loader2 class="mr-2 h-4 w-4 animate-spin" />{:else}<Pause class="mr-2 h-4 w-4" />{/if}
                        Pause
                      </Button>
                    {:else}
                      <Button variant="outline" size="sm" on:click={() => runLifecycle(sub, 'start')} disabled={!!busy}>
                        {#if busy === 'start'}<Loader2 class="mr-2 h-4 w-4 animate-spin" />{:else}<Play class="mr-2 h-4 w-4" />{/if}
                        Start
                      </Button>
                    {/if}
                    <Button variant="outline" size="sm" on:click={() => runLifecycle(sub, 'restart')} disabled={!!busy}>
                      {#if busy === 'restart'}<Loader2 class="mr-2 h-4 w-4 animate-spin" />{:else}<RotateCw class="mr-2 h-4 w-4" />{/if}
                      Restart
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      on:click={() => openEdit(sub)}
                      disabled={sub.status === 'running'}
                      title={sub.status === 'running' ? 'Stop the subscription before editing' : ''}
                    >
                      <Pencil class="mr-2 h-4 w-4" />
                      Edit
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      class="text-destructive hover:text-destructive"
                      on:click={() => openDelete(sub)}
                      disabled={!!busy}
                    >
                      <Trash2 class="mr-2 h-4 w-4" />
                      Delete
                    </Button>
                  </div>
                  {#if sub.status === 'running'}
                    <p class="mt-2 text-xs text-muted-foreground">Stop the subscription to edit its configuration.</p>
                  {/if}
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>

<!-- Create/Edit Dialog -->
<Dialog.Root bind:open={showFormDialog}>
  <Dialog.Content class="max-h-[85vh] overflow-y-auto sm:max-w-[560px]">
    <Dialog.Header>
      <Dialog.Title>{editing ? 'Edit Subscription' : 'Add Subscription'}</Dialog.Title>
      <Dialog.Description>
        Connect to an MQTT broker and route topics into an Arc database.
      </Dialog.Description>
    </Dialog.Header>

    <div class="space-y-4 py-4">
      {#if formError}
        <div class="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{formError}</div>
      {/if}

      <div class="space-y-2">
        <Label for="mqtt-name">Name</Label>
        <Input id="mqtt-name" placeholder="e.g., sensors-ingest" bind:value={fName} />
      </div>

      <div class="grid grid-cols-2 gap-4">
        <div class="space-y-2">
          <Label for="mqtt-broker">Broker URL</Label>
          <Input id="mqtt-broker" placeholder="tcp://broker:1883" bind:value={fBroker} />
        </div>
        <div class="space-y-2">
          <Label for="mqtt-qos">QoS</Label>
          <select
            id="mqtt-qos"
            class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
            bind:value={fQos}
          >
            <option value={0}>0 — at most once</option>
            <option value={1}>1 — at least once</option>
            <option value={2}>2 — exactly once</option>
          </select>
        </div>
      </div>

      <div class="space-y-2">
        <Label for="mqtt-topics">Topics</Label>
        <textarea
          id="mqtt-topics"
          class="flex min-h-[70px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
          placeholder={"sensors/#\nfactory/+/temperature"}
          bind:value={fTopics}
        ></textarea>
        <p class="text-xs text-muted-foreground">One topic per line. MQTT wildcards + and # are allowed.</p>
      </div>

      <div class="grid grid-cols-2 gap-4">
        <div class="space-y-2">
          <Label for="mqtt-database">Target Database</Label>
          <Input id="mqtt-database" placeholder="e.g., iot" bind:value={fDatabase} />
        </div>
        <div class="space-y-2">
          <Label for="mqtt-client-id">Client ID <span class="text-muted-foreground">(optional)</span></Label>
          <Input id="mqtt-client-id" placeholder="auto-generated" bind:value={fClientId} />
        </div>
      </div>

      <div class="grid grid-cols-2 gap-4">
        <div class="space-y-2">
          <Label for="mqtt-username">Username <span class="text-muted-foreground">(optional)</span></Label>
          <Input id="mqtt-username" bind:value={fUsername} autocomplete="off" />
        </div>
        <div class="space-y-2">
          <Label for="mqtt-password">
            Password
            {#if editing && editing.has_password}
              <span class="text-muted-foreground">(set — leave blank to keep)</span>
            {:else}
              <span class="text-muted-foreground">(optional)</span>
            {/if}
          </Label>
          <Input id="mqtt-password" type="password" bind:value={fPassword} disabled={fClearPassword} autocomplete="new-password" />
        </div>
      </div>
      {#if editing && editing.has_password}
        <label class="flex items-center gap-2 text-sm">
          <input type="checkbox" bind:checked={fClearPassword} class="h-4 w-4 rounded border-input" />
          Remove stored password
        </label>
      {/if}

      <div class="flex flex-wrap gap-4">
        <label class="flex items-center gap-2 text-sm">
          <input type="checkbox" bind:checked={fAutoStart} class="h-4 w-4 rounded border-input" />
          Auto-start on Arc boot
        </label>
        <label class="flex items-center gap-2 text-sm">
          <input type="checkbox" bind:checked={fCleanSession} class="h-4 w-4 rounded border-input" />
          Clean session
        </label>
      </div>

      <!-- Advanced -->
      <button
        type="button"
        class="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
        on:click={() => (showAdvanced = !showAdvanced)}
      >
        <ChevronsUpDown class="h-4 w-4" />
        Advanced (TLS, topic mapping, tuning)
      </button>

      {#if showAdvanced}
        <div class="space-y-4 rounded-md border border-dashed p-4">
          <label class="flex items-center gap-2 text-sm">
            <input type="checkbox" bind:checked={fTlsEnabled} class="h-4 w-4 rounded border-input" />
            Enable TLS
          </label>
          {#if fTlsEnabled}
            <div class="grid grid-cols-1 gap-3">
              <div class="space-y-1">
                <Label for="mqtt-tls-ca">CA certificate path</Label>
                <Input id="mqtt-tls-ca" placeholder="/etc/arc/ca.pem" bind:value={fTlsCaPath} />
              </div>
              <div class="grid grid-cols-2 gap-3">
                <div class="space-y-1">
                  <Label for="mqtt-tls-cert">Client cert path</Label>
                  <Input id="mqtt-tls-cert" bind:value={fTlsCertPath} />
                </div>
                <div class="space-y-1">
                  <Label for="mqtt-tls-key">Client key path</Label>
                  <Input id="mqtt-tls-key" bind:value={fTlsKeyPath} />
                </div>
              </div>
              <label class="flex items-center gap-2 text-sm">
                <input type="checkbox" bind:checked={fTlsInsecure} class="h-4 w-4 rounded border-input" />
                Skip TLS verification <span class="text-muted-foreground">(insecure)</span>
              </label>
            </div>
          {/if}

          <div class="space-y-2">
            <Label for="mqtt-topic-mapping">Topic → database mapping <span class="text-muted-foreground">(optional)</span></Label>
            <textarea
              id="mqtt-topic-mapping"
              class="flex min-h-[60px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder={"sensors/# = sensor_data\nfactory/+/temperature = factory"}
              bind:value={fTopicMapping}
            ></textarea>
            <p class="text-xs text-muted-foreground">Override the target database per topic. One <code class="font-mono">topic = database</code> per line.</p>
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div class="space-y-1">
              <Label for="mqtt-keepalive">Keep-alive (s)</Label>
              <Input id="mqtt-keepalive" type="number" min="0" bind:value={fKeepAlive} />
            </div>
            <div class="space-y-1">
              <Label for="mqtt-connect-timeout">Connect timeout (s)</Label>
              <Input id="mqtt-connect-timeout" type="number" min="0" bind:value={fConnectTimeout} />
            </div>
            <div class="space-y-1">
              <Label for="mqtt-reconnect-min">Reconnect min (s)</Label>
              <Input id="mqtt-reconnect-min" type="number" min="0" bind:value={fReconnectMin} />
            </div>
            <div class="space-y-1">
              <Label for="mqtt-reconnect-max">Reconnect max (s)</Label>
              <Input id="mqtt-reconnect-max" type="number" min="0" bind:value={fReconnectMax} />
            </div>
          </div>
        </div>
      {/if}
    </div>

    <Dialog.Footer>
      <Button variant="outline" on:click={() => (showFormDialog = false)}>Cancel</Button>
      <Button on:click={handleSave} disabled={isSaving}>
        {#if isSaving}<Loader2 class="mr-2 h-4 w-4 animate-spin" />{/if}
        {editing ? 'Update' : 'Create'}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<!-- Delete Dialog -->
<Dialog.Root bind:open={showDeleteDialog}>
  <Dialog.Content class="sm:max-w-[400px]">
    <Dialog.Header>
      <Dialog.Title>Delete Subscription</Dialog.Title>
      <Dialog.Description>
        Are you sure you want to delete "{deleting?.name}"? This stops it if running and cannot be undone.
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="outline" on:click={() => (showDeleteDialog = false)}>Cancel</Button>
      <Button variant="destructive" on:click={handleDelete} disabled={isDeleting}>
        {#if isDeleting}<Loader2 class="mr-2 h-4 w-4 animate-spin" />{/if}
        Delete
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
