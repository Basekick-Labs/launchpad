import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { isSafeWebhookUrl, MIN_ALERT_INTERVAL_MS } from '$lib/server/alertEvaluator';
import { parseIntervalToMs } from '$lib/alertManager';

function checkAccess(locals: App.Locals, orgId: string, instanceId: string) {
  if (!locals.user) return { error: 'Unauthorized', status: 401 };
  const db = getDb();
  const membership = db.prepare(
    'SELECT role FROM org_members WHERE org_id = ? AND user_id = ?'
  ).get(orgId, locals.user.id) as { role: string } | undefined;
  if (!membership) return { error: 'Forbidden', status: 403 };
  const instance = db.prepare(
    'SELECT id FROM instances WHERE id = ? AND org_id = ? AND deleted_at IS NULL'
  ).get(instanceId, orgId) as { id: string } | undefined;
  if (!instance) return { error: 'Instance not found', status: 404 };
  return { membership, instance };
}

export const GET: RequestHandler = async ({ locals, params }) => {
  const access = checkAccess(locals, params.org_id, params.id);
  if ('error' in access) return json({ error: access.error }, { status: access.status });

  const db = getDb();
  const rules = db.prepare(
    'SELECT id, name, query, condition, threshold, check_interval, webhook_url, enabled, last_checked_at, last_value, last_error, triggered_count, created_at, updated_at FROM alert_rules WHERE instance_id = ? ORDER BY created_at DESC'
  ).all(params.id);

  return json({ rules });
};

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const access = checkAccess(locals, params.org_id, params.id);
  if ('error' in access) return json({ error: access.error }, { status: access.status });
  if (!['owner', 'admin'].includes((access.membership as { role: string }).role)) {
    return json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await request.json();
  const { name, query, condition, threshold, check_interval, webhook_url, enabled } = body;

  if (!name || !query || !condition || threshold === undefined || !check_interval) {
    return json({ error: 'Missing required fields' }, { status: 400 });
  }

  const validConditions = ['greater_than', 'less_than', 'equals', 'not_equals', 'contains'];
  if (!validConditions.includes(condition)) {
    return json({ error: 'Invalid condition' }, { status: 400 });
  }

  if (parseIntervalToMs(check_interval) < MIN_ALERT_INTERVAL_MS) {
    return json({ error: 'Minimum check interval is 1 minute' }, { status: 400 });
  }

  if (webhook_url && !isSafeWebhookUrl(webhook_url)) {
    return json({ error: 'Webhook URL must be a valid public HTTPS URL' }, { status: 400 });
  }

  const db = getDb();
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO alert_rules (id, instance_id, name, query, condition, threshold, check_interval, webhook_url, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, params.id, name, query, condition, String(threshold), check_interval, webhook_url || null, enabled === false ? 0 : 1);

  const rule = db.prepare('SELECT * FROM alert_rules WHERE id = ?').get(id);
  return json({ rule }, { status: 201 });
};
