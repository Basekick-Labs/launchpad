import { getDb } from './db.js';
import { getProxyTarget } from './arcConnection.js';
import { parseIntervalToMs } from '../alertManager.js';
import http from 'http';
import https from 'https';
import { isSafeWebhookUrl } from './util.js';
export { isSafeWebhookUrl };

export const MIN_ALERT_INTERVAL_MS = 60_000; // 1 minute minimum

export type AlertCondition = 'greater_than' | 'less_than' | 'equals' | 'not_equals' | 'contains';

export interface AlertRule {
  id: string;
  instance_id: string;
  name: string;
  query: string;
  condition: AlertCondition;
  threshold: string;
  check_interval: string;
  webhook_url: string | null;
  enabled: number;
  last_checked_at: string | null;
  last_value: string | null;
  last_error: string | null;
  triggered_count: number;
  created_at: string;
  updated_at: string;
}

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

async function queryInstance(
  endpointUrl: string | null,
  adminToken: string,
  sql: string,
): Promise<{ rows: unknown[][] } | null> {
  const target = getProxyTarget(endpointUrl);
  if (!target) return null;
  const body = JSON.stringify({ sql });
  const options = {
    hostname: target.hostname,
    port: target.port,
    path: '/api/v1/query',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Authorization': `Bearer ${adminToken}`,
      'Host': target.host,
    },
  };

  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), 15_000);
    const mod = target.protocol === 'https' ? https : http;
    const MAX_RESPONSE_BYTES = 1024 * 1024; // 1 MB
    const req = mod.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
        if (data.length > MAX_RESPONSE_BYTES) {
          clearTimeout(timeout);
          req.destroy();
          resolve(null);
        }
      });
      res.on('end', () => {
        clearTimeout(timeout);
        try {
          const parsed = JSON.parse(data);
          resolve(parsed);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => { clearTimeout(timeout); resolve(null); });
    req.write(body);
    req.end();
  });
}

async function fireWebhook(
  webhookUrl: string,
  rule: AlertRule,
  value: unknown,
  triggeredAt: string,
): Promise<void> {
  const payload = JSON.stringify({
    alert: rule.name,
    instance_id: rule.instance_id,
    condition: rule.condition,
    threshold: rule.threshold,
    value,
    triggered_at: triggeredAt,
    message: `${rule.name}: ${value} ${rule.condition.replace('_', ' ')} ${rule.threshold}`,
  });

  if (!isSafeWebhookUrl(webhookUrl)) {
    console.warn(`[alerts] Skipping unsafe webhook URL for rule ${rule.id}`);
    return;
  }

  try {
    const url = new URL(webhookUrl);
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 10_000);
      const req = https.request(
        { hostname: url.hostname, port: url.port || 443, path: url.pathname + url.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
        (res) => { res.resume(); res.on('end', () => { clearTimeout(timeout); resolve(); }); },
      );
      req.on('error', () => { clearTimeout(timeout); resolve(); });
      req.write(payload);
      req.end();
    });
  } catch {
    // Webhook errors are non-fatal
  }
}

export async function evaluateAlerts(): Promise<void> {
  const db = getDb();
  const now = Date.now();

  const rows = db.prepare(`
    SELECT ar.*, i.endpoint_url, i.admin_token
    FROM alert_rules ar
    JOIN instances i ON ar.instance_id = i.id
    WHERE ar.enabled = 1
      AND i.status = 'running'
      AND i.deleted_at IS NULL
  `).all() as Array<AlertRule & { endpoint_url: string | null; admin_token: string | null }>;

  for (const rule of rows) {
    try {
      // Check if interval has elapsed
      const intervalMs = parseIntervalToMs(rule.check_interval);
      if (rule.last_checked_at) {
        const lastMs = new Date(rule.last_checked_at).getTime();
        if (now - lastMs < intervalMs) continue;
      }

      if (!rule.admin_token) {
        db.prepare(`UPDATE alert_rules SET last_checked_at = ?, last_error = ?, updated_at = datetime('now') WHERE id = ?`)
          .run(new Date().toISOString(), 'No admin token available', rule.id);
        continue;
      }

      const result = await queryInstance(rule.endpoint_url, rule.admin_token, rule.query);

      const checkedAt = new Date().toISOString();

      if (!result?.rows?.length) {
        db.prepare(`UPDATE alert_rules SET last_checked_at = ?, last_value = NULL, last_error = 'Query returned no results', updated_at = datetime('now') WHERE id = ?`)
          .run(checkedAt, rule.id);
        continue;
      }

      const value = result.rows[0][0];
      const triggered = evaluateCondition(value, rule.condition, rule.threshold);

      if (triggered) {
        const triggeredAt = checkedAt;
        const message = `${rule.name}: ${value} ${rule.condition.replace(/_/g, ' ')} ${rule.threshold}`;

        db.prepare(`
          INSERT INTO alert_executions (id, alert_rule_id, triggered_at, value, message)
          VALUES (?, ?, ?, ?, ?)
        `).run(crypto.randomUUID(), rule.id, triggeredAt, String(value), message);

        db.prepare(`
          UPDATE alert_rules SET last_checked_at = ?, last_value = ?, last_error = NULL,
            triggered_count = triggered_count + 1, updated_at = datetime('now') WHERE id = ?
        `).run(checkedAt, String(value), rule.id);

        if (rule.webhook_url) {
          fireWebhook(rule.webhook_url, rule, value, triggeredAt).catch(() => {});
        }
      } else {
        db.prepare(`
          UPDATE alert_rules SET last_checked_at = ?, last_value = ?, last_error = NULL, updated_at = datetime('now') WHERE id = ?
        `).run(checkedAt, String(value), rule.id);
      }

      console.log(`[alerts] Rule "${rule.name}" (${rule.id}): triggered=${triggered}`);
    } catch (err) {
      console.error(`[alerts] Error evaluating rule ${rule.id}:`, err);
      try {
        db.prepare(`UPDATE alert_rules SET last_checked_at = ?, last_error = ?, updated_at = datetime('now') WHERE id = ?`)
          .run(new Date().toISOString(), err instanceof Error ? err.message : 'Unknown error', rule.id);
      } catch { /* ignore */ }
    }
  }
}
