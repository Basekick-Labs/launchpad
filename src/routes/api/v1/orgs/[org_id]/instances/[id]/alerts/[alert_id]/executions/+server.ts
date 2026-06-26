import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';

export const GET: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

  const db = getDb();
  const membership = db.prepare(
    'SELECT role FROM org_members WHERE org_id = ? AND user_id = ?'
  ).get(params.org_id, locals.user.id);
  if (!membership) return json({ error: 'Forbidden' }, { status: 403 });

  const instance = db.prepare(
    'SELECT id FROM instances WHERE id = ? AND org_id = ? AND deleted_at IS NULL'
  ).get(params.id, params.org_id);
  if (!instance) return json({ error: 'Instance not found' }, { status: 404 });

  const rule = db.prepare(
    'SELECT id FROM alert_rules WHERE id = ? AND instance_id = ?'
  ).get(params.alert_id, params.id);
  if (!rule) return json({ error: 'Alert not found' }, { status: 404 });

  const executions = db.prepare(
    'SELECT * FROM alert_executions WHERE alert_rule_id = ? ORDER BY triggered_at DESC LIMIT 50'
  ).all(params.alert_id);

  return json({ executions });
};
