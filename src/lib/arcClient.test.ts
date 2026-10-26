import { describe, expect, it } from 'vitest';
import {
	continuousQueryDefinition,
	continuousQueryEditFields,
	retentionPolicyEditFields,
	type ContinuousQuery
} from './arcClient';

describe('continuousQueryEditFields (Arc #93)', () => {
	// Arc 27.01.1 preserves omitted values on PUT, so a cleared field must be sent as null.
	it('sends null for optional fields cleared in the edit form', () => {
		expect(continuousQueryEditFields('', null, null)).toEqual({
			description: null,
			retention_days: null,
			delete_source_after_days: null
		});
	});

	it('preserves non-empty edit values', () => {
		expect(continuousQueryEditFields('  hourly rollup  ', 30, 7)).toEqual({
			description: 'hourly rollup',
			retention_days: 30,
			delete_source_after_days: 7
		});
	});
});

describe('retentionPolicyEditFields (Arc #93)', () => {
	it('sends null when the edit form switches to all measurements', () => {
		expect(retentionPolicyEditFields('')).toEqual({ measurement: null });
	});

	it('preserves a selected measurement', () => {
		expect(retentionPolicyEditFields('cpu')).toEqual({ measurement: 'cpu' });
	});
});

/**
 * Older Arc versions require key definition fields on PUT. The toggle helper
 * sends the stored definition for compatibility with those versions.
 */
describe('continuousQueryDefinition', () => {
	const stored: ContinuousQuery = {
		id: 7,
		name: 'downsample-cpu',
		description: 'hourly rollup',
		database: 'default',
		source_measurement: 'cpu',
		destination_measurement: 'cpu_1h',
		query: 'SELECT avg(usage) FROM default.cpu WHERE time >= {start_time} AND time < {end_time}',
		interval: '1h',
		tag_columns: ['host'],
		retention_days: 365,
		delete_source_after_days: 7,
		is_active: true,
		created_at: '2026-10-01T00:00:00Z',
		updated_at: '2026-10-01T00:00:00Z'
	};

	it('carries every field Arc requires', () => {
		const body = continuousQueryDefinition(stored);

		expect(body.name).toBe('downsample-cpu');
		expect(body.database).toBe('default');
		expect(body.source_measurement).toBe('cpu');
		expect(body.destination_measurement).toBe('cpu_1h');
		expect(body.query).toBe(stored.query);
		expect(body.interval).toBe('1h');
	});

	it('carries the fields Arc overwrites without requiring', () => {
		const body = continuousQueryDefinition(stored);

		expect(body.description).toBe('hourly rollup');
		expect(body.tag_columns).toEqual(['host']);
		expect(body.retention_days).toBe(365);
		expect(body.delete_source_after_days).toBe(7);
		expect(body.is_active).toBe(true);
	});

	it('survives a flipped is_active without losing the rest', () => {
		const body = { ...continuousQueryDefinition(stored), is_active: !stored.is_active };

		expect(body.is_active).toBe(false);
		expect(body.source_measurement).toBe('cpu');
		expect(body.tag_columns).toEqual(['host']);
	});

	it('omits the optional fields a query does not have rather than sending null', () => {
		const bare: ContinuousQuery = {
			...stored,
			description: null,
			tag_columns: null,
			retention_days: null,
			delete_source_after_days: null
		};

		const body = continuousQueryDefinition(bare);

		expect('description' in body).toBe(false);
		expect('tag_columns' in body).toBe(false);
		expect('retention_days' in body).toBe(false);
		expect('delete_source_after_days' in body).toBe(false);
		expect(body.name).toBe('downsample-cpu');
	});
});
