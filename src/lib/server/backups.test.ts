import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createBackup, deleteBackup, getBackupDetail, getBackupProgress, getBackupsView, resetBackupCachesForTests, restoreBackup } from './backups';
import { resetClusterCachesForTests } from './clusterNodes';
import { getDb } from './db';
import { listChanges } from './instanceChangeLog';

/**
 * Fake Arc nodes. Node "a" is the endpoint; with `cluster` set it reports a
 * cluster of a (reader), b and c (writers), with `primary` as Arc main's
 * primary_writer_id. Each node answers the backup routes from its own state,
 * as Arc does.
 */
interface Fake {
  id: string;
  port: number;
  server: http.Server;
  requests: Array<{ method: string; path: string; body: string }>;
  backups: Array<Record<string, unknown>>;
  progress: Record<string, unknown>;
  /** Status for the next answer to each "METHOD path", then removed. */
  next: Map<string, { status: number; body: unknown } | 'hang'>;
}
const nodes: Record<string, Fake> = {};
let cluster: { primary: string | null; writers: string[] } | null = null;
let backupEnabled = true;
const TOKEN = 'admin-token';
const opts = { allowPrivate: true, nodeCidrs: [] };
const ID = 'backup-20261119-191548-072799a5';
const ID2 = 'backup-20261120-080000-0000beef';

function summary(id: string, extra: Record<string, unknown> = {}) {
  return { backup_id: id, created_at: `${id.slice(7, 11)}-${id.slice(11, 13)}-${id.slice(13, 15)}T00:00:00Z`, backup_type: 'full', total_files: 4, total_size_bytes: 3637, database_count: 2, ...extra };
}

function handler(id: string) {
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    const n = nodes[id];
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const p = url.pathname;
      const send = (status: number, b: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(b));
      };
      if (p === '/api/v1/cluster') {
        if (!cluster) return send(200, { success: false, enabled: false, mode: 'standalone', reason: 'off' });
        return send(200, {
          enabled: true, cluster_name: 'bk', local_node_id: 'a',
          ...(cluster.primary ? { primary_writer_id: cluster.primary } : {}),
          nodes: ['a', 'b', 'c'].map((x) => ({
            id: x, name: x, role: cluster!.writers.includes(x) ? 'writer' : 'reader', state: 'healthy',
            address: `127.0.0.1:${9000 + x.charCodeAt(0)}`, api_address: `127.0.0.1:${nodes[x].port}`,
          })),
        });
      }
      if (p === '/api/v1/cluster/health') return send(200, {});
      if (p === '/api/v1/cluster/local') return send(200, { id, cluster_name: 'bk' });
      if (p === '/health') return send(200, { status: 'ok' });
      if (!p.startsWith('/api/v1/backup')) return send(404, { error: `Cannot ${req.method} ${p}` });

      n.requests.push({ method: req.method ?? '', path: p, body });
      if (!backupEnabled) return send(404, { error: `Cannot ${req.method} ${p}` });
      const key = `${req.method} ${p}`;
      const forced = n.next.get(key);
      if (forced) {
        n.next.delete(key);
        if (forced === 'hang') return; // never answers
        return send(forced.status, forced.body);
      }
      if (req.method === 'GET' && p === '/api/v1/backup') return send(200, { backups: n.backups, count: n.backups.length });
      if (req.method === 'GET' && p === '/api/v1/backup/status') return send(200, n.progress);
      if (req.method === 'POST' && p === '/api/v1/backup') {
        n.progress = { operation: 'backup', backup_id: ID2, status: 'running', total_files: 4, processed_files: 1, skipped_files: 0, total_bytes: 100, processed_bytes: 25, started_at: new Date().toISOString() };
        return send(202, { message: 'Backup started', status: 'running' });
      }
      if (req.method === 'POST' && p === '/api/v1/backup/restore') {
        const r = JSON.parse(body) as { backup_id: string; restore_metadata: boolean };
        n.progress = { operation: 'restore', backup_id: r.backup_id, status: 'running', total_files: 4, processed_files: 0, skipped_files: 0, total_bytes: 0, processed_bytes: 0, started_at: new Date().toISOString() };
        return send(202, { message: 'Restore started', backup_id: r.backup_id, status: 'running', ...(r.restore_metadata ? { restart_required: true, staged: true } : {}) });
      }
      const m = /^\/api\/v1\/backup\/(.+)$/.exec(p);
      if (m) {
        const found = n.backups.find((b) => b.backup_id === m[1]);
        // Arc's delete has no 404: a missing backup is its 500, like any failure.
        if (!found) return send(req.method === 'DELETE' ? 500 : 404, { error: req.method === 'DELETE' ? 'Failed to delete backup' : 'Backup not found' });
        if (req.method === 'GET') {
          return send(200, { version: '26.09.4', ...found, databases: [{ name: 'metrics', file_count: 1, size_bytes: 1023, measurements: [{ name: 'cpu', file_count: 1, size_bytes: 1023 }] }], has_metadata: true, has_config: true });
        }
        if (req.method === 'DELETE') {
          n.backups = n.backups.filter((b) => b !== found);
          return send(200, { message: 'Backup deleted', backup_id: m[1] });
        }
      }
      return send(404, { error: `Cannot ${req.method} ${p}` });
    });
  };
}

beforeAll(async () => {
  for (const id of ['a', 'b', 'c']) {
    const server = http.createServer(handler(id));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    nodes[id] = { id, server, port: (server.address() as AddressInfo).port, requests: [], backups: [], progress: { status: 'idle' }, next: new Map() };
  }
});
afterAll(() => Promise.all(Object.values(nodes).map((n) => new Promise<void>((r) => {
  n.server.closeAllConnections();
  n.server.close(() => r());
}))));

const target = () => ({ id: 'i1', endpoint_url: `http://127.0.0.1:${nodes.a.port}`, admin_token: TOKEN, node_scheme: null });

beforeEach(() => {
  resetBackupCachesForTests();
  resetClusterCachesForTests();
  const db = getDb();
  db.exec('DELETE FROM instance_change_log; DELETE FROM instances; DELETE FROM organizations; DELETE FROM users;');
  db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run('u1', 'ada@example.test');
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run('o1', 'Org', 'u1');
  db.prepare('INSERT INTO instances (id, org_id, resource_id, status) VALUES (?, ?, ?, ?)').run('i1', 'o1', 'r1', 'running');
  cluster = null;
  backupEnabled = true;
  for (const n of Object.values(nodes)) {
    n.requests = [];
    n.backups = [summary(ID)];
    n.progress = { status: 'idle' };
    n.next.clear();
  }
});

const backupRequests = (id: string) => nodes[id].requests.map((r) => `${r.method} ${r.path}`);
const changes = () => listChanges('i1', null).changes.map((c) => [c.method, c.path, c.status, c.outcome]);

describe('getBackupsView', () => {
  it('reads a standalone instance\'s backups and status from its endpoint', async () => {
    nodes.a.backups = [summary(ID), summary(ID2, { scope: ['metrics'] })];
    const v = await getBackupsView(target(), opts);
    expect(v.node).toEqual({ nodeId: 'standalone', source: `127.0.0.1:${nodes.a.port}`, clustered: false });
    expect(v.backups.map((b) => [b.id, b.scope])).toEqual([[ID2, ['metrics']], [ID, []]]);
    expect(v.progress.status).toBe('idle');
  });

  it('reads a cluster\'s primary writer, never another node', async () => {
    cluster = { primary: 'c', writers: ['b', 'c'] };
    nodes.b.backups = [];
    const v = await getBackupsView(target(), opts);
    expect(v.node).toEqual({ nodeId: 'c', source: `127.0.0.1:${nodes.c.port}`, clustered: true });
    expect(v.backups.map((b) => b.id)).toEqual([ID]);
    expect(backupRequests('a')).toEqual([]);
    expect(backupRequests('b')).toEqual([]);
    expect(backupRequests('c').sort()).toEqual(['GET /api/v1/backup', 'GET /api/v1/backup/status']);
  });

  it('uses a v26.09 cluster\'s only writer, which has no primary', async () => {
    cluster = { primary: null, writers: ['b'] };
    expect((await getBackupsView(target(), opts)).node.nodeId).toBe('b');
  });

  it('refuses to guess between writers when Arc names no primary', async () => {
    cluster = { primary: null, writers: ['b', 'c'] };
    await expect(getBackupsView(target(), opts)).rejects.toMatchObject({ code: 'no_primary_writer' });
    expect(backupRequests('b')).toEqual([]);
    expect(backupRequests('c')).toEqual([]);
  });

  it('says backups are turned off when Arc does not serve the routes', async () => {
    backupEnabled = false;
    await expect(getBackupsView(target(), opts)).rejects.toMatchObject({ code: 'upstream_status', message: expect.stringMatching(/turned off.*\[backup\]/) });
  });

  it('passes on Arc main\'s reason when no destination can be listed', async () => {
    nodes.a.next.set('GET /api/v1/backup', { status: 503, body: { error: 'could not list backups: backup target "s3" is unreachable', targets: ['s3'] } });
    await expect(getBackupsView(target(), opts)).rejects.toMatchObject({ message: 'could not list backups: backup target "s3" is unreachable' });
  });

  it('maps a rejected or non-admin token', async () => {
    nodes.a.next.set('GET /api/v1/backup', { status: 401, body: { error: 'Invalid token' } });
    await expect(getBackupsView(target(), opts)).rejects.toMatchObject({ code: 'token_rejected' });
    resetBackupCachesForTests();
    nodes.a.next.set('GET /api/v1/backup', { status: 403, body: { error: 'Admin permission required' } });
    await expect(getBackupsView(target(), opts)).rejects.toMatchObject({ code: 'token_not_admin' });
  });
});

describe('getBackupProgress', () => {
  it('reads the running operation from the backup node', async () => {
    nodes.a.progress = { operation: 'backup', backup_id: ID2, status: 'running', total_files: 10, processed_files: 4, skipped_files: 0, total_bytes: 200, processed_bytes: 50, started_at: '2026-11-20T08:00:00Z' };
    const p = await getBackupProgress(target(), opts);
    expect(p.progress).toMatchObject({ status: 'running', operation: 'backup', backupId: ID2, processedBytes: 50 });
  });
});

describe('getBackupDetail', () => {
  it('reads one backup\'s manifest', async () => {
    const d = await getBackupDetail(target(), ID, opts);
    expect(d.backup).toMatchObject({ id: ID, version: '26.09.4', hasMetadata: true, hasConfig: true, databaseCount: 1 });
    expect(d.backup.databases[0].measurements).toEqual([{ name: 'cpu', fileCount: 1, sizeBytes: 1023 }]);
  });

  it('says when Arc has no such backup', async () => {
    await expect(getBackupDetail(target(), ID2, opts)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('createBackup', () => {
  it('sends both choices explicitly and records the change', async () => {
    const o = await createBackup(target(), { includeMetadata: true, includeConfig: false }, 'u1', opts);
    expect(o).toMatchObject({ result: 'done' });
    const post = nodes.a.requests.find((r) => r.method === 'POST');
    expect(JSON.parse(post!.body)).toEqual({ include_metadata: true, include_config: false });
    expect(changes()).toEqual([['POST', '/api/v1/backup', 202, 'ok']]);
  });

  it('sends a cluster\'s backup to its primary writer only', async () => {
    cluster = { primary: 'b', writers: ['b', 'c'] };
    await createBackup(target(), { includeMetadata: true, includeConfig: false }, 'u1', opts);
    expect(backupRequests('b')).toContain('POST /api/v1/backup');
    expect(backupRequests('a')).toEqual([]);
    expect(backupRequests('c')).toEqual([]);
  });

  it('says which operation holds Arc\'s slot', async () => {
    nodes.a.next.set('POST /api/v1/backup', { status: 409, body: { error: 'A backup or restore operation is already in progress', status: 'running', operation: 'restore' } });
    const o = await createBackup(target(), { includeMetadata: true, includeConfig: false }, 'u1', opts);
    expect(o).toMatchObject({ result: 'busy', message: expect.stringMatching(/^A restore is already running/) });
    expect(changes()).toEqual([['POST', '/api/v1/backup', 409, 'error']]);
  });

  it('passes on Arc main\'s refusal on a node that is no longer the primary', async () => {
    nodes.a.next.set('POST /api/v1/backup', { status: 503, body: { error: 'backup rejected: node role "writer" is not primary writer; route to the primary writer', role: 'writer' } });
    const o = await createBackup(target(), { includeMetadata: true, includeConfig: false }, 'u1', opts);
    expect(o).toMatchObject({ result: 'refused', message: expect.stringMatching(/not primary writer/) });
  });

  it('reads the status back after a 5xx, and counts only a run this request started', async () => {
    nodes.a.progress = { operation: 'backup', backup_id: ID, status: 'completed', total_files: 4, processed_files: 4, skipped_files: 0, total_bytes: 1, processed_bytes: 1, started_at: '2026-11-19T19:15:48Z' };
    nodes.a.next.set('POST /api/v1/backup', { status: 502, body: {} });
    // The earlier run is still the last one: nothing was started.
    await expect(createBackup(target(), { includeMetadata: true, includeConfig: false }, 'u1', opts)).rejects.toMatchObject({ code: 'upstream_status', message: expect.stringMatching(/whether the backup started is not known/) });
    expect(changes()).toEqual([['POST', '/api/v1/backup', 502, 'unknown']]);
  });

  it('reports the run when the answer was lost but Arc started it', async () => {
    // A proxy in front of Arc answering 502 after Arc accepted the request.
    const server = nodes.a;
    server.next.set('POST /api/v1/backup', { status: 502, body: {} });
    const original = server.server.listeners('request')[0] as http.RequestListener;
    server.server.removeAllListeners('request');
    server.server.on('request', (req, res) => {
      if (req.method === 'POST' && req.url === '/api/v1/backup') {
        server.progress = { operation: 'backup', backup_id: ID2, status: 'running', total_files: 0, processed_files: 0, skipped_files: 0, total_bytes: 0, processed_bytes: 0, started_at: new Date().toISOString() };
      }
      original(req, res);
    });
    try {
      const o = await createBackup(target(), { includeMetadata: true, includeConfig: false }, 'u1', opts);
      expect(o.result).toBe('done');
      expect(changes()).toEqual([['POST', '/api/v1/backup', 502, 'ok']]);
    } finally {
      server.server.removeAllListeners('request');
      server.server.on('request', original);
    }
  });
});

describe('deleteBackup', () => {
  it('deletes on the backup node and records it', async () => {
    expect(await deleteBackup(target(), ID, 'u1', opts)).toMatchObject({ result: 'done' });
    expect(nodes.a.backups).toEqual([]);
    expect(changes()).toEqual([['DELETE', `/api/v1/backup/${ID}`, 200, 'ok']]);
  });

  it('reads back a failed delete of a backup that is no longer there', async () => {
    expect(await deleteBackup(target(), ID2, 'u1', opts)).toMatchObject({ result: 'done', message: expect.stringMatching(/no longer on Arc's backup destination/) });
    expect(changes()).toEqual([['DELETE', `/api/v1/backup/${ID2}`, 500, 'ok']]);
  });

  it('checks whether a failed delete left the backup', async () => {
    nodes.a.next.set(`DELETE /api/v1/backup/${ID}`, { status: 500, body: { error: 'Failed to delete backup' } });
    await expect(deleteBackup(target(), ID, 'u1', opts)).rejects.toMatchObject({ message: expect.stringMatching(/still there: some of its files may already be gone/) });
    expect(changes()).toEqual([['DELETE', `/api/v1/backup/${ID}`, 500, 'error']]);
  });
});

describe('restoreBackup', () => {
  it('sends the choices with confirm, and says when Arc needs a restart', async () => {
    const o = await restoreBackup(target(), ID, { restoreData: true, restoreMetadata: true, restoreConfig: false }, 'u1', opts);
    expect(o).toMatchObject({ result: 'done', restartRequired: true, mode: null });
    const post = nodes.a.requests.find((r) => r.method === 'POST');
    expect(JSON.parse(post!.body)).toEqual({ backup_id: ID, restore_data: true, restore_metadata: true, restore_config: false, confirm: true });
    expect(changes()).toEqual([['POST', '/api/v1/backup/restore', 202, 'ok']]);
  });

  it('passes on the mode Arc main runs it in', async () => {
    nodes.a.next.set('POST /api/v1/backup/restore', { status: 202, body: { message: 'Restore started', backup_id: ID, status: 'running', mode: 'replace' } });
    expect(await restoreBackup(target(), ID, { restoreData: true, restoreMetadata: false, restoreConfig: false }, 'u1', opts)).toMatchObject({ mode: 'replace', restartRequired: false });
  });

  it('never sends the metadata or config of a restore to a cluster node', async () => {
    cluster = { primary: 'b', writers: ['b'] };
    const o = await restoreBackup(target(), ID, { restoreData: true, restoreMetadata: true, restoreConfig: false }, 'u1', opts);
    expect(o.result).toBe('refused');
    expect(backupRequests('b')).toEqual([]);
    expect(changes()).toEqual([]);
    expect(await restoreBackup(target(), ID, { restoreData: true, restoreMetadata: false, restoreConfig: false }, 'u1', opts)).toMatchObject({ result: 'done' });
    expect(backupRequests('b')).toContain('POST /api/v1/backup/restore');
  });

  it('passes on Arc\'s validation', async () => {
    nodes.a.next.set('POST /api/v1/backup/restore', { status: 400, body: { error: 'restore_config: arc.toml is not writable by the Arc process' } });
    const o = await restoreBackup(target(), ID, { restoreData: true, restoreMetadata: false, restoreConfig: true }, 'u1', opts);
    expect(o).toMatchObject({ result: 'refused', message: 'restore_config: arc.toml is not writable by the Arc process' });
  });

  it('reads the status back when Arc does not answer', async () => {
    nodes.a.next.set('POST /api/v1/backup/restore', 'hang');
    // Shorten the wait: abort the hung request by closing its socket.
    setTimeout(() => nodes.a.server.closeAllConnections(), 200);
    await expect(restoreBackup(target(), ID, { restoreData: true, restoreMetadata: false, restoreConfig: false }, 'u1', opts)).rejects.toMatchObject({ code: 'unreachable' });
    expect(changes()).toEqual([['POST', '/api/v1/backup/restore', null, 'unknown']]);
  });
});
