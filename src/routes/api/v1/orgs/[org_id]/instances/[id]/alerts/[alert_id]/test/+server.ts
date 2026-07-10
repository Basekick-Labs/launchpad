import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { queryArc } from '$lib/server/arcConnection';

type AlertCondition = 'greater_than' | 'less_than' | 'equals' | 'not_equals' | 'contains';

function evaluateCondition(value: unknown, condition: AlertCondition, threshold: string): boolean {
  if (value === null || value === undefined) return false;
  switch (condition) {
    case 'greater_than': return Number(value) > Number(threshold);
    case 'less_than': return Number(value) < Number(threshold);
    case 'equals': return String(value) == threshold;
    case 'not_equals': return String(value) != threshold;
    case 'contains': return String(value).toLowerCase().includes(threshold.toLowerCase());
    default: return false;
  }
}

export const POST: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

  const db = getDb();
  const membership = db.prepare(
    'SELECT role FROM org_members WHERE org_id = ? AND user_id = ?'
  ).get(params.org_id, locals.user.id) as { role: string } | undefined;
  // Running the alert query against Arc is a write-shaped side effect — restrict
  // to owner/admin, matching alert create/update/delete. Viewers are read-only.
  if (!membership || !['owner', 'admin'].includes(membership.role)) {
    return json({ error: 'Forbidden' }, { status: 403 });
  }

  const instance = db.prepare(
    'SELECT id, endpoint_url, admin_token FROM instances WHERE id = ? AND org_id = ? AND deleted_at IS NULL'
  ).get(params.id, params.org_id) as { id: string; endpoint_url: string | null; admin_token: string | null } | undefined;
  if (!instance) return json({ error: 'Instance not found' }, { status: 404 });

  const rule = db.prepare(
    'SELECT query, condition, threshold FROM alert_rules WHERE id = ? AND instance_id = ?'
  ).get(params.alert_id, params.id) as { query: string; condition: AlertCondition; threshold: string } | undefined;
  if (!rule) return json({ error: 'Alert not found' }, { status: 404 });

  if (!instance.admin_token) {
    return json({ error: 'Instance admin token not available' }, { status: 503 });
  }

  if (!instance.endpoint_url) {
    return json({ error: 'Instance has no Arc endpoint configured' }, { status: 503 });
  }

  // queryArc resolves + pins the IP (SSRF/rebinding-safe) and caps the response.
  let result: { rows?: unknown[][] } | null = null;
  try {
    const res = await queryArc(instance.endpoint_url, instance.admin_token, rule.query);
    if (res.status >= 200 && res.status < 300) {
      try { result = JSON.parse(res.body.toString('utf-8')); } catch { result = null; }
    }
  } catch {
    return json({ error: 'Instance endpoint is not reachable or not allowed' }, { status: 502 });
  }

  if (!result?.rows?.length) {
    return json({ value: null, wouldTrigger: false, error: 'Query returned no results' });
  }

  const value = result.rows[0][0];
  const wouldTrigger = evaluateCondition(value, rule.condition, rule.threshold);
  return json({ value, wouldTrigger });
};
