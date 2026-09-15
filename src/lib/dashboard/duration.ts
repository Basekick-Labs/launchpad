/**
 * Duration parsing, in its own module for one reason: the validator's copy lives
 * in `validate.ts`, which imports zod (~145KB, more than doubling the largest app
 * chunk — see that file's header). Client code that needs to parse `30s` must not
 * drag a schema library in to do it.
 *
 * Pure, dependency-free, importable from anywhere.
 */

import { DURATION_PATTERN } from './model';

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * `30s`, `5m`, `2h`, `500ms` -> milliseconds. null when it is not a duration
 * this grammar accepts.
 *
 * Matches `DURATION_PATTERN`, which is what the model validates stored durations
 * against — so anything saved can be parsed, and anything parseable could have
 * been saved. Deliberately rejects `M` and `y`: `M` means month in Grafana and
 * minute in DuckDB, a factor of 43,200 apart, so guessing is worse than
 * refusing.
 */
export function durationToMs(value: string): number | null {
  if (!DURATION_PATTERN.test(value)) return null;
  const m = /^(\d+)(ms|s|m|h|d|w)$/.exec(value);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return n * UNIT_MS[m[2]];
}

/**
 * The same, tolerating the `now-` prefix that `Panel.timeFrom` carries
 * (`'now-7d'`), and a bare duration (`'7d'`). Returns the SPAN, not an instant.
 *
 * This is the narrow slice of Grafana's relative-range grammar that panel
 * overrides actually use. The full grammar — snapping, chains, calendar units —
 * now lives in `./timeRange`, which owns the dashboard range.
 *
 * The two parsers are NOT the same and should not be merged. This one returns a
 * SPAN in milliseconds, for a value that becomes a DuckDB INTERVAL, which is why
 * it rejects `M` and `y`: `M` is a month in Grafana and a minute in DuckDB, a
 * factor of 43,200. `timeRange` returns INSTANTS, never touches an interval, and
 * therefore supports the full calendar unit set.
 *
 * `Panel.timeFrom` is the one place the line blurs — it is a range override
 * parsed here as a span. Migrating `effectiveBounds` to the range parser is
 * tracked separately; doing it here would change panel-override semantics in a
 * PR about the dashboard range.
 */
export function durationToMsLoose(value: string): number | null {
  const trimmed = value.trim();
  const body = trimmed.startsWith('now-') ? trimmed.slice(4) : trimmed;
  return durationToMs(body);
}
