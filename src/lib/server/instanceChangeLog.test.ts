import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from './db';
import { listChanges, outcomeFor, recordChange } from './instanceChangeLog';

beforeAll(() => {
  const db = getDb();
  db.prepare('INSERT INTO users (id, email, first_name, last_name) VALUES (?, ?, ?, ?)').run('u1', 'ada@example.test', 'Ada', 'L');
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run('o1', 'Org', 'u1');
  db.prepare('INSERT INTO instances (id, org_id, resource_id, status) VALUES (?, ?, ?, ?)').run('i1', 'o1', 'r1', 'running');
  db.prepare('INSERT INTO instances (id, org_id, resource_id, status) VALUES (?, ?, ?, ?)').run('i2', 'o1', 'r2', 'running');
});

describe('outcomeFor', () => {
  it('reads statuses as ok, error or unknown', () => {
    expect([200, 204, 400, 404, 409, 500, 502, null].map(outcomeFor)).toEqual(
      ['ok', 'ok', 'error', 'error', 'error', 'unknown', 'unknown', 'unknown'],
    );
  });
});

describe('recordChange / listChanges', () => {
  it('records the actor, method, path and outcome, newest first, per instance', () => {
    recordChange({ instanceId: 'i1', actorUserId: 'u1', method: 'post', path: 'api/v1/auth/tokens', status: 201 });
    recordChange({ instanceId: 'i1', actorUserId: 'u1', method: 'DELETE', path: 'api/v1/retention/3', status: null });
    recordChange({ instanceId: 'i2', actorUserId: 'u1', method: 'PUT', path: 'api/v1/mqtt/x', status: 200 });

    const list = listChanges('i1', null);
    expect(list.map((c) => [c.method, c.path, c.status, c.outcome])).toEqual([
      ['DELETE', '/api/v1/retention/3', null, 'unknown'],
      ['POST', '/api/v1/auth/tokens', 201, 'ok'],
    ]);
    expect(list[0].actor).toEqual({ id: 'u1', email: 'ada@example.test', name: 'Ada L' });
    expect(listChanges('i2', null)).toHaveLength(1);
  });

  it('pages back with beforeId', () => {
    for (let i = 0; i < 5; i++) recordChange({ instanceId: 'i2', actorUserId: 'u1', method: 'POST', path: `api/v1/x/${i}`, status: 200 });
    const first = listChanges('i2', null, 3);
    const next = listChanges('i2', first[2].id, 3);
    expect(first).toHaveLength(3);
    expect(next.every((c) => c.id < first[2].id)).toBe(true);
  });

  it('never throws, even when the write fails', () => {
    expect(() => recordChange({ instanceId: 'no-such-instance', actorUserId: 'u1', method: 'POST', path: 'x', status: 200 })).not.toThrow();
  });

  it('goes with the instance when it is deleted', () => {
    getDb().prepare('DELETE FROM instances WHERE id = ?').run('i2');
    expect(listChanges('i2', null)).toEqual([]);
  });
});
