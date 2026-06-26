import type { Statement } from 'better-sqlite3';
import { env } from '$env/dynamic/private';
import { getDb } from './db';
import { isSafeWebhookUrl } from './util.js';

const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_DETAIL_LEN = 500;
const SECRET_PATTERN = /(ARC_LICENSE_KEY|ARC_AUTH_TOKEN|ARC_ADMIN_TOKEN|Bearer\s+[A-Za-z0-9._-]+|sk_(live|test)_[A-Za-z0-9]+|license[-_]?key["':\s]+[A-Za-z0-9._-]+)/gi;

export type OpsAlertSource = 'trial-enforcement' | 'background-job' | 'k8s-api' | 'webhook-delivery';

interface OpsAlertInput {
  source: OpsAlertSource;
  dedupKey: string;
  title: string;
  details?: Record<string, string | number | boolean | null | undefined>;
}

let _selectDedup: Statement | null = null;
let _markDedup: Statement | null = null;

function selectDedup(): Statement {
  if (!_selectDedup) {
    _selectDedup = getDb().prepare(
      'SELECT last_sent_at FROM alert_dedup WHERE source = ? AND dedup_key = ?'
    );
  }
  return _selectDedup;
}

function markDedup(): Statement {
  if (!_markDedup) {
    _markDedup = getDb().prepare(
      `INSERT INTO alert_dedup (source, dedup_key, last_sent_at) VALUES (?, ?, ?)
       ON CONFLICT(source, dedup_key) DO UPDATE SET last_sent_at = excluded.last_sent_at`
    );
  }
  return _markDedup;
}

function withinDedupWindow(source: string, dedupKey: string): boolean {
  const row = selectDedup().get(source, dedupKey) as { last_sent_at: string } | undefined;
  if (!row) return false;
  return Date.now() - new Date(row.last_sent_at).getTime() < DEDUP_WINDOW_MS;
}

function recordSent(source: string, dedupKey: string): void {
  markDedup().run(source, dedupKey, new Date().toISOString());
}

function redact(s: string): string {
  return s.replace(SECRET_PATTERN, '[redacted]');
}

function truncate(s: string): string {
  return s.length > MAX_DETAIL_LEN ? s.slice(0, MAX_DETAIL_LEN) + '…' : s;
}

function safeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return redact(truncate(raw));
}

async function postToChat(webhookUrl: string, text: string): Promise<void> {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Google Chat webhook returned ${res.status}`);
  }
}

function formatDetails(details?: OpsAlertInput['details']): string {
  if (!details) return '';
  const lines: string[] = [];
  for (const [k, v] of Object.entries(details)) {
    if (v === undefined || v === null || v === '') continue;
    lines.push(`*${k}:* ${redact(truncate(String(v)))}`);
  }
  return lines.length ? '\n' + lines.join('\n') : '';
}

export async function notifyOps(input: OpsAlertInput): Promise<void> {
  try {
    const webhookUrl = env.GCHAT_OPS_WEBHOOK_URL;
    if (!webhookUrl) return;
    if (!isSafeWebhookUrl(webhookUrl)) {
      console.error('[gchat-alert] GCHAT_OPS_WEBHOOK_URL rejected by isSafeWebhookUrl');
      return;
    }

    if (withinDedupWindow(input.source, input.dedupKey)) return;

    const text = `*[${input.source}]* ${input.title}${formatDetails(input.details)}`;
    await postToChat(webhookUrl, text);
    recordSent(input.source, input.dedupKey);
  } catch (err) {
    console.error('[gchat-alert] notifyOps failed:', err instanceof Error ? err.message : String(err));
  }
}

export async function withK8sAlert<T>(
  operation: string,
  instanceId: string,
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await fn();
  } catch (err: any) {
    const code = err?.code ?? err?.statusCode;
    void notifyOps({
      source: 'k8s-api',
      dedupKey: `${operation}:${instanceId}:${code ?? 'unknown'}`,
      title: `k8s API error: ${operation}`,
      details: {
        instance_id: instanceId,
        operation,
        http_code: code ?? 'unknown',
        error: safeErrorMessage(err),
      },
    });
    throw err;
  }
}


export function cleanupAlertDedup(): void {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  getDb().prepare('DELETE FROM alert_dedup WHERE last_sent_at < ?').run(cutoff);
}
