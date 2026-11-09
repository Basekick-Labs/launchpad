/** Shapes of the instance change log, shared by the server and the browser. */

export type ChangeOutcome = 'ok' | 'error' | 'unknown';

export interface ChangeEntry {
  id: number;
  method: string;
  /** Canonical Arc path; never a query string or a body. */
  path: string;
  /** Arc's HTTP status; null when Arc never answered. */
  status: number | null;
  outcome: ChangeOutcome;
  /** A preview (dry run): Arc changed nothing. */
  dryRun: boolean;
  createdAt: string;
  actor: { id: string; email: string; name: string | null } | null;
}

export interface ChangePage {
  changes: ChangeEntry[];
  /** Pass as `before` for the next page; null when there is none. */
  nextBefore: number | null;
}
