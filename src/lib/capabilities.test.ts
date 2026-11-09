import { describe, expect, it } from 'vitest';
import {
  capabilityUsable,
  deriveCapabilities,
  licenseNotices,
  normalizeVersion,
  parseClusterInfo,
  parseHealthLicense,
  tierLabel,
  viewForRole,
  type CapabilityId,
  type ClusterInfo,
  type LicenseSummary,
  type ProbeOutcome,
  type ProbeResults,
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

function probes(overrides: Partial<ProbeResults> = {}, each: ProbeOutcome = ok): ProbeResults {
  return {
    hasToken: true,
    health: { license: license() },
    tokenPermissions: ['read', 'write', 'delete', 'admin'],
    tokenRejected: false,
    cluster: standalone,
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
    const caps = deriveCapabilities(probes(
      { health: { license: license({ status: 'expired', expiresAt: '2026-10-01T00:00:00Z' }) }, probes: { rbac: licenseDenied('rbac'), backup: ok, compaction: ok, tiering: notFound, query_governance: notFound, query_management: notFound, audit_log: notFound } },
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
    expect(view.capabilities).toHaveLength(8);
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
