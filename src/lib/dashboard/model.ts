/**
 * Dashboard model — the contract every other part of the dashboarding feature
 * codes against.
 *
 * A dashboard's CONTENT is one JSON document (panels, layout, variables, time
 * settings) stored as a single blob. Its IDENTITY and concurrency metadata
 * (uid, version, author, timestamps) live outside it, on the storage row — see
 * {@link DashboardRecord}. Keeping those apart is not cosmetic: a `version`
 * inside the blob and a `version` column diverge the moment a version is
 * restored, and the dashboard then fails every optimistic-concurrency check
 * forever.
 *
 * Field names track Grafana's dashboard schema where the concept is the same —
 * `gridPos`, `fieldConfig`, `targets`, `thresholds`, `options` — so layouts and
 * panel configs port across. Nothing here is imported or copied from Grafana;
 * these are our own declarations, narrowed to what Launchpad renders.
 *
 * Converting a foreign (Grafana) document into this shape is NOT this module's
 * job and must never leak into the validator — it belongs to the import
 * adapter, which is allowed to be lossy so long as it reports what it dropped.
 *
 * ## Invariants that must outlive this file
 *
 * 1. **No dashboard field is ever rendered through `{@html}`.** Titles,
 *    descriptions, units, series names and mapping text are all user-controlled.
 *    Svelte escapes interpolation by default; `{@html}` opts out of the only
 *    thing protecting us. There are currently zero uses of it in this repo.
 *
 * 2. **Panel options are combined with spread, never a deep merge.** Use
 *    `{ ...DEFAULTS, ...panel.options }`. A recursive merge walks
 *    attacker-controlled keys and `target[k] ??= {}` on `k === '__proto__'`
 *    reads and writes `Object.prototype` — process-wide pollution affecting
 *    every user. `Object.assign` is unsafe for the same reason (it assigns via
 *    [[Set]], which triggers the `__proto__` setter); object spread is safe
 *    because it defines own properties.
 *
 * 3. **An `instanceId` in this model is untrusted until resolved.** It arrives
 *    as request-body data with no provenance, and there are three levels of it.
 *    No code path may construct an Arc URL or read an admin token from the
 *    model alone — every execution path goes through the org-scoped resolver in
 *    `$lib/server/dashboardInstance`, which queries
 *    `WHERE id = ? AND org_id = ?` and throws rather than returning null.
 *
 * 4. **`timezone: 'browser'` must be resolved to a concrete IANA zone before it
 *    reaches the macro engine.** The `$__timeGroup` implementation silently
 *    degrades an unrecognised zone to UTC, so an unresolved `'browser'` buckets
 *    in UTC while the axis renders local time — off by hours, and invisible to
 *    anyone testing in UTC.
 *
 * 5. **The `__` prefix is reserved for macros** (`$__interval`, `$__timeFrom`,
 *    …). Variable names may not start with it.
 */

import { v4 as uuidv4 } from 'uuid';

/**
 * Version of THIS model. Deliberately not named `schemaVersion`: Grafana
 * dashboards carry their own `schemaVersion` (16–42 in the wild), and sharing
 * one field name between two unrelated migration ladders means every Grafana
 * document looks like it came from a newer Launchpad.
 */
export const LAUNCHPAD_SCHEMA_VERSION = 1;

/** The grid is 24 columns wide, matching Grafana so layouts port across. */
export const GRID_COLUMNS = 24;

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Shared by the validator AND its consumers — the panel editor disables "add
 * target" at `maxTargetsPerPanel`, the import dialog reports "203 panels (max
 * 200)", the variable editor validates names as you type. Defined once here so
 * those cannot drift from what the validator enforces.
 */
export const LIMITS = {
  /** Checked on the raw request body in BYTES, before JSON.parse. */
  maxPayloadBytes: 1_048_576,
  /**
   * Maximum nesting depth of any value. Not arbitrary: `devalue` — the
   * serializer SvelteKit runs over every `load` return value — is recursive and
   * stack-overflows near depth 1560. A ~9.5 KB payload reaches that, which is
   * three orders of magnitude under `maxPayloadBytes`, and the resulting 500
   * makes the dashboard permanently unopenable, including by an admin trying to
   * delete it. Must be enforced by an ITERATIVE walk, or the validator
   * overflows before it can report the error.
   */
  maxDepth: 32,
  maxPanels: 200,
  maxTargetsPerPanel: 10,
  maxSqlBytes: 50_000,
  maxVariables: 50,
  maxTags: 20,
  maxTagLength: 50,
  maxTitleLength: 200,
  maxDescriptionLength: 2000,
  maxThresholdSteps: 100,
  maxMappings: 100,
  /** Panel `options` / `fieldConfig.custom` free-form bags. */
  maxOptionsBytes: 16_000,
  maxOptionsKeys: 100,
  maxOptionsDepth: 8,
  /** Refresh floor, so a saved dashboard cannot hammer Arc. */
  minRefreshMs: 5_000,
  maxDataPoints: 100_000,
  /** Beyond this the grid allocates absurd numbers of implicit CSS rows. */
  maxGridY: 1000,
  maxPanelHeight: 100,
  /** Errors returned before truncating; a hostile document fails every field. */
  maxErrors: 100,
} as const;

export const UID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const PANEL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const REF_ID_PATTERN = /^[A-Za-z0-9_-]{1,16}$/;
/**
 * Variable names become object keys in the interpolation map and are spliced
 * into SQL as `$name`. The negative lookahead blocks `__proto__` and
 * `constructor`-style keys and reserves the macro namespace.
 */
export const VARIABLE_NAME_PATTERN = /^(?!__)[A-Za-z][A-Za-z0-9_]{0,63}$/;
export const RESERVED_VARIABLE_NAMES: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);
/** Database names are sent as the `x-arc-database` header and reach SQL. */
export const DATABASE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** `1m`, `30s`, `2h`. Also the grammar for refresh intervals. */
export const DURATION_PATTERN = /^\d+(ms|s|m|h|d|w)$/;

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

/**
 * Grafana's named color tokens, which appear in every real threshold config
 * (`green`/`red` are its defaults). Kept verbatim for import fidelity.
 */
export const NAMED_COLORS: ReadonlySet<string> = new Set([
  'green', 'red', 'blue', 'orange', 'yellow', 'purple', 'text', 'panel-bg',
  'transparent',
  ...['blue', 'green', 'red', 'orange', 'yellow', 'purple'].flatMap((h) => [
    `dark-${h}`, `semi-dark-${h}`, `light-${h}`, `super-light-${h}`,
  ]),
]);

/**
 * Colors land in inline `style` attributes, so an unvalidated string is a CSS
 * injection vector — not for exfiltration (our CSP blocks remote `url()`), but
 * a full-viewport `position:fixed` overlay can deface an authenticated view or
 * cover a destructive confirm button.
 *
 * This is an allowlist, deliberately: a denylist on `url(` is defeated by CSS
 * escapes (`\75 rl(...)`). Panels must render colors via Svelte's `style:`
 * directive, which sets the property through CSSOM and rejects a value
 * containing `;`, rather than interpolating into a `style="..."` string.
 */
const HEX_OR_FUNC = /^(#[0-9a-fA-F]{3,8}|rgba?\(\s*[\d.]+%?(\s*,\s*[\d.]+%?){2,3}\s*\))$/;

export function isSafeColor(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 32) return false;
  return HEX_OR_FUNC.test(value) || NAMED_COLORS.has(value);
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

/**
 * Closed union. An unknown panel type is rejected on SAVE rather than reaching
 * a renderer with no component for it. (The import adapter uses a softer
 * policy — drop the panel, warn, keep the document.)
 */
export const PANEL_TYPES = [
  'timeseries',
  'stat',
  'table',
  'barchart',
  'bargauge',
  'heatmap',
  'logs',
] as const;

export type PanelType = (typeof PANEL_TYPES)[number];

const PANEL_TYPE_SET: ReadonlySet<string> = new Set(PANEL_TYPES);
/**
 * Use this rather than `PANEL_TYPES.includes(x)` — `.includes` on a
 * `readonly [...]` narrows its parameter to the union, so passing a `string`
 * does not compile and everyone reaches for `as any`.
 */
export const isPanelType = (v: unknown): v is PanelType =>
  typeof v === 'string' && PANEL_TYPE_SET.has(v);

export interface GridPos {
  /** Columns from the left edge, 0-based. */
  x: number;
  /** Rows from the top edge, 0-based. */
  y: number;
  /** Width in columns, 1..24. */
  w: number;
  /** Height in rows. */
  h: number;
}

/** How a query's result should be interpreted before it reaches a panel. */
export const TARGET_FORMATS = ['time_series', 'table', 'logs'] as const;
export type TargetFormat = (typeof TARGET_FORMATS)[number];

/** One query belonging to a panel. */
export interface Target {
  /** Stable within the panel ("A", "B", …). Used in legends and the inspector. */
  refId: string;
  /**
   * SQL, which may contain $variables and $__macros. Deliberately NOT
   * sanitised: a panel query is arbitrary SQL by design, and every org member
   * can already run arbitrary SQL through the console and the proxy, so a
   * stored query grants no capability that did not already exist. Only shape
   * and size are enforced. An empty string is legal and means "not configured";
   * the query runner must skip it rather than POSTing `""` to Arc.
   */
  sql: string;
  /** Overrides the panel's and dashboard's instance. Untrusted — see invariant 3. */
  instanceId?: string;
  /** Sent as the `x-arc-database` header rather than qualifying the table. */
  database?: string;
  format?: TargetFormat;
  /** Kept in the model but not executed. */
  hide?: boolean;
}

// ---------------------------------------------------------------------------
// Field configuration
// ---------------------------------------------------------------------------

export const THRESHOLDS_MODES = ['absolute', 'percentage'] as const;
export type ThresholdsMode = (typeof THRESHOLDS_MODES)[number];

export interface Threshold {
  /** null marks the base step; every other step is a real number. */
  value: number | null;
  color: string;
}

export interface ThresholdsConfig {
  mode: ThresholdsMode;
  /**
   * Base (null) step first, then ascending by value. The validator SORTS to
   * establish this rather than rejecting, since nothing upstream guarantees it.
   */
  steps: Threshold[];
}

export const FIELD_COLOR_MODES = [
  /**
   * Assigns palette colors by series NAME, so a series keeps its color when
   * series are added, removed or reordered. This is the default for a reason —
   * index-based assignment reshuffles every color whenever the result set
   * changes shape, which reads as a rendering bug.
   */
  'palette-classic-by-name',
  /** Index-based. Kept for import fidelity; prefer the by-name mode. */
  'palette-classic',
  'fixed',
  'thresholds',
  'continuous',
] as const;
export type FieldColorMode = (typeof FIELD_COLOR_MODES)[number];

/** Every mode except 'fixed', as a runtime list the validator can enum over. */
export const NON_FIXED_COLOR_MODES = [
  'palette-classic-by-name',
  'palette-classic',
  'thresholds',
  'continuous',
] as const;
export type NonFixedColorMode = (typeof NON_FIXED_COLOR_MODES)[number];

export type FieldColor =
  | { mode: 'fixed'; fixedColor: string }
  | { mode: NonFixedColorMode; scheme?: string };

export const MAPPING_TYPES = ['value', 'range', 'regex', 'special'] as const;
export type MappingType = (typeof MAPPING_TYPES)[number];

export const SPECIAL_MATCHES = ['null', 'nan', 'empty', 'true', 'false'] as const;
export type SpecialMatch = (typeof SPECIAL_MATCHES)[number];

/** What a matched value displays as. Mirrors Grafana's nested `result`. */
export interface MappingResult {
  text?: string;
  color?: string;
}

/**
 * A discriminated union rather than a flat bag of optionals — which fields
 * apply depends entirely on `type`, and encoding that in a doc comment instead
 * of the type system is how mappings get half-populated.
 */
export type ValueMapping =
  | { type: 'value'; value: string; result: MappingResult }
  | { type: 'range'; from: number | null; to: number | null; result: MappingResult }
  | { type: 'regex'; pattern: string; result: MappingResult }
  | { type: 'special'; match: SpecialMatch; result: MappingResult };

export interface FieldConfig {
  /** Unit id from the units registry, e.g. 'bytes', 'ms', 'percent'. */
  unit?: string;
  /** 0..20 — `toFixed` throws a RangeError outside 0..100 and blanks the panel. */
  decimals?: number;
  min?: number;
  max?: number;
  /** Overrides the series name in legends and tooltips. */
  displayName?: string;
  /** Rendered in place of an empty result. */
  noValue?: string;
  color?: FieldColor;
  thresholds?: ThresholdsConfig;
  mappings?: ValueMapping[];
  /** Panel-type-specific display options (line width, fill opacity, …). */
  custom?: Record<string, unknown>;
}

/**
 * Per-field overrides are deliberately NOT in v1. Grafana's shape is
 * `{ matcher, properties: Array<{id: string, value: unknown}> }`, and that
 * `unknown` bypasses every rule the validator applies to `defaults` — including
 * the color allowlist, since `{id: 'color', value: {...}}` reaches the same
 * inline style. They arrive with #36's series overrides, typed per property id.
 */
export interface FieldConfigSource {
  defaults: FieldConfig;
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

/**
 * Panels declare their own option shapes by augmenting this interface, which
 * keeps `Panel<'stat'>` fully typed inside the stat renderer without coupling
 * this module to seven unwritten panels:
 *
 * ```ts
 * declare module '$lib/dashboard/model' {
 *   interface PanelOptionsRegistry { stat: StatOptions }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface PanelOptionsRegistry {}

export type OptionsFor<T extends PanelType> = T extends keyof PanelOptionsRegistry
  ? PanelOptionsRegistry[T]
  : Record<string, unknown>;

export interface Panel<T extends PanelType = PanelType> {
  /**
   * Unique within the dashboard, and STABLE across saves — it appears in URLs
   * (`?viewPanel=`, `?editPanel=`), so renumbering on save breaks every
   * bookmarked panel link.
   */
  id: string;
  type: T;
  /** May be empty; untitled panels are normal. */
  title: string;
  description?: string;
  gridPos: GridPos;
  targets: Target[];
  fieldConfig: FieldConfigSource;
  /** Validated by the panel, not here. See {@link PanelOptionsRegistry}. */
  options: OptionsFor<T>;
  /** Overrides the dashboard's instance. Untrusted — see invariant 3. */
  instanceId?: string;
  /** Draws without the card background and border. */
  transparent?: boolean;
  /**
   * MINIMUM interval, not an override — this is Grafana's semantics and
   * changing it is an outage-shaped surprise. A panel with `interval: '1m'`
   * viewed over 30 days must yield ~30m buckets, not 43,200 one-minute ones.
   */
  interval?: string;
  /**
   * Point budget feeding the `$__interval` calculation
   * (`max(rangeMs / maxDataPoints, minInterval)`), normally derived from the
   * panel's rendered width.
   */
  maxDataPoints?: number;
  /** Renders a different range than the dashboard, e.g. 'now-7d'. */
  timeFrom?: string;
  /** Shifts this panel's range backwards, e.g. '1d' for week-over-week. */
  timeShift?: string;
  /** Suppresses the "last 7 days" badge a timeFrom/timeShift panel shows. */
  hideTimeOverride?: boolean;
}

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

/**
 * `instance` is ours — it templates a dashboard across Arc instances, filling
 * the role Grafana's `datasource` variable plays.
 */
export const VARIABLE_TYPES = [
  'query',
  'custom',
  'constant',
  'interval',
  'textbox',
  'instance',
] as const;

export type VariableType = (typeof VARIABLE_TYPES)[number];

const VARIABLE_TYPE_SET: ReadonlySet<string> = new Set(VARIABLE_TYPES);
export const isVariableType = (v: unknown): v is VariableType =>
  typeof v === 'string' && VARIABLE_TYPE_SET.has(v);

export const VARIABLE_REFRESH = ['never', 'on-dashboard-load', 'on-time-range-change'] as const;
export type VariableRefresh = (typeof VARIABLE_REFRESH)[number];

export const VARIABLE_HIDE = ['none', 'label', 'variable'] as const;
export type VariableHide = (typeof VARIABLE_HIDE)[number];

export const VARIABLE_SORT = [
  'none', 'alpha-asc', 'alpha-desc', 'numeric-asc', 'numeric-desc',
] as const;
export type VariableSort = (typeof VARIABLE_SORT)[number];

/** One selected value. The resolved option LIST is runtime state, not stored. */
export interface VariableOption {
  text: string;
  value: string;
}

export interface TemplateVariable {
  /** Interpolated as `$name`. See {@link VARIABLE_NAME_PATTERN}. */
  name: string;
  type: VariableType;
  label?: string;
  description?: string;
  hide?: VariableHide;
  /**
   * Meaning depends on type: SQL for 'query' (which goes through the macro
   * engine, so it may use `$__timeFilter`), a comma-separated list for 'custom'
   * and 'interval', the literal value for 'constant' and 'textbox'.
   */
  query?: string;
  /**
   * The saved selection. The resolved option LIST is deliberately not persisted:
   * it is redundant for every variable type, unbounded (a `SELECT DISTINCT host`
   * over 100k hosts would blow the payload cap with an error naming the whole
   * document), and it churns on every view — which floods version diffs and
   * makes dirty-tracking fire when nothing changed.
   */
  current?: VariableOption[];
  multi?: boolean;
  includeAll?: boolean;
  /**
   * Literal substituted when 'All' is selected. NOT a regex — Grafana defaults
   * to one because Prometheus matches with regex, but in SQL `host = '.*'`
   * silently returns zero rows. When unset, 'All' expands to the quoted comma
   * list of current options.
   */
  allValue?: string;
  /** Defaults to 'on-dashboard-load' for query variables. */
  refresh?: VariableRefresh;
  /** Filters/captures part of each result value. Capped — see the validator. */
  regex?: string;
  sort?: VariableSort;
  /**
   * Which instance a 'query' variable runs against. Without this, a dashboard
   * templated across instances by an `instance` variable still populates its
   * other dropdowns from the original instance.
   */
  instanceId?: string;
  /** 'interval' variables only: offer an "auto" option sized to the range. */
  auto?: boolean;
  autoCount?: number;
  autoMin?: string;
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

export const WEEK_STARTS = ['saturday', 'sunday', 'monday'] as const;
export type WeekStart = (typeof WEEK_STARTS)[number];

export interface TimeSettings {
  /** Relative ('now-6h', 'now/d') or an absolute ISO instant. */
  from: string;
  to: string;
  /** 'utc', 'browser', or an IANA zone name. See invariant 4. */
  timezone: string;
  /** Auto-refresh interval such as '30s'. Empty string means off — one representation, not two. */
  refresh: string;
  /**
   * Subtracted from `now` when resolving the range.
   *
   * This matters more for Arc than for most backends: Parquet-over-object-store
   * with a write buffer means rows land seconds to tens of seconds late, so
   * querying `to = now` leaves the final bucket partially filled. With
   * auto-refresh the last bar then dips and recovers on every single tick,
   * which reads as "the charts are wrong".
   */
  nowDelay?: string;
  /**
   * Anchors `now/w`. Reserved and currently unused: DuckDB's
   * `date_trunc('week')` is Monday-anchored, so a Sunday-anchored "this week"
   * is inexpressible until this is honoured. Adding it later would silently
   * change what every existing `now/w` dashboard means.
   */
  weekStart?: WeekStart;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

/** Cursor sharing across panels. 0 off, 1 crosshair, 2 crosshair + tooltip. */
export type GraphTooltip = 0 | 1 | 2;

/**
 * The CONTENT of a dashboard. Note what is absent: `uid`, `version`, author and
 * timestamps all live on {@link DashboardRecord}. Export/import carries only
 * this, which is what makes importing a copy rather than an overwrite.
 */
export interface Dashboard {
  launchpadSchemaVersion: number;
  title: string;
  description?: string;
  tags: string[];
  /**
   * Default Arc instance; panels and targets may override it. Null means
   * "unset" — an export shared outside the org externalizes its instance
   * reference so the importer can pick their own. Storage rejects null on save;
   * shape is the validator's concern, resolvability is storage's.
   */
  instanceId: string | null;
  time: TimeSettings;
  variables: TemplateVariable[];
  panels: Panel[];
  graphTooltip?: GraphTooltip;
  /** Floor for the computed `$__interval`, e.g. '10s'. */
  minInterval?: string;
}

/**
 * A stored dashboard: content plus the identity and concurrency metadata that
 * must NOT live inside the document. `version` is the optimistic-concurrency
 * token and belongs to the storage row alone — mirroring it into the blob makes
 * a restored dashboard permanently unsaveable.
 */
export interface DashboardRecord {
  uid: string;
  orgId: string;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  model: Dashboard;
}

// ---------------------------------------------------------------------------
// Validation result types
// ---------------------------------------------------------------------------

/**
 * Machine-readable so consumers branch on `code` rather than string-matching
 * English. Messages are for humans and will be reworded.
 */
export type ValidationCode =
  | 'malformed_json'
  | 'too_large'
  | 'too_deep'
  | 'version_too_new'
  | 'required'
  | 'wrong_type'
  | 'out_of_range'
  | 'too_long'
  | 'too_many'
  | 'duplicate'
  | 'invalid_format'
  | 'unknown_value';

/**
 * `path` uses JS accessor grammar — `panels[2].gridPos.w` — and is rendered
 * directly by the import dialog, so it is public API and is asserted literally
 * in tests. Errors are returned in document order, depth-first.
 */
export interface ValidationError {
  path: string;
  code: ValidationCode;
  message: string;
}

/** A non-fatal loss: something was accepted, but not exactly as supplied. */
export interface ValidationWarning {
  path: string;
  message: string;
}

export type DashboardValidationResult =
  | {
      ok: true;
      model: Dashboard;
      warnings: ValidationWarning[];
      /**
       * Every distinct instance id referenced anywhere in the document —
       * dashboard, panel and target levels. Returned so a caller cannot check
       * "the" instance id and miss the overrides; this module performs no
       * database access itself.
       */
      referencedInstanceIds: Set<string>;
    }
  | {
      ok: false;
      errors: ValidationError[];
      /** True when the error list hit {@link LIMITS.maxErrors}. */
      truncated: boolean;
    };

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/**
 * Random and globally unique — never derived from the title. Per-org uids plus
 * a cookie-selected active org made `/d/[uid]` resolve to different dashboards
 * for different viewers as soon as two orgs both created "Production Overview".
 */
export function newDashboardUid(): string {
  return uuidv4().replace(/-/g, '').slice(0, 22);
}

export function newPanelId(): string {
  return uuidv4().replace(/-/g, '').slice(0, 12);
}

/** Lowest unused positive integer id, for deterministic assignment on import. */
export function nextPanelId(panels: ReadonlyArray<{ id: string }>): string {
  const used = new Set(panels.map((p) => p.id));
  for (let i = 1; ; i++) {
    const candidate = String(i);
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * Appends panels, reassigning any id that collides. Import and "add to
 * dashboard" must renumber rather than reject — a Grafana-imported dashboard
 * has ids "1", "2", …, so appending a freshly generated "1" would otherwise
 * fail uniqueness and reject the entire save, losing the panel the user just
 * built to an error naming an id they never saw.
 */
export function mergePanels(existing: Panel[], incoming: Panel[]): Panel[] {
  const out = [...existing];
  for (const panel of incoming) {
    const collides = out.some((p) => p.id === panel.id);
    out.push(collides ? { ...panel, id: nextPanelId(out) } : panel);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Defaults and factories
// ---------------------------------------------------------------------------

/** A fresh object every call — a shared mutable default is process-wide state. */
export function defaultTimeSettings(): TimeSettings {
  return { from: 'now-6h', to: 'now', timezone: 'utc', refresh: '' };
}

export function emptyFieldConfig(): FieldConfigSource {
  return { defaults: {} };
}

export function createPanel(opts: {
  type: PanelType;
  gridPos: GridPos;
  id?: string;
  title?: string;
}): Panel {
  return {
    id: opts.id ?? newPanelId(),
    type: opts.type,
    title: opts.title ?? '',
    gridPos: opts.gridPos,
    targets: [{ refId: 'A', sql: '' }],
    fieldConfig: emptyFieldConfig(),
    options: {},
  };
}

/** Object parameter: three positional strings of the same type invite transposition. */
export function createDashboard(opts: {
  title: string;
  instanceId: string | null;
  description?: string;
}): Dashboard {
  return {
    launchpadSchemaVersion: LAUNCHPAD_SCHEMA_VERSION,
    title: opts.title,
    ...(opts.description !== undefined ? { description: opts.description } : {}),
    tags: [],
    instanceId: opts.instanceId,
    time: defaultTimeSettings(),
    variables: [],
    panels: [],
  };
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Canonical form for storage, dirty-checking, diffing and export. Keys are
 * sorted at every level so a `JSON.stringify` comparison is meaningful — the
 * panel editor rebuilds option objects on every change, and without a canonical
 * order a key-order difference reads as "the whole panel changed".
 *
 * Used by storage, the dirty-check, the version diff and export alike, so the
 * four cannot disagree about what "unchanged" means.
 */
export function serializeForSave(model: Dashboard): string {
  return JSON.stringify(sortKeys(model));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortKeys((value as Record<string, unknown>)[key]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/**
 * Range-checks the document version before any migration runs.
 *
 * Separate from {@link migrateModel} so the check cannot be skipped: migration
 * operates on unvalidated input, which commits every future migration to being
 * defensive against arbitrary JSON. Keeping the version check in front of it
 * bounds what migrations must tolerate.
 */
export function preflightVersion(
  input: unknown,
): { ok: true; version: number } | { ok: false; error: ValidationError } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return {
      ok: false,
      error: { path: '', code: 'wrong_type', message: 'Dashboard must be a JSON object' },
    };
  }
  const raw = (input as Record<string, unknown>).launchpadSchemaVersion;
  // Absent means a pre-versioning document, which is version 0. A PRESENT but
  // malformed version is an error, not a silent zero — otherwise a document
  // claiming `"2"` is stamped as current without ever being migrated.
  if (raw === undefined) return { ok: true, version: 0 };
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    return {
      ok: false,
      error: {
        path: 'launchpadSchemaVersion',
        code: 'wrong_type',
        message: 'launchpadSchemaVersion must be a non-negative integer',
      },
    };
  }
  if (raw > LAUNCHPAD_SCHEMA_VERSION) {
    return {
      ok: false,
      error: {
        path: 'launchpadSchemaVersion',
        code: 'version_too_new',
        message: `This dashboard was created by a newer version of Launchpad (schema ${raw}, this build supports ${LAUNCHPAD_SCHEMA_VERSION})`,
      },
    };
  }
  return { ok: true, version: raw };
}

/**
 * Upgrade a document written by an older build. Its version has already been
 * range-checked by {@link preflightVersion}. Always returns a fresh object, so
 * callers never have to wonder whether they own the result.
 *
 * There is nothing to migrate at version 1; the `from` switch belongs here when
 * the first real migration lands, handling each version in turn and falling
 * through so an old document walks every step.
 *
 * NOTE: the spread below must stay a spread. Object spread defines own
 * properties, so a `JSON.parse`'d `"__proto__"` key stays an inert own property.
 * `Object.assign` assigns via [[Set]] and WOULD trigger the `__proto__` setter,
 * replacing the prototype.
 */
export function migrateModel(input: Record<string, unknown>, from: number): Record<string, unknown> {
  const out = { ...input };
  if (from < LAUNCHPAD_SCHEMA_VERSION) {
    out.launchpadSchemaVersion = LAUNCHPAD_SCHEMA_VERSION;
  }
  return out;
}
