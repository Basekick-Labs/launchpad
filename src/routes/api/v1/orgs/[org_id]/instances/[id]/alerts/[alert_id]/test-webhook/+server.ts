import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { isSafeWebhookUrl } from '$lib/server/alertEvaluator';
import { safePostJson } from '$lib/server/ssrf';

export const POST: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

  const db = getDb();
  const membership = db.prepare(
    'SELECT role FROM org_members WHERE org_id = ? AND user_id = ?'
  ).get(params.org_id, locals.user.id) as { role: string } | undefined;
  // Triggering an outbound webhook is a write-shaped side effect — restrict to
  // owner/admin, matching alert create/update/delete. Viewers are read-only.
  if (!membership || !['owner', 'admin'].includes(membership.role)) {
    return json({ error: 'Forbidden' }, { status: 403 });
  }

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
    // Resolves + pins the IP (SSRF / DNS-rebinding safe) before sending.
    const { status } = await safePostJson(rule.webhook_url, payload, { timeoutMs: 10_000 });
    if (status < 200 || status >= 300) {
      return json({ error: `Webhook returned HTTP ${status}` }, { status: 502 });
    }
    return json({ success: true });
  } catch (err) {
    // Don't leak internal resolution/transport detail to the caller.
    const message = err instanceof Error && /not allowed|private address|Invalid URL|scheme/.test(err.message)
      ? 'Webhook URL is not allowed'
      : 'Webhook delivery failed';
    return json({ error: message }, { status: 502 });
  }
};
