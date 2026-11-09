import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from './db';
import { deleteOrganization } from './org';
import { DELETE } from '../../routes/api/v1/admin/orgs/[org_id]/+server';

type DeleteEvent = Parameters<typeof DELETE>[0];

function seedOrg() {
  const db = getDb();
  db.exec(
    'DELETE FROM operator_audit_log; DELETE FROM alert_executions; DELETE FROM alert_rules; DELETE FROM instance_events; DELETE FROM instances; DELETE FROM org_invitations; DELETE FROM org_members; DELETE FROM organizations; DELETE FROM users;',
  );
  db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run('user-1', 'user@example.test');
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run('org-1', 'Test org', 'user-1');
  db.prepare('INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, ?)').run('org-1', 'user-1', 'owner');
  db.prepare('INSERT INTO instances (id, org_id, resource_id, admin_token) VALUES (?, ?, ?, ?)').run(
    'instance-1',
    'org-1',
    'resource-1',
    'secret-token',
  );
  db.prepare('INSERT INTO instance_events (instance_id, event_type) VALUES (?, ?)').run('instance-1', 'connected');
  db.prepare(
    'INSERT INTO alert_rules (id, instance_id, name, query, condition, threshold, check_interval) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run('rule-1', 'instance-1', 'cpu high', 'SELECT 1', 'gt', '90', '5m');
  db.prepare('INSERT INTO alert_executions (id, alert_rule_id, triggered_at) VALUES (?, ?, ?)').run(
    'exec-1',
    'rule-1',
    '2026-01-01T00:00:00.000Z',
  );
  db.prepare('INSERT INTO org_invitations (id, org_id, email, token, invited_by, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    'invite-1',
    'org-1',
    'invitee@example.test',
    'invite-token',
    'user-1',
    '2099-01-01T00:00:00.000Z',
  );
  return db;
}

function deleteRequest(user: { id: string; is_operator: boolean } | null, orgId = 'org-1') {
  return DELETE({ locals: { user }, params: { org_id: orgId } } as unknown as DeleteEvent);
}

describe('deleteOrganization (#61)', () => {
  beforeEach(seedOrg);

  it('deletes instances and their retained data before the organization', () => {
    const db = getDb();

    deleteOrganization(db, 'org-1');

    expect(db.prepare('SELECT 1 FROM organizations WHERE id = ?').get('org-1')).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM org_members WHERE org_id = ?').get('org-1')).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM org_invitations WHERE org_id = ?').get('org-1')).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM instances WHERE org_id = ?').get('org-1')).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM instance_events WHERE instance_id = ?').get('instance-1')).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM instances WHERE admin_token = ?').get('secret-token')).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM alert_rules WHERE id = ?').get('rule-1')).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM alert_executions WHERE id = ?').get('exec-1')).toBeUndefined();
  });
});

describe('DELETE /api/v1/admin/orgs/[org_id]', () => {
  beforeEach(seedOrg);

  it('refuses a non-operator and leaves the organization in place', async () => {
    const res = await deleteRequest({ id: 'user-1', is_operator: false });

    expect(res.status).toBe(403);
    expect(getDb().prepare('SELECT 1 FROM organizations WHERE id = ?').get('org-1')).toBeDefined();
  });

  it('returns 404 for an unknown organization', async () => {
    const res = await deleteRequest({ id: 'operator-1', is_operator: true }, 'org-missing');

    expect(res.status).toBe(404);
  });

  it('deletes an organization that has instances and records the operator action', async () => {
    const res = await deleteRequest({ id: 'operator-1', is_operator: true });
    const db = getDb();

    expect(res.status).toBe(200);
    expect(db.prepare('SELECT 1 FROM organizations WHERE id = ?').get('org-1')).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM instances WHERE org_id = ?').get('org-1')).toBeUndefined();
    expect(
      db
        .prepare("SELECT 1 FROM operator_audit_log WHERE action = 'delete_org' AND target_id = ? AND operator_id = ?")
        .get('org-1', 'operator-1'),
    ).toBeDefined();
  });
});
