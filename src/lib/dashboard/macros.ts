/**
 * The Arc SQL macro engine.
 *
 * A port of `grafana-arc-datasource/pkg/plugin/query.go` (Apache-2.0, ours), so
 * a dashboard means the same thing in Grafana-with-Arc and in Launchpad. The Go
 * implementation is the specification; where this diverges it is marked
 * DIVERGENCE with the reason, because a silent divergence is how two engines
 * that are supposed to agree stop agreeing.
 *
 * Pure and isomorphic — no DOM, no imports beyond `model.ts`. Same rules as
 * `frame.ts`, `units.ts` and `colors.ts`.
 *
 * ## This is not a security boundary
 *
 * `validateColumnArg` looks like a SQL-injection guard and is not one. The
 * dashboard author already has arbitrary SQL: the console builds `ArcClient` in
 * the browser against the instance proxy, and the proxy forwards the request
 * body as raw bytes without ever parsing it — it enforces RBAC, org scoping,
 * path gating and SSRF pinning, none of which this module touches. Its
 * `MEMBER_POST_PREFIXES` allows `api/v1/query`, so even a viewer can POST any
 * statement they like.
 *
 * What the validation is actually for is keeping *the text this module
 * generates* well-formed, so a macro cannot produce SQL whose shape the author
 * did not intend. The Go source says the same thing (`safety.go:76-79`). Do not
 * relax it, and do not rely on it.
 *
 * ## Known limits, stated rather than inherited
 *
 * The walkers understand `'...'` string literals with `''` escaping, and
 * nothing else. DuckDB's dollar-quoted strings (`$$...$$`), double-quoted
 * identifiers containing an apostrophe (`"it's"`), and `E'...'` escape strings
 * all desync them — a macro inside a `$$...$$` block does get expanded, and an
 * apostrophe inside a quoted identifier sends the scanner into literal mode
 * with no close, so every later macro is missed. This matches the Go engine
 * exactly. Extending it would change expansion relative to both Go and Grafana,
 * so the behaviour is kept and the limit is written down.
 */

import { DURATION_PATTERN } from './model';

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

/**
 * RFC3339 with second precision, matching Go's `time.RFC3339`.
 *
 * Not `toISOString().slice(0, 19)`: at an expanded year `toISOString` returns
 * `+010000-01-01T00:00:00.000Z`, and slicing 19 characters cuts the seconds off
 * (`+010000-01-01T00:00Z`). Trimming the fraction by pattern is length-agnostic.
 *
 * Expanded years remain a divergence — Go emits `10000-01-01T00:00:00Z` with no
 * `+` — but they are unreachable from a real range, and a wrong prefix is
 * visibly wrong where a truncated timestamp is not.
 */
export function rfc3339(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * `new Date(NaN).toISOString()` throws a RangeError, which would escape into
 * whatever is drawing the panel. Callers hand us dates derived from user input,
 * so the guard belongs here rather than at each call site.
 */
function assertFiniteDate(d: Date, label: string): void {
  if (!Number.isFinite(d.getTime())) {
    throw new RangeError(`macro expansion received an invalid ${label} date`);
  }
}

// ---------------------------------------------------------------------------
// Timezones
// ---------------------------------------------------------------------------

/**
 * A plain IANA zone name: letters, digits, underscore, plus and minus, in one
 * to three slash-separated segments. Every real zone fits ("Europe/Madrid",
 * "America/Argentina/Salta", "UTC", "Etc/GMT+5") while "." and a leading slash
 * — the shapes that turn a zone name into a path — do not.
 *
 * Checked BEFORE `Intl`, so this function is the allowlist its name implies.
 */
const IANA_ZONE_NAME = /^[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+){0,2}$/;

/**
 * Go rejects these three explicitly. `Intl` happens to reject them too, but the
 * case documents why they are wrong rather than merely unknown: "Local" is a
 * valid Go zone name meaning the HOST's zone, and it reaches DuckDB as
 * `Unknown TimeZone 'Local'!` — a hard panel failure rather than a fallback.
 */
const NON_IANA_NAMES = new Set(['Local', 'Factory', 'posixrules']);

/**
 * Bounded, unlike the Go `sync.Map` it ports and unlike the `probedZones` cache
 * in `validate.ts`. Real zones plus aliases number in the hundreds, so a cap
 * around a thousand is never reached by legitimate use — but the key is a
 * string from a saved dashboard, and this module may run in a long-lived
 * server process. An unbounded map keyed by attacker-chosen strings is a
 * memory-growth vector, and caching *misses* (which this must, since the probe
 * is the expensive part) is what makes it one.
 *
 * Past the cap we stop caching rather than evict: no policy to get wrong, and
 * the steady state for any real deployment is far below it.
 */
const MAX_CACHED_ZONES = 1000;
const zoneCache = new Map<string, string>();

/** One formatter per zone. Constructing these is the expensive part. */
const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

function offsetFormatter(tz: string): Intl.DateTimeFormat {
  let f = offsetFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    if (offsetFormatters.size < MAX_CACHED_ZONES) offsetFormatters.set(tz, f);
  }
  return f;
}

/**
 * The zone's UTC offset in seconds at a given instant.
 *
 * Arithmetic on `formatToParts` rather than parsing a `longOffset` name. Both
 * agree to the second on every sub-hour zone, but this has no feature
 * dependency, needs no probe, and cannot be tripped by an engine that renders a
 * bare `GMT` instead of `GMT+00:00`.
 *
 * Throws (via the formatter) for an unknown zone — callers validate first.
 */
function zoneOffsetSeconds(tz: string, at: Date): number {
  const parts = offsetFormatter(tz).formatToParts(at);
  const get = (type: string): number => {
    const p = parts.find((x) => x.type === type);
    return p ? Number(p.value) : 0;
  };
  // `hourCycle: 'h23'` still renders midnight as 24 in some engines.
  const hour = get('hour') % 24;
  const asUTC = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
  // Whole seconds: the formatter has no sub-second field, so the instant's own
  // milliseconds must not leak into the difference.
  return Math.round((asUTC - Math.floor(at.getTime() / 1000) * 1000) / 1000);
}

/** Samples a year at a fortnight's spacing, as the Go original does. */
function sampleOffsets(tz: string): number[] {
  const out: number[] = [];
  const base = Date.UTC(new Date().getUTCFullYear(), 0, 1);
  for (let d = 0; d < 365; d += 14) {
    out.push(zoneOffsetSeconds(tz, new Date(base + d * 86_400_000)));
  }
  return out;
}

/**
 * True when the zone sits at offset zero all year (Etc/UTC, Etc/GMT,
 * Atlantic/Reykjavik...). Such a zone is canonicalised to 'UTC' so it takes the
 * byte-identical epoch path.
 */
function isAlwaysUTC(tz: string): boolean {
  return sampleOffsets(tz).every((o) => o === 0);
}

/**
 * True when every offset the zone uses across a year is a whole number of
 * hours. False for the :30 and :45 zones — Asia/Kolkata, Pacific/Chatham,
 * Australia/Eucla, Asia/Kathmandu.
 */
function zoneOffsetIsWholeHour(tz: string): boolean {
  return sampleOffsets(tz).every((o) => o % 3600 === 0);
}

/**
 * Returns a zone name safe to interpolate into SQL, or 'UTC'.
 *
 * An unknown zone degrades rather than failing the query: a bad timezone should
 * not black out a panel. The name reaches SQL, so it is never taken on trust —
 * the character allowlist runs first, then `Intl` both rejects unknown zones and
 * constrains the value to something the runtime recognises.
 *
 * Note that `Intl` is looser than Go's tzdata: it accepts `america/new_york`,
 * `EST5EDT`, `Japan` and `Zulu`. All pass the allowlist and all are accepted by
 * DuckDB, so the looseness is safe — but it is the RAW name that reaches SQL,
 * not a canonical one, so the offset checks must run on the raw name too.
 */
export function validateTimezone(tz: string | null | undefined): string {
  if (!tz) return 'UTC';
  // Case-insensitive: the dashboard model's own default is lowercase 'utc'
  // (`defaultTimeSettings`). Comparing exactly would send every default
  // dashboard down the calendar branch, emitting `timezone('utc', ...)` instead
  // of the byte-identical epoch path.
  if (tz.toUpperCase() === 'UTC') return 'UTC';
  if (NON_IANA_NAMES.has(tz)) return 'UTC';
  if (!IANA_ZONE_NAME.test(tz)) return 'UTC';

  const cached = zoneCache.get(tz);
  if (cached !== undefined) return cached;

  let resolved: string;
  try {
    // Probes existence; throws RangeError for an unknown zone.
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    resolved = isAlwaysUTC(tz) ? 'UTC' : tz;
  } catch {
    resolved = 'UTC';
  }
  if (zoneCache.size < MAX_CACHED_ZONES) zoneCache.set(tz, resolved);
  return resolved;
}

/**
 * `'browser'` resolved to a concrete IANA name. Client-only — there is no
 * browser zone on the server, and an unresolved `'browser'` degrades to UTC,
 * which buckets hours away from the axis that renders it. Silent, and invisible
 * to a UTC-based test.
 *
 * Call this before issuing any query. Never expand server-side with `'browser'`
 * still in the model.
 */
export function resolveTimezone(tz: string | null | undefined): string {
  if (tz === 'browser') {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      return 'UTC';
    }
  }
  return tz || 'UTC';
}

/**
 * Renders a validated zone as a SQL string literal. Doubling any quote is
 * belt-and-braces — `validateTimezone` has already excluded anything containing
 * one — but it costs nothing and keeps the emitter honest.
 */
function quoteTimezone(tz: string): string {
  return `'${tz.replace(/'/g, "''")}'`;
}

// ---------------------------------------------------------------------------
// Column arguments
// ---------------------------------------------------------------------------

/**
 * Anything that could break out of the SQL the macro generates. A double quote
 * is NOT unsafe: DuckDB uses it for quoted identifiers, `"time"` and
 * `t."time"` are ordinary column references, and it cannot terminate the
 * single-quoted literals a macro emits.
 */
const COLUMN_ARG_UNSAFE = /[';]|--|\/\*/;

/**
 * Deliberately a permissive denylist, not an identifier pattern. Requiring
 * `^[A-Za-z_][A-Za-z0-9_.]*$` rejected every ordinary DuckDB column expression
 * — a quoted identifier, a qualified-and-quoted `t."time"`, a cast
 * `time::TIMESTAMP`, a non-ASCII name — and left the macro unexpanded, so Arc
 * received a literal `$__timeFilter(...)` and failed to parse.
 *
 * The cost is false positives on legal-but-odd identifiers: `t."a--b"` and
 * `"O'Brien"` are rejected because the sequence appears anywhere in the string.
 * That fails closed, to an unexpanded macro and a clear Arc error, which is the
 * right direction. Do not "fix" it by loosening the pattern.
 */
export function isSafeColumnArg(name: string): boolean {
  if (name.trim() === '') return false;
  if (COLUMN_ARG_UNSAFE.test(name)) return false;
  // Parens must balance and must never close more than they opened. Without
  // this, `$__timeFilter(time) OR (1=1)` parses as the argument
  // `time) OR (1=1`, which closes the macro's own paren and appends a
  // disjunction — and since AND binds tighter than OR, the time filter is
  // neutralised and the panel returns the whole table.
  let depth = 0;
  for (let i = 0; i < name.length; i++) {
    if (name[i] === '(') depth++;
    else if (name[i] === ')') {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

// ---------------------------------------------------------------------------
// The walkers
// ---------------------------------------------------------------------------

/** Can this byte be part of a macro token's name? */
function isMacroWordChar(c: string): boolean {
  return /[A-Za-z0-9_]/.test(c);
}

/**
 * Scans forward from `openIdx` (which must point at `(`) to the matching `)`,
 * respecting nested parens and string literals. Returns -1 when unmatched.
 */
function findMatchingParen(sql: string, openIdx: number): number {
  if (openIdx >= sql.length || sql[openIdx] !== '(') return -1;
  let depth = 1;
  let i = openIdx + 1;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
    } else if (c === '(') {
      depth++;
      i++;
    } else if (c === ')') {
      depth--;
      if (depth === 0) return i;
      i++;
    } else {
      i++;
    }
  }
  return -1;
}

/**
 * Rewrites every occurrence of an argument-bearing `macro` that lives outside
 * string literals and comments. The inner argument is handed to `rewrite`;
 * returning null preserves the original macro text verbatim, so Arc surfaces a
 * clear error rather than receiving silently-mangled SQL.
 *
 * An unmatched paren or unterminated comment is an EARLY RETURN, not a skip:
 * the remainder is copied verbatim and no later occurrence expands. That is
 * Go's behaviour and a port that "skips and continues" diverges on
 * `$__timeFilter(a ... $__timeFilter(b)` while still passing the no-infinite-
 * loop test.
 */
function replaceMacroOccurrences(
  sql: string,
  macro: string,
  rewrite: (arg: string) => string | null,
): string {
  // Most queries use one or two of the five macros, and without this guard the
  // walk copies the whole statement byte by byte for every macro that is absent.
  if (!sql.includes(macro)) return sql;

  let out = '';
  let i = 0;
  while (i < sql.length) {
    // '...' string literal — preserved verbatim.
    if (sql[i] === "'") {
      out += sql[i];
      i++;
      while (i < sql.length) {
        out += sql[i];
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            out += sql[i + 1];
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // -- line comment
    if (sql[i] === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      if (end < 0) return out + sql.slice(i);
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    // /* block comment */ — not nest-aware, matching Go. DuckDB does nest, so
    // a macro inside `/* a /* b */ $__timeFilter(t) */` is expanded here; but
    // the expansion lands inside what DuckDB still treats as one comment, so
    // Arc receives semantically identical SQL and the divergence is cosmetic.
    if (sql[i] === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end < 0) return out + sql.slice(i);
      out += sql.slice(i, end + 2);
      i = end + 2;
      continue;
    }
    if (sql.startsWith(macro, i)) {
      const closeIdx = findMatchingParen(sql, i + macro.length - 1);
      if (closeIdx < 0) return out + sql.slice(i);
      const arg = sql.slice(i + macro.length, closeIdx);
      const rewritten = rewrite(arg);
      out += rewritten === null ? sql.slice(i, closeIdx + 1) : rewritten;
      i = closeIdx + 1;
      continue;
    }
    out += sql[i];
    i++;
  }
  return out;
}

/**
 * The zero-argument sibling: replaces a fixed token such as `$__timeFrom()`,
 * skipping string literals and comments.
 */
function replaceLiteralAwareTokens(sql: string, token: string, replacement: string): string {
  if (!sql.includes(token)) return sql;

  let out = '';
  let i = 0;
  while (i < sql.length) {
    if (sql[i] === "'") {
      out += sql[i];
      i++;
      while (i < sql.length) {
        out += sql[i];
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            out += sql[i + 1];
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (sql[i] === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      if (end < 0) return out + sql.slice(i);
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    if (sql[i] === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end < 0) return out + sql.slice(i);
      out += sql.slice(i, end + 2);
      i = end + 2;
      continue;
    }
    if (sql.startsWith(token, i)) {
      out += replacement;
      i += token.length;
      continue;
    }
    out += sql[i];
    i++;
  }
  return out;
}

/**
 * Replaces every whole-word occurrence of an interval token, skipping comments
 * but NOT string literals.
 *
 * The literal exception is deliberate and is the whole reason this function is
 * separate: the documented use of `$__interval` is inside quotes —
 * `time_bucket(INTERVAL '$__interval', t)` — and skipping literals there leaves
 * the token intact for DuckDB to reject with "Could not convert string
 * '$__interval' to INTERVAL".
 *
 * DIVERGENCE (bug fix). The Go version has no single-quote handling at all
 * (`query.go:551-609`), yet it still tests for `--` and `/*`. So a quoted
 * comment marker anywhere before the token swallows the rest of the query and
 * leaves the token unexpanded:
 *
 *     WHERE note = 'a--b' AND x = time_bucket(INTERVAL '$__interval', t)
 *
 * produces exactly the DuckDB failure the function exists to prevent. The other
 * two walkers are immune only because they test `'` before `--`. Here we track
 * literals for the purpose of comment detection while still expanding inside
 * them, which preserves both documented behaviours and fixes the break.
 *
 * The word-boundary check is what makes replacement order irrelevant:
 * `$__interval` cannot consume the prefix of `$__interval_ms`.
 */
function replaceIntervalToken(sql: string, token: string, replacement: string): string {
  if (!sql.includes(token)) return sql;

  const tryToken = (i: number): number => {
    if (!sql.startsWith(token, i)) return -1;
    const next = i + token.length;
    if (next < sql.length && isMacroWordChar(sql[next])) return -1;
    return next;
  };

  let out = '';
  let i = 0;
  while (i < sql.length) {
    // Inside a literal: comment markers are just characters, but the token
    // still expands.
    if (sql[i] === "'") {
      out += sql[i];
      i++;
      while (i < sql.length) {
        const next = tryToken(i);
        if (next >= 0) {
          out += replacement;
          i = next;
          continue;
        }
        out += sql[i];
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            out += sql[i + 1];
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (sql[i] === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      if (end < 0) return out + sql.slice(i);
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    // Nest-aware, as Go is here — and unlike Go's other two walkers.
    if (sql[i] === '/' && sql[i + 1] === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < sql.length - 1) {
        if (sql[j] === '/' && sql[j + 1] === '*') {
          depth++;
          j += 2;
          continue;
        }
        if (sql[j] === '*' && sql[j + 1] === '/') {
          depth--;
          j += 2;
          if (depth === 0) break;
          continue;
        }
        j++;
      }
      if (depth !== 0) return out + sql.slice(i);
      out += sql.slice(i, j);
      i = j;
      continue;
    }
    const next = tryToken(i);
    if (next >= 0) {
      out += replacement;
      i = next;
      continue;
    }
    out += sql[i];
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Intervals
// ---------------------------------------------------------------------------

const INTERVAL_UNIT_SECONDS: Record<string, number> = {
  s: 1, sec: 1, secs: 1, second: 1, seconds: 1,
  m: 60, min: 60, mins: 60, minute: 60, minutes: 60,
  h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600,
  d: 86400, day: 86400, days: 86400,
  w: 604800, week: 604800, weeks: 604800,
};

/** Anchored, so trailing junk is rejected rather than silently truncated. */
const INTERVAL_PATTERN = /^(\d+)\s*([a-zA-Z]+)$/;

/**
 * A bucket wider than a month is never a useful time-series aggregation, and an
 * absurd one would collapse every row into a single bucket at the epoch — a
 * silently meaningless chart rather than an error.
 */
export const MAX_INTERVAL_SECONDS = 31 * 86400;
/** The epoch path divides whole seconds, so this is the narrowest expressible bucket. */
export const MIN_INTERVAL_SECONDS = 1;

/**
 * A DuckDB interval string in whole seconds, or null when it is not something
 * this engine can bucket by.
 *
 * Parses the `<n><unit>` grammar rather than consulting a fixed table: a table
 * accepted only a handful of literal strings, which excluded most of what
 * `$__interval` produces (20s, 2m, 3h, 2d are all routine) and left the whole
 * macro unexpanded so Arc received a literal `$`.
 *
 * Sub-second intervals parse to 0 and are rejected. Note this lowercases the
 * unit, so `1M` reads as one MINUTE — which is what DuckDB itself does with
 * `INTERVAL '1M'` (verified on 1.5.5), so the two agree. Grafana's `M` means
 * MONTH; that mismatch is handled where it arises, in `parseLowLimitMs`.
 */
export function intervalToSeconds(interval: string): number | null {
  const m = INTERVAL_PATTERN.exec(interval.trim());
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = INTERVAL_UNIT_SECONDS[m[2].toLowerCase()];
  if (unit === undefined) return null;
  // Bound before multiplying so the product cannot overflow.
  if (n > MAX_INTERVAL_SECONDS) return null;
  const secs = n * unit;
  if (secs <= 0 || secs > MAX_INTERVAL_SECONDS) return null;
  return secs;
}

/**
 * Strips surrounding quotes the way Go's `strings.Trim(s, "'\"")` does — a
 * CUTSET trim, removing any run of either quote character from both ends. A
 * naive `.replace(/^['"]|['"]$/g, '')` strips one of each and would reject
 * `'''1h'''`, which the Go engine accepts.
 */
function trimQuotes(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && (s[start] === "'" || s[start] === '"')) start++;
  while (end > start && (s[end - 1] === "'" || s[end - 1] === '"')) end--;
  return s.slice(start, end);
}

/**
 * Grafana's interval ladder, ported verbatim from `@grafana/data`
 * (`rangeutil.mjs:560`). Thirty entries; all thirty round-trip exactly through
 * the compact text form.
 */
export function roundInterval(interval: number): number {
  switch (true) {
    case interval < 10: return 1;
    case interval < 15: return 10;
    case interval < 35: return 20;
    case interval < 75: return 50;
    case interval < 150: return 100;
    case interval < 350: return 200;
    case interval < 750: return 500;
    case interval < 1500: return 1000;
    case interval < 3500: return 2000;
    case interval < 7500: return 5000;
    case interval < 12500: return 10000;
    case interval < 17500: return 15000;
    case interval < 25000: return 20000;
    case interval < 45000: return 30000;
    case interval < 90000: return 60000;
    case interval < 210000: return 120000;
    case interval < 450000: return 300000;
    case interval < 750000: return 600000;
    case interval < 1050000: return 900000;
    case interval < 1500000: return 1200000;
    case interval < 2700000: return 1800000;
    case interval < 5400000: return 3600000;
    case interval < 9000000: return 7200000;
    case interval < 16200000: return 10800000;
    case interval < 32400000: return 21600000;
    case interval < 86400000: return 43200000;
    case interval < 604800000: return 86400000;
    case interval < 1814400000: return 604800000;
    case interval < 3628800000: return 2592000000;
    default: return 31536000000;
  }
}

/**
 * The bucket text, as the largest unit that divides the duration exactly.
 *
 * DIVERGENCE from Grafana's `secondsToHms`, which TRUNCATES: it renders 90000ms
 * as `'1m'`, so `$__interval` and `$__interval_ms` disagree by a third. That is
 * unreachable on the automatic path — all thirty ladder outputs round-trip —
 * but immediately reachable through a user-supplied `minInterval: '90s'`. This
 * form is lossless, so the two macros agree by construction, and it still
 * matches `secondsToHms` on 29 of the 30 ladder values.
 *
 * DIVERGENCE from the Go engine, which emits a word form (`'10 seconds'`). A
 * day is NOT 86400 seconds in DuckDB — months, days and microseconds are stored
 * separately, so `+ INTERVAL '1 day'` and `+ INTERVAL '86400 seconds'` differ by
 * an hour across a DST boundary (verified on 1.5.5). Since `$__interval` is
 * documented for use inside a literal in arbitrary SQL, emitting seconds would
 * silently move every day-or-wider bucket.
 *
 * CAPPED AT DAYS, never weeks. 604800000 divides exactly by a week, and
 * emitting `'1w'` would flip `truncUnitForSeconds`'s week gate from epoch
 * arithmetic to Monday-anchored `date_trunc('week')` — re-bucketing a request
 * that only ever meant "seven days wide".
 */
export function formatIntervalText(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

const DURATION_UNIT_MS: Record<string, number> = {
  ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000,
};

/**
 * The low limit, parsed with the repo's own `DURATION_PATTERN` rather than
 * either the Go or the Grafana grammar.
 *
 * Three grammars disagree here and the difference is not cosmetic. Go's rejects
 * `500ms` and reads `1M` as a minute; Grafana's accepts `500ms` and reads `1M`
 * as a month — a factor of 43,200 between them. `DURATION_PATTERN` is what the
 * model validates a stored `minInterval` against, so it is the only grammar
 * that cannot disagree with what was saved. It admits `ms` (so `'500ms'` is a
 * legal stored value) and rejects `M` and `y` outright, which is the safe
 * direction: an unparseable low limit means no low limit, not a wrong one.
 *
 * A Grafana import carrying `interval: '1M'` therefore loses its floor rather
 * than gaining a minute-wide one. Mapping those units belongs in the import
 * adapter (#57), where the source semantics are known.
 */
function parseLowLimitMs(value: string | null | undefined): number | null {
  if (!value) return null;
  if (!DURATION_PATTERN.test(value)) return null;
  const m = /^(\d+)(ms|s|m|h|d|w)$/.exec(value);
  if (!m) return null;
  return Number.parseInt(m[1], 10) * DURATION_UNIT_MS[m[2]];
}

/**
 * Grafana's default panel resolution. Used when a panel carries no
 * `maxDataPoints`, so there is ONE ladder rather than two.
 *
 * The Go plugin falls back to a four-entry table here, but that table is
 * Grafana's *backend* fallback — the frontend substitutes the real value before
 * a panel query reaches the plugin. Launchpad IS the frontend, so falling back
 * to it would make the same dashboard jump between two unrelated ladders
 * depending on whether a panel happens to carry the field.
 */
export const DEFAULT_MAX_DATA_POINTS = 1000;

export interface IntervalOptions {
  /** Point budget; normally derived from the panel's pixel width. */
  maxDataPoints?: number;
  /** The panel's own floor. A LOWER BOUND, never an override. */
  panelInterval?: string | null;
  /** The dashboard's floor, used when the panel sets none. */
  minInterval?: string | null;
}

/**
 * The bucket width for a range, in milliseconds.
 *
 * `max(roundInterval(rangeMs / resolution), lowLimit)`, clamped to the range the
 * epoch path can actually express.
 *
 * Clamping BOTH ends matters. The floor is the documented one: `roundInterval`
 * returns 1ms for a narrow range, and a sub-second value leaves `$__timeGroup`
 * unexpanded and ships a literal `$` to Arc. The ceiling is the same bug at the
 * other end and is just as reachable — the ladder's top entry is 365 days,
 * which exceeds `MAX_INTERVAL_SECONDS` in every text form, and Grafana stat
 * panels ship `maxDataPoints: 1`, so a stat panel over a 45-day range hits it.
 *
 * Note the floor is a product decision, not just a guard: it engages whenever
 * `rangeMs / resolution < 750`, so every range under ~12.5 minutes gets 1s
 * buckets where Grafana would give 200ms.
 *
 * The number of buckets is bounded by `maxDataPoints`, NOT by these clamps —
 * bucket count is approximately `rangeMs / intervalMs ≈ maxDataPoints`. Do not
 * remove `maxDataPoints` from this formula believing the clamps protect Arc.
 */
export function computeIntervalMs(rangeMs: number, opts: IntervalOptions = {}): number {
  const resolution =
    opts.maxDataPoints && opts.maxDataPoints > 0 ? opts.maxDataPoints : DEFAULT_MAX_DATA_POINTS;
  // Grafana's own default is 1, not 0. Behaviourally identical since
  // roundInterval never returns less, but written as the port it is.
  const lowLimitMs = parseLowLimitMs(opts.panelInterval) ?? parseLowLimitMs(opts.minInterval) ?? 1;

  const safeRange = Number.isFinite(rangeMs) && rangeMs > 0 ? rangeMs : 0;
  let intervalMs = Math.max(roundInterval(safeRange / resolution), lowLimitMs);

  intervalMs = Math.min(
    Math.max(intervalMs, MIN_INTERVAL_SECONDS * 1000),
    MAX_INTERVAL_SECONDS * 1000,
  );
  return intervalMs;
}

// ---------------------------------------------------------------------------
// Macro expansion
// ---------------------------------------------------------------------------

/**
 * Maps an interval to the `date_trunc` unit meaning exactly the same span, for
 * the intervals where a timezone-aware bucket is expressible as a calendar
 * truncation. Anything else (6h, 3d, sub-hour) has no equivalent and stays on
 * epoch arithmetic.
 */
function truncUnitForSeconds(secs: number, interval: string, tz: string): string | null {
  if (secs === 3600) {
    // An hour bucket takes the calendar path ONLY when the zone's offset is not
    // a whole number of hours (Asia/Kolkata +5:30, Pacific/Chatham +12:45). In a
    // whole-hour zone a local hour boundary IS a UTC hour boundary, so epoch
    // arithmetic yields identical buckets — and it avoids a DST hazard the
    // calendar path cannot.
    //
    // At a fall-back transition the local wall clock repeats an hour, so
    // `timezone(tz, ts)` is not injective: both 01:30 EDT and 01:30 EST truncate
    // to the same wall time and convert back to one instant. Verified on DuckDB
    // 1.5.5 — America/New_York on 2024-11-03 puts 120 minutes in the 06:00Z
    // bucket and produces no 05:00Z bucket at all. Once a year, per DST zone,
    // one bar reads double and its neighbour vanishes.
    return zoneOffsetIsWholeHour(tz) ? null : 'hour';
  }
  if (secs === 86400) return 'day';
  if (secs === 7 * 86400) {
    // A week is only a calendar week when the author asked for one.
    // `date_trunc('week')` anchors on Monday (verified), so silently turning
    // "7d" — which reads as seven days wide, starting wherever the range does —
    // into Monday-anchored weeks would change the buckets underneath them.
    const lower = interval.trim().toLowerCase();
    return lower.endsWith('w') || lower.includes('week') ? 'week' : null;
  }
  return null;
}

/** `$__timeFilter(column)` -> `(column) >= 'from' AND (column) < 'to'`. */
function expandTimeFilter(sql: string, from: Date, to: Date): string {
  const fromStr = rfc3339(from);
  const toStr = rfc3339(to);
  return replaceMacroOccurrences(sql, '$__timeFilter(', (arg) => {
    // An empty argument defaults to `time`. Note $__timeGroup does NOT do this
    // — there, an empty column is rejected. The asymmetry is Go's.
    const column = arg.trim() === '' ? 'time' : arg.trim();
    if (!isSafeColumnArg(column)) return null;
    // Parenthesised on both sides: the balance check already rejects an
    // unbalanced argument, and wrapping makes a break-out structurally
    // impossible rather than merely rejected. Costs nothing semantically.
    return `(${column}) >= '${fromStr}' AND (${column}) < '${toStr}'`;
  });
}

/** `$__timeGroup(column, interval)` -> epoch- or calendar-based bucketing. */
function expandTimeGroup(sql: string, tz: string): string {
  // Re-validated here, as Go does, even though applyMacros already did: this is
  // called directly by tests and by any future macro path, and a bogus zone
  // must degrade to UTC rather than reach SQL.
  const zone = validateTimezone(tz);
  return replaceMacroOccurrences(sql, '$__timeGroup(', (arg) => {
    // Split on every comma, as Go does. This disagrees with findMatchingParen's
    // nesting-awareness, so `$__timeGroup(coalesce(a,b), '1m')` is left
    // unexpanded while `$__timeFilter(coalesce(a,b))` expands fine. Ported
    // verbatim: it fails closed, and the paren-balance check is what makes the
    // rejection safe rather than mangling.
    const parts = arg.split(',');
    if (parts.length < 2) return null;
    // A third "fill" argument is IGNORED, not rejected. Postgres and Timescale
    // accept `$__timeGroup(time, '5m', 0)`, so migrated dashboards carry it;
    // rejecting it left the whole macro unexpanded and broke every such panel.
    const column = parts[0].trim();
    if (!isSafeColumnArg(column)) return null;
    const interval = trimQuotes(parts[1].trim());
    const secs = intervalToSeconds(interval);
    if (secs === null) return null;

    // A bucket of an hour or more in a NON-UTC dashboard must align to local
    // calendar boundaries, not UTC ones: with epoch arithmetic a "day" starts at
    // 00:00 UTC, which in UTC-6 is 18:00 the previous evening, so every bar
    // mixes two local days.
    //
    // UTC dashboards never take this branch, so their SQL stays byte-identical
    // to the epoch path. That matters twice over: `date_trunc` on a TIMESTAMPTZ
    // truncates in the DuckDB session's timezone, so a "UTC" dashboard would
    // otherwise silently follow Arc's session setting rather than UTC.
    if (zone !== 'UTC' && secs >= 3600) {
      const unit = truncUnitForSeconds(secs, interval, zone);
      if (unit) {
        // `timezone(tz, ts)`, not `ts AT TIME ZONE tz`. The function form is
        // explicit about direction: the inner call takes the instant to
        // wall-clock in tz, the outer reads that wall clock back as an instant.
        //
        // The Go comment attributes this to the infix form round-tripping
        // wrongly on Arc's DuckDB build. That does NOT reproduce on 1.4.3 or
        // 1.5.5, for either TIMESTAMP or TIMESTAMPTZ operands — so the form is
        // kept for fidelity and explicitness, not for the stated hazard.
        const q = quoteTimezone(zone);
        return `timezone(${q}, date_trunc('${unit}', timezone(${q}, ${column})))`;
      }
    }
    // epoch_ns() (BIGINT) with // (integer division), never epoch() (DOUBLE)
    // with /. The DOUBLE form loses precision near a boundary: verified on
    // 1.5.5, 05:59:59.999 lands in the 06:00 bucket instead of 05:00.
    return `to_timestamp((epoch_ns(${column}) // 1000000000 // ${secs}) * ${secs})`;
  });
}

export interface MacroContext {
  /** The filter range. Under query splitting this is the CHUNK's range. */
  from: Date;
  to: Date;
  /**
   * The bucket width. Under query splitting this stays the ORIGINAL range's
   * interval, so bucket sizes do not change between chunks — which is why this
   * is a separate field rather than derived from `from`/`to`.
   */
  intervalMs: number;
  /** A concrete IANA zone. `'browser'` must be resolved before it gets here. */
  timezone?: string | null;
}

/**
 * Expands every Arc macro in `sql`.
 *
 * The ORDER IS LOAD-BEARING and matches Go's `applyMacrosWith`. The interval
 * macros must run before `$__timeGroup`, because `$__timeGroup(time,
 * '$__interval')` is a documented composition that only works if the inner
 * token is already substituted.
 */
export function applyMacros(sql: string, ctx: MacroContext): string {
  assertFiniteDate(ctx.from, 'from');
  assertFiniteDate(ctx.to, 'to');

  const zone = validateTimezone(ctx.timezone);
  // Re-floored defensively. The caller is expected to have used
  // computeIntervalMs, but an invariant whose violation ships a literal `$` to
  // Arc and breaks the panel does not belong in a doc comment. Idempotent.
  const intervalMs = Math.min(
    Math.max(Math.round(ctx.intervalMs) || 0, MIN_INTERVAL_SECONDS * 1000),
    MAX_INTERVAL_SECONDS * 1000,
  );

  let out = expandTimeFilter(sql, ctx.from, ctx.to);
  out = replaceLiteralAwareTokens(out, '$__timeFrom()', `'${rfc3339(ctx.from)}'`);
  out = replaceLiteralAwareTokens(out, '$__timeTo()', `'${rfc3339(ctx.to)}'`);
  // These two expand INSIDE string literals, unlike the parenthesised macros
  // above. The word-boundary check makes their order irrelevant.
  out = replaceIntervalToken(out, '$__interval_ms', String(intervalMs));
  out = replaceIntervalToken(out, '$__interval', formatIntervalText(intervalMs));
  out = expandTimeGroup(out, zone);
  return out;
}

/** Exposed for tests and for the query inspector. */
export const __internal = {
  replaceMacroOccurrences,
  replaceLiteralAwareTokens,
  replaceIntervalToken,
  findMatchingParen,
  trimQuotes,
  truncUnitForSeconds,
  zoneOffsetSeconds,
  zoneOffsetIsWholeHour,
  parseLowLimitMs,
  expandTimeGroup,
  expandTimeFilter,
};
