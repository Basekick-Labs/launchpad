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
  | 'compaction'
  | 'cq_scheduler'
  | 'retention_scheduler';

export interface CapabilityDefinition {
  id: CapabilityId;
  label: string;
  /** Arc license feature that gates it; null for features Arc ships in OSS. */
  licenseFeature: string | null;
  /**
   * Cheap admin-gated GET whose status says whether the area is served. Chosen
   * for a small, bounded handler: tiering/status and audit/stats scan tables,
   * so tiering/policies and audit/logs?limit=1 stand in for them. Null when
   * the state comes from /api/v1/cluster or /api/v1/schedulers instead.
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
  // Admin-only like the Retention and CQ tabs they explain: the proxy does not
  // let members reach either area.
  { id: 'cq_scheduler', label: 'CQ scheduler', licenseFeature: 'cq_scheduler', probePath: null, minRole: 'admin' },
  { id: 'retention_scheduler', label: 'Retention scheduler', licenseFeature: 'retention_scheduler', probePath: null, minRole: 'admin' },
];

export type CapabilityState = 'available' | 'unlicensed' | 'disabled' | 'unavailable' | 'unknown';

export type CapabilityReason =
  | 'ok'
  | 'not_licensed'
  | 'disabled_in_config'
  | 'turned_off'
  | 'arc_auth_off'
  | 'off_or_failed_to_start'
  | 'failed_to_start'
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

/** One scheduler from /api/v1/schedulers, validated. */
export interface SchedulerInfo {
  running: boolean;
  /** Arc's reason when it reports the scheduler as not set up; null otherwise. */
  reason: string | null;
  /** Whether the license still includes the scheduler; null when not reported. */
  licenseValid: boolean | null;
  /** CQ scheduler: jobs scheduled. */
  jobCount: number | null;
  /** Retention scheduler: its cron expression and next run (ISO 8601). */
  schedule: string | null;
  nextRun: string | null;
  /**
   * False on a cluster node that is not the primary writer: its scheduler runs
   * but skips every tick, and the primary writer runs the jobs. Null when Arc
   * does not say (standalone, or a CQ scheduler with no retention to infer from).
   */
  canRun: boolean | null;
  /** That node's cluster role (reader, compactor, writer), when Arc reports it. */
  nodeRole: string | null;
}

export interface SchedulersInfo {
  cq: SchedulerInfo | null;
  retention: SchedulerInfo | null;
}

/** What a running scheduler reports, for the views that explain it. */
export type SchedulerDetail = Pick<SchedulerInfo, 'jobCount' | 'schedule' | 'nextRun' | 'canRun' | 'nodeRole'>;

export interface ClusterInfo {
  enabled: boolean;
  reason: string | null;
  licenseValid: boolean | null;
  features: string[] | null;
  version: string | null;
  /** The answering node's cluster role (local_role), identifier-checked. */
  localRole: string | null;
}

export interface ProbeResults {
  /**
   * Whether a token is stored. Without one only /health is probed: an Arc with
   * auth on would log every other probe as a failed authentication.
   */
  hasToken: boolean;
  /** null when /health could not be read at all. */
  health: { license: LicenseSummary | null } | null;
  /** Permissions of the stored token from /api/v1/auth/verify; null = unknown. */
  tokenPermissions: string[] | null;
  /** Arc answered 401 to the stored token; nothing past /health was probed. */
  tokenRejected: boolean;
  /** The /api/v1/cluster answer; undefined when not probed. */
  clusterProbe?: ProbeOutcome;
  /** Its parsed body, when it was a 2xx Arc cluster response. */
  cluster: ClusterInfo | null;
  /** The /api/v1/schedulers answer; undefined when not probed. */
  schedulersProbe?: ProbeOutcome;
  /** Its parsed body, when it was a 2xx answer. */
  schedulers: SchedulersInfo | null;
  /** Gated probe answers; an absent id was not probed (see the token fields). */
  probes: Partial<Record<CapabilityId, ProbeOutcome>>;
}

export interface CapabilityResult {
  state: CapabilityState;
  reason: CapabilityReason;
  /** Set for a running scheduler only. */
  scheduler?: SchedulerDetail;
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

/**
 * Tier and status identifiers are shown in the UI, and the Arc server is
 * whatever the org admin pointed the connection at: accept identifier-shaped
 * values only, so a server cannot put its own sentences in a Launchpad notice.
 */
const IDENTIFIER_RE = /^[a-z0-9_-]{1,32}$/i;

function identifier(value: unknown): string | null {
  const v = str(value);
  return v && IDENTIFIER_RE.test(v) ? v : null;
}

/** Validate the `license` block of /health. Anything malformed is ignored. */
export function parseHealthLicense(value: unknown): LicenseSummary | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const tier = identifier(v.tier);
  const rawStatus = identifier(v.status);
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
    localRole: typeof v.local_role === 'string' && /^[a-z_]{1,32}$/.test(v.local_role) ? v.local_role : null,
  };
}

/**
 * Arc parses the retention schedule as a five-field cron expression
 * (robfig/cron), so only that shape is kept. Anything else is not shown: like
 * tier names, it ends up in Launchpad's own sentences.
 */
const CRON_RE = /^[0-9A-Za-z*?/,#-]{1,20}(?: [0-9A-Za-z*?/,#-]{1,20}){4}$/;

/** Validate one scheduler of a /api/v1/schedulers body. */
export function parseSchedulerInfo(value: unknown): SchedulerInfo | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  // Running or not, a scheduler Arc created reports Status(); one it did not
  // create (unlicensed, off in config, failed to construct) is
  // {enabled: false, reason} (internal/api/scheduler.go).
  if (typeof v.running !== 'boolean' && v.enabled !== false) return null;
  const nextRun = str(v.next_run);
  const nextRunAt = nextRun ? Date.parse(nextRun) : NaN;
  return {
    running: v.running === true,
    reason: v.enabled === false ? str(v.reason) : null,
    licenseValid: typeof v.license_valid === 'boolean' ? v.license_valid : null,
    jobCount: typeof v.job_count === 'number' && Number.isInteger(v.job_count) && v.job_count >= 0 ? v.job_count : null,
    schedule: typeof v.schedule === 'string' && CRON_RE.test(v.schedule) ? v.schedule : null,
    // Arc sends Go's zero time when the schedule does not parse.
    nextRun: nextRunAt > 0 ? new Date(nextRunAt).toISOString() : null,
    // The retention scheduler reports its cluster gate (can_run, gate_role);
    // the CQ scheduler does not (see parseSchedulers).
    canRun: typeof v.can_run === 'boolean' ? v.can_run : null,
    nodeRole: typeof v.gate_role === 'string' && /^[a-z_]{1,32}$/.test(v.gate_role) ? v.gate_role : null,
  };
}

/** Validate a /api/v1/schedulers body. Null when it is not one. */
export function parseSchedulers(value: unknown): SchedulersInfo | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const cq = parseSchedulerInfo(v.cq_scheduler);
  const retention = parseSchedulerInfo(v.retention_scheduler);
  // Both schedulers skip their ticks on a node that is not the primary writer,
  // through the same gate (newWriterClusterGate in Arc's cmd/arc/main.go), but
  // only the retention scheduler reports it (whenever it has a gate, running
  // or not). Its answer holds for this node.
  if (cq && cq.canRun === null && retention && retention.canRun !== null) {
    cq.canRun = retention.canRun;
    cq.nodeRole = retention.nodeRole;
  }
  return cq || retention ? { cq, retention } : null;
}

/** Arc's license-gate wording (e.g. internal/api/tiering.go). */
export const LICENSE_403 = /requires an enterprise license/i;
/** auth.RequireAdmin's wording; it runs before the license gate. */
export const ADMIN_403 = /admin required|permission denied/i;

/**
 * True when the license keeps Enterprise features on. v26.09.3 relays a
 * license-server `read_only` status, under which its IsValid() is false.
 */
function licenseIsLive(license: LicenseSummary | null): boolean {
  if (!license || license.tier === 'oss') return false;
  return license.status === 'active' || license.status === 'grace_period' || license.status === 'writes_stopped';
}

/** A non-2xx (or failed) answer to a request Arc should have served. */
function classifyFailure(outcome: ProbeOutcome): CapabilityResult {
  if (outcome === null) return { state: 'unknown', reason: 'unreachable' };
  if (outcome.status === 401) return { state: 'unknown', reason: 'token_rejected' };
  if (outcome.status === 403 && ADMIN_403.test(outcome.body)) return { state: 'unknown', reason: 'token_not_admin' };
  return { state: 'unknown', reason: 'error' };
}

function classifyCluster(probes: ProbeResults, license: LicenseSummary | null): CapabilityResult {
  const c = probes.cluster;
  if (!c) return probes.clusterProbe === undefined ? { state: 'unknown', reason: 'error' } : classifyFailure(probes.clusterProbe);
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

function classifyScheduler(probes: ProbeResults, which: keyof SchedulersInfo): CapabilityResult {
  const cluster = probes.cluster;
  if (!probes.schedulers) {
    return probes.schedulersProbe === undefined ? { state: 'unknown', reason: 'error' } : classifyFailure(probes.schedulersProbe);
  }
  const info = probes.schedulers[which];
  if (!info) return { state: 'unknown', reason: 'error' };
  // A scheduler created under a license that lapsed since keeps running but
  // skips every run (internal/scheduler/*_scheduler.go).
  if (info.licenseValid === false) return { state: 'unlicensed', reason: 'not_licensed' };
  if (info.running) {
    let { canRun, nodeRole } = info;
    // No gate reported (e.g. retention off on this node, so nothing to infer
    // the CQ gate from): a reader or compactor is never the primary writer.
    const role = cluster?.enabled ? cluster.localRole : null;
    if (canRun === null && (role === 'reader' || role === 'compactor')) {
      canRun = false;
      nodeRole = role;
    }
    return {
      state: 'available',
      reason: 'ok',
      scheduler: { jobCount: info.jobCount, schedule: info.schedule, nextRun: info.nextRun, canRun, nodeRole },
    };
  }
  // Created but not running: Arc logged why its Start() failed.
  if (info.reason === null) return { state: 'disabled', reason: 'failed_to_start' };
  // Arc's reasons: "Enterprise license required", "License tier does not
  // include CQ|retention scheduler feature", and "... not enabled
  // (continuous_query|retention.enabled=false)", to which Arc main (after
  // v26.09.4) adds ", or the scheduler failed to start (see the startup log)".
  if (/licen[cs]e/i.test(info.reason)) return { state: 'unlicensed', reason: 'not_licensed' };
  if (/not enabled/i.test(info.reason)) {
    return { state: 'disabled', reason: /failed to start/i.test(info.reason) ? 'off_or_failed_to_start' : 'disabled_in_config' };
  }
  return { state: 'unknown', reason: 'error' };
}

function classifyProbe(
  def: CapabilityDefinition,
  outcome: ProbeOutcome | undefined,
  license: LicenseSummary | null,
  features: string[] | null,
): CapabilityResult {
  if (outcome === undefined) return { state: 'unknown', reason: 'error' };
  if (outcome === null) return { state: 'unknown', reason: 'unreachable' };
  const { status, body } = outcome;
  if (status >= 200 && status < 300) return { state: 'available', reason: 'ok' };
  // RequireAdmin runs before the license gate, so a non-admin token gets a
  // 403 too. Only Arc's license wording means "not licensed".
  if (status === 403 && LICENSE_403.test(body) && !ADMIN_403.test(body)) {
    return { state: 'unlicensed', reason: 'not_licensed' };
  }
  if (status === 404) {
    // OSS features (backup, compaction) are only absent when off in config.
    if (def.licenseFeature === null) return { state: 'disabled', reason: 'turned_off' };
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
  if (status === 503) return { state: 'disabled', reason: def.licenseFeature === null ? 'turned_off' : 'disabled_in_config' };
  return classifyFailure(outcome);
}

/** Why gated probes were skipped, when the token says they would fail. */
function skippedReason(probes: ProbeResults, tokenIsAdmin: boolean | null): CapabilityReason | null {
  if (!probes.hasToken) return 'no_token';
  if (probes.tokenRejected) return 'token_rejected';
  if (tokenIsAdmin === false) return 'token_not_admin';
  return null;
}

/** The decision table: probe results → per-capability states. */
export function deriveCapabilities(probes: ProbeResults): InstanceCapabilities {
  const license = probes.health?.license ?? null;
  // A feature list is only trustworthy from a valid license: Arc returns it
  // even when `valid` is false.
  const features = probes.cluster?.licenseValid === true ? probes.cluster.features : null;
  const tokenIsAdmin = probes.tokenPermissions ? probes.tokenPermissions.includes('admin') : null;

  const skipped = skippedReason(probes, tokenIsAdmin);

  const classify = (def: CapabilityDefinition): CapabilityResult => {
    if (!probes.health) return { state: 'unknown', reason: 'unreachable' };
    // /api/v1/cluster and /api/v1/schedulers take any valid token, so only a
    // missing or rejected token leaves them unprobed; gated areas also need admin.
    if (def.probePath === null) {
      if (skipped && skipped !== 'token_not_admin') return { state: 'unknown', reason: skipped };
      if (def.id === 'cluster') return classifyCluster(probes, license);
      if (def.id === 'cq_scheduler') return classifyScheduler(probes, 'cq');
      if (def.id === 'retention_scheduler') return classifyScheduler(probes, 'retention');
      return { state: 'unknown', reason: 'error' };
    }
    if (skipped) return { state: 'unknown', reason: skipped };
    return classifyProbe(def, probes.probes[def.id], license, features);
  };
  const capabilities = Object.fromEntries(CAPABILITIES.map((def) => [def.id, classify(def)])) as Record<
    CapabilityId,
    CapabilityResult
  >;

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

  const tokenReason = caps.capabilities.cluster.reason;
  if (tokenReason === 'token_rejected') {
    notices.push({
      severity: 'warning',
      message: 'Arc rejected the stored token, so Enterprise features cannot be checked. Update the connection with a valid admin token.',
    });
  } else if (tokenReason === 'no_token') {
    notices.push({
      severity: 'info',
      message: 'No admin token is stored for this connection, so Enterprise features cannot be checked.',
    });
  } else if (caps.tokenIsAdmin === false) {
    notices.push({
      severity: 'warning',
      message: 'The stored Arc token lacks admin permission, so Enterprise features cannot be checked. Update the connection with an admin token.',
    });
  }
  if (!lic) return notices;

  const anyAvailable = anyLicensedAvailable(caps);
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
      notices.push({ severity: 'critical', message: 'The license is read-only. Arc is refusing writes, and Enterprise features are off.' });
      break;
    case 'unlicensed':
      notices.push({ severity: 'critical', message: 'Arc reports the license as not active, so Enterprise features are off.' });
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
  scheduler?: SchedulerDetail;
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

function anyLicensedAvailable(caps: InstanceCapabilities): boolean {
  return CAPABILITIES.some((d) => d.licenseFeature !== null && caps.capabilities[d.id].state === 'available');
}

/**
 * Enterprise UI is driven by what the instance shows, not its tier name: a
 * configured license (any tier, including a failed one, so its notice is
 * seen) or an observed licensed feature.
 */
function enterpriseObserved(caps: InstanceCapabilities): boolean {
  return caps.license !== null || anyLicensedAvailable(caps);
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


/** Arc's API still sends the original identifiers (internal/license/license.go). */
const TIER_LABELS: Record<string, string> = {
  starter: 'Tier I',
  professional: 'Tier II',
  enterprise: 'Tier III',
  unlimited: 'Tier IV',
};

/**
 * Display name for Arc's license tier: the product names are Tier I–IV.
 * Anything else (a future identifier) is shown as Arc sent it, already
 * restricted to identifier characters by parseHealthLicense.
 */
export function tierLabel(tier: string | null): string | null {
  if (!tier || tier === 'oss') return null;
  return TIER_LABELS[tier] ?? tier;
}

/**
 * Navigation/action gate: true when the caller may see the capability and
 * its state is one of `states`. Unknown is never usable.
 */
export function capabilityIn(view: CapabilitiesView | null, id: CapabilityId, states: readonly CapabilityState[]): boolean {
  const c = findCapability(view, id);
  return !!c && states.includes(c.state);
}

/** The caller's view of one capability; null when not loaded or not visible to the role. */
export function findCapability(view: CapabilitiesView | null, id: CapabilityId): CapabilityView | null {
  return view?.capabilities.find((x) => x.id === id) ?? null;
}

/** The common case of {@link capabilityIn}: the instance serves it. */
export function capabilityUsable(view: CapabilitiesView | null, id: CapabilityId): boolean {
  return capabilityIn(view, id, ['available']);
}

/** A node that is not the primary writer, for the scheduler texts. */
function nodeLabel(role: string | null): string {
  if (role === 'writer') return 'a writer that is not the primary';
  return role ?? 'not the primary writer';
}

/** A UTC minute, for times shown outside the browser's locale formatting. */
function formatMinute(iso: string): string {
  return `${iso.slice(0, 16).replace('T', ' ')} UTC`;
}

/** One-line explanation for a capability state, for the UI. */
export function describeCapability(c: Pick<CapabilityView, 'state' | 'reason' | 'scheduler'>): string {
  if (c.scheduler) {
    const { jobCount, nextRun, canRun, nodeRole } = c.scheduler;
    if (canRun === false) return `Skipped on this node (${nodeLabel(nodeRole)}); only the primary writer runs it`;
    if (jobCount !== null) return `Running, ${jobCount} job${jobCount === 1 ? '' : 's'}`;
    return nextRun ? `Running, next run ${formatMinute(nextRun)}` : 'Running';
  }
  switch (c.reason) {
    case 'ok': return 'Available';
    case 'not_licensed': return 'Not included in the license';
    case 'disabled_in_config': return 'Licensed, but turned off in Arc’s configuration';
    case 'turned_off': return 'Turned off in Arc’s configuration';
    case 'arc_auth_off': return 'Requires authentication to be enabled in Arc';
    case 'off_or_failed_to_start': return 'Licensed, but turned off in Arc’s configuration or failed to start';
    case 'failed_to_start': return 'Licensed, but failed to start (see Arc’s startup log)';
    case 'not_enabled': return 'Not enabled on this instance';
    case 'token_not_admin': return 'Cannot check: the stored token is not an admin token';
    case 'token_rejected': return 'Cannot check: Arc rejected the stored token';
    case 'no_token': return 'Cannot check: no admin token is stored';
    case 'unreachable': return 'Cannot check: Arc did not respond';
    case 'error': return 'Cannot check: unexpected response from Arc';
  }
}

export interface SchedulerNotice {
  running: boolean;
  message: string;
}

const SCHEDULED = {
  cq_scheduler: { name: 'The CQ scheduler', config: 'continuous_query', what: 'Continuous queries' },
  retention_scheduler: { name: 'The retention scheduler', config: 'retention', what: 'Retention policies' },
} as const;

/**
 * What the CQ or retention view says about its scheduler: definitions only
 * run on their own while it runs. Null when its state is not known (not
 * loaded, or discovery could not check), so a view says nothing rather than
 * guess. `formatTime` renders the next run in the viewer's locale.
 */
export function schedulerNotice(
  c: Pick<CapabilityView, 'id' | 'state' | 'reason' | 'scheduler'> | null,
  formatTime: (iso: string) => string = formatMinute,
): SchedulerNotice | null {
  if (!c || (c.id !== 'cq_scheduler' && c.id !== 'retention_scheduler')) return null;
  const s = SCHEDULED[c.id];
  if (c.state === 'available') {
    const d = c.scheduler;
    if (d?.canRun === false) {
      return {
        running: true,
        message: `On a cluster only the primary writer runs ${s.what.toLowerCase()}; this node (${nodeLabel(d.nodeRole)}) skips every run.`,
      };
    }
    let detail = '';
    if (c.id === 'cq_scheduler') {
      if (d && d.jobCount !== null) detail = `, with ${d.jobCount} active quer${d.jobCount === 1 ? 'y' : 'ies'} scheduled`;
    } else {
      if (d?.schedule) detail += ` on schedule ${d.schedule}`;
      if (d?.nextRun) detail += `; next run ${formatTime(d.nextRun)}`;
    }
    return { running: true, message: `${s.name} is running${detail}.` };
  }
  const manual = `${s.what} only run when executed manually.`;
  switch (c.reason) {
    case 'not_licensed':
      return { running: false, message: `${s.name} needs an Arc Enterprise license that includes it. ${manual}` };
    case 'disabled_in_config':
      return { running: false, message: `${s.name} is off because ${s.config}.enabled is false in Arc’s configuration. ${manual}` };
    case 'off_or_failed_to_start':
      return {
        running: false,
        message: `${s.name} is not running: ${s.config}.enabled is false in Arc’s configuration, or it failed to start (see Arc’s startup log). ${manual}`,
      };
    case 'failed_to_start':
      return { running: false, message: `${s.name} failed to start (see Arc’s startup log). ${manual}` };
    default:
      return null;
  }
}
