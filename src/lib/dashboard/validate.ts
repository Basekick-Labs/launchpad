/**
 * Dashboard validation — the trust boundary for dashboard documents.
 *
 * ## This module is isomorphic, and that has a cost worth knowing
 *
 * It runs on the server (authoritative, on every write) and in the browser
 * (the import dialog previews errors before uploading anything). The client
 * copy is a UX affordance with NO authority: the server revalidates everything
 * it stores, and nothing may assume a document is safe because the browser said
 * so. It therefore imports no node builtins and lives outside `$lib/server/`.
 *
 * **zod is ~145KB raw / 35KB gzipped, against a largest app chunk of ~62KB.**
 * Any page that imports this eagerly more than doubles the biggest bundle in
 * the app. Client-side callers MUST load it with a dynamic `import()` from
 * inside the component that needs it (the import dialog), so it never lands on
 * an entry chunk. Server-side callers can import it normally.
 *
 * ## Why zod
 *
 * The rules here must stay in step with the interfaces in `./model`, and a
 * hand-rolled validator drifts silently in exactly the direction we hit most
 * often: TypeScript says nothing when a new optional field has no reader, so
 * the field is declared, documented, set by the editor — and deleted on every
 * save. The `Eq<z.infer<...>, T>` assertions at the bottom turn that into a
 * compile error in either direction.
 *
 * They pin the SHAPE, not the RULES: relaxing `.regex(...)` to a bare
 * `z.string()` still type-checks. Shape drift is what the pins catch; rule
 * drift is what the tests are for.
 *
 * ## What this module does NOT do
 *
 * - **It does not touch the database.** Instance existence and org ownership
 *   are storage's job; this returns every referenced instance id so the caller
 *   cannot check one and miss the overrides.
 * - **It does not sanitise SQL.** A panel query is arbitrary SQL by design.
 *   Only shape and size are enforced.
 * - **It does not understand foreign documents.** Converting a Grafana
 *   dashboard belongs to the import adapter (#57).
 * - **It cannot be cancelled.** Both entry points are fully synchronous, so
 *   they cannot honour `event.request.signal`; a client that disconnects
 *   mid-save still pays the full walk. Bounding the input is the only lever,
 *   which is why the node budget below is not optional.
 */

import { z } from 'zod';
import {
  DATABASE_PATTERN,
  DURATION_PATTERN,
  GRID_COLUMNS,
  LIMITS,
  NON_FIXED_COLOR_MODES,
  PANEL_ID_PATTERN,
  PANEL_TYPES,
  REF_ID_PATTERN,
  SPECIAL_MATCHES,
  TARGET_FORMATS,
  THRESHOLDS_MODES,
  UID_PATTERN,
  VARIABLE_HIDE,
  VARIABLE_NAME_PATTERN,
  VARIABLE_REFRESH,
  VARIABLE_SORT,
  VARIABLE_TYPES,
  WEEK_STARTS,
  isInstanceRef,
  isSafeColor,
  isSafeObjectKey,
  migrateModel,
  preflightVersion,
  type Dashboard,
  type DashboardValidationResult,
  type FieldConfig,
  type GridPos,
  type Panel,
  type Target,
  type TemplateVariable,
  type TimeSettings,
  type ValidationCode,
  type ValidationError,
  type ValidationWarning,
  type ValueMapping,
  type WarningCode,
} from './model';

// ---------------------------------------------------------------------------
// Structural walk — depth and size in one pass
// ---------------------------------------------------------------------------

export interface WalkResult {
  depth: number;
  nodes: number;
  /** Set when a cap was exceeded; the walk stops early rather than finishing. */
  exceeded: 'depth' | 'nodes' | null;
}

/**
 * Measures nesting depth and node count in a single ITERATIVE pass.
 *
 * Iterative is not a style preference. A recursive implementation would
 * overflow on exactly the input this exists to reject, reporting a crash
 * instead of a validation error.
 *
 * Nodes and depths go in two parallel arrays rather than an array of
 * `{node, depth}` wrappers — allocating one object per node cost ~31MB of heap
 * on a 3.5MB document versus ~14.6MB this way, for the same answer.
 *
 * Caveat: this sees only enumerable own properties, and is TOCTOU against
 * getters. Unreachable via `parseAndValidate` (JSON has neither); reachable
 * only if a caller hands `validateDashboard` a live object or a Proxy.
 */
export function walkStructure(value: unknown, maxDepth: number, maxNodes: number): WalkResult {
  let deepest = 0;
  let nodes = 0;
  const stackNodes: unknown[] = [value];
  const stackDepths: number[] = [0];

  while (stackNodes.length > 0) {
    const node = stackNodes.pop();
    const depth = stackDepths.pop()!;

    nodes++;
    if (nodes > maxNodes) return { depth: deepest, nodes, exceeded: 'nodes' };
    if (depth > deepest) deepest = depth;
    if (deepest > maxDepth) return { depth: deepest, nodes, exceeded: 'depth' };

    if (node === null || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (const child of node) {
        stackNodes.push(child);
        stackDepths.push(depth + 1);
      }
    } else {
      for (const key of Object.keys(node as Record<string, unknown>)) {
        stackNodes.push((node as Record<string, unknown>)[key]);
        stackDepths.push(depth + 1);
      }
    }
  }
  return { depth: deepest, nodes, exceeded: null };
}

/** Convenience wrapper for callers that only care about depth. */
export function maxDepthOf(value: unknown, maxDepth = LIMITS.maxDepth): number {
  return walkStructure(value, maxDepth, Number.MAX_SAFE_INTEGER).depth;
}

/** UTF-8 byte length without allocating an encoded copy of the string. */
export function utf8Length(str: string): number {
  let bytes = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4; // surrogate pair: consume both units
      i++;
    } else bytes += 3;
  }
  return bytes;
}

export function durationToMs(value: string): number | null {
  const match = /^(\d+)(ms|s|m|h|d|w)$/.exec(value);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return null;
  const unit: Record<string, number> = {
    ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000,
  };
  return n * unit[match[2]];
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/**
 * zod issue codes are too coarse for consumers to branch on, and every
 * `.refine()` collapses to `custom`. Each refine therefore carries the code it
 * actually means, read back out in `codeFor`.
 */
function withCode(code: ValidationCode, message: string) {
  return { message, params: { code } };
}

const colorString = z
  .string()
  .refine(isSafeColor, withCode('invalid_format', 'not an allowed color'));

/** Durations feed interval arithmetic, so they are bounded at both ends. */
const duration = z
  .string()
  .max(32)
  .regex(DURATION_PATTERN)
  .refine((d) => {
    const ms = durationToMs(d);
    return ms !== null && ms <= LIMITS.maxDurationMs;
  }, withCode('out_of_range', 'duration is out of range'));

const boundedText = (max: number) => z.string().max(max);

/** An instance id, or a `$variable` naming one. Both are untrusted. */
const instanceRef = z
  .string()
  .min(1)
  .max(64)
  .refine(
    (v) => UID_PATTERN.test(v) || isInstanceRef(v),
    withCode('invalid_format', 'must be an instance id or a $variable reference'),
  );

/** Identifiers that become object keys need more than a charset. */
const objectKey = (pattern: RegExp, max: number) =>
  z
    .string()
    .max(max)
    .regex(pattern)
    .refine(isSafeObjectKey, withCode('unknown_value', 'is a reserved name'));

const boundedSql = z
  .string()
  .refine(
    (s) => utf8Length(s) <= LIMITS.maxSqlBytes,
    withCode('too_long', `must be at most ${LIMITS.maxSqlBytes} bytes`),
  );

/**
 * A free-form bag (panel options, `fieldConfig.custom`), bounded on keys, depth
 * and bytes in ONE walk.
 *
 * Previously three chained `.refine()` calls, each traversing independently.
 * zod does not short-circuit a refine chain, so a bag failing the first check
 * still paid for all three — about 48% of total validation time.
 */
const optionsBag = z.record(z.string(), z.unknown()).superRefine((value, ctx) => {
  if (Object.keys(value).length > LIMITS.maxOptionsKeys) {
    ctx.addIssue({
      code: 'custom',
      message: `must have at most ${LIMITS.maxOptionsKeys} keys`,
      params: { code: 'too_many' },
    });
    return;
  }
  const walk = walkStructure(value, LIMITS.maxOptionsDepth, LIMITS.maxNodes);
  if (walk.exceeded === 'depth') {
    ctx.addIssue({
      code: 'custom',
      message: `must nest at most ${LIMITS.maxOptionsDepth} levels deep`,
      params: { code: 'too_deep' },
    });
    return;
  }
  if (walk.exceeded === 'nodes') {
    ctx.addIssue({ code: 'custom', message: 'has too many values', params: { code: 'too_many' } });
    return;
  }
  // Size last: it is the only check that materializes a copy, so it runs only
  // once the cheap structural checks have passed.
  if (approximateBytes(value) > LIMITS.maxOptionsBytes) {
    ctx.addIssue({
      code: 'custom',
      message: `must serialize to at most ${LIMITS.maxOptionsBytes} bytes`,
      params: { code: 'too_large' },
    });
  }
});

function approximateBytes(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return Number.POSITIVE_INFINITY;
    // UTF-16 code units are a lower bound on UTF-8 bytes, so this decides
    // without a second pass whenever the string alone is already over.
    if (json.length > LIMITS.maxOptionsBytes) return json.length;
    return utf8Length(json);
  } catch {
    return Number.POSITIVE_INFINITY; // circular or otherwise unserializable
  }
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const GridPosSchema = z.object({
  x: z.number().int().min(0).max(GRID_COLUMNS - 1),
  y: z.number().int().min(0).max(LIMITS.maxGridY),
  w: z.number().int().min(1).max(GRID_COLUMNS),
  h: z.number().int().min(1).max(LIMITS.maxPanelHeight),
});

const TargetSchema = z.object({
  refId: objectKey(REF_ID_PATTERN, 16),
  // Empty is legal — createPanel produces it, and it means "not configured".
  sql: boundedSql,
  instanceId: instanceRef.optional(),
  database: z.string().regex(DATABASE_PATTERN).optional(),
  format: z.enum(TARGET_FORMATS).optional(),
  hide: z.boolean().optional(),
});

const ThresholdSchema = z.object({
  value: z.number().nullable(),
  color: colorString,
});

const ThresholdsConfigSchema = z.object({
  mode: z.enum(THRESHOLDS_MODES),
  steps: z.array(ThresholdSchema).max(LIMITS.maxThresholdSteps),
});

// Discriminated, so a `{mode:'fixed'}` missing its color reports the missing
// field rather than an unactionable "Invalid input" on the whole object.
const FieldColorSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('fixed'), fixedColor: colorString }),
  z.object({ mode: z.literal(NON_FIXED_COLOR_MODES[0]), scheme: z.string().max(64).optional() }),
  z.object({ mode: z.literal(NON_FIXED_COLOR_MODES[1]), scheme: z.string().max(64).optional() }),
  z.object({ mode: z.literal(NON_FIXED_COLOR_MODES[2]), scheme: z.string().max(64).optional() }),
  z.object({ mode: z.literal(NON_FIXED_COLOR_MODES[3]), scheme: z.string().max(64).optional() }),
]);

const MappingResultSchema = z.object({
  text: boundedText(200).optional(),
  color: colorString.optional(),
});

const ValueMappingSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('value'), value: boundedText(200), result: MappingResultSchema }),
  z.object({
    type: z.literal('range'),
    from: z.number().nullable(),
    to: z.number().nullable(),
    result: MappingResultSchema,
  }),
  z.object({
    type: z.literal('special'),
    match: z.enum(SPECIAL_MATCHES),
    result: MappingResultSchema,
  }),
]);

const FieldConfigSchema = z.object({
  unit: boundedText(32).optional(),
  // toFixed throws a RangeError outside 0..100 and blanks the whole panel.
  decimals: z.number().int().min(0).max(20).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  displayName: boundedText(200).optional(),
  noValue: boundedText(200).optional(),
  color: FieldColorSchema.optional(),
  thresholds: ThresholdsConfigSchema.optional(),
  mappings: z.array(ValueMappingSchema).max(LIMITS.maxMappings).optional(),
  custom: optionsBag.optional(),
});

const FieldConfigSourceSchema = z.object({ defaults: FieldConfigSchema });

const PanelSchema = z.object({
  id: objectKey(PANEL_ID_PATTERN, 64),
  type: z.enum(PANEL_TYPES),
  title: boundedText(LIMITS.maxTitleLength),
  description: boundedText(LIMITS.maxDescriptionLength).optional(),
  gridPos: GridPosSchema,
  targets: z.array(TargetSchema).max(LIMITS.maxTargetsPerPanel),
  fieldConfig: FieldConfigSourceSchema,
  options: optionsBag,
  instanceId: instanceRef.optional(),
  transparent: z.boolean().optional(),
  interval: duration.optional(),
  maxDataPoints: z.number().int().min(1).max(LIMITS.maxDataPoints).optional(),
  timeFrom: boundedText(32).optional(),
  timeShift: boundedText(32).optional(),
  hideTimeOverride: z.boolean().optional(),
});

const VariableOptionSchema = z.object({
  text: boundedText(500),
  value: boundedText(500),
});

const TemplateVariableSchema = z.object({
  name: objectKey(VARIABLE_NAME_PATTERN, 64),
  type: z.enum(VARIABLE_TYPES),
  label: boundedText(200).optional(),
  description: boundedText(LIMITS.maxDescriptionLength).optional(),
  hide: z.enum(VARIABLE_HIDE).optional(),
  // For a query variable this IS SQL, executed on dashboard load.
  query: boundedSql.optional(),
  current: z.array(VariableOptionSchema).max(1000).optional(),
  multi: z.boolean().optional(),
  includeAll: z.boolean().optional(),
  allValue: boundedText(500).optional(),
  refresh: z.enum(VARIABLE_REFRESH).optional(),
  sort: z.enum(VARIABLE_SORT).optional(),
  instanceId: instanceRef.optional(),
  auto: z.boolean().optional(),
  autoCount: z.number().int().min(1).max(10_000).optional(),
  autoMin: duration.optional(),
});

const TimeSettingsSchema = z.object({
  from: boundedText(64),
  to: boundedText(64),
  timezone: z
    .string()
    .max(64)
    .refine(isValidTimezone, withCode('unknown_value', 'not a known timezone')),
  refresh: z
    .string()
    .max(32)
    .refine(
      (r) => r === '' || DURATION_PATTERN.test(r),
      withCode('invalid_format', 'must be empty or a duration'),
    ),
  nowDelay: duration.optional(),
  weekStart: z.enum(WEEK_STARTS).optional(),
});

const DashboardSchema = z.object({
  launchpadSchemaVersion: z.number().int().min(0),
  title: z
    .string()
    .max(LIMITS.maxTitleLength)
    // Trimmed before the emptiness check: a whitespace-only title is an
    // invisible row in the dashboard list.
    .refine((t) => t.trim().length > 0, withCode('required', 'must not be empty')),
  description: boundedText(LIMITS.maxDescriptionLength).optional(),
  tags: z.array(boundedText(LIMITS.maxTagLength)).max(LIMITS.maxTags),
  instanceId: instanceRef.nullable(),
  time: TimeSettingsSchema,
  variables: z.array(TemplateVariableSchema).max(LIMITS.maxVariables),
  panels: z.array(PanelSchema).max(LIMITS.maxPanels),
  graphTooltip: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
  minInterval: duration.optional(),
});

// ---------------------------------------------------------------------------
// Timezones
// ---------------------------------------------------------------------------

const CANONICAL_ZONES: ReadonlySet<string> = (() => {
  const set = new Set<string>(['utc', 'UTC', 'browser']);
  try {
    const supported = (Intl as unknown as { supportedValuesOf?(k: string): string[] })
      .supportedValuesOf?.('timeZone');
    for (const zone of supported ?? []) set.add(zone);
  } catch {
    /* fall through to the Intl probe below */
  }
  return set;
})();

/**
 * Bounded, because this runs server-side on every dashboard write, the key is a
 * string from the request body, and a MISS is cached too — so distinct bogus
 * zone names grow it on requests that then 400. Real zones plus aliases number
 * in the hundreds, so the cap is never reached by legitimate use.
 *
 * Past the cap we stop caching rather than evict: no policy to get wrong, and
 * the probe still runs, so correctness never depends on the cache.
 */
const MAX_PROBED_ZONES = 1000;
const probedZones = new Map<string, boolean>();

/**
 * `Intl.supportedValuesOf` returns CANONICAL zones only — 418 of them — and
 * deliberately excludes link names. Treating that list as exhaustive rejected
 * `US/Eastern`, `GMT`, `Etc/GMT+5`, `Japan` and every case variant, all of
 * which `Intl.DateTimeFormat` accepts and which appear throughout older
 * Grafana exports.
 *
 * So the set is a CACHE, not a control: a miss always falls through to the real
 * check. A cache must never be authoritative for a miss.
 */
function isValidTimezone(tz: string): boolean {
  if (CANONICAL_ZONES.has(tz)) return true;
  const cached = probedZones.get(tz);
  if (cached !== undefined) return cached;
  let valid = false;
  try {
    // Locale stays undefined — never attacker-influenced.
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    valid = true;
  } catch {
    valid = false;
  }
  if (probedZones.size < MAX_PROBED_ZONES) probedZones.set(tz, valid);
  return valid;
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/** `['panels', 2, 'gridPos', 'w']` -> `panels[2].gridPos.w` */
function formatPath(path: ReadonlyArray<PropertyKey>): string {
  const parts: string[] = [];
  for (const segment of path) {
    if (typeof segment === 'number') parts.push(`[${segment}]`);
    else parts.push(parts.length === 0 ? String(segment) : `.${String(segment)}`);
  }
  return parts.join('');
}

function codeFor(issue: z.core.$ZodIssue): ValidationCode {
  // Every .refine() in this file collapses to `custom` and carries the code it
  // actually means. Without this, "too many option keys" and "malformed refId"
  // were indistinguishable to a consumer branching on `code`.
  const carried = (issue as { params?: { code?: ValidationCode } }).params?.code;
  if (carried) return carried;

  switch (issue.code) {
    case 'invalid_type':
      return issue.input === undefined ? 'required' : 'wrong_type';
    case 'too_big':
      return issue.origin === 'string' ? 'too_long' : 'too_many';
    case 'too_small':
      return issue.origin === 'string' ? 'required' : 'out_of_range';
    case 'not_multiple_of':
      return 'out_of_range';
    case 'invalid_format':
      return 'invalid_format';
    case 'unrecognized_keys':
    case 'invalid_key':
    case 'invalid_element':
    case 'invalid_value':
    case 'invalid_union':
      return 'unknown_value';
    case 'custom':
      return 'invalid_format';
    default:
      return 'invalid_format';
  }
}

/**
 * Messages deliberately never echo the offending VALUE — an error like
 * `Invalid color: "<img src=x>"` round-trips attacker-controlled text into an
 * admin's import dialog, a toast, and the server log.
 */
function toErrors(issues: ReadonlyArray<z.core.$ZodIssue>): {
  errors: ValidationError[];
  truncated: boolean;
} {
  const errors: ValidationError[] = [];
  for (const issue of issues) {
    if (errors.length >= LIMITS.maxErrors) return { errors, truncated: true };
    errors.push({ path: formatPath(issue.path), code: codeFor(issue), message: issue.message });
  }
  return { errors, truncated: false };
}

function fail(error: ValidationError): DashboardValidationResult {
  return { ok: false, errors: [error], truncated: false };
}

/** Bounded warning sink — the success path needs the same cap as the failure path. */
class Warnings {
  readonly items: ValidationWarning[] = [];
  truncated = false;

  add(path: string, code: WarningCode, message: string): void {
    if (this.items.length >= LIMITS.maxWarnings) {
      this.truncated = true;
      return;
    }
    this.items.push({ path, code, message });
  }
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Validate an already-parsed value.
 *
 * This enforces its own structural budget rather than trusting the caller:
 * every route in this repo uses `request.json()`, so leaving the bound to the
 * caller meant the idiomatic path had none at all. A 44MB hostile input blocked
 * the event loop for 484ms before this existed.
 */
export function validateDashboard(input: unknown): DashboardValidationResult {
  const pre = preflightVersion(input);
  if (!pre.ok) return fail(pre.error);

  // Before anything walks the document — including zod, and including the
  // serializer SvelteKit will later run over it.
  const walk = walkStructure(input, LIMITS.maxDepth, LIMITS.maxNodes);
  if (walk.exceeded === 'depth') {
    return fail({
      path: '',
      code: 'too_deep',
      message: `Dashboard nests more than ${LIMITS.maxDepth} levels deep`,
    });
  }
  if (walk.exceeded === 'nodes') {
    return fail({
      path: '',
      code: 'too_large',
      message: `Dashboard contains more than ${LIMITS.maxNodes} values`,
    });
  }

  const migrated = migrateModel(input as Record<string, unknown>, pre.version);
  const parsed = DashboardSchema.safeParse(migrated);
  if (!parsed.success) {
    const { errors, truncated } = toErrors(parsed.error.issues);
    return { ok: false, errors, truncated };
  }

  const warnings = new Warnings();
  const model = normalize(parsed.data as Dashboard, warnings);
  const referencedInstanceIds = collectInstanceIds(model, warnings);
  return { ok: true, model, warnings: warnings.items, referencedInstanceIds };
}

/**
 * Validate a raw JSON string, enforcing the byte cap before parsing.
 *
 * Prefer this whenever the raw body is available — the byte check is cheaper
 * and more precise than the node budget, and it rejects before `JSON.parse`
 * materializes anything.
 */
export function parseAndValidate(json: string): DashboardValidationResult {
  // UTF-16 code units are a lower bound on UTF-8 bytes, so an over-cap string
  // is rejected without scanning it at all.
  if (json.length > LIMITS.maxPayloadBytes || utf8Length(json) > LIMITS.maxPayloadBytes) {
    return fail({
      path: '',
      code: 'too_large',
      message: `Dashboard exceeds the ${LIMITS.maxPayloadBytes} byte limit`,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    // V8 splices ~15 bytes of the raw body verbatim into its SyntaxError
    // message, so forwarding it would echo attacker bytes into the import
    // dialog and the server log — the one thing toErrors is careful not to do.
    return fail({ path: '', code: 'malformed_json', message: 'Invalid JSON' });
  }
  return validateDashboard(parsed);
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function normalize(model: Dashboard, warnings: Warnings): Dashboard {
  const panels = model.panels.map((panel, i) => normalizePanel(panel, `panels[${i}]`, warnings));

  // Seeded with EVERY id, not just those seen so far: probing upward from a
  // partially-filled set hands out ids belonging to panels LATER in the array,
  // which then cascade-renumber. Panel ids appear in ?viewPanel= URLs, so that
  // silently broke bookmarks for panels that were never duplicates.
  const allIds = new Set(panels.map((p) => p.id));
  const assigned = new Set<string>();
  for (let i = 0; i < panels.length; i++) {
    const panel = panels[i];
    if (!assigned.has(panel.id)) {
      assigned.add(panel.id);
      continue;
    }
    let next = 1;
    while (allIds.has(String(next)) || assigned.has(String(next))) next++;
    const id = String(next);
    warnings.add(`panels[${i}].id`, 'renamed', 'Duplicate panel id was reassigned');
    panels[i] = { ...panel, id };
    allIds.add(id);
    assigned.add(id);
  }

  const seenVarNames = new Set<string>();
  const variables: TemplateVariable[] = [];
  for (let i = 0; i < model.variables.length; i++) {
    const variable = model.variables[i];
    if (seenVarNames.has(variable.name)) {
      warnings.add(`variables[${i}]`, 'dropped', 'Duplicate variable name dropped');
      continue;
    }
    seenVarNames.add(variable.name);
    variables.push(
      variable.type === 'query' && variable.refresh === undefined
        ? { ...variable, refresh: 'on-dashboard-load' }
        : variable,
    );
  }

  const time = normalizeTime(model.time, warnings);
  return { ...model, panels, variables, time };
}

function normalizeTime(time: TimeSettings, warnings: Warnings): TimeSettings {
  if (time.refresh === '') return time;
  const ms = durationToMs(time.refresh);
  if (ms !== null && ms < LIMITS.minRefreshMs) {
    // Clamp rather than reject, so an imported dashboard still opens.
    warnings.add(
      'time.refresh',
      'clamped',
      `Refresh interval raised to the ${LIMITS.minRefreshMs}ms minimum`,
    );
    return { ...time, refresh: `${LIMITS.minRefreshMs / 1000}s` };
  }
  return time;
}

function normalizePanel(panel: Panel, path: string, warnings: Warnings): Panel {
  let next = panel;

  // Clamp rather than reject — an off-grid panel is a layout nuisance, not a
  // reason to refuse the document.
  if (panel.gridPos.x + panel.gridPos.w > GRID_COLUMNS) {
    const w = Math.max(1, GRID_COLUMNS - panel.gridPos.x);
    warnings.add(`${path}.gridPos`, 'clamped', 'Panel extended past the grid and was narrowed');
    next = { ...next, gridPos: { ...next.gridPos, w } };
  }

  const seenRefIds = new Set<string>();
  const targets: Target[] = [];
  for (let i = 0; i < next.targets.length; i++) {
    const target = next.targets[i];
    if (seenRefIds.has(target.refId)) {
      warnings.add(`${path}.targets[${i}]`, 'dropped', 'Duplicate refId dropped');
      continue;
    }
    seenRefIds.add(target.refId);
    targets.push(target);
  }
  if (targets.length !== next.targets.length) next = { ...next, targets };

  const thresholds = next.fieldConfig.defaults.thresholds;
  if (thresholds) {
    const steps = [...thresholds.steps].sort(compareThresholds);
    // Reference identity is a valid movement check: the copy shares references
    // and Array.prototype.sort is stable.
    const wasSorted = steps.every((s, i) => s === thresholds.steps[i]);
    if (!wasSorted) {
      warnings.add(
        `${path}.fieldConfig.defaults.thresholds`,
        'reordered',
        'Threshold steps were reordered',
      );
      // Rebuild only when something moved, and spread the existing fieldConfig
      // so siblings added later (overrides, in #36) are not dropped.
      next = {
        ...next,
        fieldConfig: {
          ...next.fieldConfig,
          defaults: { ...next.fieldConfig.defaults, thresholds: { ...thresholds, steps } },
        },
      };
    }
  }

  const { min, max } = next.fieldConfig.defaults;
  if (min !== undefined && max !== undefined && min > max) {
    warnings.add(`${path}.fieldConfig.defaults`, 'dropped', 'min exceeded max; both were cleared');
    const defaults: FieldConfig = { ...next.fieldConfig.defaults };
    delete defaults.min;
    delete defaults.max;
    next = { ...next, fieldConfig: { ...next.fieldConfig, defaults } };
  }

  return next;
}

/**
 * Base (null) step first, then ascending.
 *
 * Returning -1 for both orderings when two steps are null — as an earlier
 * version did — is a non-antisymmetric comparator, which V8's sort answers by
 * swapping the pair on every pass. Validation then stopped being idempotent:
 * which color served as the base step flipped on every save, dirty tracking
 * fired on every open, and a new version accumulated per save with no user edit.
 */
function compareThresholds(a: { value: number | null }, b: { value: number | null }): number {
  if (a.value === null && b.value === null) return 0;
  if (a.value === null) return -1;
  if (b.value === null) return 1;
  return a.value - b.value;
}

/**
 * Every distinct LITERAL instance id in the document, at all four levels.
 *
 * `$variable` references are excluded and validated instead: they must name a
 * declared variable of type `instance`. Emitting them as ids made every
 * templated dashboard unsaveable — storage resolves ids against
 * `WHERE id = ? AND org_id = ?`, which `$instance` never matches — while the id
 * that actually gets resolved never reached the authorizer at all.
 */
function collectInstanceIds(model: Dashboard, warnings: Warnings): string[] {
  const instanceVars = new Set(
    model.variables.filter((v) => v.type === 'instance').map((v) => `$${v.name}`),
  );
  const ids = new Set<string>();

  const consider = (value: string | null | undefined, path: string): void => {
    if (!value) return;
    if (isInstanceRef(value)) {
      if (!instanceVars.has(value)) {
        warnings.add(
          path,
          'dropped',
          'References a variable that is not a declared instance variable',
        );
      }
      return;
    }
    ids.add(value);
  };

  consider(model.instanceId, 'instanceId');
  for (let p = 0; p < model.panels.length; p++) {
    const panel = model.panels[p];
    consider(panel.instanceId, `panels[${p}].instanceId`);
    for (let t = 0; t < panel.targets.length; t++) {
      consider(panel.targets[t].instanceId, `panels[${p}].targets[${t}].instanceId`);
    }
  }
  for (let v = 0; v < model.variables.length; v++) {
    consider(model.variables[v].instanceId, `variables[${v}].instanceId`);
  }
  return [...ids].sort();
}

// ---------------------------------------------------------------------------
// Compile-time pins
// ---------------------------------------------------------------------------

/**
 * These assertions are the reason zod is here rather than a hand-rolled
 * validator: if someone adds a field to an interface in `./model` and forgets
 * the schema — or tightens a schema past what the type allows — `npm run check`
 * fails here instead of the field being silently dropped on every save.
 *
 * The `_Hint` parameter exists so the failure names the type that drifted;
 * without it the error is a bare "Type 'false' does not satisfy the constraint
 * 'true'" that cascades to every enclosing pin at once.
 */
type Eq<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true, _Hint extends string> = T;

type _GridPosPinned = Assert<Eq<z.infer<typeof GridPosSchema>, GridPos>, 'GridPos'>;
type _TargetPinned = Assert<Eq<z.infer<typeof TargetSchema>, Target>, 'Target'>;
type _ValueMappingPinned = Assert<
  Eq<z.infer<typeof ValueMappingSchema>, ValueMapping>,
  'ValueMapping'
>;
type _FieldConfigPinned = Assert<Eq<z.infer<typeof FieldConfigSchema>, FieldConfig>, 'FieldConfig'>;
type _TimeSettingsPinned = Assert<
  Eq<z.infer<typeof TimeSettingsSchema>, TimeSettings>,
  'TimeSettings'
>;
type _PanelPinned = Assert<Eq<z.infer<typeof PanelSchema>, Panel>, 'Panel'>;
type _VariablePinned = Assert<
  Eq<z.infer<typeof TemplateVariableSchema>, TemplateVariable>,
  'TemplateVariable'
>;
type _DashboardPinned = Assert<Eq<z.infer<typeof DashboardSchema>, Dashboard>, 'Dashboard'>;
