import { v4 as uuidv4 } from 'uuid';
import { getDb } from './db.js';
import { generateResourceId } from './auth.js';
import { checkArcHealth, normalizeEndpointUrl } from './arcConnection.js';

export interface Instance {
  id: string;
  org_id: string;
  resource_id: string;
  name: string | null;
  endpoint_url: string | null;
  status: string;
  arc_version: string;
  admin_token: string | null;
  created_at: string;
  updated_at: string;
  suspended_at: string | null;
  deleted_at: string | null;
}

export interface CreateInstanceInput {
  orgId: string;
  userId?: string;
  name?: string;
  endpointUrl: string;
  adminToken?: string;
}

const DEFAULT_ARC_VERSION = '26.03.1';
const VERSION_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
let cachedVersion: { version: string; fetchedAt: number } | null = null;

/** Fetch the latest Arc release version from GitHub. Caches for 5 minutes. */
export async function getLatestArcVersion(): Promise<string> {
  if (cachedVersion && Date.now() - cachedVersion.fetchedAt < VERSION_CACHE_TTL) {
    return cachedVersion.version;
  }
  try {
    const res = await fetch('https://api.github.com/repos/Basekick-Labs/arc/releases/latest', {
      headers: { Accept: 'application/vnd.github.v3+json', 'User-Agent': 'launchpad' },
    });
    if (!res.ok) {
      console.warn(`[arc-version] GitHub API returned ${res.status}, using fallback ${DEFAULT_ARC_VERSION}`);
      return cachedVersion?.version ?? DEFAULT_ARC_VERSION;
    }
    const data = await res.json() as { tag_name: string };
    const version = data.tag_name.replace(/^v/, '');
    cachedVersion = { version, fetchedAt: Date.now() };
    return version;
  } catch (err: any) {
    console.warn(`[arc-version] Failed to fetch latest release: ${err.message}, using fallback`);
    return cachedVersion?.version ?? DEFAULT_ARC_VERSION;
  }
}

/**
 * Register a connection to an existing Arc server. No provisioning — we store
 * the endpoint URL + admin token and record whether it's reachable.
 */
export async function createInstance(input: CreateInstanceInput): Promise<Instance> {
  const db = getDb();

  const endpointUrl = normalizeEndpointUrl(input.endpointUrl);
  if (!endpointUrl) {
    throw new Error('A valid Arc server URL is required (e.g. https://arc.example.com:8000)');
  }

  const id = uuidv4();
  const resourceId = generateResourceId();
  const adminToken = input.adminToken?.trim() || null;
  const name = input.name?.trim() || null;

  // Probe the server so we land in a real state instead of a fake 'provisioning'.
  const status = await checkArcHealth(endpointUrl, adminToken);
  const arcVersion = await getLatestArcVersion();

  db.prepare(`
    INSERT INTO instances (id, org_id, resource_id, name, endpoint_url, status, arc_version, admin_token)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, input.orgId, resourceId, name, endpointUrl, status, arcVersion, adminToken);

  logEvent(id, 'connected', { endpoint_url: endpointUrl, status });

  return getInstance(id)!;
}

export function getInstance(id: string): Instance | null {
  const db = getDb();
  return db.prepare('SELECT * FROM instances WHERE id = ? AND deleted_at IS NULL').get(id) as Instance | null;
}

export function getInstanceByResourceId(resourceId: string): Instance | null {
  const db = getDb();
  return db.prepare('SELECT * FROM instances WHERE resource_id = ? AND deleted_at IS NULL').get(resourceId) as Instance | null;
}

export function listInstances(orgId: string): Instance[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM instances WHERE org_id = ? AND deleted_at IS NULL ORDER BY created_at DESC'
  ).all(orgId) as Instance[];
}

export function updateInstanceStatus(id: string, status: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE instances SET status = ?, updated_at = datetime('now'),
    deleted_at = CASE WHEN ? = 'deleted' THEN datetime('now') ELSE deleted_at END
    WHERE id = ?
  `).run(status, status, id);

  logEvent(id, status === 'deleted' ? 'deleted' : `status_${status}`, null);
}

/** Update the stored connection details and re-check health. */
export async function updateInstanceConnection(
  id: string,
  fields: { name?: string | null; endpointUrl?: string; adminToken?: string | null },
): Promise<Instance | null> {
  const db = getDb();
  const instance = getInstance(id);
  if (!instance) return null;

  let endpointUrl = instance.endpoint_url;
  if (fields.endpointUrl !== undefined) {
    const normalized = normalizeEndpointUrl(fields.endpointUrl);
    if (!normalized) throw new Error('A valid Arc server URL is required');
    endpointUrl = normalized;
  }
  const adminToken = fields.adminToken !== undefined ? (fields.adminToken?.trim() || null) : instance.admin_token;
  const name = fields.name !== undefined ? (fields.name?.trim() || null) : instance.name;

  const status = await checkArcHealth(endpointUrl, adminToken);

  db.prepare(`
    UPDATE instances SET name = ?, endpoint_url = ?, admin_token = ?, status = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(name, endpointUrl, adminToken, status, id);

  logEvent(id, 'updated', { endpoint_url: endpointUrl, status });
  return getInstance(id);
}

/** Remove a connection. There is nothing external to tear down. */
export async function deleteInstance(id: string): Promise<void> {
  updateInstanceStatus(id, 'deleted');
}

/** Re-probe an instance's Arc server and persist the resulting status. */
export async function refreshInstanceHealth(instance: Instance): Promise<string> {
  const status = await checkArcHealth(instance.endpoint_url, instance.admin_token);
  if (status !== instance.status && instance.status !== 'deleted') {
    const db = getDb();
    db.prepare("UPDATE instances SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, instance.id);
  }
  return status;
}

/** Background job: health-check every active connection. */
export async function refreshAllInstanceHealth(): Promise<void> {
  const db = getDb();
  const instances = db.prepare(
    'SELECT * FROM instances WHERE deleted_at IS NULL'
  ).all() as Instance[];
  for (const instance of instances) {
    try {
      await refreshInstanceHealth(instance);
    } catch (err: any) {
      console.error(`[health] Error checking instance ${instance.id}:`, err.message);
    }
  }
}

const PURGE_AFTER_DAYS = 7;

/** Hard-delete connection rows that were soft-deleted long ago. */
export function purgeExpiredInstances(): void {
  const db = getDb();
  const cutoff = new Date(Date.now() - PURGE_AFTER_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(
    "UPDATE instances SET status = 'purged', updated_at = datetime('now') WHERE deleted_at IS NOT NULL AND deleted_at < ? AND status != 'purged'"
  ).run(cutoff);
}

function logEvent(instanceId: string, eventType: string, details: Record<string, unknown> | null): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO instance_events (instance_id, event_type, details) VALUES (?, ?, ?)
  `).run(instanceId, eventType, details ? JSON.stringify(details) : null);
}

export function getInstanceEvents(instanceId: string, limit: number = 50): Array<{
  id: number;
  instance_id: string;
  event_type: string;
  details: string | null;
  created_at: string;
}> {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM instance_events WHERE instance_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(instanceId, limit) as any[];
}
