import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from './db';
import {
  DashboardNotFoundError,
  VersionConflictError,
  dashboardsUsingInstance,
  deleteDashboard,
  getDashboard,
  getDashboardForUser,
  getVersionModelJson,
  insertDashboard,
  listDashboards,
  listVersions,
  restoreVersion,
  updateDashboard,
} from './dashboards';
import { assertInstancesInOrg, InstanceNotInOrgError, resolveTargetInstance, resolveTargetCredential } from './dashboardInstance';
import { createDashboard, createPanel, LIMITS, type Dashboard } from '$lib/dashboard/model';
import type { OrgScope } from '$lib/roles';

// The test DB is :memory: via vitest.config.ts `test.env`. It MUST be set
// there: db.ts reads the path at module evaluation and ESM hoists imports, so
// setting it in this file would run too late and write to data/launchpad.db.
const ORG_A = 'org-a' as OrgScope;
const ORG_B = 'org-b' as OrgScope;
const USER_1 = 'user-1';
const USER_2 = 'user-2';

function seed(): void {
  const db = getDb();
  db.exec(`
    DELETE FROM dashboard_instance_refs;
    DELETE FROM dashboard_versions;
    DELETE FROM dashboards;
    DELETE FROM org_members;
    DELETE FROM instances;
    DELETE FROM organizations;
    DELETE FROM users;
  `);
  const user = db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)');
  user.run(USER_1, 'one@example.com', 'x');
  user.run(USER_2, 'two@example.com', 'x');
  const org = db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)');
  org.run(ORG_A, 'Org A', USER_1);
  org.run(ORG_B, 'Org B', USER_2);
  const member = db.prepare('INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, ?)');
  member.run(ORG_A, USER_1, 'owner');
  member.run(ORG_B, USER_2, 'owner');
  // Instances are seeded with direct SQL: instance.ts reaches
  // $env/dynamic/private through auth.ts and cannot be imported under vitest.
  const inst = db.prepare(
    'INSERT INTO instances (id, org_id, resource_id, endpoint_url, admin_token) VALUES (?, ?, ?, ?, ?)',
  );
  inst.run('inst-a', ORG_A, 'res-a', 'https://a.example', 'TOKEN-A');
  inst.run('inst-b', ORG_B, 'res-b', 'https://b.example', 'TOKEN-B');
}

function model(over: Partial<Dashboard> = {}): Dashboard {
  return { ...createDashboard({ title: 'Test', instanceId: 'inst-a' }), ...over };
}

function make(orgId: OrgScope = ORG_A, userId = USER_1, over: Partial<Dashboard> = {}) {
  return insertDashboard({ orgId, userId, model: model(over), instanceIds: ['inst-a'] });
}

beforeEach(seed);

describe('cross-org isolation', () => {
  it('does not return another org’s dashboard', () => {
    const made = make(ORG_A);
    expect(getDashboard(ORG_B, made.uid)).toBeNull();
  });

  it('does not update another org’s dashboard, and reports it as absent not stale', () => {
    // A 409 carrying the real version would be a cross-tenant existence and
    // edit-frequency oracle, so the disambiguating read is org-scoped too.
    const made = make(ORG_A);
    expect(() =>
      updateDashboard({
        orgId: ORG_B,
        uid: made.uid,
        userId: USER_2,
        model: model({ title: 'Stolen' }),
        expectedVersion: 1,
        instanceIds: [],
      }),
    ).toThrow(DashboardNotFoundError);
  });

  it('does not delete another org’s dashboard', () => {
    const made = make(ORG_A);
    expect(() => deleteDashboard(ORG_B, made.uid)).toThrow(DashboardNotFoundError);
    expect(getDashboard(ORG_A, made.uid)).not.toBeNull();
  });

  it('does not list another org’s dashboards', () => {
    make(ORG_A);
    expect(listDashboards(ORG_B)).toEqual([]);
  });

  it('does not list another org’s versions', () => {
    // dashboard_versions carries no org_id of its own, so this is the read
    // most likely to be written without a predicate.
    const made = make(ORG_A);
    expect(() => listVersions(ORG_B, made.uid)).toThrow(DashboardNotFoundError);
  });

  it('does not read another org’s version blob', () => {
    const made = make(ORG_A);
    expect(() => getVersionModelJson(ORG_B, made.uid, 1)).toThrow(DashboardNotFoundError);
  });
});

describe('getDashboardForUser', () => {
  it('resolves without an org for a member of the owning org', () => {
    const made = make(ORG_A, USER_1);
    const found = getDashboardForUser(made.uid, USER_1);
    expect(found?.record.uid).toBe(made.uid);
    expect(found?.role).toBe('owner');
  });

  it('returns null for a user who is not a member', () => {
    const made = make(ORG_A, USER_1);
    expect(getDashboardForUser(made.uid, USER_2)).toBeNull();
  });

  it('resolves a dashboard in the user’s other org', () => {
    // The case that 404s when the org comes from the active-org cookie: a
    // member of two orgs opening a link to the one they are not "in".
    getDb().prepare('INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, ?)')
      .run(ORG_B, USER_1, 'member');
    const made = insertDashboard({ orgId: ORG_B, userId: USER_2, model: model({ instanceId: 'inst-b' }), instanceIds: ['inst-b'] });
    expect(getDashboardForUser(made.uid, USER_1)?.record.uid).toBe(made.uid);
  });
});

describe('optimistic concurrency', () => {
  it('rejects a stale write and does not apply it', () => {
    const made = make();
    updateDashboard({
      orgId: ORG_A, uid: made.uid, userId: USER_1,
      model: model({ title: 'Second' }), expectedVersion: 1, instanceIds: ['inst-a'],
    });
    expect(() =>
      updateDashboard({
        orgId: ORG_A, uid: made.uid, userId: USER_1,
        model: model({ title: 'Stale' }), expectedVersion: 1, instanceIds: ['inst-a'],
      }),
    ).toThrow(VersionConflictError);
    expect(getDashboard(ORG_A, made.uid)!.model.title).toBe('Second');
  });

  it('reports the current version on conflict', () => {
    const made = make();
    updateDashboard({
      orgId: ORG_A, uid: made.uid, userId: USER_1,
      model: model({ title: 'Second' }), expectedVersion: 1, instanceIds: ['inst-a'],
    });
    try {
      updateDashboard({
        orgId: ORG_A, uid: made.uid, userId: USER_1,
        model: model({ title: 'X' }), expectedVersion: 1, instanceIds: ['inst-a'],
      });
      throw new Error('expected a conflict');
    } catch (err) {
      expect(err).toBeInstanceOf(VersionConflictError);
      expect((err as VersionConflictError).currentVersion).toBe(2);
    }
  });

  it('does not burn a history slot on a no-op save', () => {
    const made = make();
    const again = updateDashboard({
      orgId: ORG_A, uid: made.uid, userId: USER_1,
      model: model(), expectedVersion: 1, instanceIds: ['inst-a'],
    });
    expect(again.version).toBe(1);
    expect(listVersions(ORG_A, made.uid)).toHaveLength(1);
  });
});

describe('version history', () => {
  it('records the content under its own version number', () => {
    // Storing the PREVIOUS content instead would leave the current version
    // absent from the table and make "restore vN" hand back what N replaced.
    const made = make(ORG_A, USER_1, { title: 'v1' });
    updateDashboard({
      orgId: ORG_A, uid: made.uid, userId: USER_1,
      model: model({ title: 'v2' }), expectedVersion: 1, instanceIds: ['inst-a'],
    });
    expect(JSON.parse(getVersionModelJson(ORG_A, made.uid, 1)).title).toBe('v1');
    expect(JSON.parse(getVersionModelJson(ORG_A, made.uid, 2)).title).toBe('v2');
  });

  it('includes the current version in the list, marked as current', () => {
    const made = make();
    const versions = listVersions(ORG_A, made.uid);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ version: 1, current: true });
  });

  it('gives a freshly created dashboard a history entry', () => {
    expect(listVersions(ORG_A, make().uid)).toHaveLength(1);
  });

  it('prunes to the retention limit, keeping the highest versions', () => {
    const made = make();
    for (let i = 2; i <= LIMITS.maxVersionHistory + 5; i++) {
      updateDashboard({
        orgId: ORG_A, uid: made.uid, userId: USER_1,
        model: model({ title: `v${i}` }), expectedVersion: i - 1, instanceIds: ['inst-a'],
      });
    }
    const versions = listVersions(ORG_A, made.uid);
    expect(versions).toHaveLength(LIMITS.maxVersionHistory);
    // Ordered by version, not created_at: datetime('now') is 1-second granular,
    // and these all land in the same second.
    expect(versions[0].version).toBe(LIMITS.maxVersionHistory + 5);
    expect(versions.some((v) => v.current)).toBe(true);
  });

  it('prunes only the dashboard being written', () => {
    const a = make(ORG_A);
    const b = insertDashboard({ orgId: ORG_B, userId: USER_2, model: model({ instanceId: 'inst-b' }), instanceIds: ['inst-b'] });
    for (let i = 2; i <= LIMITS.maxVersionHistory + 3; i++) {
      updateDashboard({
        orgId: ORG_A, uid: a.uid, userId: USER_1,
        model: model({ title: `v${i}` }), expectedVersion: i - 1, instanceIds: ['inst-a'],
      });
    }
    expect(listVersions(ORG_B, b.uid)).toHaveLength(1);
  });
});

describe('restore', () => {
  it('writes the restored content as a new version', () => {
    const made = make(ORG_A, USER_1, { title: 'original' });
    updateDashboard({
      orgId: ORG_A, uid: made.uid, userId: USER_1,
      model: model({ title: 'changed' }), expectedVersion: 1, instanceIds: ['inst-a'],
    });
    const restored = restoreVersion({
      orgId: ORG_A, uid: made.uid, userId: USER_1,
      model: model({ title: 'original' }), expectedVersion: 2,
      instanceIds: ['inst-a'], restoredFrom: 1,
    });
    expect(restored.version).toBe(3);
    expect(restored.model.title).toBe('original');
    // History is not rewritten.
    expect(JSON.parse(getVersionModelJson(ORG_A, made.uid, 2)).title).toBe('changed');
  });

  it('recomputes the projection columns', () => {
    // Restore writes an OLDER blob, so a path that set model_json without
    // re-deriving the columns would list one title and open another.
    const made = make(ORG_A, USER_1, { title: 'original' });
    updateDashboard({
      orgId: ORG_A, uid: made.uid, userId: USER_1,
      model: model({ title: 'changed', tags: ['new'] }), expectedVersion: 1, instanceIds: ['inst-a'],
    });
    restoreVersion({
      orgId: ORG_A, uid: made.uid, userId: USER_1,
      model: model({ title: 'original' }), expectedVersion: 2,
      instanceIds: ['inst-a'], restoredFrom: 1,
    });
    const listed = listDashboards(ORG_A)[0];
    expect(listed.title).toBe('original');
    expect(listed.tags).toEqual([]);
  });
});

describe('instance references', () => {
  it('rejects an instance belonging to another org', () => {
    expect(() => assertInstancesInOrg(ORG_A, ['inst-b'])).toThrow(InstanceNotInOrgError);
  });

  it('rejects a soft-deleted instance', () => {
    getDb().prepare("UPDATE instances SET deleted_at = datetime('now') WHERE id = ?").run('inst-a');
    expect(() => assertInstancesInOrg(ORG_A, ['inst-a'])).toThrow(InstanceNotInOrgError);
  });

  it('accepts an empty list without querying', () => {
    expect(() => assertInstancesInOrg(ORG_A, [])).not.toThrow();
  });

  it('records refs for every level, so instance usage is answerable', () => {
    const made = insertDashboard({
      orgId: ORG_A, userId: USER_1, model: model(), instanceIds: ['inst-a'],
    });
    expect(dashboardsUsingInstance(ORG_A, 'inst-a')).toEqual([made.uid]);
    expect(dashboardsUsingInstance(ORG_B, 'inst-a')).toEqual([]);
  });

  it('clears refs that a later save removed', () => {
    const made = make();
    updateDashboard({
      orgId: ORG_A, uid: made.uid, userId: USER_1,
      model: model({ title: 'no refs' }), expectedVersion: 1, instanceIds: [],
    });
    expect(dashboardsUsingInstance(ORG_A, 'inst-a')).toEqual([]);
  });
});

describe('resolveTargetInstance', () => {
  const dash = () => model();

  it('never returns the admin token', () => {
    // instance.ts keeps SafeInstance for exactly this reason: a helper that
    // returns the row is one `return` from serializing the credential into a
    // page any viewer can read.
    const resolved = resolveTargetInstance(ORG_A, dash(), null, null);
    expect(Object.keys(resolved)).toEqual(['id', 'endpointUrl']);
    expect(JSON.stringify(resolved)).not.toContain('TOKEN-A');
  });

  it('returns the token only from the credential function', () => {
    expect(resolveTargetCredential(ORG_A, dash(), null, null).adminToken).toBe('TOKEN-A');
  });

  it('refuses an instance in another org', () => {
    expect(() => resolveTargetInstance(ORG_B, dash(), null, null)).toThrow(InstanceNotInOrgError);
  });

  it('prefers the target override over the panel and dashboard', () => {
    getDb().prepare('INSERT INTO instances (id, org_id, resource_id, endpoint_url) VALUES (?, ?, ?, ?)')
      .run('inst-a2', ORG_A, 'res-a2', 'https://a2.example');
    const panel = { ...createPanel({ type: 'stat', gridPos: { x: 0, y: 0, w: 4, h: 4 }, id: 'p' }), instanceId: 'inst-a' };
    const target = { refId: 'A', sql: '', instanceId: 'inst-a2' };
    expect(resolveTargetInstance(ORG_A, dash(), panel, target).id).toBe('inst-a2');
  });

  it('dereferences a $variable against the declared instance variables', () => {
    const d = model({
      instanceId: '$inst',
      variables: [{ name: 'inst', type: 'instance' }],
    });
    expect(resolveTargetInstance(ORG_A, d, null, null, { inst: 'inst-a' }).id).toBe('inst-a');
  });

  it('refuses a $variable that is not a declared instance variable', () => {
    // Otherwise ?var-anything=<id> reaches an instance the dashboard never named.
    const d = model({ instanceId: '$rogue', variables: [] });
    expect(() => resolveTargetInstance(ORG_A, d, null, null, { rogue: 'inst-a' })).toThrow(
      InstanceNotInOrgError,
    );
  });

  it('applies the org predicate to an interpolated variable value', () => {
    // The selected value is raw client input and gets no more trust for having
    // arrived through a variable.
    const d = model({ instanceId: '$inst', variables: [{ name: 'inst', type: 'instance' }] });
    expect(() => resolveTargetInstance(ORG_A, d, null, null, { inst: 'inst-b' })).toThrow(
      InstanceNotInOrgError,
    );
  });

  it('never names the offending instance id in its message', () => {
    try {
      resolveTargetInstance(ORG_B, dash(), null, null);
      throw new Error('expected a throw');
    } catch (err) {
      expect((err as Error).message).not.toContain('inst-a');
    }
  });
});

describe('delete', () => {
  it('removes the dashboard, its versions and its refs', () => {
    const made = make();
    deleteDashboard(ORG_A, made.uid);
    expect(getDashboard(ORG_A, made.uid)).toBeNull();
    const db = getDb();
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM dashboard_versions WHERE dashboard_uid = ?').get(made.uid),
    ).toEqual({ n: 0 });
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM dashboard_instance_refs WHERE dashboard_uid = ?').get(made.uid),
    ).toEqual({ n: 0 });
  });
});

describe('org deletion', () => {
  it('does not add a new foreign-key blocker to tenant teardown', () => {
    // Without ON DELETE CASCADE, deleting an org would abort for any org that
    // had ever held a dashboard. The instances table is separately missing its
    // cascade (#61), so this seeds only the dashboard side to isolate what
    // this change contributes.
    const db = getDb();
    db.prepare('DELETE FROM instances WHERE org_id = ?').run(ORG_A);
    make(ORG_A);
    expect(() => db.prepare('DELETE FROM organizations WHERE id = ?').run(ORG_A)).not.toThrow();
  });

  it('cascades dashboards, versions and refs when the org row goes', () => {
    const db = getDb();
    db.prepare('DELETE FROM instances WHERE org_id = ?').run(ORG_A);
    const made = make(ORG_A);
    db.prepare('DELETE FROM organizations WHERE id = ?').run(ORG_A);
    expect(db.prepare('SELECT COUNT(*) AS n FROM dashboards').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM dashboard_versions').get()).toEqual({ n: 0 });
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM dashboard_instance_refs WHERE dashboard_uid = ?').get(made.uid),
    ).toEqual({ n: 0 });
  });

  it('documents the pre-existing instances blocker (#61)', () => {
    // Deliberately asserting the CURRENT broken behaviour so the fix for #61
    // has a failing test to flip, rather than discovering this again.
    const db = getDb();
    expect(() => db.prepare('DELETE FROM organizations WHERE id = ?').run(ORG_A)).toThrow(
      /FOREIGN KEY/,
    );
  });
});
