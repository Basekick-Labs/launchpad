import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyRbacChange, getRbacSnapshot, resetRbacCacheForTests, type RbacTarget } from './rbacAdmin';
import { listChanges } from './instanceChangeLog';
import { getDb } from './db';
import { previewFingerprint, type RbacChange, type RbacSnapshot } from '../rbac';

/**
 * A fake Arc RBAC API: the routes Launchpad uses, with Arc's shapes (lists
 * are null when empty, nested GETs embed the next level down).
 */
interface Store {
  next: number;
  orgs: Map<number, { id: number; name: string; description: string }>;
  teams: Map<number, { id: number; organization_id: number; name: string; description: string; enabled: boolean }>;
  roles: Map<number, { id: number; team_id: number; database_pattern: string; permissions: string[] }>;
  mps: Map<number, { id: number; role_id: number; measurement_pattern: string; permissions: string[] }>;
  tokens: Map<number, { id: number; name: string; permissions: string[]; enabled: boolean }>;
  members: Set<string>; // `${tokenId}:${teamId}`
}
let store: Store;
let licensed = true;
/** Fail the next create with a 500 after committing it (cluster read-back lag). */
let failNextCreateAfterCommit = false;
/** Paths that answer 500 (a failing child read). */
let failingPaths = new Set<string>();
/** Hold the next write this long before answering (after applying it). */
let slowWriteMs = 0;
let requests: Array<{ method: string; path: string; auth?: string }> = [];
let server: http.Server;
let base = '';

const TOKEN = 'admin-token';

function seed(): Store {
  const s: Store = { next: 100, orgs: new Map(), teams: new Map(), roles: new Map(), mps: new Map(), tokens: new Map(), members: new Set() };
  s.orgs.set(1, { id: 1, name: 'acme', description: '' });
  s.teams.set(10, { id: 10, organization_id: 1, name: 'analysts', description: '', enabled: true });
  s.roles.set(20, { id: 20, team_id: 10, database_pattern: 'prod_*', permissions: ['read'] });
  s.tokens.set(5, { id: 5, name: 'admin', permissions: ['admin'], enabled: true });
  s.tokens.set(6, { id: 6, name: 'analyst', permissions: ['read'], enabled: true });
  s.tokens.set(7, { id: 7, name: 'loose', permissions: ['read'], enabled: true });
  s.members.add('6:10');
  return s;
}

const nullIfEmpty = <T>(a: T[]) => (a.length ? a : null);

function route(method: string, path: string, body: Record<string, unknown>): [number, unknown] {
  const s = store;
  const rbac = path.startsWith('/api/v1/rbac');
  if (rbac && !licensed) return [403, { success: false, error: "RBAC requires an enterprise license with the 'rbac' feature enabled" }];
  const m = (re: RegExp) => re.exec(path);
  const created = (status: number, payload: unknown): [number, unknown] => {
    if (failNextCreateAfterCommit) {
      failNextCreateAfterCommit = false;
      return [500, { success: false, error: 'Internal server error' }];
    }
    return [status, payload];
  };
  let r: RegExpExecArray | null;
  if (method === 'GET' && path === '/api/v1/rbac/organizations') return [200, { success: true, organizations: nullIfEmpty([...s.orgs.values()]) }];
  if (method === 'POST' && path === '/api/v1/rbac/organizations') {
    if ([...s.orgs.values()].some((o) => o.name === body.name)) return [409, { success: false, error: `organization with name '${body.name}' already exists` }];
    const o = { id: s.next++, name: String(body.name), description: String(body.description ?? '') };
    s.orgs.set(o.id, o);
    return created(201, { success: true, organization: o });
  }
  if ((r = m(/^\/api\/v1\/rbac\/organizations\/(\d+)$/))) {
    const id = +r[1];
    const o = s.orgs.get(id);
    if (!o) return [404, { success: false, error: 'Organization not found' }];
    if (method === 'GET') return [200, { success: true, organization: { ...o, teams: [...s.teams.values()].filter((t) => t.organization_id === id) } }];
    if (method === 'PATCH') { Object.assign(o, body); return [200, { success: true }]; }
    if (method === 'DELETE') {
      for (const t of [...s.teams.values()].filter((t) => t.organization_id === id)) route('DELETE', `/api/v1/rbac/teams/${t.id}`, {});
      s.orgs.delete(id);
      return [200, { success: true }];
    }
  }
  if (method === 'GET' && (r = m(/^\/api\/v1\/rbac\/organizations\/(\d+)\/teams$/))) {
    return [200, { success: true, teams: nullIfEmpty([...s.teams.values()].filter((t) => t.organization_id === +r![1])) }];
  }
  if (method === 'GET' && (r = m(/^\/api\/v1\/rbac\/teams\/(\d+)\/roles$/))) {
    return [200, { success: true, roles: nullIfEmpty([...s.roles.values()].filter((x) => x.team_id === +r![1])) }];
  }
  if (method === 'GET' && (r = m(/^\/api\/v1\/rbac\/roles\/(\d+)\/measurements$/))) {
    return [200, { success: true, measurement_permissions: nullIfEmpty([...s.mps.values()].filter((p) => p.role_id === +r![1])) }];
  }
  if (method === 'POST' && (r = m(/^\/api\/v1\/rbac\/organizations\/(\d+)\/teams$/))) {
    if (!s.orgs.has(+r[1])) return [400, { success: false, error: 'organization not found' }];
    const t = { id: s.next++, organization_id: +r[1], name: String(body.name), description: String(body.description ?? ''), enabled: true };
    s.teams.set(t.id, t);
    return created(201, { success: true, team: t });
  }
  if ((r = m(/^\/api\/v1\/rbac\/teams\/(\d+)$/))) {
    const id = +r[1];
    const t = s.teams.get(id);
    if (!t) return [404, { success: false, error: 'Team not found' }];
    if (method === 'GET') return [200, { success: true, team: { ...t, roles: [...s.roles.values()].filter((x) => x.team_id === id) } }];
    if (method === 'PATCH') { Object.assign(t, body); return [200, { success: true }]; }
    if (method === 'DELETE') {
      for (const x of [...s.roles.values()].filter((x) => x.team_id === id)) route('DELETE', `/api/v1/rbac/roles/${x.id}`, {});
      for (const k of [...s.members]) if (k.endsWith(`:${id}`)) s.members.delete(k);
      s.teams.delete(id);
      return [200, { success: true }];
    }
  }
  if (method === 'POST' && (r = m(/^\/api\/v1\/rbac\/teams\/(\d+)\/roles$/))) {
    if (!s.teams.has(+r[1])) return [400, { success: false, error: 'team not found' }];
    const x = { id: s.next++, team_id: +r[1], database_pattern: String(body.database_pattern), permissions: body.permissions as string[] };
    s.roles.set(x.id, x);
    return created(201, { success: true, role: x });
  }
  if ((r = m(/^\/api\/v1\/rbac\/roles\/(\d+)$/))) {
    const id = +r[1];
    const x = s.roles.get(id);
    if (!x) return [404, { success: false, error: 'Role not found' }];
    if (method === 'GET') return [200, { success: true, role: { ...x, measurement_permissions: [...s.mps.values()].filter((p) => p.role_id === id) } }];
    if (method === 'PATCH') { Object.assign(x, body); return [200, { success: true }]; }
    if (method === 'DELETE') {
      for (const p of [...s.mps.values()].filter((p) => p.role_id === id)) s.mps.delete(p.id);
      s.roles.delete(id);
      return [200, { success: true }];
    }
  }
  if (method === 'POST' && (r = m(/^\/api\/v1\/rbac\/roles\/(\d+)\/measurements$/))) {
    const p = { id: s.next++, role_id: +r[1], measurement_pattern: String(body.measurement_pattern), permissions: body.permissions as string[] };
    s.mps.set(p.id, p);
    return created(201, { success: true, measurement_permission: p });
  }
  if (method === 'DELETE' && (r = m(/^\/api\/v1\/rbac\/measurement-permissions\/(\d+)$/))) {
    return s.mps.delete(+r[1]) ? [200, { success: true }] : [404, { success: false, error: 'Measurement permission not found' }];
  }
  if (method === 'GET' && path === '/api/v1/auth/tokens') return [200, { tokens: [...s.tokens.values()] }];
  if ((r = m(/^\/api\/v1\/auth\/tokens\/(\d+)\/teams$/))) {
    const tid = +r[1];
    if (method === 'GET') {
      const teams = [...s.teams.values()].filter((t) => s.members.has(`${tid}:${t.id}`));
      return [200, { success: true, teams: nullIfEmpty(teams) }];
    }
    if (method === 'POST') {
      if (!licensed) return [403, { success: false, error: "RBAC requires an enterprise license with the 'rbac' feature enabled" }];
      s.members.add(`${tid}:${body.team_id}`);
      return created(201, { success: true });
    }
  }
  if (method === 'DELETE' && (r = m(/^\/api\/v1\/auth\/tokens\/(\d+)\/teams\/(\d+)$/))) {
    return s.members.delete(`${r[1]}:${r[2]}`) ? [200, { success: true }] : [404, { success: false, error: 'Token is not a member of this team' }];
  }
  return [404, { error: `Cannot ${method} ${path}` }];
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      requests.push({ method: req.method ?? '', path: req.url ?? '', auth: req.headers.authorization });
      const path = (req.url ?? '').split('?')[0];
      const [status, payload] = failingPaths.has(path) ? [500, { success: false, error: 'boom' }] : route(req.method ?? 'GET', path, raw ? JSON.parse(raw) : {});
      const send = () => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.method !== 'GET' && slowWriteMs) {
        const ms = slowWriteMs;
        slowWriteMs = 0;
        setTimeout(send, ms);
      } else send();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const db = getDb();
  db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run('u1', 'ada@example.test');
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run('o1', 'Org', 'u1');
  db.prepare('INSERT INTO instances (id, org_id, resource_id, status) VALUES (?, ?, ?, ?)').run('inst', 'o1', 'r1', 'running');
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(() => {
  resetRbacCacheForTests();
  store = seed();
  licensed = true;
  failNextCreateAfterCommit = false;
  failingPaths = new Set();
  slowWriteMs = 0;
  requests = [];
  getDb().prepare('DELETE FROM instance_change_log').run();
});

const target = (): RbacTarget => ({ id: 'inst', endpoint_url: base, admin_token: TOKEN });
const opts = { allowPrivate: true };

async function change(c: RbacChange, s?: RbacSnapshot) {
  const snap = s ?? (await getRbacSnapshot(target(), opts));
  return applyRbacChange(target(), opts, 'u1', c, previewFingerprint(snap, c));
}

describe('getRbacSnapshot', () => {
  it('loads the tree and memberships with the token, null lists as empty', async () => {
    const s = await getRbacSnapshot(target(), opts);
    expect(s.licensed).toBe(true);
    expect(s.orgs.map((o) => o.name)).toEqual(['acme']);
    expect(s.teams.map((t) => t.name)).toEqual(['analysts']);
    expect(s.roles).toEqual([{ id: 20, teamId: 10, databasePattern: 'prod_*', permissions: ['read'] }]);
    expect(s.measurementPermissions).toEqual([]);
    expect(s.memberships).toEqual({ 6: [10] });
    expect(requests.every((r) => r.auth === `Bearer ${TOKEN}`)).toBe(true);
  });

  it('without an RBAC license, still loads token memberships', async () => {
    licensed = false;
    const s = await getRbacSnapshot(target(), opts);
    expect(s).toMatchObject({ licensed: false, orgs: [], teams: [], memberships: { 6: [10] }, teamNames: { 10: 'analysts' } });
  });
});

describe('applyRbacChange', () => {
  it('applies a change, returns the new tree and records who made it', async () => {
    const out = await change({ kind: 'role.create', teamId: 10, databasePattern: 'logs', permissions: ['read'] });
    expect(out.result).toBe('applied');
    expect(out.snapshot!.roles.map((r) => r.databasePattern)).toEqual(['prod_*', 'logs']);
    const log = listChanges('inst', null).changes;
    expect(log.map((c) => [c.method, c.path, c.status])).toEqual([['POST', '/api/v1/rbac/teams/10/roles', 201]]);
    expect(log[0].actor?.id).toBe('u1');
  });

  it('refuses when another admin changed access since the preview', async () => {
    const seen = await getRbacSnapshot(target(), opts);
    store.roles.delete(20); // someone else removed the analysts' role
    const c: RbacChange = { kind: 'membership.remove', tokenId: 6, teamId: 10 };
    await expect(applyRbacChange(target(), opts, 'u1', c, previewFingerprint(seen, c))).rejects.toMatchObject({ code: 'stale' });
    expect(store.members.has('6:10')).toBe(true); // nothing was sent
    expect(listChanges('inst', null).changes).toEqual([]);
  });

  it('tells "applied after an error" from "not applied" when a create answers 500', async () => {
    failNextCreateAfterCommit = true;
    const out = await change({ kind: 'mp.create', roleId: 20, measurementPattern: 'orders', permissions: ['read'] });
    expect(out.result).toBe('applied_after_error');
    expect(store.mps.size).toBe(1); // created once, not retried
    // Recorded with what was established: Arc answered 500, but it applied.
    expect(listChanges('inst', null).changes[0]).toMatchObject({ status: 500, outcome: 'ok' });
  });


  it('rejects invalid fields before contacting Arc', async () => {
    const s = await getRbacSnapshot(target(), opts);
    requests = [];
    const c: RbacChange = { kind: 'team.create', orgId: 1, name: '9lives', description: '' };
    await expect(applyRbacChange(target(), opts, 'u1', c, previewFingerprint(s, c))).rejects.toMatchObject({ code: 'invalid', fields: { name: expect.any(String) } });
    expect(requests).toEqual([]);
  });

  it('cascades a team delete in the returned tree', async () => {
    const out = await change({ kind: 'team.delete', teamId: 10 });
    expect(out.snapshot!.teams).toEqual([]);
    expect(out.snapshot!.memberships).toEqual({});
  });

  it('without a license, only allows removing a token from a team', async () => {
    licensed = false;
    await expect(change({ kind: 'org.create', name: 'x', description: '' })).rejects.toMatchObject({ code: 'unlicensed' });
    const out = await change({ kind: 'membership.remove', tokenId: 6, teamId: 10 });
    expect(out.result).toBe('applied');
    expect(store.members.size).toBe(0);
  });
});

describe('review cases', () => {
  it('fails the load when a child read fails, instead of showing a hole', async () => {
    failingPaths.add('/api/v1/auth/tokens/6/teams');
    await expect(getRbacSnapshot(target(), opts)).rejects.toMatchObject({ code: 'arc_error' });
  });

  it('refuses a membership add when someone added a role to that team meanwhile', async () => {
    const seen = await getRbacSnapshot(target(), opts);
    const c: RbacChange = { kind: 'membership.add', tokenId: 7, teamId: 10 };
    // Another admin widens the team the token is about to join.
    store.roles.set(99, { id: 99, team_id: 10, database_pattern: '*', permissions: ['read', 'write'] });
    resetRbacCacheForTests();
    await expect(applyRbacChange(target(), opts, 'u1', c, previewFingerprint(seen, c))).rejects.toMatchObject({ code: 'stale' });
  });

  it('reports a target that no longer exists rather than sending the change', async () => {
    const seen = await getRbacSnapshot(target(), opts);
    const c: RbacChange = { kind: 'role.delete', roleId: 20 };
    const fp = previewFingerprint(seen, c);
    store.roles.delete(20);
    requests = [];
    await expect(applyRbacChange(target(), opts, 'u1', c, fp)).rejects.toMatchObject({ code: 'not_found' });
    expect(requests.some((r) => r.method === 'DELETE')).toBe(false);
  });

  it('settles a write that timed out by reading the tree back', async () => {
    slowWriteMs = 12_000; // past the write deadline; the fake applies it first
    const out = await change({ kind: 'org.create', name: 'slow', description: '' });
    expect(out.result).toBe('applied_after_error');
    expect(out.snapshot!.orgs.map((o) => o.name)).toContain('slow');
  }, 30_000);

  it('passes Arc\'s field refusal back next to the field', async () => {
    await expect(change({ kind: 'org.create', name: 'acme', description: '' })).rejects.toMatchObject({
      code: 'arc_error',
      fields: { name: "Arc: organization with name 'acme' already exists" },
    });
  });
});
