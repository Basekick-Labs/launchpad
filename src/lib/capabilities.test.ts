import { describe, expect, it } from 'vitest';
import {
  capabilityUsable,
  deriveCapabilities,
  describeCapability,
  findCapability,
  licenseNotices,
  normalizeVersion,
  parseClusterInfo,
  parseHealthLicense,
  parseSchedulerInfo,
  parseSchedulers,
  schedulerNotice,
  tierLabel,
  viewForRole,
  type CapabilityId,
  type ClusterInfo,
  type LicenseSummary,
  type ProbeOutcome,
  type ProbeResults,
  type SchedulersInfo,
} from './capabilities';

const ok: ProbeOutcome = { status: 200, body: '{}' };
const notFound: ProbeOutcome = { status: 404, body: '{"error":"Cannot GET /api/v1/x"}' };
const licenseDenied = (feature: string): ProbeOutcome => ({
  status: 403,
  body: `{"success":false,"error":"X requires an enterprise license with the '${feature}' feature enabled"}`,
});
const adminDenied: ProbeOutcome = { status: 403, body: '{"error":"Permission denied: admin required","success":false}' };

const GATED: CapabilityId[] = ['rbac', 'tiering', 'query_governance', 'query_management', 'audit_log', 'backup', 'compaction'];

function license(overrides: Partial<LicenseSummary> = {}): LicenseSummary {
  return {
    tier: 'enterprise', status: 'active', rawStatus: null,
    expiresAt: '2031-01-07T19:20:56Z', graceDay: null, writesStopAt: null, cutoff: null,
    ...overrides,
  };
}

const standalone: ClusterInfo = {
  enabled: false,
  reason: 'Clustering not enabled in configuration (cluster.enabled=false)',
  licenseValid: null,
  features: null,
  version: null,
};

/**
 * GET /api/v1/schedulers bodies as Arc sends them. Running shapes come from
 * Status() in internal/scheduler/*_scheduler.go; the others from
 * internal/api/scheduler.go on main and at v26.09.3.
 */
const SCHEDULERS = {
  running: {
    cq_scheduler: {
      running: true, license_valid: true, job_count: 2,
      jobs: [{ cq_id: 1, cq_name: 'cpu_1m', interval: '1m0s' }, { cq_id: 2, cq_name: 'mem_1h', interval: '1h0m0s' }],
    },
    retention_scheduler: { running: true, license_valid: true, schedule: '0 3 * * *', next_run: '2026-11-10T03:00:00-06:00' },
  },
  oss: {
    cq_scheduler: { enabled: false, reason: 'Enterprise license required' },
    retention_scheduler: { enabled: false, reason: 'Enterprise license required' },
  },
  tier: {
    cq_scheduler: { enabled: false, reason: 'License tier does not include CQ scheduler feature' },
    retention_scheduler: { enabled: false, reason: 'License tier does not include retention scheduler feature' },
  },
  offMain: {
    cq_scheduler: {
      enabled: false,
      reason: 'CQ feature not enabled (continuous_query.enabled=false), or the scheduler failed to start (see the startup log)',
    },
    retention_scheduler: {
      enabled: false,
      reason: 'Retention feature not enabled (retention.enabled=false), or the scheduler failed to start (see the startup log)',
    },
  },
  offV26093: {
    cq_scheduler: { enabled: false, reason: 'CQ feature not enabled (continuous_query.enabled=false)' },
    retention_scheduler: { enabled: false, reason: 'Retention feature not enabled (retention.enabled=false)' },
  },
  // Created, but Start() failed: Status() of a scheduler that is not running.
  notStarted: {
    cq_scheduler: { running: false, license_valid: true, job_count: 0, jobs: [] },
    retention_scheduler: { running: false, license_valid: true, schedule: '0 3 * * *' },
  },
  // Started under a license that has since lapsed: running, but skipping every run.
  lapsed: {
    cq_scheduler: { running: true, license_valid: false, job_count: 2, jobs: [] },
    retention_scheduler: { running: true, license_valid: false, schedule: '0 3 * * *', next_run: '2026-11-10T09:00:00Z' },
  },
} as const;

const schedulers = (body: unknown): SchedulersInfo => parseSchedulers(JSON.parse(JSON.stringify(body)))!;

function probes(overrides: Partial<ProbeResults> = {}, each: ProbeOutcome = ok): ProbeResults {
  return {
    hasToken: true,
    health: { license: license() },
    tokenPermissions: ['read', 'write', 'delete', 'admin'],
    tokenRejected: false,
    cluster: standalone,
    schedulers: schedulers(SCHEDULERS.running),
    probes: Object.fromEntries(GATED.map((id) => [id, each])),
    ...overrides,
  };
}

const states = (p: ProbeResults) =>
  Object.fromEntries(Object.entries(deriveCapabilities(p).capabilities).map(([k, v]) => [k, v.state]));

describe('deriveCapabilities: OSS', () => {
  // No license configured: /health has no license block, gated routes are not
  // registered (404), and RBAC answers its license 403.
  const oss = probes({
    health: { license: null },
    cluster: { ...standalone, reason: 'Enterprise license not configured' },
    schedulers: schedulers(SCHEDULERS.oss),
    probes: {
      rbac: licenseDenied('rbac'),
      tiering: notFound, query_governance: notFound, query_management: notFound, audit_log: notFound,
      backup: ok, compaction: ok,
    },
  });

  it('marks licensed features unlicensed and keeps OSS features', () => {
    expect(states(oss)).toEqual({
      cluster: 'unlicensed', rbac: 'unlicensed', tiering: 'unlicensed', query_governance: 'unlicensed',
      query_management: 'unlicensed', audit_log: 'unlicensed', backup: 'available', compaction: 'available',
      cq_scheduler: 'unlicensed', retention_scheduler: 'unlicensed',
    });
  });

  it('hides the Enterprise section, even from admins', () => {
    const view = viewForRole(deriveCapabilities(oss), 'owner');
    expect(view.showEnterprise).toBe(false);
    expect(view.tier).toBeNull();
    expect(view.notices).toEqual([]);
  });
});

describe('deriveCapabilities: Enterprise', () => {
  it('marks every served area available', () => {
    expect(new Set(Object.values(states(probes({ cluster: { ...standalone, enabled: true, reason: null } }))))).toEqual(
      new Set(['available']),
    );
  });

  it('reads the version of the answering node in cluster mode', () => {
    const cluster = parseClusterInfo({
      enabled: true,
      local_node_id: 'n2',
      nodes: [{ id: 'n1', version: '27.01.0' }, { id: 'n2', version: 'v27.01.1' }],
      license: { valid: true, tier: 'enterprise', features: ['clustering'] },
    });
    expect(deriveCapabilities(probes({ cluster })).version).toBe('27.01.1');
  });
});

describe('deriveCapabilities: partially available', () => {
  it('cannot tell unlicensed from disabled on a standalone node, and says so', () => {
    // The dev instance this was built against: standalone, RBAC/backup/
    // compaction served, the rest not set up at boot.
    const p = probes({
      probes: {
        rbac: ok, backup: ok, compaction: ok,
        tiering: notFound, query_governance: notFound, query_management: notFound, audit_log: notFound,
      },
    });
    expect(states(p)).toMatchObject({
      cluster: 'disabled', rbac: 'available', backup: 'available', compaction: 'available',
      tiering: 'unavailable', query_governance: 'unavailable', query_management: 'unavailable', audit_log: 'unavailable',
    });
  });

  it('uses a valid cluster feature list to split disabled from unlicensed', () => {
    const p = probes({
      cluster: { enabled: true, reason: null, licenseValid: true, features: ['clustering', 'tiering'], version: null },
      probes: { ...probes().probes, tiering: notFound, audit_log: notFound },
    });
    expect(states(p)).toMatchObject({ tiering: 'disabled', audit_log: 'unlicensed' });
  });

  it('ignores the feature list of an invalid license', () => {
    const p = probes({
      cluster: { enabled: false, reason: 'Enterprise license not valid', licenseValid: false, features: ['tiering'], version: null },
      probes: { ...probes().probes, tiering: notFound },
    });
    expect(states(p)).toMatchObject({ cluster: 'unlicensed', tiering: 'unavailable' });
  });

  it('treats backup and compaction 404 as off in config, never unlicensed', () => {
    const p = probes({ health: { license: null }, probes: { ...probes().probes, backup: notFound, compaction: notFound } });
    expect(states(p)).toMatchObject({ backup: 'disabled', compaction: 'disabled' });
  });

  it('reads an RBAC 404 as Arc running without auth', () => {
    const caps = deriveCapabilities(probes({ probes: { ...probes().probes, rbac: notFound } }));
    expect(caps.capabilities.rbac).toEqual({ state: 'disabled', reason: 'arc_auth_off' });
  });

  it('reads a license 403 after boot as unlicensed', () => {
    const caps = deriveCapabilities(probes({ probes: { ...probes().probes, tiering: licenseDenied('tiering') } }));
    expect(caps.capabilities.tiering).toEqual({ state: 'unlicensed', reason: 'not_licensed' });
  });
});

describe('deriveCapabilities: the stored token', () => {
  it('does not mistake a non-admin token for a missing license', () => {
    const caps = deriveCapabilities(probes({ tokenPermissions: ['read', 'write'] }, adminDenied));
    expect(caps.tokenIsAdmin).toBe(false);
    expect(caps.capabilities.rbac).toEqual({ state: 'unknown', reason: 'token_not_admin' });
    expect(caps.capabilities.tiering).toEqual({ state: 'unknown', reason: 'token_not_admin' });
    expect(licenseNotices(caps)[0].message).toMatch(/lacks admin permission/);
  });

  it('reports a rejected token as unknown', () => {
    const caps = deriveCapabilities(probes({ tokenRejected: true, cluster: null }, { status: 401, body: '' }));
    expect(caps.capabilities.rbac.reason).toBe('token_rejected');
    expect(caps.capabilities.cluster.reason).toBe('token_rejected');
  });

  it('only reports what /health says when no token is stored', () => {
    const caps = deriveCapabilities(probes({ hasToken: false, tokenPermissions: null, cluster: null, probes: {} }));
    expect(new Set(Object.values(caps.capabilities).map((c) => c.reason))).toEqual(new Set(['no_token']));
    expect(caps.license?.tier).toBe('enterprise');
  });
});

describe('deriveCapabilities: failures', () => {
  it('marks everything unknown when Arc is unreachable', () => {
    const caps = deriveCapabilities(probes({ health: null }));
    expect(caps.reachable).toBe(false);
    expect(new Set(Object.values(caps.capabilities).map((c) => c.reason))).toEqual(new Set(['unreachable']));
  });

  it('marks a failed probe or an unexpected status unknown', () => {
    const p = probes({ probes: { ...probes().probes, tiering: null, audit_log: { status: 500, body: 'boom' } } });
    expect(states(p)).toMatchObject({ tiering: 'unknown', audit_log: 'unknown' });
  });
});

describe('license states degrade gracefully', () => {
  const now = Date.parse('2026-11-09T12:00:00Z');

  it('expired after a restart: 404s become unlicensed, notice is critical', () => {
    // Arc then creates neither scheduler, and says a license is required.
    const caps = deriveCapabilities(probes(
      { health: { license: license({ status: 'expired', expiresAt: '2026-10-01T00:00:00Z' }) }, schedulers: schedulers(SCHEDULERS.oss), probes: { rbac: licenseDenied('rbac'), backup: ok, compaction: ok, tiering: notFound, query_governance: notFound, query_management: notFound, audit_log: notFound } },
    ));
    expect(caps.capabilities.tiering.state).toBe('unlicensed');
    expect(licenseNotices(caps, now)).toEqual([
      { severity: 'critical', message: 'The license expired on 2026-10-01. Enterprise features are off.' },
    ]);
  });

  it('expired on v26.09.3 before a restart: features still respond, notice says so', () => {
    const caps = deriveCapabilities(probes({ health: { license: license({ status: 'expired', expiresAt: '2026-10-01T00:00:00Z' }) } }));
    expect(caps.capabilities.tiering.state).toBe('available');
    expect(licenseNotices(caps, now)[0]).toMatchObject({ severity: 'warning', message: expect.stringMatching(/stop when Arc restarts/) });
  });

  it('grace period, with and without the 27.01 grace fields', () => {
    const full = deriveCapabilities(probes({ health: { license: license({ status: 'grace_period', expiresAt: '2026-11-05T00:00:00Z', graceDay: 4, writesStopAt: '2026-11-12T00:00:00Z' }) } }));
    expect(licenseNotices(full, now)[0].message).toBe(
      'The license expired on 2026-11-05 and is in its grace period (day 4). Writes stop on 2026-11-12.',
    );
    const v26 = deriveCapabilities(probes({ health: { license: license({ status: 'grace_period', expiresAt: '2026-11-05T00:00:00Z' }) } }));
    expect(licenseNotices(v26, now)[0].message).toBe('The license expired on 2026-11-05 and is in its grace period.');
    expect(v26.capabilities.rbac.state).toBe('available');
  });

  it('writes stopped and read-only are critical', () => {
    const stopped = deriveCapabilities(probes({ health: { license: license({ status: 'writes_stopped', cutoff: '2026-11-20T00:00:00Z' }) } }));
    expect(licenseNotices(stopped, now)[0]).toMatchObject({ severity: 'critical', message: expect.stringMatching(/refusing writes, and Enterprise features stop on 2026-11-20/) });
    const readOnly = deriveCapabilities(probes({ health: { license: license({ status: 'read_only' }) } }));
    expect(licenseNotices(readOnly, now)[0].severity).toBe('critical');
  });

  it('a configured license that failed is not silent', () => {
    const caps = deriveCapabilities(probes({
      health: { license: license({ tier: 'oss', status: 'unlicensed', expiresAt: null }) },
      probes: { rbac: licenseDenied('rbac'), backup: ok, compaction: ok, tiering: notFound, query_governance: notFound, query_management: notFound, audit_log: notFound },
    }));
    const view = viewForRole(caps, 'admin', now);
    expect(view.showEnterprise).toBe(true);
    expect(view.notices[0]).toMatchObject({ severity: 'critical', message: expect.stringMatching(/configured .* not active/) });
    expect(view.tier).toBe('oss');
  });

  it('an unrecognized status is kept, not dropped', () => {
    expect(parseHealthLicense({ tier: 'enterprise', status: 'suspended' })).toMatchObject({ status: 'unknown', rawStatus: 'suspended' });
  });

  it('warns 30 days ahead using expires_at (days_remaining is omitted at 0)', () => {
    const soon = deriveCapabilities(probes({ health: { license: license({ expiresAt: '2026-11-09T20:00:00Z' }) } }));
    expect(licenseNotices(soon, now)).toEqual([{ severity: 'info', message: 'The license expires on 2026-11-09 (1 day).' }]);
    const later = deriveCapabilities(probes());
    expect(licenseNotices(later, now)).toEqual([]);
  });
});

describe('parsers', () => {
  it('parses the /health license block from Arc', () => {
    expect(parseHealthLicense({
      tier: 'enterprise', status: 'active', source: 'file', expires_at: '2031-01-07T19:20:56Z', days_remaining: 1520, site_license: true,
    })).toEqual(license());
  });

  it('ignores malformed bodies', () => {
    expect(parseHealthLicense(null)).toBeNull();
    expect(parseHealthLicense({ tier: 3, status: 'active' })).toBeNull();
    expect(parseClusterInfo({ enabled: 'yes' })).toBeNull();
    expect(parseClusterInfo({ enabled: true, license: { valid: true, features: [1] } })).toMatchObject({ features: null });
  });

  it('accepts release versions only', () => {
    expect(normalizeVersion('v26.09.3')).toBe('26.09.3');
    expect(normalizeVersion('27.01.1-rc.1')).toBe('27.01.1-rc.1');
    expect(normalizeVersion('dev')).toBeNull();
    expect(normalizeVersion('<script>')).toBeNull();
  });
});

describe('viewForRole', () => {
  const caps = deriveCapabilities(probes());

  it('gives members no Enterprise or license detail', () => {
    for (const role of ['member', 'viewer', 'nonsense']) {
      const view = viewForRole(caps, role);
      expect(view).toMatchObject({ showEnterprise: false, tier: null, notices: [], capabilities: [] });
    }
  });

  it('gives admins the full view', () => {
    const view = viewForRole(caps, 'admin');
    expect(view.showEnterprise).toBe(true);
    expect(view.tier).toBe('enterprise');
    expect(view.capabilities).toHaveLength(10);
    expect(capabilityUsable(view, 'rbac')).toBe(true);
    expect(capabilityUsable(view, 'cluster')).toBe(false);
    expect(capabilityUsable(null, 'rbac')).toBe(false);
  });

  it('shows the Enterprise section when a licensed feature answers without a license block', () => {
    // Arc auth off and no license configured cannot serve gated routes, but
    // if /health ever stops carrying the license block, observed features
    // still decide.
    const view = viewForRole(deriveCapabilities(probes({ health: { license: null } })), 'owner');
    expect(view.showEnterprise).toBe(true);
  });
});

describe('tierLabel', () => {
  it('maps Arc tier identifiers to the Tier I–IV names', () => {
    expect(['starter', 'professional', 'enterprise', 'unlimited'].map(tierLabel)).toEqual(['Tier I', 'Tier II', 'Tier III', 'Tier IV']);
    expect(tierLabel('oss')).toBeNull();
    expect(tierLabel('custom-x')).toBe('custom-x');
  });
});

describe('review follow-ups', () => {
  it('read_only is not a live license: 404s are unlicensed and the notice says features are off', () => {
    const caps = deriveCapabilities(probes({
      health: { license: license({ status: 'read_only' }) },
      probes: { ...probes().probes, tiering: notFound },
    }));
    expect(caps.capabilities.tiering).toEqual({ state: 'unlicensed', reason: 'not_licensed' });
    expect(licenseNotices(caps)[0].message).toMatch(/Enterprise features are off/);
  });

  it('distinguishes an OSS feature turned off from a licensed one', () => {
    const caps = deriveCapabilities(probes({
      probes: { ...probes().probes, backup: notFound, tiering: { status: 503, body: '' } },
    }));
    expect(caps.capabilities.backup).toEqual({ state: 'disabled', reason: 'turned_off' });
    expect(caps.capabilities.tiering).toEqual({ state: 'disabled', reason: 'disabled_in_config' });
  });

  it('does not read any 403 mentioning "license" as unlicensed', () => {
    const caps = deriveCapabilities(probes({
      probes: { ...probes().probes, tiering: { status: 403, body: 'blocked by license proxy' } },
    }));
    expect(caps.capabilities.tiering).toEqual({ state: 'unknown', reason: 'error' });
  });

  it('gives the cluster probe failure its own reason', () => {
    expect(deriveCapabilities(probes({ cluster: null, clusterProbe: null })).capabilities.cluster.reason).toBe('unreachable');
    expect(deriveCapabilities(probes({ cluster: null, clusterProbe: { status: 404, body: '' } })).capabilities.cluster.reason).toBe('error');
    expect(deriveCapabilities(probes({ cluster: null, clusterProbe: adminDenied })).capabilities.cluster.reason).toBe('token_not_admin');
  });

  it('keeps an unrecognized cluster reason unknown', () => {
    const caps = deriveCapabilities(probes({ cluster: { ...standalone, reason: 'something new' } }));
    expect(caps.capabilities.cluster).toEqual({ state: 'unknown', reason: 'error' });
  });

  it('refuses tier and status values that are not identifiers', () => {
    expect(parseHealthLicense({ tier: 'enterprise', status: 'License revoked, call +1 555 0100' })).toBeNull();
    expect(parseHealthLicense({ tier: 'x'.repeat(33), status: 'active' })).toBeNull();
    expect(parseHealthLicense({ tier: 'tier-5', status: 'suspended_by_vendor' })).toMatchObject({ tier: 'tier-5', rawStatus: 'suspended_by_vendor' });
  });

  it('warns when Arc reports a paid tier as not active', () => {
    const caps = deriveCapabilities(probes({ health: { license: license({ status: 'unlicensed' }) } }));
    expect(licenseNotices(caps)[0]).toMatchObject({ severity: 'critical', message: expect.stringMatching(/not active/) });
  });

  it('every capability gets a result', () => {
    const caps = deriveCapabilities(probes());
    expect(Object.keys(caps.capabilities).sort()).toEqual(
      [
        'audit_log', 'backup', 'cluster', 'compaction', 'cq_scheduler', 'query_governance', 'query_management', 'rbac',
        'retention_scheduler', 'tiering',
      ],
    );
  });

  it('says so when the token is rejected or missing', () => {
    const rejected = deriveCapabilities(probes({ tokenRejected: true, cluster: null }));
    expect(licenseNotices(rejected)[0].message).toMatch(/rejected the stored token/);
    const none = deriveCapabilities(probes({ hasToken: false, tokenPermissions: null, cluster: null, probes: {} }));
    expect(licenseNotices(none)[0].message).toMatch(/No admin token is stored/);
  });
});

describe('schedulers', () => {
  const both = (body: unknown, overrides: Partial<ProbeResults> = {}) => {
    const caps = deriveCapabilities(probes({ schedulers: schedulers(body), ...overrides }));
    return [caps.capabilities.cq_scheduler, caps.capabilities.retention_scheduler];
  };

  it('reads the running shapes, with what each scheduler reports', () => {
    const [cq, retention] = both(SCHEDULERS.running);
    expect(cq).toEqual({ state: 'available', reason: 'ok', scheduler: { jobCount: 2, schedule: null, nextRun: null } });
    expect(retention).toEqual({
      state: 'available',
      reason: 'ok',
      scheduler: { jobCount: null, schedule: '0 3 * * *', nextRun: '2026-11-10T09:00:00.000Z' },
    });
  });

  it('reads "Enterprise license required" (OSS, or a license that is not valid) as unlicensed', () => {
    expect(both(SCHEDULERS.oss)).toEqual([
      { state: 'unlicensed', reason: 'not_licensed' },
      { state: 'unlicensed', reason: 'not_licensed' },
    ]);
  });

  it('reads a tier without the scheduler feature as unlicensed', () => {
    expect(both(SCHEDULERS.tier).map((c) => c.state)).toEqual(['unlicensed', 'unlicensed']);
  });

  it('reads the main wording as off in config or failed to start', () => {
    expect(both(SCHEDULERS.offMain)).toEqual([
      { state: 'disabled', reason: 'off_or_failed_to_start' },
      { state: 'disabled', reason: 'off_or_failed_to_start' },
    ]);
  });

  it('reads the v26.09.3 wording as off in config', () => {
    expect(both(SCHEDULERS.offV26093)).toEqual([
      { state: 'disabled', reason: 'disabled_in_config' },
      { state: 'disabled', reason: 'disabled_in_config' },
    ]);
  });

  it('reads a created scheduler that is not running as failed to start', () => {
    expect(both(SCHEDULERS.notStarted)).toEqual([
      { state: 'disabled', reason: 'failed_to_start' },
      { state: 'disabled', reason: 'failed_to_start' },
    ]);
  });

  it('reads a running scheduler whose license lapsed as unlicensed: it skips every run', () => {
    expect(both(SCHEDULERS.lapsed).map((c) => c.state)).toEqual(['unlicensed', 'unlicensed']);
  });

  it('keeps an unrecognized reason or a missing scheduler unknown', () => {
    const [cq, retention] = both({ cq_scheduler: { enabled: false, reason: 'something new' } });
    expect(cq).toEqual({ state: 'unknown', reason: 'error' });
    expect(retention).toEqual({ state: 'unknown', reason: 'error' });
  });

  it('gives the schedulers probe failure its own reason', () => {
    const cq = (p: Partial<ProbeResults>) => deriveCapabilities(probes({ schedulers: null, ...p })).capabilities.cq_scheduler;
    expect(cq({ schedulersProbe: null })).toEqual({ state: 'unknown', reason: 'unreachable' });
    expect(cq({ schedulersProbe: { status: 404, body: '' } })).toEqual({ state: 'unknown', reason: 'error' });
    expect(cq({ schedulersProbe: { status: 200, body: 'not json' } })).toEqual({ state: 'unknown', reason: 'error' });
    expect(cq({})).toEqual({ state: 'unknown', reason: 'error' });
  });

  it('still reads them with a non-admin token: the route takes any token', () => {
    const caps = deriveCapabilities(probes({ tokenPermissions: ['read'] }, adminDenied));
    expect(caps.capabilities.cq_scheduler.state).toBe('available');
    expect(caps.capabilities.rbac.reason).toBe('token_not_admin');
  });

  it('cannot read them without a token Arc accepts', () => {
    expect(both(SCHEDULERS.running, { tokenRejected: true }).map((c) => c.reason)).toEqual(['token_rejected', 'token_rejected']);
    expect(both(SCHEDULERS.running, { hasToken: false }).map((c) => c.reason)).toEqual(['no_token', 'no_token']);
  });

  it('a running scheduler shows the Enterprise section: it needs a valid license', () => {
    const caps = deriveCapabilities(probes({ health: { license: null }, probes: {} }, notFound));
    expect(viewForRole(caps, 'owner').showEnterprise).toBe(true);
  });

  it('parses only scheduler-shaped bodies', () => {
    expect(parseSchedulers(null)).toBeNull();
    expect(parseSchedulers([])).toBeNull();
    expect(parseSchedulers({ error: 'Cannot GET /api/v1/schedulers' })).toBeNull();
    expect(parseSchedulerInfo({ running: 'yes' })).toBeNull();
    expect(parseSchedulerInfo({ enabled: true })).toBeNull();
  });

  it('drops values it would not show as they are', () => {
    expect(parseSchedulerInfo({
      running: true, job_count: -1, schedule: 'Renew your license at example.com today', next_run: '0001-01-01T00:00:00Z',
    })).toMatchObject({ jobCount: null, schedule: null, nextRun: null });
    expect(parseSchedulerInfo({ running: true, job_count: 1.5, schedule: '0 3 * * * *', next_run: 'soon' }))
      .toMatchObject({ jobCount: null, schedule: null, nextRun: null });
    expect(parseSchedulerInfo({ running: true, schedule: '*/15 1-5 * JAN MON-FRI' })).toMatchObject({ schedule: '*/15 1-5 * JAN MON-FRI' });
    // A reason only comes with the not-created shape.
    expect(parseSchedulerInfo({ running: false, reason: 'x' })).toMatchObject({ reason: null });
  });

  it('describes a running scheduler by what it reports', () => {
    const view = viewForRole(deriveCapabilities(probes()), 'admin');
    expect(describeCapability(findCapability(view, 'cq_scheduler')!)).toBe('Running, 2 jobs');
    expect(describeCapability(findCapability(view, 'retention_scheduler')!)).toBe('Running, next run 2026-11-10 09:00 UTC');
    expect(describeCapability({ state: 'available', reason: 'ok', scheduler: { jobCount: 1, schedule: null, nextRun: null } }))
      .toBe('Running, 1 job');
    expect(describeCapability({ state: 'disabled', reason: 'off_or_failed_to_start' })).toMatch(/failed to start/);
  });

  it('finds a capability only when the role can see it', () => {
    const caps = deriveCapabilities(probes());
    expect(findCapability(viewForRole(caps, 'admin'), 'cq_scheduler')?.state).toBe('available');
    expect(findCapability(viewForRole(caps, 'member'), 'cq_scheduler')).toBeNull();
    expect(findCapability(null, 'cq_scheduler')).toBeNull();
  });
});

describe('schedulerNotice', () => {
  const notice = (body: unknown, id: 'cq_scheduler' | 'retention_scheduler') =>
    schedulerNotice(findCapability(viewForRole(deriveCapabilities(probes({ schedulers: schedulers(body) })), 'admin'), id));

  it('says the scheduler runs, with its jobs or its next run', () => {
    expect(notice(SCHEDULERS.running, 'cq_scheduler')).toEqual({
      running: true, message: 'The CQ scheduler is running, with 2 active queries scheduled.',
    });
    expect(notice(SCHEDULERS.running, 'retention_scheduler')).toEqual({
      running: true, message: 'The retention scheduler is running on schedule 0 3 * * *; next run 2026-11-10 09:00 UTC.',
    });
    const c = findCapability(viewForRole(deriveCapabilities(probes()), 'admin'), 'retention_scheduler');
    expect(schedulerNotice(c, () => 'local time')?.message).toMatch(/next run local time\.$/);
  });

  it('explains each reason it is not running, and that runs are then manual only', () => {
    expect(notice(SCHEDULERS.oss, 'cq_scheduler')?.message).toBe(
      'The CQ scheduler needs an Arc Enterprise license that includes it. Continuous queries only run when executed manually.',
    );
    expect(notice(SCHEDULERS.offV26093, 'retention_scheduler')?.message).toBe(
      'The retention scheduler is off because retention.enabled is false in Arc’s configuration. Retention policies only run when executed manually.',
    );
    expect(notice(SCHEDULERS.offMain, 'cq_scheduler')?.message).toMatch(/continuous_query\.enabled is false .* or it failed to start/);
    expect(notice(SCHEDULERS.notStarted, 'retention_scheduler')?.message).toMatch(/^The retention scheduler failed to start/);
    for (const body of [SCHEDULERS.oss, SCHEDULERS.tier, SCHEDULERS.offMain, SCHEDULERS.offV26093, SCHEDULERS.notStarted, SCHEDULERS.lapsed]) {
      expect(notice(body, 'cq_scheduler')).toMatchObject({ running: false, message: expect.stringMatching(/executed manually\.$/) });
    }
  });

  it('says nothing when the state is not known', () => {
    expect(schedulerNotice(null)).toBeNull();
    expect(schedulerNotice({ id: 'cq_scheduler', state: 'unknown', reason: 'unreachable' })).toBeNull();
    expect(schedulerNotice({ id: 'rbac', state: 'available', reason: 'ok' })).toBeNull();
  });
});
