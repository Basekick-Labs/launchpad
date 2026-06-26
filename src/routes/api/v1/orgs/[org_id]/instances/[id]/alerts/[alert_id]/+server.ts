import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { isSafeWebhookUrl, MIN_ALERT_INTERVAL_MS } from '$lib/server/alertEvaluator';
import { parseIntervalToMs } from '$lib/alertManager';

function checkAccess(locals: App.Locals, orgId: string, instanceId: string, alertId: string) {
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
  const rule = db.prepare(
    'SELECT * FROM alert_rules WHERE id = ? AND instance_id = ?'
  ).get(alertId, instanceId) as Record<string, unknown> | undefined;
  if (!rule) return { error: 'Alert not found', status: 404 };
  return { membership, instance, rule };
}

export const GET: RequestHandler = async ({ locals, params }) => {
  const access = checkAccess(locals, params.org_id, params.id, params.alert_id);
  if ('error' in access) return json({ error: access.error }, { status: access.status });
  return json({ rule: access.rule });
};

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  const access = checkAccess(locals, params.org_id, params.id, params.alert_id);
  if ('error' in access) return json({ error: access.error }, { status: access.status });
  if (!['owner', 'admin'].includes((access.membership as { role: string }).role)) {
    return json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await request.json();
  const allowed = ['name', 'query', 'condition', 'threshold', 'check_interval', 'webhook_url', 'enabled'];
  const updates = Object.fromEntries(Object.entries(body).filter(([k]) => allowed.includes(k)));

  if (Object.keys(updates).length === 0) {
    return json({ error: 'No valid fields to update' }, { status: 400 });
  }

  if (updates.condition) {
    const validConditions = ['greater_than', 'less_than', 'equals', 'not_equals', 'contains'];
    if (!validConditions.includes(updates.condition as string)) {
      return json({ error: 'Invalid condition' }, { status: 400 });
    }
  }

  if (updates.check_interval !== undefined) {
    if (parseIntervalToMs(updates.check_interval as string) < MIN_ALERT_INTERVAL_MS) {
      return json({ error: 'Minimum check interval is 1 minute' }, { status: 400 });
    }
  }

  if (updates.webhook_url !== undefined && updates.webhook_url !== null) {
    if (!isSafeWebhookUrl(updates.webhook_url as string)) {
      return json({ error: 'Webhook URL must be a valid public HTTPS URL' }, { status: 400 });
    }
  }

  if (updates.threshold !== undefined) updates.threshold = String(updates.threshold);
  if (updates.enabled !== undefined) updates.enabled = updates.enabled ? 1 : 0;

  const db = getDb();
  const setClauses = [...Object.keys(updates).map(k => `${k} = ?`), "updated_at = datetime('now')"].join(', ');
  db.prepare(`UPDATE alert_rules SET ${setClauses} WHERE id = ?`)
    .run(...Object.values(updates), params.alert_id);

  const rule = db.prepare('SELECT * FROM alert_rules WHERE id = ?').get(params.alert_id);
  return json({ rule });
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
  const access = checkAccess(locals, params.org_id, params.id, params.alert_id);
  if ('error' in access) return json({ error: access.error }, { status: access.status });
  if (!['owner', 'admin'].includes((access.membership as { role: string }).role)) {
    return json({ error: 'Forbidden' }, { status: 403 });
  }

  const db = getDb();
  db.prepare('DELETE FROM alert_rules WHERE id = ?').run(params.alert_id);
  return json({ success: true });
};
