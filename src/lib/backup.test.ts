import { describe, expect, it } from 'vitest';
import {
  arcText,
  BACKUP_ID_RE,
  busyMessage,
  createBackupBody,
  describeProgress,
  IDLE,
  MAX_BACKUPS,
  parseBackupDetail,
  parseBackupList,
  parseCreateInput,
  parseProgress,
  parseRestoreInput,
  progressPercent,
  restoreBody,
  restoreImpact,
} from './backup';

const ID = 'backup-20261119-191548-072799a5';
const ID2 = 'backup-20261120-080000-0000beef';

// What Arc v26.09.4 answers (captured from ghcr.io/basekick-labs/arc:26.09.4).
const LIST_26094 = {
  backups: [{ backup_id: ID, created_at: '2026-11-19T19:15:48.291560588Z', backup_type: 'full', total_files: 4, total_size_bytes: 3637, database_count: 2 }],
  count: 1,
};
const MANIFEST_26094 = {
  version: 'dev',
  backup_id: ID,
  created_at: '2026-11-19T19:15:48.291560588Z',
  backup_type: 'full',
  databases: [
    { name: 'metrics', measurements: [{ name: 'cpu', file_count: 1, size_bytes: 1023 }], file_count: 1, size_bytes: 1023 },
    { name: 'default', measurements: [{ name: 'mem', file_count: 2, size_bytes: 10 }, { name: 'cpu', file_count: 1, size_bytes: 1044 }], file_count: 3, size_bytes: 1054 },
  ],
  total_files: 4,
  total_size_bytes: 3637,
  auxiliary_files: 2,
  has_metadata: true,
  has_config: true,
};
const PROGRESS_26094 = {
  operation: 'backup', backup_id: ID, status: 'completed', total_files: 4, processed_files: 4, skipped_files: 0,
  total_bytes: 3637, processed_bytes: 3637, started_at: '2026-11-19T19:15:48.291560588Z', completed_at: '2026-11-19T19:15:48.313410774Z',
};

describe('BACKUP_ID_RE', () => {
  it('matches the ids Arc writes and nothing else', () => {
    expect(BACKUP_ID_RE.test(ID)).toBe(true);
    for (const bad of ['backup-20261119-191548-072799A5', 'backup-20261119-191548-072799a', `${ID}/..`, 'status', 'restore', '']) {
      expect(BACKUP_ID_RE.test(bad)).toBe(false);
    }
  });
});

describe('parseBackupList', () => {
  it('reads a v26.09.4 listing as complete, single-destination, whole-instance backups', () => {
    const l = parseBackupList(LIST_26094)!;
    expect(l.backups).toEqual([{
      id: ID, createdAt: '2026-11-19T19:15:48.291Z', type: 'full', scope: [], totalFiles: 4, totalBytes: 3637, databaseCount: 2,
      missingFiles: 0, targets: [], partialView: false,
    }]);
    expect(l).toMatchObject({ truncated: false, notes: [], incompleteRuns: [] });
  });

  it('reads what Arc main adds: scope, destinations, gaps, notes and incomplete runs', () => {
    const l = parseBackupList({
      backups: [
        { ...LIST_26094.backups[0], scope: ['metrics'], target: 'local', skipped_files: 5, skipped_reconciled: 2, unaddressable_files: 1, manifest_only_files: 4 },
        { backup_id: ID2, created_at: '2026-11-20T08:00:00Z', total_files: 1, targets: ['local', 's3'], partial_view: true },
      ],
      warning: '1 backup target(s) could not be reached: s3',
      hint: '2 backup(s) at this destination were written by a different Arc instance',
      incomplete_runs: [{ backup_id: ID2, created_at: '2026-11-20T08:00:00Z', missing_targets: ['s3'] }, { backup_id: '../x' }],
    })!;
    expect(l.backups.map((b) => [b.id, b.scope, b.targets, b.missingFiles, b.partialView])).toEqual([
      [ID2, [], ['local', 's3'], 0, true],
      [ID, ['metrics'], ['local'], 3 + 1 + 4, false],
    ]);
    expect(l.notes).toHaveLength(2);
    expect(l.incompleteRuns).toEqual([{ id: ID2, createdAt: '2026-11-20T08:00:00.000Z', missingTargets: ['s3'] }]);
  });

  it('drops entries that are not backups, and duplicates', () => {
    const l = parseBackupList({ backups: [LIST_26094.backups[0], LIST_26094.backups[0], { backup_id: 'nope' }, null, 'x'] })!;
    expect(l.backups.map((b) => b.id)).toEqual([ID]);
  });

  it('orders newest first, by the id when Arc sends no time', () => {
    const l = parseBackupList({ backups: [{ backup_id: ID }, { backup_id: ID2 }] })!;
    expect(l.backups.map((b) => b.id)).toEqual([ID2, ID]);
  });

  it('bounds the list', () => {
    const many = Array.from({ length: MAX_BACKUPS + 5 }, (_, i) => ({ backup_id: `backup-20261119-191548-${i.toString(16).padStart(8, '0')}` }));
    const l = parseBackupList({ backups: many })!;
    expect(l.backups).toHaveLength(MAX_BACKUPS);
    expect(l.truncated).toBe(true);
  });

  it('is null for anything else', () => {
    expect(parseBackupList(null)).toBeNull();
    expect(parseBackupList({ error: 'x' })).toBeNull();
  });
});

describe('parseBackupDetail', () => {
  it('reads a v26.09.4 manifest, databases and measurements by name', () => {
    const d = parseBackupDetail(MANIFEST_26094, ID)!;
    expect(d).toMatchObject({ id: ID, version: 'dev', hasMetadata: true, hasConfig: true, databaseCount: 2, totalFiles: 4, truncated: false, unavailableTargets: [] });
    expect(d.databases.map((x) => [x.name, x.measurements.map((m) => m.name)])).toEqual([['default', ['cpu', 'mem']], ['metrics', ['cpu']]]);
  });

  it('collects the destinations a restore would refuse (Arc main)', () => {
    const d = parseBackupDetail({ ...MANIFEST_26094, unreachable_targets: ['s3'], missing_targets: ['s3', 'gcs'] }, ID)!;
    expect(d.unavailableTargets).toEqual(['s3', 'gcs']);
  });

  it('refuses another backup\'s manifest', () => {
    expect(parseBackupDetail(MANIFEST_26094, ID2)).toBeNull();
  });

  it('removes control characters from Arc\'s names', () => {
    const d = parseBackupDetail({ ...MANIFEST_26094, databases: [{ name: 'a\u001b[31mb', measurements: [] }] }, ID)!;
    expect(d.databases[0].name).toBe('a [31mb');
  });
});

describe('parseProgress', () => {
  it('reads idle and Arc\'s progress record', () => {
    expect(parseProgress({ status: 'idle' })).toBe(IDLE);
    expect(parseProgress(PROGRESS_26094)).toMatchObject({ status: 'completed', operation: 'backup', backupId: ID, processedBytes: 3637, completedAt: '2026-11-19T19:15:48.313Z', error: null });
  });

  it('keeps a failure\'s reason and a restore\'s mode', () => {
    const p = parseProgress({ ...PROGRESS_26094, operation: 'restore', status: 'failed', error: 'backup not found', mode: 'replace', completed_at: '0001-01-01T00:00:00Z' })!;
    expect(p).toMatchObject({ operation: 'restore', status: 'failed', error: 'backup not found', mode: 'replace', completedAt: null });
    expect(describeProgress(p)).toBe(`Restore ${ID} failed: backup not found`);
  });

  it('is null for a status it does not know', () => {
    expect(parseProgress({ ...PROGRESS_26094, status: 'paused' })).toBeNull();
    expect(parseProgress({ ...PROGRESS_26094, operation: 'delete' })).toBeNull();
    expect(parseProgress('idle')).toBeNull();
  });
});

describe('progressPercent', () => {
  it('counts bytes, else files, and is null before Arc knows the total', () => {
    const p = parseProgress(PROGRESS_26094)!;
    expect(progressPercent({ ...p, processedBytes: 1000 })).toBe(27);
    expect(progressPercent({ ...p, totalBytes: 0, processedFiles: 1, skippedFiles: 1 })).toBe(50);
    expect(progressPercent({ ...p, totalBytes: 0, totalFiles: 0 })).toBeNull();
  });
});

describe('requests', () => {
  it('validates what the browser sends', () => {
    expect(parseCreateInput({ includeMetadata: true, includeConfig: false })).toEqual({ includeMetadata: true, includeConfig: false });
    expect(parseCreateInput({ includeMetadata: 'yes', includeConfig: false })).toBeNull();
    expect(parseRestoreInput({ restoreData: true, restoreMetadata: false, restoreConfig: false })).not.toBeNull();
    expect(parseRestoreInput({ restoreData: false, restoreMetadata: false, restoreConfig: false })).toBeNull();
    expect(parseRestoreInput({ restoreData: true })).toBeNull();
  });

  it('always names every choice, and confirms a restore', () => {
    expect(createBackupBody({ includeMetadata: false, includeConfig: false })).toEqual({ include_metadata: false, include_config: false });
    expect(restoreBody(ID, { restoreData: true, restoreMetadata: false, restoreConfig: false })).toEqual({
      backup_id: ID, restore_data: true, restore_metadata: false, restore_config: false, confirm: true,
    });
  });
});

describe('restoreImpact', () => {
  const d = parseBackupDetail(MANIFEST_26094, ID)!;
  const all = { restoreData: true, restoreMetadata: true, restoreConfig: true };

  it('says a standalone restore adds files, and what restarts', () => {
    const lines = restoreImpact(d, all, false);
    expect(lines[0]).toMatch(/^Data of databases default, metrics is copied back\. Files are added, not removed/);
    expect(lines[1]).toMatch(/metadata .* next restart.*Launchpad's included/);
    expect(lines[2]).toMatch(/arc\.toml is replaced/);
  });

  it('leaves out what the backup does not hold or the restore does not include', () => {
    expect(restoreImpact({ ...d, hasConfig: false }, all, false)).toHaveLength(2);
    expect(restoreImpact(d, { restoreData: false, restoreMetadata: true, restoreConfig: false }, false)).toHaveLength(1);
  });

  it('says a scoped restore on a cluster replaces those databases', () => {
    const lines = restoreImpact({ ...d, scope: ['metrics'] }, { restoreData: true, restoreMetadata: false, restoreConfig: false }, true);
    expect(lines).toEqual([expect.stringMatching(/^Data of database metrics: Arc replaces the current files/)]);
  });

  it('warns about an incomplete backup', () => {
    expect(restoreImpact({ ...d, missingFiles: 3 }, all, false)).toContainEqual(expect.stringMatching(/3 data files were not stored/));
  });
});

describe('wording', () => {
  it('names the operation holding the slot', () => {
    expect(busyMessage('delete')).toMatch(/^A backup deletion is already running/);
    expect(busyMessage(undefined)).toMatch(/^Another backup operation/);
  });

  it('describes each state', () => {
    expect(describeProgress(IDLE)).toMatch(/No backup or restore has run/);
    expect(describeProgress({ ...parseProgress(PROGRESS_26094)!, skippedFiles: 2 })).toBe(`Backup ${ID} completed. 2 files were skipped.`);
  });

  it('bounds and cleans Arc\'s text', () => {
    expect(arcText(' a\nb ')).toBe('a b');
    expect(arcText('x'.repeat(5000))).toHaveLength(1000);
    expect(arcText(3)).toBeNull();
  });
});
