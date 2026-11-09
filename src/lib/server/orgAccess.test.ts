import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from './db';
import { requireInstanceRole } from './orgAccess';

beforeAll(() => {
  const db = getDb();
  db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run('owner', 'owner@example.test');
  db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run('member', 'member@example.test');
  db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run('odd', 'odd@example.test');
  db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run('outsider', 'out@example.test');
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run('org-a', 'A', 'owner');
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run('org-b', 'B', 'outsider');
  db.prepare('INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, ?)').run('org-a', 'owner', 'owner');
  db.prepare('INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, ?)').run('org-a', 'member', 'member');
  db.prepare('INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, ?)').run('org-a', 'odd', 'superuser');
  db.prepare('INSERT INTO instances (id, org_id, resource_id, status) VALUES (?, ?, ?, ?)').run('inst-a', 'org-a', 'r-a', 'running');
  db.prepare('INSERT INTO instances (id, org_id, resource_id, status) VALUES (?, ?, ?, ?)').run('inst-b', 'org-b', 'r-b', 'running');
  db.prepare("INSERT INTO instances (id, org_id, resource_id, status, deleted_at) VALUES (?, ?, ?, ?, datetime('now'))").run('inst-gone', 'org-a', 'r-g', 'deleted');
});

const status = (r: ReturnType<typeof requireInstanceRole>) => (r instanceof Response ? r.status : 200);

describe('requireInstanceRole', () => {
  it('requires a signed-in user', () => {
    expect(status(requireInstanceRole(null, 'org-a', 'inst-a', 'viewer'))).toBe(401);
  });

  it('requires membership with at least the role, and a known role', () => {
    expect(status(requireInstanceRole({ id: 'outsider' }, 'org-a', 'inst-a', 'viewer'))).toBe(403);
    expect(status(requireInstanceRole({ id: 'member' }, 'org-a', 'inst-a', 'admin'))).toBe(403);
    expect(status(requireInstanceRole({ id: 'odd' }, 'org-a', 'inst-a', 'viewer'))).toBe(403);
  });

  it('hides instances of other orgs and deleted ones', () => {
    expect(status(requireInstanceRole({ id: 'owner' }, 'org-a', 'inst-b', 'admin'))).toBe(404);
    expect(status(requireInstanceRole({ id: 'owner' }, 'org-a', 'inst-gone', 'admin'))).toBe(404);
  });

  it('returns the instance and role', () => {
    const r = requireInstanceRole({ id: 'owner' }, 'org-a', 'inst-a', 'admin');
    expect(r).toMatchObject({ role: 'owner', instance: { id: 'inst-a', org_id: 'org-a' } });
  });
});
