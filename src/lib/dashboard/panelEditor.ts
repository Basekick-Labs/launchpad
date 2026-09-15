/**
 * The panel editor's decisions, separated from its UI.
 *
 * The editor is a large untestable component, so everything with a judgement in
 * it lives here: what an edit requires, what survives a visualisation change,
 * and how a draft becomes the real panel.
 *
 * ## The draft is a COPY; the original is never touched
 *
 * `beginEdit` returns a deep clone and the panel stays where it is. Discard then
 * drops the draft and writes nothing, so it is exact by construction rather than
 * by test — and an abandoned edit cannot dirty the dashboard, which editing in
 * place with a restore snapshot would do the moment the user typed a character.
 *
 * ## The draft runs under its OWN id
 *
 * `queryRunner` keys `generations` and `panelControllers` on `panel.id`, and its
 * `panelControllers.set` overwrites without aborting. Running a draft under the
 * real id therefore fights the grid: a refresh tick calls `cancelPanel(id)` and
 * aborts the preview's query mid-flight, then bumps the generation so the
 * preview's result is dropped as stale. The preview would be permanently blank
 * with nothing logged.
 *
 * `panel.id` is NOT part of the request key, so a prefixed id separates the
 * per-panel bookkeeping while still sharing the cache and the dedupe group with
 * the grid.
 */

import { newPanelId, PANEL_TYPES, type Dashboard, type Panel, type PanelType, type Target } from './model';
import { LIMITS } from './model';
import { panelRequestKeys, type RunContext, type RunPanelOptions } from './queryRunner';
import { hasPanelRenderer } from './panelRegistry';

/** The id a draft queries under. See the module header. */
export function draftRunId(panelId: string): string {
  return `__edit:${panelId}`;
}

/** A deep copy. The model is JSON by construction, so a structured clone is exact. */
export function beginEdit(panel: Panel): Panel {
  return structuredClone(panel);
}

/**
 * Replaces the edited panel, preserving array ORDER.
 *
 * Order is part of the serialized bytes — `serializeForSave` sorts object keys
 * but leaves arrays alone — so appending instead of replacing in place would
 * produce a large spurious diff and defeat the no-op-save check.
 */
export function applyEdit(panels: readonly Panel[], draft: Panel): Panel[] {
  return panels.map((p) => (p.id === draft.id ? draft : p));
}

// ---------------------------------------------------------------------------
// Does this edit need a query?
// ---------------------------------------------------------------------------

export type EditEffect =
  /** The rows will differ. Issue the query. */
  | 'refetch'
  /** Same rows, different normalization (`format` changed). Re-run; the cache answers. */
  | 'renormalize'
  /** Same rows, same frames. Rebuild the options and redraw. */
  | 'redraw';

/**
 * What changing `before` into `after` requires.
 *
 * Built on `panelRequestKeys` rather than a second opinion about what a query
 * depends on: the expanded SQL moves with `panel.interval`, `maxDataPoints`,
 * `timeFrom`, `timeShift`, the dashboard range and `minInterval`, so comparing
 * `target.sql` alone silently misses all six — a user setting "Min interval 5m"
 * would see a preview that never changed and then a saved panel that did.
 *
 * `format` is deliberately outside the request key (the cache stores raw rows and
 * each target normalizes its own frame), so it needs a re-run that the cache
 * answers in ~0ms rather than a network request.
 */
export function editEffect(
  dashboard: Dashboard,
  before: Panel,
  after: Panel,
  ctx: RunContext,
  runOpts: RunPanelOptions = {},
): EditEffect {
  const a = panelRequestKeys(dashboard, before, ctx, runOpts);
  const b = panelRequestKeys(dashboard, after, ctx, runOpts);
  if (a.length !== b.length || a.some((k: string | null, i: number) => k !== b[i])) return 'refetch';

  const formatsBefore = before.targets.map((t) => t.format ?? '');
  const formatsAfter = after.targets.map((t) => t.format ?? '');
  if (formatsBefore.length !== formatsAfter.length) return 'renormalize';
  if (formatsAfter.some((f, i) => f !== formatsBefore[i])) return 'renormalize';

  return 'redraw';
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

/**
 * The next free refId: A, B, C … then A1, B1 once the letters run out.
 *
 * Uniqueness matters more than it looks. A duplicate refId is NOT a save error —
 * `normalizePanel` silently DROPS the duplicate target with a warning, and the
 * page then adopts the server's normalised model. So the user's second query
 * would simply vanish after saving, explained only by "Saved with 1 adjustment".
 */
export function nextRefId(targets: readonly Target[]): string {
  const taken = new Set(targets.map((t) => t.refId));
  for (let round = 0; round < 100; round++) {
    for (let i = 0; i < 26; i++) {
      const id = String.fromCharCode(65 + i) + (round === 0 ? '' : String(round));
      if (!taken.has(id)) return id;
    }
  }
  return newPanelId().slice(0, 16);
}

export function addTarget(panel: Panel): Panel {
  // `LIMITS` exists so the editor can disable "add target" at the cap rather
  // than letting a save fail — its own doc comment says so.
  if (panel.targets.length >= LIMITS.maxTargetsPerPanel) return panel;
  return {
    ...panel,
    targets: [...panel.targets, { refId: nextRefId(panel.targets), sql: '' }],
  };
}

export function removeTarget(panel: Panel, refId: string): Panel {
  // Never leave a panel with zero targets: `createPanel` guarantees one, and the
  // editor would otherwise have nothing to type into.
  if (panel.targets.length <= 1) return panel;
  return { ...panel, targets: panel.targets.filter((t) => t.refId !== refId) };
}

export function duplicateTarget(panel: Panel, refId: string): Panel {
  if (panel.targets.length >= LIMITS.maxTargetsPerPanel) return panel;
  const source = panel.targets.find((t) => t.refId === refId);
  if (!source) return panel;
  // Deep copy: a shallow spread would share nothing mutable today, but a target
  // is free-form enough that it will, and the duplicate-panel path already had
  // this bug.
  const copy = structuredClone(source);
  copy.refId = nextRefId(panel.targets);
  return { ...panel, targets: [...panel.targets, copy] };
}

export function canAddTarget(panel: Panel): boolean {
  return panel.targets.length < LIMITS.maxTargetsPerPanel;
}

// ---------------------------------------------------------------------------
// Changing visualisation
// ---------------------------------------------------------------------------

/**
 * Which panel types can colour an individual VALUE rather than a whole series.
 *
 * `fieldConfig.defaults.color.mode` of `thresholds` or `continuous` is a
 * per-value mode. A stat panel's natural mode is exactly `thresholds`; a time
 * series refuses it outright, because colouring a whole line by one value would
 * be silently wrong. So carrying `color` across that boundary turns a
 * stat → timeseries switch into a panel whose only visible change is a warning
 * banner, which reads as a bug.
 *
 * Lives beside the type list so it cannot drift from it.
 */
const COLORS_PER_VALUE: Record<PanelType, boolean> = {
  timeseries: false,
  barchart: false,
  heatmap: false,
  logs: false,
  table: true,
  stat: true,
  bargauge: true,
};

export function supportsPerValueColor(type: PanelType): boolean {
  return COLORS_PER_VALUE[type] ?? false;
}

/**
 * Switches visualisation type, keeping what still means the same thing.
 *
 * Survives: `title`, `description`, `gridPos`, `targets`, `interval`,
 * `maxDataPoints`, `timeFrom`, `timeShift`, `transparent`, `hideTimeOverride`,
 * `instanceId`, `id`, and the type-neutral half of `fieldConfig.defaults` —
 * `unit`, `decimals`, `min`, `max`, `displayName`, `noValue`, `thresholds`,
 * `mappings`.
 *
 * Reset: `panel.options` and `fieldConfig.defaults.custom`, both genuinely
 * type-specific — `drawStyle` is a time series word, and a stale key would
 * shadow the new type's default rather than being ignored.
 *
 * Dropped conditionally: `color`, when the modes disagree about granularity.
 * Dropping it yields the documented default (`palette-classic-by-name`) rather
 * than a refusal banner.
 *
 * NOTE for when `fieldConfig.overrides` arrives with #36: overrides carry
 * `custom.*` property ids, so they are type-specific and will need filtering
 * here. They do not exist in v1, so there is nothing to do yet.
 */
export function switchPanelType(panel: Panel, type: PanelType): Panel {
  if (panel.type === type) return panel;
  const defaults = { ...panel.fieldConfig.defaults };
  delete defaults.custom;

  if (defaults.color && !modeFitsType(defaults.color.mode, type)) {
    delete defaults.color;
  }

  return {
    ...panel,
    type,
    options: {},
    fieldConfig: { ...panel.fieldConfig, defaults },
  };
}

function modeFitsType(mode: string | undefined, type: PanelType): boolean {
  if (mode !== 'thresholds' && mode !== 'continuous') return true;
  return supportsPerValueColor(type);
}

/** The picker's rows: every type, with the ones that cannot draw yet marked. */
export function visualisationChoices(): Array<{ type: PanelType; available: boolean }> {
  return PANEL_TYPES.map((type) => ({ type, available: hasPanelRenderer(type) }));
}

// ---------------------------------------------------------------------------
// SQL limits
// ---------------------------------------------------------------------------

/**
 * UTF-8 byte length, because that is what the validator measures.
 *
 * `boundedSql` caps at `maxSqlBytes` BYTES, not characters, so a query full of
 * non-ASCII passes a `.length` check and fails on save with a field-path error
 * after the user has built the whole panel.
 */
export function sqlByteLength(sql: string): number {
  let bytes = 0;
  for (let i = 0; i < sql.length; i++) {
    const code = sql.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

export function sqlWithinLimit(sql: string): boolean {
  return sqlByteLength(sql) <= LIMITS.maxSqlBytes;
}

// ---------------------------------------------------------------------------
// Completion hints — no network required
// ---------------------------------------------------------------------------

/**
 * Macro and variable completions.
 *
 * Schema completion (databases, tables, columns) needs a metadata call that does
 * not exist yet and is deferred. This half needs nothing: the macros are a fixed
 * list and the variables are in the document.
 */
export function completionHints(dashboard: Dashboard): Array<{ label: string; detail: string }> {
  const macros = [
    { label: '$__timeFilter(time)', detail: 'Restrict to the dashboard range' },
    { label: '$__timeGroup(time, $__interval)', detail: 'Bucket by the panel interval' },
    { label: '$__interval', detail: 'Bucket width, e.g. 10s' },
    { label: '$__interval_ms', detail: 'Bucket width in milliseconds' },
    { label: '$__timeFrom()', detail: 'Start of the range' },
    { label: '$__timeTo()', detail: 'End of the range' },
  ];
  const variables = dashboard.variables.map((v) => ({
    label: `$${v.name}`,
    detail: `${v.type} variable`,
  }));
  return [...macros, ...variables];
}
