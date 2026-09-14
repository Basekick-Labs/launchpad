/**
 * Dashboard validation — the trust boundary for dashboard documents.
 *
 * ## This module is isomorphic, and that is deliberate
 *
 * It runs on the server (authoritative, on every write) and in the browser
 * (the import dialog previews errors before uploading anything). The client
 * copy is a UX affordance with NO authority: the server revalidates everything
 * it stores, and nothing may assume a document is safe because the browser said
 * so. It therefore imports no node builtins and lives outside `$lib/server/`.
 *
 * ## Why zod
 *
 * The rules here must stay in step with the interfaces in `./model`, and a
 * hand-rolled validator drifts silently in exactly the direction we hit most
 * often: TypeScript says nothing when a new optional field has no reader, so
 * the field is declared, documented, set by the editor — and deleted on every
 * save. The `Eq<z.infer<...>, T>` assertions at the bottom of this file turn
 * that into a compile error in either direction.
 *
 * Unknown keys are stripped rather than rejected (zod's default for
 * `z.object`), so a document from a slightly different build loses what we do
 * not understand instead of failing wholesale.
 *
 * ## What this module does NOT do
 *
 * - **It does not touch the database.** Instance existence and org ownership
 *   are storage's job; this returns every referenced instance id so the caller
 *   cannot check one and miss the overrides.
 * - **It does not sanitise SQL.** A panel query is arbitrary SQL by design.
 *   Only shape and size are enforced.
 * - **It does not understand foreign documents.** Converting a Grafana
 *   dashboard belongs to the import adapter; letting that leak in here would
 *   make this lossy and heuristic, which is the opposite of what a trust
 *   boundary should be.
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
  RESERVED_VARIABLE_NAMES,
  SPECIAL_MATCHES,
  TARGET_FORMATS,
  THRESHOLDS_MODES,
  VARIABLE_HIDE,
  VARIABLE_NAME_PATTERN,
  VARIABLE_REFRESH,
  VARIABLE_SORT,
  VARIABLE_TYPES,
  WEEK_STARTS,
  isSafeColor,
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
} from './model';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Rejects NaN and Infinity, which survive neither JSON nor SQLite meaningfully. */
const finiteNumber = () => z.number().refine(Number.isFinite, { message: 'must be finite' });

const colorString = z.string().refine(isSafeColor, { message: 'not an allowed color' });

const duration = z.string().regex(DURATION_PATTERN);

const boundedText = (max: number) => z.string().max(max);

/**
 * A free-form bag (panel options, fieldConfig.custom). Bounded on three axes:
 * key count, serialized size, and nesting depth. Depth is the one that matters
 * most — see LIMITS.maxDepth.
 */
const optionsBag = z
  .record(z.string(), z.unknown())
  .refine((v) => Object.keys(v).length <= LIMITS.maxOptionsKeys, {
    message: `must have at most ${LIMITS.maxOptionsKeys} keys`,
  })
  .refine((v) => safeByteLength(v) <= LIMITS.maxOptionsBytes, {
    message: `must serialize to at most ${LIMITS.maxOptionsBytes} bytes`,
  })
  .refine((v) => maxDepthOf(v) <= LIMITS.maxOptionsDepth, {
    message: `must nest at most ${LIMITS.maxOptionsDepth} levels deep`,
  });

function safeByteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value) ?? '').length;
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
  refId: z.string().regex(REF_ID_PATTERN),
  // Empty is legal — createPanel produces it, and it means "not configured".
  sql: z.string().max(LIMITS.maxSqlBytes),
  instanceId: z.string().min(1).max(64).optional(),
  database: z.string().regex(DATABASE_PATTERN).optional(),
  format: z.enum(TARGET_FORMATS).optional(),
  hide: z.boolean().optional(),
});

const ThresholdSchema = z.object({
  value: finiteNumber().nullable(),
  color: colorString,
});

const ThresholdsConfigSchema = z.object({
  mode: z.enum(THRESHOLDS_MODES),
  steps: z.array(ThresholdSchema).max(LIMITS.maxThresholdSteps),
});

const FieldColorSchema = z.union([
  z.object({ mode: z.literal('fixed'), fixedColor: colorString }),
  z.object({
    mode: z.enum(NON_FIXED_COLOR_MODES),
    scheme: z.string().max(64).optional(),
  }),
]);

const MappingResultSchema = z.object({
  text: boundedText(200).optional(),
  color: colorString.optional(),
});

const ValueMappingSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('value'), value: boundedText(200), result: MappingResultSchema }),
  z.object({
    type: z.literal('range'),
    from: finiteNumber().nullable(),
    to: finiteNumber().nullable(),
    result: MappingResultSchema,
  }),
  z.object({ type: z.literal('regex'), pattern: safeRegexSource(), result: MappingResultSchema }),
  z.object({ type: z.literal('special'), match: z.enum(SPECIAL_MATCHES), result: MappingResultSchema }),
]);

const FieldConfigSchema = z.object({
  unit: boundedText(32).optional(),
  // toFixed throws a RangeError outside 0..100 and blanks the whole panel.
  decimals: z.number().int().min(0).max(20).optional(),
  min: finiteNumber().optional(),
  max: finiteNumber().optional(),
  displayName: boundedText(200).optional(),
  noValue: boundedText(200).optional(),
  color: FieldColorSchema.optional(),
  thresholds: ThresholdsConfigSchema.optional(),
  mappings: z.array(ValueMappingSchema).max(LIMITS.maxMappings).optional(),
  custom: optionsBag.optional(),
});

const FieldConfigSourceSchema = z.object({ defaults: FieldConfigSchema });

const PanelSchema = z.object({
  id: z.string().regex(PANEL_ID_PATTERN),
  type: z.enum(PANEL_TYPES),
  title: boundedText(LIMITS.maxTitleLength),
  description: boundedText(LIMITS.maxDescriptionLength).optional(),
  gridPos: GridPosSchema,
  targets: z.array(TargetSchema).max(LIMITS.maxTargetsPerPanel),
  fieldConfig: FieldConfigSourceSchema,
  options: optionsBag,
  instanceId: z.string().min(1).max(64).optional(),
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
  name: z
    .string()
    .regex(VARIABLE_NAME_PATTERN)
    .refine((n) => !RESERVED_VARIABLE_NAMES.has(n), { message: 'is a reserved name' }),
  type: z.enum(VARIABLE_TYPES),
  label: boundedText(200).optional(),
  description: boundedText(LIMITS.maxDescriptionLength).optional(),
  hide: z.enum(VARIABLE_HIDE).optional(),
  // For a query variable this IS SQL, executed on dashboard load.
  query: z.string().max(LIMITS.maxSqlBytes).optional(),
  current: z.array(VariableOptionSchema).max(1000).optional(),
  multi: z.boolean().optional(),
  includeAll: z.boolean().optional(),
  allValue: boundedText(500).optional(),
  refresh: z.enum(VARIABLE_REFRESH).optional(),
  regex: safeRegexSource().optional(),
  sort: z.enum(VARIABLE_SORT).optional(),
  instanceId: z.string().min(1).max(64).optional(),
  auto: z.boolean().optional(),
  autoCount: z.number().int().min(1).max(10_000).optional(),
  autoMin: duration.optional(),
});

const TimeSettingsSchema = z.object({
  from: boundedText(64),
  to: boundedText(64),
  timezone: z.string().max(64).refine(isValidTimezone, { message: 'not a known timezone' }),
  refresh: z.string().refine((r) => r === '' || DURATION_PATTERN.test(r), {
    message: 'must be empty or a duration',
  }),
  nowDelay: duration.optional(),
  weekStart: z.enum(WEEK_STARTS).optional(),
});

const DashboardSchema = z.object({
  launchpadSchemaVersion: z.number().int().min(0),
  title: z.string().min(1).max(LIMITS.maxTitleLength),
  description: boundedText(LIMITS.maxDescriptionLength).optional(),
  tags: z.array(boundedText(LIMITS.maxTagLength)).max(LIMITS.maxTags),
  instanceId: z.string().min(1).max(64).nullable(),
  time: TimeSettingsSchema,
  variables: z.array(TemplateVariableSchema).max(LIMITS.maxVariables),
  panels: z.array(PanelSchema).max(LIMITS.maxPanels),
  graphTooltip: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
  minInterval: duration.optional(),
});

// ---------------------------------------------------------------------------
// Guards used by the schemas
// ---------------------------------------------------------------------------

/**
 * Author-supplied regexes run against every result value, and dashboards are
 * shared — so catastrophic backtracking is a denial of service against
 * colleagues, not just the author. Rejects nested quantifiers structurally and
 * requires the pattern to actually compile.
 */
function safeRegexSource() {
  const NESTED_QUANTIFIER = /(\+|\*|\{\d+,?\d*\})\s*\)?\s*(\+|\*|\{)/;
  return z
    .string()
    .max(200)
    .refine((src) => !NESTED_QUANTIFIER.test(src), { message: 'has nested quantifiers' })
    .refine((src) => {
      try {
        new RegExp(src);
        return true;
      } catch {
        return false;
      }
    }, { message: 'is not a valid regular expression' });
}

const TIMEZONE_SET: ReadonlySet<string> = (() => {
  const base = new Set(['utc', 'UTC', 'browser']);
  try {
    // Cheaper than a try/catch per validation, and avoids using exceptions for
    // control flow. Node 20 ships full-icu, so this is populated.
    for (const zone of (Intl as unknown as { supportedValuesOf?(k: string): string[] })
      .supportedValuesOf?.('timeZone') ?? []) {
      base.add(zone);
    }
  } catch {
    /* fall through to the small base set */
  }
  return base;
})();

function isValidTimezone(tz: string): boolean {
  if (TIMEZONE_SET.has(tz)) return true;
  if (TIMEZONE_SET.size > 3) return false; // the full list loaded; tz is genuinely unknown
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Depth
// ---------------------------------------------------------------------------

/**
 * Maximum nesting depth, computed with an EXPLICIT STACK.
 *
 * A recursive implementation would overflow on exactly the input this exists to
 * reject, reporting a crash instead of a validation error. Cheap to get right,
 * impossible to notice when wrong.
 */
export function maxDepthOf(value: unknown): number {
  let deepest = 0;
  const stack: Array<{ node: unknown; depth: number }> = [{ node: value, depth: 0 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (depth > deepest) deepest = depth;
    // Bail early: we only ever compare against a cap, and a hostile document
    // should not cost us a full traversal.
    if (deepest > LIMITS.maxDepth) return deepest;
    if (node === null || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (const child of node) stack.push({ node: child, depth: depth + 1 });
    } else {
      for (const key of Object.keys(node as Record<string, unknown>)) {
        stack.push({ node: (node as Record<string, unknown>)[key], depth: depth + 1 });
      }
    }
  }
  return deepest;
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/** `['panels', 2, 'gridPos', 'w']` -> `panels[2].gridPos.w` */
function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${segment}]`;
    else out += out === '' ? String(segment) : `.${String(segment)}`;
  }
  return out;
}

function codeFor(issue: z.core.$ZodIssue): ValidationCode {
  switch (issue.code) {
    case 'invalid_type':
      return 'wrong_type';
    case 'too_big':
      return typeof issue.origin === 'string' && issue.origin === 'string' ? 'too_long' : 'too_many';
    case 'too_small':
      return 'out_of_range';
    case 'invalid_format':
      return 'invalid_format';
    case 'invalid_value':
    case 'invalid_union':
      return 'unknown_value';
    default:
      return 'invalid_format';
  }
}

/**
 * Messages deliberately never echo the offending VALUE — an error like
 * `Invalid color: "<img src=x>"` round-trips attacker-controlled text into an
 * admin's import dialog. The path and the rule are enough.
 */
function toErrors(issues: ReadonlyArray<z.core.$ZodIssue>): {
  errors: ValidationError[];
  truncated: boolean;
} {
  const errors: ValidationError[] = [];
  for (const issue of issues) {
    if (errors.length >= LIMITS.maxErrors) return { errors, truncated: true };
    errors.push({
      path: formatPath(issue.path),
      code: codeFor(issue),
      message: issue.message,
    });
  }
  return { errors, truncated: false };
}

function fail(error: ValidationError): DashboardValidationResult {
  return { ok: false, errors: [error], truncated: false };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Validate an already-parsed value.
 *
 * Callers holding the raw request body should prefer {@link parseAndValidate},
 * which enforces the byte cap before parsing.
 */
export function validateDashboard(input: unknown): DashboardValidationResult {
  const pre = preflightVersion(input);
  if (!pre.ok) return fail(pre.error);

  // Before anything walks the document — including zod, and including the
  // serializer SvelteKit will later run over it.
  const depth = maxDepthOf(input);
  if (depth > LIMITS.maxDepth) {
    return fail({
      path: '',
      code: 'too_deep',
      message: `Dashboard nests more than ${LIMITS.maxDepth} levels deep`,
    });
  }

  const migrated = migrateModel(input as Record<string, unknown>, pre.version);
  const parsed = DashboardSchema.safeParse(migrated);
  if (!parsed.success) {
    const { errors, truncated } = toErrors(parsed.error.issues);
    return { ok: false, errors, truncated };
  }

  const warnings: ValidationWarning[] = [];
  const model = normalize(parsed.data as Dashboard, warnings);
  return {
    ok: true,
    model,
    warnings,
    referencedInstanceIds: collectInstanceIds(model),
  };
}

/**
 * Validate a raw JSON string.
 *
 * The byte cap here is a backstop, not the control: by the time a string
 * reaches this function the whole body is already in memory. The ROUTE must
 * bound the request first — read `request.text()` (not `.json()`, which leaves
 * no string to measure) and reject on `Buffer.byteLength` before calling this.
 */
export function parseAndValidate(json: string): DashboardValidationResult {
  // Bytes, not `.length` — the latter counts UTF-16 code units and undercounts
  // non-ASCII by up to 4x.
  if (new TextEncoder().encode(json).length > LIMITS.maxPayloadBytes) {
    return fail({
      path: '',
      code: 'too_large',
      message: `Dashboard exceeds the ${LIMITS.maxPayloadBytes} byte limit`,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return fail({
      path: '',
      code: 'malformed_json',
      message: err instanceof Error ? err.message : 'Invalid JSON',
    });
  }
  return validateDashboard(parsed);
}

/**
 * Strip the fields a client must never supply.
 *
 * `uid` and `version` are storage's, not the document's. Accepting them from an
 * import makes it an overwrite primitive (a matching uid silently replaces an
 * existing dashboard) and lets an importer poison optimistic concurrency by
 * claiming whatever version it likes.
 */
export function stripServerOwnedFields(input: unknown): unknown {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return input;
  const { uid: _uid, version: _version, ...rest } = input as Record<string, unknown>;
  return rest;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function normalize(model: Dashboard, warnings: ValidationWarning[]): Dashboard {
  const panels = model.panels.map((panel, i) => normalizePanel(panel, `panels[${i}]`, warnings));

  const seenPanelIds = new Set<string>();
  for (let i = 0; i < panels.length; i++) {
    const panel = panels[i];
    if (seenPanelIds.has(panel.id)) {
      // Renumber rather than reject: a duplicate id is recoverable, and
      // rejecting the document would lose work the user cannot get back.
      let next = 1;
      while (seenPanelIds.has(String(next))) next++;
      warnings.push({
        path: `panels[${i}].id`,
        message: `Duplicate panel id reassigned to "${next}"`,
      });
      panels[i] = { ...panel, id: String(next) };
    }
    seenPanelIds.add(panels[i].id);
  }

  const seenVarNames = new Set<string>();
  const variables: TemplateVariable[] = [];
  for (let i = 0; i < model.variables.length; i++) {
    const variable = model.variables[i];
    if (seenVarNames.has(variable.name)) {
      warnings.push({
        path: `variables[${i}]`,
        message: 'Duplicate variable name dropped',
      });
      continue;
    }
    seenVarNames.add(variable.name);
    variables.push(
      variable.type === 'query' && variable.refresh === undefined
        ? { ...variable, refresh: 'on-dashboard-load' }
        : variable,
    );
  }

  return { ...model, panels, variables };
}

function normalizePanel(panel: Panel, path: string, warnings: ValidationWarning[]): Panel {
  let next = panel;

  // Clamp rather than reject — an off-grid panel is a layout nuisance, not a
  // reason to refuse the document.
  if (panel.gridPos.x + panel.gridPos.w > GRID_COLUMNS) {
    const w = Math.max(1, GRID_COLUMNS - panel.gridPos.x);
    warnings.push({ path: `${path}.gridPos`, message: `Panel extends past the grid; width clamped to ${w}` });
    next = { ...next, gridPos: { ...next.gridPos, w } };
  }

  const seenRefIds = new Set<string>();
  const targets: Target[] = [];
  for (let i = 0; i < next.targets.length; i++) {
    const target = next.targets[i];
    if (seenRefIds.has(target.refId)) {
      warnings.push({ path: `${path}.targets[${i}]`, message: 'Duplicate refId dropped' });
      continue;
    }
    seenRefIds.add(target.refId);
    targets.push(target);
  }
  if (targets.length !== next.targets.length) next = { ...next, targets };

  const thresholds = next.fieldConfig.defaults.thresholds;
  if (thresholds) {
    // Sort rather than reject: the renderer requires base-first-then-ascending,
    // and nothing upstream guarantees it.
    const steps = [...thresholds.steps].sort((a, b) => {
      if (a.value === null) return -1;
      if (b.value === null) return 1;
      return a.value - b.value;
    });
    const wasSorted = steps.every((s, i) => s === thresholds.steps[i]);
    if (!wasSorted) {
      warnings.push({ path: `${path}.fieldConfig.defaults.thresholds`, message: 'Threshold steps reordered' });
    }
    next = {
      ...next,
      fieldConfig: { defaults: { ...next.fieldConfig.defaults, thresholds: { ...thresholds, steps } } },
    };
  }

  const { min, max } = next.fieldConfig.defaults;
  if (min !== undefined && max !== undefined && min > max) {
    warnings.push({ path: `${path}.fieldConfig.defaults`, message: 'min exceeded max; both cleared' });
    const defaults: FieldConfig = { ...next.fieldConfig.defaults };
    delete defaults.min;
    delete defaults.max;
    next = { ...next, fieldConfig: { defaults } };
  }

  return next;
}

/**
 * Every distinct instance id in the document, at all three levels. Returned so
 * a caller cannot authorize the dashboard-level id and miss the panel and
 * target overrides — the levels that have no UI yet, and therefore no test and
 * no reviewer intuition.
 */
function collectInstanceIds(model: Dashboard): Set<string> {
  const ids = new Set<string>();
  if (model.instanceId) ids.add(model.instanceId);
  for (const panel of model.panels) {
    if (panel.instanceId) ids.add(panel.instanceId);
    for (const target of panel.targets) {
      if (target.instanceId) ids.add(target.instanceId);
    }
  }
  for (const variable of model.variables) {
    if (variable.instanceId) ids.add(variable.instanceId);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Compile-time pins
// ---------------------------------------------------------------------------

/**
 * These assertions are the whole reason zod is here rather than a hand-rolled
 * validator. If someone adds a field to an interface in `./model` and forgets
 * the schema — or tightens a schema past what the type allows — `npm run check`
 * fails here instead of the field being silently dropped on every save.
 */
type Eq<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

type _GridPosPinned = Assert<Eq<z.infer<typeof GridPosSchema>, GridPos>>;
type _TargetPinned = Assert<Eq<z.infer<typeof TargetSchema>, Target>>;
type _ValueMappingPinned = Assert<Eq<z.infer<typeof ValueMappingSchema>, ValueMapping>>;
type _FieldConfigPinned = Assert<Eq<z.infer<typeof FieldConfigSchema>, FieldConfig>>;
type _TimeSettingsPinned = Assert<Eq<z.infer<typeof TimeSettingsSchema>, TimeSettings>>;
type _PanelPinned = Assert<Eq<z.infer<typeof PanelSchema>, Panel>>;
type _VariablePinned = Assert<Eq<z.infer<typeof TemplateVariableSchema>, TemplateVariable>>;
type _DashboardPinned = Assert<Eq<z.infer<typeof DashboardSchema>, Dashboard>>;
