import { describe, expect, it } from 'vitest';
import { deleteOrganization, getDb } from './db';

describe('organization deletion', () => {
  it('deletes instances and their retained data before the organization', () => {
    const db = getDb();
    db.exec('DELETE FROM instance_events; DELETE FROM instances; DELETE FROM org_members; DELETE FROM organizations; DELETE FROM users;');
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
    db.prepare('INSERT INTO org_invitations (id, org_id, email, token, invited_by, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      'invite-1',
      'org-1',
      'invitee@example.test',
      'invite-token',
      'user-1',
      '2099-01-01T00:00:00.000Z',
    );

    deleteOrganization(db, 'org-1');

    expect(db.prepare('SELECT 1 FROM organizations WHERE id = ?').get('org-1')).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM org_members WHERE org_id = ?').get('org-1')).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM org_invitations WHERE org_id = ?').get('org-1')).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM instances WHERE org_id = ?').get('org-1')).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM instance_events WHERE instance_id = ?').get('instance-1')).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM instances WHERE admin_token = ?').get('secret-token')).toBeUndefined();
  });
});
