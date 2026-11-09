import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from './db';
import { listChanges, outcomeFor, purgeOldChanges, recordChange } from './instanceChangeLog';

beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM instance_change_log; DELETE FROM instances; DELETE FROM organizations; DELETE FROM users;');
  db.prepare('INSERT INTO users (id, email, first_name, last_name) VALUES (?, ?, ?, ?)').run('u1', 'ada@example.test', 'Ada', 'L');
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run('o1', 'Org', 'u1');
  db.prepare('INSERT INTO instances (id, org_id, resource_id, status) VALUES (?, ?, ?, ?)').run('i1', 'o1', 'r1', 'running');
  db.prepare('INSERT INTO instances (id, org_id, resource_id, status) VALUES (?, ?, ?, ?)').run('i2', 'o1', 'r2', 'running');
});

const rec = (instanceId: string, path: string, status: number | null = 200, dryRun = false) =>
  recordChange({ instanceId, actorUserId: 'u1', method: 'POST', path, status, dryRun });

describe('outcomeFor', () => {
  it('reads statuses as ok, error or unknown', () => {
    expect([200, 204, 400, 404, 409, 500, 502, null].map(outcomeFor)).toEqual(
      ['ok', 'ok', 'error', 'error', 'error', 'unknown', 'unknown', 'unknown'],
    );
  });
});

describe('recordChange / listChanges', () => {
  it('records the actor, method, path, outcome and dry runs, newest first, per instance', () => {
    rec('i1', 'api/v1/auth/tokens', 201);
    recordChange({ instanceId: 'i1', actorUserId: 'u1', method: 'DELETE', path: 'api/v1/retention/3', status: null });
    rec('i1', 'api/v1/delete', 200, true);
    rec('i2', 'api/v1/mqtt/x');

    const { changes, nextBefore } = listChanges('i1', null);
    expect(changes.map((c) => [c.method, c.path, c.status, c.outcome, c.dryRun])).toEqual([
      ['POST', '/api/v1/delete', 200, 'ok', true],
      ['DELETE', '/api/v1/retention/3', null, 'unknown', false],
      ['POST', '/api/v1/auth/tokens', 201, 'ok', false],
    ]);
    expect(changes[0].actor).toEqual({ id: 'u1', email: 'ada@example.test', name: 'Ada L' });
    expect(nextBefore).toBeNull();
    expect(listChanges('i2', null).changes).toHaveLength(1);
  });

  it('pages back with a cursor and says when there is no more', () => {
    for (let i = 0; i < 7; i++) rec('i1', `api/v1/x/${i}`);
    const first = listChanges('i1', null, 3);
    expect(first.changes).toHaveLength(3);
    expect(first.nextBefore).toBe(first.changes[2].id);
    const second = listChanges('i1', first.nextBefore, 3);
    expect(second.changes).toHaveLength(3);
    expect(second.changes.every((c) => c.id < first.changes[2].id)).toBe(true);
    const last = listChanges('i1', second.nextBefore, 3);
    expect(last.changes).toHaveLength(1);
    expect(last.nextBefore).toBeNull();
  });

  it('caps the stored path', () => {
    rec('i1', 'a'.repeat(2000));
    expect(listChanges('i1', null).changes[0].path).toHaveLength(512);
  });

  it('never throws, even when the write fails', () => {
    expect(() => rec('no-such-instance', 'x')).not.toThrow();
  });

  it('goes with the instance when it is deleted', () => {
    rec('i2', 'x');
    getDb().prepare('DELETE FROM instances WHERE id = ?').run('i2');
    expect(listChanges('i2', null).changes).toEqual([]);
  });
});

describe('purgeOldChanges', () => {
  it('deletes entries older than the retention window only', () => {
    rec('i1', 'old');
    rec('i1', 'new');
    getDb().prepare("UPDATE instance_change_log SET created_at = '2020-01-01T00:00:00.000Z' WHERE path = '/old'").run();
    expect(purgeOldChanges()).toBe(1);
    expect(listChanges('i1', null).changes.map((c) => c.path)).toEqual(['/new']);
  });
});

describe('migration', () => {
  it('adds dry_run to a table created before the column existed', async () => {
    const Database = (await import('better-sqlite3')).default;
    const old = new Database(':memory:');
    old.exec(`CREATE TABLE instance_change_log (id INTEGER PRIMARY KEY, instance_id TEXT, actor_user_id TEXT, method TEXT, path TEXT, status INTEGER, outcome TEXT, created_at TEXT)`);
    const cols = () => (old.prepare('PRAGMA table_info(instance_change_log)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols()).not.toContain('dry_run');
    // Same statement db.ts runs on start.
    old.exec('ALTER TABLE instance_change_log ADD COLUMN dry_run INTEGER NOT NULL DEFAULT 0');
    expect(cols()).toContain('dry_run');
  });
});
