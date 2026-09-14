import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from './db';
import { AccessError, requireOrgRole } from './orgAccess';
import { roleAtLeast, isOrgRole, ORG_ROLES } from '$lib/roles';

const ORG = 'org-access';
const OTHER = 'org-other';

function locals(userId: string | null): App.Locals {
  return { user: userId ? ({ id: userId } as App.Locals['user']) : null } as App.Locals;
}

beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM org_members; DELETE FROM organizations; DELETE FROM users;');
  const user = db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)');
  for (const role of ORG_ROLES) user.run(`u-${role}`, `${role}@example.com`, 'x');
  user.run('u-none', 'none@example.com', 'x');
  const org = db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)');
  org.run(ORG, 'Org', 'u-owner');
  org.run(OTHER, 'Other', 'u-owner');
  const member = db.prepare('INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, ?)');
  for (const role of ORG_ROLES) member.run(ORG, `u-${role}`, role);
});

describe('roleAtLeast', () => {
  it('orders owner > admin > member > viewer', () => {
    expect(roleAtLeast('owner', 'admin')).toBe(true);
    expect(roleAtLeast('admin', 'admin')).toBe(true);
    expect(roleAtLeast('member', 'admin')).toBe(false);
    expect(roleAtLeast('viewer', 'member')).toBe(false);
    expect(roleAtLeast('viewer', 'viewer')).toBe(true);
  });

  it.each([['Admin'], ['ADMIN'], ['superuser'], [''], ['root']])(
    'denies the unrecognised role %j',
    (role) => {
      // The natural spelling `RANK[role] < RANK[need]` evaluates to
      // `undefined < 2`, which is false, and would ALLOW these. It reads
      // identically to the correct version in review.
      expect(roleAtLeast(role, 'viewer')).toBe(false);
    },
  );

  it('isOrgRole is exact', () => {
    expect(isOrgRole('owner')).toBe(true);
    expect(isOrgRole('Owner')).toBe(false);
    expect(isOrgRole(null)).toBe(false);
  });
});

describe('requireOrgRole', () => {
  it('returns the role and a branded org id for a sufficient member', () => {
    const access = requireOrgRole(locals('u-admin'), ORG, 'member');
    expect(access.role).toBe('admin');
    expect(access.userId).toBe('u-admin');
    expect(access.orgId).toBe(ORG);
  });

  it('rejects an anonymous caller with 401', () => {
    try {
      requireOrgRole(locals(null), ORG, 'viewer');
      throw new Error('expected a throw');
    } catch (err) {
      expect((err as AccessError).status).toBe(401);
    }
  });

  it('rejects a non-member with 403 rather than treating them as a viewer', () => {
    // activeOrg.ts defaults a missing membership to 'viewer', which is fine for
    // resolving a page's active org and fail-open here: it would grant every
    // signed-in user read access to every org.
    try {
      requireOrgRole(locals('u-none'), ORG, 'viewer');
      throw new Error('expected a throw');
    } catch (err) {
      expect((err as AccessError).status).toBe(403);
    }
  });

  it('rejects a member of a different org', () => {
    expect(() => requireOrgRole(locals('u-owner'), OTHER, 'viewer')).toThrow(AccessError);
  });

  it('returns 403, not 404, for an org that does not exist', () => {
    // A 404 here would be an org-existence oracle.
    try {
      requireOrgRole(locals('u-owner'), 'no-such-org', 'viewer');
      throw new Error('expected a throw');
    } catch (err) {
      expect((err as AccessError).status).toBe(403);
    }
  });

  it.each([[undefined], ['']])('rejects a missing org id %j without querying', (orgId) => {
    expect(() => requireOrgRole(locals('u-owner'), orgId as string | undefined, 'viewer')).toThrow(
      AccessError,
    );
  });

  it('denies a role stored in the database that is not recognised', () => {
    getDb().prepare('UPDATE org_members SET role = ? WHERE org_id = ? AND user_id = ?')
      .run('superuser', ORG, 'u-member');
    expect(() => requireOrgRole(locals('u-member'), ORG, 'viewer')).toThrow(AccessError);
  });

  it.each([
    ['viewer', 'viewer', true],
    ['viewer', 'member', false],
    ['member', 'member', true],
    ['member', 'admin', false],
    ['admin', 'admin', true],
    ['owner', 'admin', true],
  ] as const)('role %s against minRole %s -> %s', (role, minRole, allowed) => {
    const call = () => requireOrgRole(locals(`u-${role}`), ORG, minRole);
    if (allowed) expect(call().role).toBe(role);
    else expect(call).toThrow(AccessError);
  });
});
