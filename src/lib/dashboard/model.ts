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
  /**
   * Total nodes in the parsed document. THIS is the structural bound that
   * actually binds, and it is enforced in the same walk as the depth check so
   * it costs nothing extra.
   *
   * The per-field limits below are per-field sanity bounds, NOT a composable
   * budget: 200 panels x 10 targets is already ~1.2MB with empty option bags,
   * and 200 x 10 x maxSqlBytes is far past maxPayloadBytes. Whichever of the
   * byte cap and this node cap binds first is the real ceiling.
   */
  maxNodes: 150_000,
  maxPanels: 200,
  maxTargetsPerPanel: 10,
  maxSqlBytes: 16_000,
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
  /**
   * Refresh floor. Enforced by CLAMPING rather than rejecting, so an imported
   * dashboard with an aggressive interval still opens.
   *
   * A shared dashboard at `refresh: '0ms'` makes every viewer's browser poll
   * the instance proxy as fast as it can — and the proxy injects the admin
   * token, so this is a privilege-amplified DoS launched from the lowest write
   * privilege in the product.
   */
  minRefreshMs: 5_000,
  /** Upper bound on any duration, so interval arithmetic cannot overflow. */
  maxDurationMs: 365 * 24 * 60 * 60 * 1000,
  maxWarnings: 100,
  maxDataPoints: 100_000,
  /** Beyond this the grid allocates absurd numbers of implicit CSS rows. */
  maxGridY: 1000,
  maxPanelHeight: 100,
  /** Errors returned before truncating; a hostile document fails every field. */
  maxErrors: 100,
  /**
   * Versions retained per dashboard. Lives here rather than in the store
   * because the version-history UI needs it too, and that is client code which
   * cannot import from `$lib/server`.
   */
  maxVersionHistory: 20,
  /** Save message accompanying a version, bounded since it is outside the model. */
  maxVersionMessage: 256,
} as const;

export const UID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const PANEL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const REF_ID_PATTERN = /^[A-Za-z0-9_-]{1,16}$/;

/**
 * A `$variable` reference, accepted anywhere an instance id is accepted.
 *
 * The `instance` variable type exists to template one dashboard across Arc
 * instances, which means a panel must be able to say "whichever instance
 * $instance currently selects". Half-accepting that — letting the literal
 * string `$instance` through as if it were an id — makes every templated
 * dashboard unsaveable, because storage resolves referenced ids against
 * `WHERE id = ? AND org_id = ?` and `$instance` matches nothing.
 *
 * So it is accepted explicitly, excluded from {@link Dashboard} instance-id
 * collection, and validated instead against the declared variables.
 *
 * SECURITY: the value a reference resolves to at runtime is still untrusted
 * and MUST go through the org-scoped resolver. A reference is not an exemption
 * from invariant 3 — it defers the check to execution time rather than
 * removing it.
 */
export const INSTANCE_REF_PATTERN = /^\$[A-Za-z][A-Za-z0-9_]{0,63}$/;

export function isInstanceRef(value: string): boolean {
  return INSTANCE_REF_PATTERN.test(value);
}
/**
 * Variable names become object keys in the interpolation map and are spliced
 * into SQL as `$name`. The negative lookahead blocks `__proto__` and
 * `constructor`-style keys and reserves the macro namespace.
 */
export const VARIABLE_NAME_PATTERN = /^(?!__)[A-Za-z][A-Za-z0-9_]{0,63}$/;
/**
 * Keys that are dangerous as object properties. Panel ids, target refIds and
 * variable names all become keys in lookup maps (`panelsById[panel.id]`,
 * `resultsByRefId[t.refId]`), so all three need this — not just variable names.
 *
 * A charset alone is not enough: `constructor` and `toString` are ordinary
 * identifiers that pass any reasonable pattern. Assigning to `__proto__` on a
 * bare object replaces that object's prototype; assigning to `toString` shadows
 * a method every consumer assumes exists.
 */
export const RESERVED_OBJECT_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'toString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
]);

/** True when `name` is safe to use as a key in a plain-object lookup map. */
export function isSafeObjectKey(name: string): boolean {
  return !RESERVED_OBJECT_KEYS.has(name);
}

/** @deprecated Use {@link RESERVED_OBJECT_KEYS}. Retained for one release. */
export const RESERVED_VARIABLE_NAMES = RESERVED_OBJECT_KEYS;
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
  // Grafana's palette tokens, which appear in every real threshold config.
  'text', 'panel-bg', 'transparent',
  ...['blue', 'green', 'red', 'orange', 'yellow', 'purple'].flatMap((h) => [
    h, `dark-${h}`, `semi-dark-${h}`, `light-${h}`, `super-light-${h}`,
  ]),
  // The CSS named colors. Omitting these made the allowlist reject `white`,
  // `black`, `gray`, `cyan` and the rest, so an imported dashboard using any
  // of them failed the entire save with no in-product fix. An allowlist that
  // rejects ordinary input is the pressure that turns it into a denylist
  // later, which is the mistake this is built to avoid.
  'aliceblue', 'antiquewhite', 'aqua', 'aquamarine', 'azure', 'beige', 'bisque',
  'black', 'blanchedalmond', 'blueviolet', 'brown', 'burlywood', 'cadetblue',
  'chartreuse', 'chocolate', 'coral', 'cornflowerblue', 'cornsilk', 'crimson',
  'cyan', 'darkblue', 'darkcyan', 'darkgoldenrod', 'darkgray', 'darkgreen',
  'darkgrey', 'darkkhaki', 'darkmagenta', 'darkolivegreen', 'darkorange',
  'darkorchid', 'darkred', 'darksalmon', 'darkseagreen', 'darkslateblue',
  'darkslategray', 'darkslategrey', 'darkturquoise', 'darkviolet', 'deeppink',
  'deepskyblue', 'dimgray', 'dimgrey', 'dodgerblue', 'firebrick', 'floralwhite',
  'forestgreen', 'fuchsia', 'gainsboro', 'ghostwhite', 'gold', 'goldenrod',
  'gray', 'greenyellow', 'grey', 'honeydew', 'hotpink', 'indianred', 'indigo',
  'ivory', 'khaki', 'lavender', 'lavenderblush', 'lawngreen', 'lemonchiffon',
  'lightblue', 'lightcoral', 'lightcyan', 'lightgoldenrodyellow', 'lightgray',
  'lightgreen', 'lightgrey', 'lightpink', 'lightsalmon', 'lightseagreen',
  'lightskyblue', 'lightslategray', 'lightslategrey', 'lightsteelblue',
  'lightyellow', 'lime', 'limegreen', 'linen', 'magenta', 'maroon',
  'mediumaquamarine', 'mediumblue', 'mediumorchid', 'mediumpurple',
  'mediumseagreen', 'mediumslateblue', 'mediumspringgreen', 'mediumturquoise',
  'mediumvioletred', 'midnightblue', 'mintcream', 'mistyrose', 'moccasin',
  'navajowhite', 'navy', 'oldlace', 'olive', 'olivedrab', 'orangered', 'orchid',
  'palegoldenrod', 'palegreen', 'paleturquoise', 'palevioletred', 'papayawhip',
  'peachpuff', 'peru', 'pink', 'plum', 'powderblue', 'rebeccapurple',
  'rosybrown', 'royalblue', 'saddlebrown', 'salmon', 'sandybrown', 'seagreen',
  'seashell', 'sienna', 'silver', 'skyblue', 'slateblue', 'slategray',
  'slategrey', 'snow', 'springgreen', 'steelblue', 'tan', 'teal', 'thistle',
  'tomato', 'turquoise', 'violet', 'wheat', 'white', 'whitesmoke',
  'yellowgreen',
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
// Hex lengths are enumerated, not a {3,8} range: #RGB, #RGBA, #RRGGBB and
// #RRGGBBAA are valid CSS, while 5 and 7 digits are not — a browser drops the
// whole declaration and the element silently inherits, so a threshold would
// validate and then render in the wrong color.
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
// Legacy comma form and the modern space/slash form, plus hsl(). The modern
// form is what getComputedStyle returns and what most color pickers emit.
const FUNC_COLOR =
  /^(?:rgba?|hsla?)\((?:\s*[\d.]+(?:deg|%)?\s*(?:,\s*[\d.]+%?\s*){2,3}|\s*[\d.]+(?:deg|%)?(?:\s+[\d.]+%?){2}(?:\s*\/\s*[\d.]+%?)?\s*)\)$/i;

/**
 * The 32-character guard runs BEFORE the patterns, deliberately: `FUNC_COLOR`
 * contains a quantified group, and keeping the length check adjacent is what
 * makes its worst case irrelevant. Do not separate them.
 */
export function isSafeColor(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 32) return false;
  // CSS color keywords are case-insensitive.
  if (NAMED_COLORS.has(value.toLowerCase())) return true;
  return HEX_COLOR.test(value) || FUNC_COLOR.test(value);
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

/**
 * Every mode except 'fixed', as a runtime list the validator can enum over.
 * Pinned to {@link FIELD_COLOR_MODES} below, so adding a mode there without
 * adding it here is a compile error rather than a silently-rejected value.
 */
export const NON_FIXED_COLOR_MODES = [
  'palette-classic-by-name',
  'palette-classic',
  'thresholds',
  'continuous',
] as const;
export type NonFixedColorMode = (typeof NON_FIXED_COLOR_MODES)[number];

type _NonFixedModesComplete = Exclude<FieldColorMode, 'fixed'> extends NonFixedColorMode
  ? NonFixedColorMode extends Exclude<FieldColorMode, 'fixed'>
    ? true
    : never
  : never;
const _nonFixedModesComplete: _NonFixedModesComplete = true;

/**
 * Distributed over each non-fixed mode rather than written as a single
 * `{ mode: NonFixedColorMode }` member, so the shape matches the discriminated
 * union the validator uses — which is what lets a `{mode:'fixed'}` missing its
 * color report the missing FIELD instead of an unactionable "Invalid input" on
 * the whole object.
 */
export type FieldColor =
  | { mode: 'fixed'; fixedColor: string }
  | { [M in NonFixedColorMode]: { mode: M; scheme?: string } }[NonFixedColorMode];

/**
 * `regex` is deliberately NOT in v1, alongside `TemplateVariable.regex`.
 *
 * A user-supplied pattern runs against every result value, and dashboards are
 * shared — so catastrophic backtracking is a denial of service against
 * colleagues, and against the whole control plane if it is ever evaluated
 * server-side (better-sqlite3 is synchronous, so a pegged event loop takes
 * SQLite with it). No source-level heuristic can prevent this: `\s*\s*$` is
 * seven characters with no nested quantifier and blocks for ~12s on a 4KB
 * value; `^(a|a)+$` is exponential. Denylisting patterns is the same mistake
 * {@link isSafeColor} correctly refuses to make for CSS.
 *
 * It returns with #38 behind a linear-time engine (RE2) or a grammar
 * restricted to a provably-linear subset.
 */
export const MAPPING_TYPES = ['value', 'range', 'special'] as const;
export type MappingType = (typeof MAPPING_TYPES)[number];

const MAPPING_TYPE_SET: ReadonlySet<string> = new Set(MAPPING_TYPES);
export const isMappingType = (v: unknown): v is MappingType =>
  typeof v === 'string' && MAPPING_TYPE_SET.has(v);

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
 * Reads a panel's options with its type's defaults applied, doing the cast in
 * ONE place instead of at every use site across seven panel implementations.
 *
 * ```ts
 * const opts = panelOptions<StatOptions>(panel, STAT_DEFAULTS);
 * ```
 *
 * SECURITY: spread, never a recursive merge — see invariant 2. A deep merge
 * walks attacker-controlled keys and pollutes `Object.prototype`.
 *
 * (An earlier draft used a `PanelOptionsRegistry` interface plus a generic
 * `Panel<T>`. It was removed: narrowing on `panel.type` does not narrow
 * `panel.options` when iterating a `Panel[]`, so renderers still needed an
 * unchecked cast — and augmenting the registry widened `Panel['options']` to a
 * union, which broke the schema pins in `validate.ts` and would have failed
 * the build on the first panel PR.)
 */
export function panelOptions<T extends object>(panel: Panel, defaults: T): T {
  return { ...defaults, ...(panel.options as Partial<T>) };
}

export interface Panel {
  /**
   * Unique within the dashboard, and STABLE across saves — it appears in URLs
   * (`?viewPanel=`, `?editPanel=`), so renumbering on save breaks every
   * bookmarked panel link.
   */
  id: string;
  type: PanelType;
  /** May be empty; untitled panels are normal. */
  title: string;
  description?: string;
  gridPos: GridPos;
  targets: Target[];
  fieldConfig: FieldConfigSource;
  /** Validated by the panel, not here. Read via {@link panelOptions}. */
  options: Record<string, unknown>;
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
 * A dashboard as it appears in a list: the projection columns, without the
 * model blob. Declared here rather than beside the store because the list page
 * renders it and cannot import a `$lib/server` module.
 */
export interface DashboardSummary {
  uid: string;
  title: string;
  description: string | null;
  tags: string[];
  version: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

/** One entry in a dashboard's version history, without its blob. */
export interface VersionSummary {
  version: number;
  createdBy: string;
  createdAt: string;
  message: string | null;
  /** True for the version currently live on the dashboard. */
  current: boolean;
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
  updatedBy: string;
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

export type WarningCode =
  | 'reordered'
  | 'clamped'
  | 'renamed'
  | 'dropped'
  | 'defaulted'
  | 'truncated';

/**
 * A non-fatal loss: something was accepted, but not exactly as supplied.
 *
 * Carries a `code` for the same reason {@link ValidationError} does — warnings
 * are rendered in the same import dialog, and without one a consumer has to
 * match on English that will be reworded.
 */
export interface ValidationWarning {
  path: string;
  code: WarningCode;
  message: string;
}

export type DashboardValidationResult =
  | {
      ok: true;
      model: Dashboard;
      warnings: ValidationWarning[];
      /**
       * Every distinct LITERAL instance id referenced anywhere in the document
       * — dashboard, panel, target and variable levels. Returned so a caller
       * cannot authorize "the" instance id and miss the overrides; this module
       * performs no database access itself.
       *
       * A sorted array rather than a Set: this crosses an API boundary, and
       * `JSON.stringify` turns a Set into `{}` — a security control that
       * silently serializes to empty is a trap.
       *
       * `$variable` references are NOT included, because they name a variable
       * rather than an instance. Whatever they resolve to at runtime is still
       * untrusted and must go through the org-scoped resolver.
       */
      referencedInstanceIds: string[];
    }
  | {
      ok: false;
      errors: ValidationError[];
      /** True when the error list hit {@link LIMITS.maxErrors}. */
      truncated: boolean;
    };

/** Result of collecting warnings, exposed so consumers can detect truncation. */
export type WarningList = {
  warnings: ValidationWarning[];
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
function randomId(length: number): string {
  // crypto.randomUUID is available in Node 18+ and every browser we target,
  // so an isomorphic module does not need the `uuid` dependency for this.
  return globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, length);
}

export function newDashboardUid(): string {
  return randomId(22);
}

export function newPanelId(): string {
  return randomId(12);
}

/** Lowest unused positive integer id, for deterministic assignment on import. */
export function nextPanelId(panels: ReadonlyArray<{ id: string }>): string {
  return firstFreeId(new Set(panels.map((p) => p.id)));
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
  // One set, maintained as we go — `out.some()` per panel plus a rebuilt set
  // per collision made this quadratic.
  const used = new Set(out.map((p) => p.id));
  for (const panel of incoming) {
    let next = panel;
    if (used.has(panel.id)) {
      next = { ...panel, id: firstFreeId(used) };
    }
    used.add(next.id);
    out.push(next);
  }
  return out;
}

function firstFreeId(used: ReadonlySet<string>): string {
  for (let i = 1; ; i++) {
    const candidate = String(i);
    if (!used.has(candidate)) return candidate;
  }
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
 *
 * REQUIRES a depth-bounded model: throws {@link DashboardTooDeepError} rather
 * than letting `JSON.stringify` blow the stack. Anything that has been through
 * the validator qualifies.
 */
export function serializeForSave(model: Dashboard): string {
  return JSON.stringify(sortKeys(model));
}

/**
 * Thrown by {@link serializeForSave} for a model too deep to serialize.
 *
 * `sortKeys` is iterative, but `JSON.stringify` is recursive in V8 and there is
 * no way around that short of writing a full serializer — and the depth at
 * which it overflows varies by Node version, so it cannot even be pinned to a
 * constant. A validated model is always within `LIMITS.maxDepth`, so this only
 * fires for a model that never went through the validator (the Grafana import
 * adapter builds one before validating).
 *
 * It exists so that case surfaces as a catchable, explicable error instead of
 * a bare RangeError from deep inside a serializer.
 */
export class DashboardTooDeepError extends Error {
  constructor(readonly depth: number) {
    super(`Dashboard nests ${depth} levels deep, past the limit of ${LIMITS.maxDepth}`);
    this.name = 'DashboardTooDeepError';
  }
}

/**
 * Sorts object keys at every level, without recursion.
 *
 * Recursion here would stack-overflow on exactly the deep input the validator
 * goes to trouble to reject iteratively — and `serializeForSave` is exported
 * for general use, so it can be handed an unvalidated model (the Grafana
 * import adapter will do precisely that).
 *
 * Keys are assigned with `defineProperty` rather than `out[key] = …`, because
 * plain assignment to `__proto__` invokes the prototype setter: the key would
 * vanish from the output and the intermediate object would carry an
 * attacker-chosen prototype, making this "canonical" form lossy.
 */
function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;

  const depth = depthOf(value);
  if (depth > LIMITS.maxDepth) throw new DashboardTooDeepError(depth);

  type Frame = { src: unknown; dst: unknown; keys: string[]; i: number };
  const rootDst: unknown = Array.isArray(value) ? [] : {};
  const stack: Frame[] = [
    { src: value, dst: rootDst, keys: Array.isArray(value) ? [] : Object.keys(value).sort(), i: 0 },
  ];

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    const srcIsArray = Array.isArray(frame.src);
    const length = srcIsArray ? (frame.src as unknown[]).length : frame.keys.length;

    if (frame.i >= length) {
      stack.pop();
      continue;
    }

    const key = srcIsArray ? frame.i : frame.keys[frame.i];
    const child = srcIsArray
      ? (frame.src as unknown[])[frame.i]
      : (frame.src as Record<string, unknown>)[frame.keys[frame.i]];
    frame.i++;

    let outChild: unknown = child;
    if (child !== null && typeof child === 'object') {
      outChild = Array.isArray(child) ? [] : {};
      stack.push({
        src: child,
        dst: outChild,
        keys: Array.isArray(child) ? [] : Object.keys(child).sort(),
        i: 0,
      });
    }

    if (srcIsArray) {
      (frame.dst as unknown[])[key as number] = outChild;
    } else {
      Object.defineProperty(frame.dst as object, key as string, {
        value: outChild,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }

  return rootDst;
}

/** Iterative depth probe, so the guard itself cannot overflow. */
function depthOf(value: unknown): number {
  let deepest = 0;
  const nodes: unknown[] = [value];
  const depths: number[] = [0];
  while (nodes.length > 0) {
    const node = nodes.pop();
    const depth = depths.pop()!;
    if (depth > deepest) deepest = depth;
    if (deepest > LIMITS.maxDepth) return deepest;
    if (node === null || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (const child of node) {
        nodes.push(child);
        depths.push(depth + 1);
      }
    } else {
      for (const key of Object.keys(node as Record<string, unknown>)) {
        nodes.push((node as Record<string, unknown>)[key]);
        depths.push(depth + 1);
      }
    }
  }
  return deepest;
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
