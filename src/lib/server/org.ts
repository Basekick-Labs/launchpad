import type Database from 'better-sqlite3';

/**
 * Hard-delete an organization and everything it owns, in one transaction.
 * instances.org_id and instance_events.instance_id have no ON DELETE clause,
 * so both are removed explicitly; alert rules and their executions cascade from
 * instances. Deleting the instance rows also removes their stored Arc admin
 * tokens (#61).
 */
export function deleteOrganization(db: Database.Database, orgId: string): void {
  const tx = db.transaction(() => {
    // Instance events do not cascade, so remove them before their instances.
    db.prepare(
      'DELETE FROM instance_events WHERE instance_id IN (SELECT id FROM instances WHERE org_id = ?)',
    ).run(orgId);
    db.prepare('DELETE FROM instances WHERE org_id = ?').run(orgId);
    db.prepare('DELETE FROM org_invitations WHERE org_id = ?').run(orgId);
    db.prepare('DELETE FROM org_members WHERE org_id = ?').run(orgId);
    db.prepare('DELETE FROM organizations WHERE id = ?').run(orgId);
  });

  tx();
}
