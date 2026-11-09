import { describe, expect, it } from 'vitest';
import {
  applyChange,
  describeChange,
  parseChange,
  parseRole,
  parseTeam,
  previewChange,
  previewFingerprint,
  tokenAccess,
  validateChange,
  type RbacSnapshot,
} from './rbac';

/**
 * org 1 "acme" → team 10 "analysts" (enabled) → role 100 read on prod_* (no
 *   measurement limits) and role 101 read,write on metrics with measurement
 *   permission 1000 read on cpu*.
 * team 11 "ops" (disabled) → role 110 read,write on *.
 * Tokens: 1 analyst (read) in team 10; 2 ops-only (read,write) in team 11;
 *   3 loose (read,write) in no team; 4 admin in team 10; 5 disabled in team 10.
 */
function snap(): RbacSnapshot {
  return {
    licensed: true,
    orgs: [{ id: 1, name: 'acme', description: '' }],
    teams: [
      { id: 10, orgId: 1, name: 'analysts', description: '', enabled: true },
      { id: 11, orgId: 1, name: 'ops', description: '', enabled: false },
    ],
    roles: [
      { id: 100, teamId: 10, databasePattern: 'prod_*', permissions: ['read'] },
      { id: 101, teamId: 10, databasePattern: 'metrics', permissions: ['read', 'write'] },
      { id: 110, teamId: 11, databasePattern: '*', permissions: ['read', 'write'] },
    ],
    measurementPermissions: [{ id: 1000, roleId: 101, measurementPattern: 'cpu*', permissions: ['read'] }],
    tokens: [
      { id: 1, name: 'analyst', permissions: ['read'], enabled: true },
      { id: 2, name: 'ops-only', permissions: ['read', 'write'], enabled: true },
      { id: 3, name: 'loose', permissions: ['read', 'write'], enabled: true },
      { id: 4, name: 'root', permissions: ['admin'], enabled: true },
      { id: 5, name: 'off', permissions: ['read'], enabled: false },
    ],
    memberships: { 1: [10], 2: [11], 4: [10], 5: [10] },
    teamNames: {},
    loadedAt: 0,
    truncated: false,
  };
}

describe('tokenAccess (Arc rbac_manager.go semantics)', () => {
  it('admin bypasses RBAC', () => {
    expect(tokenAccess(snap(), 4).mode).toBe('admin_bypass');
  });

  it('a disabled token gets nothing', () => {
    expect(tokenAccess(snap(), 5).mode).toBe('disabled');
  });

  it('a token in no team keeps its own permissions', () => {
    expect(tokenAccess(snap(), 3)).toMatchObject({ mode: 'token', ownPermissions: ['read', 'write'] });
  });

  it('a team member gets exactly its grants; measurement permissions replace the role-wide grant', () => {
    const a = tokenAccess(snap(), 1);
    expect(a.mode).toBe('rbac');
    expect(a.grants.map((g) => [g.databasePattern, g.measurementPattern, g.permissions])).toEqual([
      ['metrics', 'cpu*', ['read']], // role 101's read,write on all of metrics does NOT apply
      ['prod_*', null, ['read']],
    ]);
  });

  it('membership in only a disabled team denies everything (no fallback to own permissions)', () => {
    expect(tokenAccess(snap(), 2)).toMatchObject({ mode: 'rbac', grants: [] });
  });

  it('notes the route gate: SQL and ingest still need the token\'s own bits (arc#1559)', () => {
    expect(tokenAccess(snap(), 1).routeGate).toEqual({ query: true, ingest: false });
  });
});

describe('previewChange', () => {
  it('removing the last membership reverts the token to its own permissions everywhere (widens)', () => {
    const p = previewChange(snap(), { kind: 'membership.remove', tokenId: 1, teamId: 10 });
    expect(p.impacts[0].flags).toEqual(['reverts_to_token_permissions']);
    expect(p.widensAccess).toBe(true);
  });

  it('adding a token to a team switches it to RBAC (narrows, not a widening)', () => {
    const p = previewChange(snap(), { kind: 'membership.add', tokenId: 3, teamId: 10 });
    expect(p.impacts[0].flags).toEqual(['switches_to_rbac']);
    expect(p.widensAccess).toBe(false);
  });

  it('the first measurement permission on a role narrows it', () => {
    const p = previewChange(snap(), { kind: 'mp.create', roleId: 100, measurementPattern: 'orders', permissions: ['read'] });
    const analyst = p.impacts.find((i) => i.tokenId === 1)!;
    expect(analyst.flags).toContain('narrowed_to_measurements');
    expect(p.widensAccess).toBe(false); // found live: narrowing was reported as widening
  });

  it('deleting the last measurement permission widens the role to the whole database', () => {
    const p = previewChange(snap(), { kind: 'mp.delete', mpId: 1000 });
    const analyst = p.impacts.find((i) => i.tokenId === 1)!;
    expect(analyst.flags).toContain('widened_to_database');
    expect(analyst.gained).toEqual([expect.objectContaining({ databasePattern: 'metrics', measurementPattern: null, permissions: ['read', 'write'] })]);
    expect(p.widensAccess).toBe(true);
  });

  it('disabling a token\'s only team denies it everything', () => {
    const p = previewChange(snap(), { kind: 'team.update', teamId: 10, enabled: false });
    expect(p.impacts.find((i) => i.tokenId === 1)!.flags).toEqual(['total_denial']);
  });

  it('admin tokens are reported as unaffected', () => {
    const p = previewChange(snap(), { kind: 'team.delete', teamId: 10 });
    expect(p.impacts.find((i) => i.tokenId === 4)!.flags).toEqual(['no_effect_admin']);
  });

  it('deleting an org lists the cascade and reverts every member token', () => {
    const p = previewChange(snap(), { kind: 'org.delete', orgId: 1 });
    expect(p.cascade).toEqual({ teams: 2, roles: 3, measurementPermissions: 1, memberships: 4 });
    expect(p.impacts.find((i) => i.tokenId === 2)!.flags).toEqual(['reverts_to_token_permissions']);
  });

  it('new grants for a token already under RBAC widen; create-only changes touch nobody', () => {
    const p = previewChange(snap(), { kind: 'role.create', teamId: 10, databasePattern: 'logs', permissions: ['read'] });
    expect(p.impacts.find((i) => i.tokenId === 1)!.gained).toHaveLength(1);
    expect(p.widensAccess).toBe(true);
    expect(previewChange(snap(), { kind: 'org.create', name: 'x', description: '' }).impacts).toEqual([]);
  });
});

describe('previewFingerprint', () => {
  it('is stable for the same state and changes when another admin edits it', () => {
    const c = { kind: 'membership.remove', tokenId: 1, teamId: 10 } as const;
    expect(previewFingerprint(snap(), c)).toBe(previewFingerprint(snap(), c));
    const edited = applyChange(snap(), { kind: 'role.delete', roleId: 100 });
    expect(previewFingerprint(edited, c)).not.toBe(previewFingerprint(snap(), c));
  });
});

describe('validateChange', () => {
  it('applies Arc\'s name, pattern and permission rules', () => {
    expect(validateChange({ kind: 'org.create', name: '1bad', description: '' })).toHaveProperty('name');
    expect(validateChange({ kind: 'role.create', teamId: 1, databasePattern: 'a*b', permissions: ['read'] })).toHaveProperty('databasePattern');
    expect(validateChange({ kind: 'role.create', teamId: 1, databasePattern: '*_prod', permissions: [] })).toHaveProperty('permissions');
    expect(validateChange({ kind: 'role.update', roleId: 1 })).toHaveProperty('form');
    expect(validateChange({ kind: 'mp.create', roleId: 1, measurementPattern: 'cpu*', permissions: ['read'] })).toBeNull();
  });
});

describe('parsers', () => {
  it('read Arc shapes and drop malformed ones', () => {
    expect(parseTeam({ id: 5, organization_id: 2, name: 'x', enabled: false })).toEqual({ id: 5, orgId: 2, name: 'x', description: '', enabled: false });
    expect(parseRole({ id: 1, team_id: 2, database_pattern: 'db', permissions: ['read', 'nope', 'read'] })).toEqual({ id: 1, teamId: 2, databasePattern: 'db', permissions: ['read'] });
    expect(parseTeam({ id: 'x' })).toBeNull();
  });
});

describe('parseChange', () => {
  it('rebuilds known changes from known fields only', () => {
    expect(parseChange({ kind: 'membership.remove', tokenId: 5, teamId: 9 })).toEqual({ kind: 'membership.remove', tokenId: 5, teamId: 9 });
    expect(parseChange({ kind: 'org.create', name: 'acme' })).toEqual({ kind: 'org.create', name: 'acme', description: '' });
    expect(parseChange({ kind: 'team.update', teamId: 3, enabled: false })).toEqual({ kind: 'team.update', teamId: 3, enabled: false });
  });

  it('rejects unknown kinds, extra fields, bad ids and wrong types', () => {
    expect(parseChange({ kind: 'token.promote', tokenId: 1 })).toBeNull();
    expect(parseChange({ kind: 'org.delete', orgId: 1, cascade: true })).toBeNull();
    expect(parseChange({ kind: 'org.delete', orgId: -1 })).toBeNull();
    expect(parseChange({ kind: 'org.delete', orgId: '1' })).toBeNull();
    expect(parseChange({ kind: 'role.create', teamId: 1, databasePattern: 'x' })).toBeNull();
    expect(parseChange({ kind: 'team.update', teamId: 1, enabled: 'no' })).toBeNull();
    expect(parseChange('nope')).toBeNull();
  });
});

describe('describeChange', () => {
  it('names things from the snapshot', () => {
    expect(describeChange(snap(), { kind: 'membership.remove', tokenId: 1, teamId: 10 })).toBe('Remove token analyst from team analysts.');
    expect(describeChange(snap(), { kind: 'mp.create', roleId: 100, measurementPattern: 'orders', permissions: ['read'] }))
      .toBe('Limit the prod_* role of analysts: read on measurements matching orders.');
    expect(describeChange(snap(), { kind: 'team.update', teamId: 11, enabled: true })).toBe('Enable team ops.');
  });
});
