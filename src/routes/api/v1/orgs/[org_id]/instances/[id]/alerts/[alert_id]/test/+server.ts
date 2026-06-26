import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { getProxyTarget } from '$lib/server/arcConnection';
import http from 'http';
import https from 'https';

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
  ).get(params.org_id, locals.user.id);
  if (!membership) return json({ error: 'Forbidden' }, { status: 403 });

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

  const target = getProxyTarget(instance.endpoint_url);
  if (!target) {
    return json({ error: 'Instance has no Arc endpoint configured' }, { status: 503 });
  }
  const body = JSON.stringify({ sql: rule.query });

  const result = await new Promise<{ rows?: unknown[][] } | null>((resolve) => {
    const timeout = setTimeout(() => resolve(null), 15_000);
    const options = {
      hostname: target.hostname,
      port: target.port,
      path: '/api/v1/query',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': `Bearer ${instance.admin_token}`,
        'Host': target.host,
      },
    };
    const MAX_RESPONSE_BYTES = 1024 * 1024; // 1 MB
    const mod = target.protocol === 'https' ? https : http;
    const req = mod.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
        if (data.length > MAX_RESPONSE_BYTES) { req.destroy(); clearTimeout(timeout); resolve(null); }
      });
      res.on('end', () => {
        clearTimeout(timeout);
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', () => { clearTimeout(timeout); resolve(null); });
    req.write(body);
    req.end();
  });

  if (!result?.rows?.length) {
    return json({ value: null, wouldTrigger: false, error: 'Query returned no results' });
  }

  const value = result.rows[0][0];
  const wouldTrigger = evaluateCondition(value, rule.condition, rule.threshold);
  return json({ value, wouldTrigger });
};
