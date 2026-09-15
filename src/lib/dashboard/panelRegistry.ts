/**
 * Panel renderers, loaded on demand.
 *
 * This is what keeps uPlot (~45KB) and every future chart library out of the
 * dashboard page's route chunk. Measured before this existed: the `/d/[uid]`
 * node chunk was 84 KB with no uPlot reference — uPlot lived only in the
 * instance-console chunk, which imports `MetricChart` statically. A static
 * import of a panel here would have moved it.
 *
 * ## Every value must stay a bare `() => import(...)`
 *
 * That is the whole mechanism. Hoisting the import into a variable, awaiting one
 * at module scope, or building the map from a loop over paths all collapse the
 * split — and they collapse it SILENTLY: the build still succeeds and the chunk
 * just gets bigger. If you change this file, re-check the build output.
 *
 * `Partial` on purpose: six of the seven panel types do not exist yet, and a
 * total `Record` would not compile until they all do. `loadPanel` returning null
 * for a miss is what the page renders "unsupported panel type" from.
 */

import type { PanelType } from './model';

/** A Svelte component constructor. Typed loosely to avoid importing svelte here. */
export type PanelComponent = unknown;

type Loader = () => Promise<{ default: PanelComponent }>;

const REGISTRY: Partial<Record<PanelType, Loader>> = {
  timeseries: () => import('../components/dashboard/panels/TimeSeriesPanel.svelte'),
};

/** True when a type has a renderer, without loading it. */
export function hasPanelRenderer(type: PanelType): boolean {
  return type in REGISTRY;
}

/** The component for a panel type, or null when nothing renders it yet. */
export async function loadPanel(type: PanelType): Promise<PanelComponent | null> {
  const loader = REGISTRY[type];
  if (!loader) return null;
  try {
    return (await loader()).default;
  } catch (err) {
    // A chunk that fails to load must not take the dashboard down with it — the
    // page shows the panel as unsupported and its neighbours keep rendering.
    console.error(`Failed to load the "${type}" panel renderer:`, err);
    return null;
  }
}

/** The types that currently have a renderer. For tests and the panel editor. */
export function renderablePanelTypes(): PanelType[] {
  return Object.keys(REGISTRY) as PanelType[];
}
