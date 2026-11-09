import type { CapabilitiesView } from '$lib/capabilities';
import type { ClusterViewData, NodeLogsData, NodeSnapshotData } from '$lib/cluster';
import type { ChangePage } from '$lib/changeLog';
import type { RbacChange, RbacSnapshot } from '$lib/rbac';

export interface User {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
}

export interface Organization {
  id: string;
  name: string;
  owner_user_id: string;
  created_at: string;
}

export interface Instance {
  id: string;
  org_id: string;
  resource_id: string;
  name: string | null;
  endpoint_url: string | null;
  status: string;
  /** Version the instance reported; null when Arc does not expose it. */
  detected_arc_version: string | null;
  /** Scheme for cluster node API addresses; null = the endpoint's. */
  node_scheme: 'http' | 'https' | null;
  created_at: string;
  updated_at: string;
}

export interface ConnectionInfo {
  url: string | null;
  resource_id: string;
  status: string;
  /** Version the instance reported; null when Arc does not expose it. */
  arc_version: string | null;
}

async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  return res;
}

// Auth
export interface OrganizationFull extends Organization {
  company: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  tax_id: string | null;
}

// Profile
export async function updateProfile(data: { first_name?: string; last_name?: string; email?: string }) {
  const res = await apiFetch('/api/v1/users/profile', {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const d = await res.json();
    throw new Error(d.error || 'Failed to update profile');
  }
  return res.json();
}

export async function updateOrg(orgId: string, data: Record<string, string>) {
  const res = await apiFetch(`/api/v1/orgs/${orgId}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const d = await res.json();
    throw new Error(d.error || 'Failed to update organization');
  }
  return res.json();
}

export async function signup(email: string, password: string, name: string, captchaToken?: string) {
  const res = await apiFetch('/api/v1/auth/signup', {
    method: 'POST',
    body: JSON.stringify({ email, password, name, captchaToken }),
  });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || 'Signup failed');
  }
  return res.json();
}

export async function login(email: string, password: string) {
  const res = await apiFetch('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || 'Login failed');
  }
  return res.json();
}

export async function logout() {
  await apiFetch('/api/v1/auth/logout', { method: 'POST' });
}

// Organizations
export async function listOrgs(): Promise<Organization[]> {
  const res = await apiFetch('/api/v1/orgs');
  if (!res.ok) throw new Error('Failed to fetch organizations');
  const data = await res.json();
  return data.organizations;
}

// Instances
export async function listInstances(orgId: string): Promise<Instance[]> {
  const res = await apiFetch(`/api/v1/orgs/${orgId}/instances`);
  if (!res.ok) throw new Error('Failed to fetch instances');
  const data = await res.json();
  return data.instances;
}

export async function createInstance(
  orgId: string,
  params: { name?: string; endpoint_url: string; admin_token?: string },
): Promise<Instance> {
  const res = await apiFetch(`/api/v1/orgs/${orgId}/instances`, {
    method: 'POST',
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || 'Failed to create instance');
  }
  const data = await res.json();
  return data.instance;
}

export async function getInstance(orgId: string, id: string): Promise<{ instance: Instance; events: any[] }> {
  const res = await apiFetch(`/api/v1/orgs/${orgId}/instances/${id}`);
  if (!res.ok) throw new Error('Failed to fetch instance');
  return res.json();
}

export async function deleteInstance(orgId: string, id: string): Promise<void> {
  const res = await apiFetch(`/api/v1/orgs/${orgId}/instances/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete instance');
}

export async function updateInstance(
  orgId: string,
  id: string,
  params: { name?: string; endpoint_url?: string; admin_token?: string | null; node_scheme?: 'http' | 'https' | null },
): Promise<Instance> {
  const res = await apiFetch(`/api/v1/orgs/${orgId}/instances/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || 'Failed to update instance');
  }
  const data = await res.json();
  return data.instance;
}

export async function getInstanceCapabilities(
  orgId: string,
  id: string,
  opts: { refresh?: boolean } = {},
): Promise<CapabilitiesView> {
  const qs = opts.refresh ? '?refresh=1' : '';
  const res = await apiFetch(`/api/v1/orgs/${orgId}/instances/${id}/capabilities${qs}`);
  if (!res.ok) throw new Error('Failed to check instance capabilities');
  return res.json();
}

export async function getConnectionInfo(orgId: string, id: string): Promise<ConnectionInfo> {
  const res = await apiFetch(`/api/v1/orgs/${orgId}/instances/${id}/connection`);
  if (!res.ok) throw new Error('Failed to fetch connection info');
  return res.json();
}

// MFA
export async function mfaSetup(): Promise<{ qrDataUri: string; secret: string; challengeId: string }> {
  const res = await apiFetch('/api/v1/auth/mfa/setup', { method: 'POST' });
  if (!res.ok) {
    const d = await res.json();
    throw new Error(d.error || 'Failed to start MFA setup');
  }
  return res.json();
}

export async function mfaSetupConfirm(challengeId: string, code: string): Promise<{ recoveryCodes: string[] }> {
  const res = await apiFetch('/api/v1/auth/mfa/setup/confirm', {
    method: 'POST',
    body: JSON.stringify({ challengeId, code }),
  });
  if (!res.ok) {
    const d = await res.json();
    throw new Error(d.error || 'Failed to confirm MFA setup');
  }
  return res.json();
}

export async function mfaDisable(code: string): Promise<void> {
  const res = await apiFetch('/api/v1/auth/mfa/disable', {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
  if (!res.ok) {
    const d = await res.json();
    throw new Error(d.error || 'Failed to disable MFA');
  }
}

export async function mfaRegenerateRecoveryCodes(code: string): Promise<{ recoveryCodes: string[] }> {
  const res = await apiFetch('/api/v1/auth/mfa/recovery-codes/regenerate', {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
  if (!res.ok) {
    const d = await res.json();
    throw new Error(d.error || 'Failed to regenerate recovery codes');
  }
  return res.json();
}

export async function mfaVerify(mfaToken: string, code: string, isRecoveryCode = false) {
  const res = await apiFetch('/api/v1/auth/mfa/verify', {
    method: 'POST',
    body: JSON.stringify({ mfaToken, code, isRecoveryCode }),
  });
  if (!res.ok) {
    const d = await res.json();
    throw new Error(d.error || 'MFA verification failed');
  }
  return res.json();
}

// WebAuthn
export async function webauthnRegisterOptions() {
  const res = await apiFetch('/api/v1/auth/webauthn/register/options', { method: 'POST' });
  if (!res.ok) {
    const d = await res.json();
    throw new Error(d.error || 'Failed to get registration options');
  }
  return res.json();
}

export async function webauthnRegisterVerify(challengeId: string, credential: any, name?: string) {
  const res = await apiFetch('/api/v1/auth/webauthn/register/verify', {
    method: 'POST',
    body: JSON.stringify({ challengeId, credential, name }),
  });
  if (!res.ok) {
    const d = await res.json();
    throw new Error(d.error || 'Failed to register passkey');
  }
  return res.json();
}

export async function webauthnAuthOptions() {
  const res = await apiFetch('/api/v1/auth/webauthn/authenticate/options', { method: 'POST' });
  if (!res.ok) {
    const d = await res.json();
    throw new Error(d.error || 'Failed to get authentication options');
  }
  return res.json();
}

export async function webauthnAuthVerify(challengeId: string, credential: any) {
  const res = await apiFetch('/api/v1/auth/webauthn/authenticate/verify', {
    method: 'POST',
    body: JSON.stringify({ challengeId, credential }),
  });
  if (!res.ok) {
    const d = await res.json();
    throw new Error(d.error || 'Passkey authentication failed');
  }
  return res.json();
}

export async function webauthnDeleteCredential(id: string): Promise<void> {
  const res = await apiFetch(`/api/v1/auth/webauthn/credentials/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) {
    const d = await res.json();
    throw new Error(d.error || 'Failed to delete passkey');
  }
}

// ---------------------------------------------------------------------------
// Cluster (#7). Errors carry Launchpad's code (e.g. 'unreachable',
// 'identity_mismatch') so the view can explain each failure.

export class ClusterApiError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ClusterApiError';
  }
}

async function clusterFetch<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { signal });
  if (res.ok) return res.json();
  const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
  // Cluster routes answer {error: code, message}; the shared auth preamble
  // answers {error: 'Forbidden'} and friends, so fall back to the status.
  const code = body?.message ? body.error ?? 'error' : res.status === 401 || res.status === 403 ? 'forbidden' : res.status === 404 ? 'not_found' : 'error';
  throw new ClusterApiError(code, body?.message ?? body?.error ?? `Request failed (${res.status})`);
}

const clusterBase = (orgId: string, id: string) => `/api/v1/orgs/${orgId}/instances/${id}/cluster`;

export function getClusterView(orgId: string, id: string, signal?: AbortSignal): Promise<ClusterViewData> {
  return clusterFetch(clusterBase(orgId, id), signal);
}

export function getNodeSnapshot(orgId: string, id: string, nodeId: string, duration: number, signal?: AbortSignal): Promise<NodeSnapshotData> {
  return clusterFetch(`${clusterBase(orgId, id)}/nodes/${encodeURIComponent(nodeId)}/snapshot?duration=${duration}`, signal);
}

export function getNodeLogs(
  orgId: string,
  id: string,
  nodeId: string,
  q: { limit: number; level: string | null; since: number },
  signal?: AbortSignal,
): Promise<NodeLogsData> {
  const params = new URLSearchParams({ limit: String(q.limit), since: String(q.since) });
  if (q.level) params.set('level', q.level);
  return clusterFetch(`${clusterBase(orgId, id)}/nodes/${encodeURIComponent(nodeId)}/logs?${params}`, signal);
}

// ---------------------------------------------------------------------------
// Instance change log: Arc changes made through Launchpad, with who made them.

export async function getInstanceChanges(orgId: string, id: string, before?: number): Promise<ChangePage> {
  const qs = before !== undefined ? `?before=${before}` : '';
  const res = await apiFetch(`/api/v1/orgs/${encodeURIComponent(orgId)}/instances/${encodeURIComponent(id)}/changes${qs}`);
  if (!res.ok) throw new Error('Failed to load the change history');
  return res.json();
}

// ---------------------------------------------------------------------------
// Access (Arc RBAC administration, #8)

export class AccessApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly fields?: Record<string, string>) {
    super(message);
    this.name = 'AccessApiError';
  }
}

async function accessFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init);
  if (res.ok) return res.json();
  const body = (await res.json().catch(() => null)) as { error?: string; message?: string; fields?: Record<string, string> } | null;
  const code = body?.message ? body.error ?? 'error' : res.status === 401 || res.status === 403 ? 'forbidden' : 'error';
  throw new AccessApiError(code, body?.message ?? body?.error ?? `Request failed (${res.status})`, body?.fields);
}

const accessPath = (orgId: string, id: string) => `/api/v1/orgs/${encodeURIComponent(orgId)}/instances/${encodeURIComponent(id)}/access`;

export function getAccess(orgId: string, id: string): Promise<RbacSnapshot> {
  return accessFetch(accessPath(orgId, id));
}

export interface AccessChangeOutcome {
  result: 'applied' | 'applied_after_error' | 'not_applied' | 'unknown';
  snapshot: RbacSnapshot;
}

export function applyAccessChange(orgId: string, id: string, change: RbacChange, fingerprint: string): Promise<AccessChangeOutcome> {
  return accessFetch(accessPath(orgId, id), { method: 'POST', body: JSON.stringify({ change, fingerprint }) });
}
