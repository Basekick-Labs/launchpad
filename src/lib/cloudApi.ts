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
  arc_version: string;
  created_at: string;
  updated_at: string;
}

export interface ConnectionInfo {
  url: string | null;
  resource_id: string;
  status: string;
  arc_version: string;
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
  params: { name?: string; endpoint_url?: string; admin_token?: string | null },
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
