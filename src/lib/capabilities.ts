/**
 * Arc capability and license model (#6).
 *
 * Arc has no capabilities endpoint, so what an instance supports is inferred
 * from probes (see src/lib/server/capabilities.ts). This module is the pure,
 * isomorphic half: the registry Enterprise features extend, the decision
 * table that turns probe results into states, and the role-filtered view the
 * browser receives. No I/O here so every branch is unit tested.
 */

import { roleAtLeast, type OrgRole } from './roles';

export type CapabilityId =
  | 'cluster'
  | 'rbac'
  | 'tiering'
  | 'query_governance'
  | 'query_management'
  | 'audit_log'
  | 'backup'
  | 'compaction';

export interface CapabilityDefinition {
  id: CapabilityId;
  label: string;
  /** Arc license feature that gates it; null for features Arc ships in OSS. */
  licenseFeature: string | null;
  /**
   * Cheap admin-gated GET whose status says whether the area is served. Chosen
   * for a small, bounded handler: tiering/status and audit/stats scan tables,
   * so tiering/policies and audit/logs?limit=1 stand in for them. Null when
   * the state comes from /api/v1/cluster instead.
   */
  probePath: string | null;
  minRole: OrgRole;
}

export const CAPABILITIES: readonly CapabilityDefinition[] = [
  { id: 'cluster', label: 'Clustering', licenseFeature: 'clustering', probePath: null, minRole: 'admin' },
  { id: 'rbac', label: 'Role-based access control', licenseFeature: 'rbac', probePath: '/api/v1/rbac/organizations', minRole: 'admin' },
  { id: 'tiering', label: 'Tiered storage', licenseFeature: 'tiering', probePath: '/api/v1/tiering/policies', minRole: 'admin' },
  { id: 'query_governance', label: 'Query governance', licenseFeature: 'query_governance', probePath: '/api/v1/governance/policies', minRole: 'admin' },
  { id: 'query_management', label: 'Active query management', licenseFeature: 'query_management', probePath: '/api/v1/queries/active', minRole: 'admin' },
  { id: 'audit_log', label: 'Audit log', licenseFeature: 'audit_logging', probePath: '/api/v1/audit/logs?limit=1', minRole: 'admin' },
  { id: 'backup', label: 'Backup and restore', licenseFeature: null, probePath: '/api/v1/backup/status', minRole: 'admin' },
  { id: 'compaction', label: 'Compaction', licenseFeature: null, probePath: '/api/v1/compaction/status', minRole: 'admin' },
];

export type CapabilityState = 'available' | 'unlicensed' | 'disabled' | 'unavailable' | 'unknown';

export type CapabilityReason =
  | 'ok'
  | 'not_licensed'
  | 'disabled_in_config'
  | 'arc_auth_off'
  | 'not_enabled'
  | 'token_not_admin'
  | 'token_rejected'
  | 'no_token'
  | 'unreachable'
  | 'error';

/** Arc's license statuses; v26.09.3 relays `read_only` from the license server. */
export type LicenseStatus =
  | 'active'
  | 'grace_period'
  | 'writes_stopped'
  | 'read_only'
  | 'expired'
  | 'unlicensed'
  | 'unknown';

const LICENSE_STATUSES = new Set<LicenseStatus>([
  'active', 'grace_period', 'writes_stopped', 'read_only', 'expired', 'unlicensed',
]);

export interface LicenseSummary {
  tier: string;
  status: LicenseStatus;
  /** Raw status when Arc sent one this build doesn't know. */
  rawStatus: string | null;
  expiresAt: string | null;
  graceDay: number | null;
  writesStopAt: string | null;
  cutoff: string | null;
}

/** A probe answer: status plus the first bytes of the body (for 403 wording). */
export interface ProbeAnswer {
  status: number;
  body: string;
}

/** null = the request failed (timeout, refused, oversized). */
export type ProbeOutcome = ProbeAnswer | null;

export interface ClusterInfo {
  enabled: boolean;
  reason: string | null;
  licenseValid: boolean | null;
  features: string[] | null;
  version: string | null;
}

export interface ProbeResults {
  /** Whether a token is stored; without one only /health is probed. */
  hasToken: boolean;
  /** null when /health could not be read at all. */
  health: { license: LicenseSummary | null } | null;
  /** Permissions of the stored token from /api/v1/auth/verify; null = unknown. */
  tokenPermissions: string[] | null;
  tokenRejected: boolean;
  /** null when /api/v1/cluster failed or was not probed. */
  cluster: ClusterInfo | null;
  probes: Partial<Record<CapabilityId, ProbeOutcome>>;
}

export interface CapabilityResult {
  state: CapabilityState;
  reason: CapabilityReason;
}

export interface InstanceCapabilities {
  reachable: boolean;
  version: string | null;
  license: LicenseSummary | null;
  tokenIsAdmin: boolean | null;
  capabilities: Record<CapabilityId, CapabilityResult>;
}

const VERSION_RE = /^v?(\d+\.\d+\.\d+(?:[-+.][0-9A-Za-z.-]+)?)$/;

/** A release-shaped version string, without the leading v; null for "dev" etc. */
export function normalizeVersion(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 64) return null;
  const m = VERSION_RE.exec(raw.trim());
  return m ? m[1] : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Validate the `license` block of /health. Anything malformed is ignored. */
export function parseHealthLicense(value: unknown): LicenseSummary | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const tier = str(v.tier);
  const rawStatus = str(v.status);
  if (!tier || !rawStatus) return null;
  const known = LICENSE_STATUSES.has(rawStatus as LicenseStatus);
  return {
    tier,
    status: known ? (rawStatus as LicenseStatus) : 'unknown',
    rawStatus: known ? null : rawStatus,
    expiresAt: str(v.expires_at),
    graceDay: typeof v.grace_day === 'number' && Number.isInteger(v.grace_day) ? v.grace_day : null,
    writesStopAt: str(v.writes_stop_at),
    cutoff: str(v.cutoff),
  };
}

/** Validate a /api/v1/cluster body. */
export function parseClusterInfo(value: unknown): ClusterInfo | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.enabled !== 'boolean') return null;
  const lic = typeof v.license === 'object' && v.license !== null ? (v.license as Record<string, unknown>) : null;
  const features = Array.isArray(lic?.features) && lic.features.every((f) => typeof f === 'string')
    ? (lic.features as string[])
    : null;
  let version: string | null = null;
  if (Array.isArray(v.nodes)) {
    // The answering node; behind a load balancer this is whichever node served
    // the request, so the version is "a node's", not the cluster's.
    const local = v.nodes.find(
      (n) => typeof n === 'object' && n !== null && (n as Record<string, unknown>).id === v.local_node_id,
    ) as Record<string, unknown> | undefined;
    version = normalizeVersion(local?.version);
  }
  return {
    enabled: v.enabled,
    reason: str(v.reason),
    licenseValid: typeof lic?.valid === 'boolean' ? lic.valid : null,
    features,
    version,
  };
}

const LICENSE_403 = /requires an enterprise license|license/i;
const ADMIN_403 = /admin required|permission denied/i;

/** True when the license is in a state that keeps Enterprise features on. */
function licenseIsLive(license: LicenseSummary | null): boolean {
  if (!license || license.tier === 'oss') return false;
  return license.status === 'active' || license.status === 'grace_period' ||
    license.status === 'writes_stopped' || license.status === 'read_only';
}

function classifyCluster(probes: ProbeResults, license: LicenseSummary | null): CapabilityResult {
  const c = probes.cluster;
  if (!c) return { state: 'unknown', reason: probes.tokenRejected ? 'token_rejected' : 'unreachable' };
  if (c.enabled) return { state: 'available', reason: 'ok' };
  // Arc's reasons: "Enterprise license not configured", "...not valid",
  // "License does not include clustering feature", "Clustering not enabled
  // in configuration (cluster.enabled=false)".
  if (c.reason && /licen[cs]e/i.test(c.reason)) return { state: 'unlicensed', reason: 'not_licensed' };
  if (c.reason && /configuration/i.test(c.reason)) {
    return licenseIsLive(license) || c.licenseValid
      ? { state: 'disabled', reason: 'disabled_in_config' }
      : { state: 'unlicensed', reason: 'not_licensed' };
  }
  return { state: 'unknown', reason: 'error' };
}

function classifyProbe(
  def: CapabilityDefinition,
  outcome: ProbeOutcome | undefined,
  license: LicenseSummary | null,
  features: string[] | null,
): CapabilityResult {
  if (outcome === undefined) return { state: 'unknown', reason: 'no_token' };
  if (outcome === null) return { state: 'unknown', reason: 'unreachable' };
  const { status, body } = outcome;
  if (status >= 200 && status < 300) return { state: 'available', reason: 'ok' };
  if (status === 401) return { state: 'unknown', reason: 'token_rejected' };
  if (status === 403) {
    // RequireAdmin runs before the license gate, so a non-admin token gets a
    // 403 too. Only Arc's license wording means "not licensed".
    if (ADMIN_403.test(body)) return { state: 'unknown', reason: 'token_not_admin' };
    if (LICENSE_403.test(body)) return { state: 'unlicensed', reason: 'not_licensed' };
    return { state: 'unknown', reason: 'error' };
  }
  if (status === 404) {
    // OSS features (backup, compaction) are only absent when off in config.
    if (def.licenseFeature === null) return { state: 'disabled', reason: 'disabled_in_config' };
    // RBAC routes register whenever Arc auth is on (unlicensed is a 403), so a
    // 404 means Arc runs without auth.
    if (def.id === 'rbac') return { state: 'disabled', reason: 'arc_auth_off' };
    // Other gated routes are registered at boot only when licensed AND enabled.
    if (!licenseIsLive(license)) return { state: 'unlicensed', reason: 'not_licensed' };
    if (features) {
      return features.includes(def.licenseFeature)
        ? { state: 'disabled', reason: 'disabled_in_config' }
        : { state: 'unlicensed', reason: 'not_licensed' };
    }
    return { state: 'unavailable', reason: 'not_enabled' };
  }
  if (status === 503) return { state: 'disabled', reason: 'disabled_in_config' };
  return { state: 'unknown', reason: 'error' };
}

/** The decision table: probe results → per-capability states. */
export function deriveCapabilities(probes: ProbeResults): InstanceCapabilities {
  const license = probes.health?.license ?? null;
  // A feature list is only trustworthy from a valid license: Arc returns it
  // even when `valid` is false.
  const features = probes.cluster?.licenseValid === true ? probes.cluster.features : null;
  const tokenIsAdmin = probes.tokenPermissions ? probes.tokenPermissions.includes('admin') : null;

  const capabilities = {} as Record<CapabilityId, CapabilityResult>;
  for (const def of CAPABILITIES) {
    if (!probes.health) {
      capabilities[def.id] = { state: 'unknown', reason: 'unreachable' };
    } else if (!probes.hasToken) {
      capabilities[def.id] = { state: 'unknown', reason: 'no_token' };
    } else if (def.id === 'cluster') {
      capabilities[def.id] = classifyCluster(probes, license);
    } else {
      capabilities[def.id] = classifyProbe(def, probes.probes[def.id], license, features);
    }
  }

  return {
    reachable: probes.health !== null,
    version: probes.cluster?.version ?? null,
    license,
    tokenIsAdmin,
    capabilities,
  };
}

export type NoticeSeverity = 'info' | 'warning' | 'critical';

export interface LicenseNotice {
  severity: NoticeSeverity;
  message: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

/**
 * Admin-facing notices about the license and the stored token. `now` is a
 * parameter so expiry arithmetic is testable; days come from `expiresAt`
 * because Arc omits `days_remaining` exactly when it is 0.
 */
export function licenseNotices(caps: InstanceCapabilities, now = Date.now()): LicenseNotice[] {
  const notices: LicenseNotice[] = [];
  const lic = caps.license;

  if (caps.tokenIsAdmin === false) {
    notices.push({
      severity: 'warning',
      message: 'The stored Arc token lacks admin permission, so Enterprise features cannot be checked. Update the connection with an admin token.',
    });
  }
  if (!lic) return notices;

  const anyAvailable = CAPABILITIES.some(
    (d) => d.licenseFeature !== null && caps.capabilities[d.id].state === 'available',
  );
  const expires = formatDate(lic.expiresAt);
  const writesStop = formatDate(lic.writesStopAt);
  const cutoff = formatDate(lic.cutoff);

  if (lic.tier === 'oss' && lic.status === 'unlicensed') {
    notices.push({ severity: 'critical', message: 'A license is configured on this Arc instance but is not active, so Enterprise features are off.' });
    return notices;
  }

  switch (lic.status) {
    case 'expired':
      notices.push(anyAvailable
        ? { severity: 'warning', message: `The license expired${expires ? ` on ${expires}` : ''}. Enterprise features still respond but will stop when Arc restarts.` }
        : { severity: 'critical', message: `The license expired${expires ? ` on ${expires}` : ''}. Enterprise features are off.` });
      break;
    case 'writes_stopped':
      notices.push({
        severity: 'critical',
        message: `The license expired${expires ? ` on ${expires}` : ''}. Arc is refusing writes${cutoff ? `, and Enterprise features stop on ${cutoff}` : ''}.`,
      });
      break;
    case 'read_only':
      notices.push({ severity: 'critical', message: 'The license is read-only. Arc is refusing writes.' });
      break;
    case 'grace_period':
      notices.push({
        severity: 'warning',
        message: `The license expired${expires ? ` on ${expires}` : ''} and is in its grace period${lic.graceDay !== null ? ` (day ${lic.graceDay})` : ''}.${writesStop ? ` Writes stop on ${writesStop}.` : ''}`,
      });
      break;
    case 'unknown':
      notices.push({ severity: 'warning', message: `Arc reports an unrecognized license status "${lic.rawStatus}".` });
      break;
    case 'active': {
      const t = lic.expiresAt ? Date.parse(lic.expiresAt) : NaN;
      if (!Number.isNaN(t) && t - now <= 30 * DAY_MS) {
        const days = Math.max(0, Math.ceil((t - now) / DAY_MS));
        notices.push({ severity: 'info', message: `The license expires on ${expires} (${days} day${days === 1 ? '' : 's'}).` });
      }
      break;
    }
  }
  return notices;
}

export interface CapabilityView {
  id: CapabilityId;
  label: string;
  state: CapabilityState;
  reason: CapabilityReason;
}

/** What the browser receives, already filtered for the caller's org role. */
export interface CapabilitiesView {
  reachable: boolean;
  version: string | null;
  /** Show the Enterprise section at all. False for OSS so its UI stays clean. */
  showEnterprise: boolean;
  /** License tier and notices: owner/admin only. */
  tier: string | null;
  notices: LicenseNotice[];
  capabilities: CapabilityView[];
}

/**
 * Enterprise UI is driven by what the instance shows, not its tier name: a
 * configured license (any tier, including a failed one, so its notice is
 * seen) or an observed licensed feature.
 */
function enterpriseObserved(caps: InstanceCapabilities): boolean {
  if (caps.license) return true;
  return CAPABILITIES.some((d) => d.licenseFeature !== null && caps.capabilities[d.id].state === 'available');
}

export function viewForRole(caps: InstanceCapabilities, role: string, now = Date.now()): CapabilitiesView {
  const isAdmin = roleAtLeast(role, 'admin');
  const capabilities = CAPABILITIES
    .filter((d) => roleAtLeast(role, d.minRole))
    .map((d) => ({ id: d.id, label: d.label, ...caps.capabilities[d.id] }));
  return {
    reachable: caps.reachable,
    version: caps.version,
    showEnterprise: isAdmin && enterpriseObserved(caps),
    tier: isAdmin ? caps.license?.tier ?? null : null,
    notices: isAdmin ? licenseNotices(caps, now) : [],
    capabilities,
  };
}

/**
 * Navigation/action gate for #7–#14: true only when the caller may see the
 * capability and the instance serves it. Unknown is not usable.
 */
export function capabilityUsable(view: CapabilitiesView | null, id: CapabilityId): boolean {
  return view?.capabilities.find((c) => c.id === id)?.state === 'available';
}

/**
 * Display name for Arc's license tier. Arc's API still sends the original
 * identifiers (internal/license/license.go); the product names are Tier I–IV.
 * Anything else (a future identifier) is shown as Arc sent it.
 */
const TIER_LABELS: Record<string, string> = {
  starter: 'Tier I',
  professional: 'Tier II',
  enterprise: 'Tier III',
  unlimited: 'Tier IV',
};

export function tierLabel(tier: string | null): string | null {
  if (!tier || tier === 'oss') return null;
  return TIER_LABELS[tier] ?? tier;
}

/** One-line explanation for a capability state, for the UI. */
export function describeCapability(c: Pick<CapabilityView, 'state' | 'reason'>): string {
  switch (c.reason) {
    case 'ok': return 'Available';
    case 'not_licensed': return 'Not included in the license';
    case 'disabled_in_config': return 'Licensed, but turned off in Arc’s configuration';
    case 'arc_auth_off': return 'Requires authentication to be enabled in Arc';
    case 'not_enabled': return 'Not enabled on this instance';
    case 'token_not_admin': return 'Cannot check: the stored token is not an admin token';
    case 'token_rejected': return 'Cannot check: Arc rejected the stored token';
    case 'no_token': return 'Cannot check: no admin token is stored';
    case 'unreachable': return 'Cannot check: Arc did not respond';
    case 'error': return 'Cannot check: unexpected response from Arc';
  }
}
