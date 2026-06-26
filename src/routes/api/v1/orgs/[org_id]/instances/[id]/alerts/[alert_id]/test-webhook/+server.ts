import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { isSafeWebhookUrl } from '$lib/server/alertEvaluator';
import https from 'https';

export const POST: RequestHandler = async ({ locals, params }) => {
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
    'SELECT id, name, instance_id, condition, threshold, webhook_url FROM alert_rules WHERE id = ? AND instance_id = ?'
  ).get(params.alert_id, params.id) as { id: string; name: string; instance_id: string; condition: string; threshold: string; webhook_url: string | null } | undefined;
  if (!rule) return json({ error: 'Alert not found' }, { status: 404 });

  if (!rule.webhook_url) {
    return json({ error: 'No webhook URL configured for this alert' }, { status: 400 });
  }

  if (!isSafeWebhookUrl(rule.webhook_url)) {
    return json({ error: 'Webhook URL is not a valid public HTTPS URL' }, { status: 400 });
  }

  const payload = JSON.stringify({
    alert: rule.name,
    instance_id: rule.instance_id,
    condition: rule.condition,
    threshold: rule.threshold,
    value: null,
    triggered_at: new Date().toISOString(),
    message: `[Test] ${rule.name}: webhook test triggered manually`,
    test: true,
  });

  try {
    const url = new URL(rule.webhook_url);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Webhook timed out')), 10_000);
      const req = https.request(
        {
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname + url.search,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        },
        (res) => {
          res.resume();
          res.on('end', () => {
            clearTimeout(timeout);
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve();
            } else {
              reject(new Error(`Webhook returned HTTP ${res.statusCode}`));
            }
          });
        },
      );
      req.on('error', (err) => { clearTimeout(timeout); reject(err); });
      req.write(payload);
      req.end();
    });

    return json({ success: true });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'Webhook failed' }, { status: 502 });
  }
};
