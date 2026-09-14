import type { Dashboard } from './model';
import { LAUNCHPAD_SCHEMA_VERSION } from './model';

/**
 * A dashboard with EVERY optional field set to a value distinguishable from its
 * default.
 *
 * This is the fixture behind the most important test in the suite: validating
 * it must return it unchanged. A "typical" dashboard would pass that test while
 * silently proving nothing, because the fields most likely to be forgotten are
 * exactly the ones a typical dashboard omits.
 *
 * When a field is added to the model, add it here too. If you don't, the
 * round-trip test fails — which is the point.
 */
export function fullyPopulatedDashboard(): Dashboard {
  return {
    launchpadSchemaVersion: LAUNCHPAD_SCHEMA_VERSION,
    title: 'Fully populated',
    description: 'Every optional field set to a non-default value',
    tags: ['production', 'arc'],
    instanceId: 'inst-dashboard',
    time: {
      from: 'now-12h',
      to: 'now-1h',
      timezone: 'America/Costa_Rica',
      refresh: '30s',
      nowDelay: '30s',
      weekStart: 'sunday',
    },
    graphTooltip: 2,
    minInterval: '10s',
    variables: [
      {
        name: 'host',
        type: 'query',
        label: 'Host',
        description: 'Which host to chart',
        hide: 'label',
        query: "SELECT DISTINCT host FROM metrics WHERE $__timeFilter(time)",
        current: [{ text: 'web-1', value: 'web-1' }],
        multi: true,
        includeAll: true,
        allValue: 'ALL_HOSTS',
        refresh: 'on-time-range-change',
        sort: 'alpha-asc',
        instanceId: 'inst-variable',
        auto: true,
        autoCount: 30,
        autoMin: '10s',
      },
      {
        name: 'bucket',
        type: 'interval',
        query: '1m,5m,1h',
      },
    ],
    panels: [
      {
        id: 'panel-a',
        type: 'timeseries',
        title: 'CPU',
        description: 'CPU by host',
        gridPos: { x: 0, y: 0, w: 12, h: 8 },
        targets: [
          {
            refId: 'A',
            sql: 'SELECT $__timeGroup(time, $__interval) AS t, avg(cpu) FROM metrics GROUP BY t',
            instanceId: 'inst-target',
            database: 'metrics_db',
            format: 'time_series',
            hide: false,
          },
        ],
        fieldConfig: {
          defaults: {
            unit: 'percent',
            decimals: 2,
            min: 0,
            max: 100,
            displayName: 'CPU %',
            noValue: 'no data',
            color: { mode: 'palette-classic-by-name', scheme: 'classic' },
            thresholds: {
              mode: 'absolute',
              steps: [
                { value: null, color: 'green' },
                { value: 80, color: 'semi-dark-orange' },
                { value: 95, color: '#ff0000' },
              ],
            },
            mappings: [
              { type: 'value', value: '0', result: { text: 'idle', color: 'blue' } },
              { type: 'range', from: 1, to: 50, result: { text: 'low' } },
              { type: 'special', match: 'null', result: { text: 'N/A' } },
            ],
            custom: { lineWidth: 2, fillOpacity: 10 },
          },
        },
        options: { legend: { displayMode: 'table', placement: 'bottom' } },
        instanceId: 'inst-panel',
        transparent: true,
        interval: '1m',
        maxDataPoints: 1200,
        timeFrom: 'now-7d',
        timeShift: '1d',
        hideTimeOverride: true,
      },
      {
        id: 'panel-b',
        type: 'stat',
        title: '',
        gridPos: { x: 12, y: 0, w: 12, h: 8 },
        targets: [{ refId: 'A', sql: '' }],
        fieldConfig: { defaults: { color: { mode: 'fixed', fixedColor: 'rgba(10, 20, 30, 0.5)' } } },
        options: {},
      },
    ],
  };
}
