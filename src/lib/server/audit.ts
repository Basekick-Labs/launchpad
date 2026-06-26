import { getDb } from './db';

export function logOperatorAction(
  operatorId: string,
  action: string,
  targetType: 'user' | 'org' | 'instance',
  targetId: string,
  details?: Record<string, unknown> | null
): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO operator_audit_log (operator_id, action, target_type, target_id, details)
     VALUES (?, ?, ?, ?, ?)`
  ).run(operatorId, action, targetType, targetId, details ? JSON.stringify(details) : null);
}
