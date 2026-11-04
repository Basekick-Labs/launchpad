import { describe, expect, it } from 'vitest';
import { formatTopicMapping, parseTopicMapping } from './mqttTopicMapping';

describe('MQTT topic mapping editor', () => {
  it('parses and formats legacy topic = database entries', () => {
    const mapping = parseTopicMapping('sensors/# = sensor_data\nlegacy/topic = otherdb');
    expect(mapping).toEqual({ 'sensors/#': 'sensor_data', 'legacy/topic': 'otherdb' });
    expect(formatTopicMapping(mapping)).toBe('sensors/# = sensor_data\nlegacy/topic = otherdb');
  });

  it('round-trips mixed legacy values and rule objects as JSON', () => {
    const mapping = {
      'factory/+/+/metrics': {
        measurement: 'machine_metrics',
        tags_from_topic: [
          { position: 1, tag_name: 'line' },
          { position: 2, tag_name: 'machine_id' }
        ]
      },
      'legacy/topic': 'otherdb'
    };
    expect(parseTopicMapping(formatTopicMapping(mapping))).toEqual(mapping);
  });

  it('accepts database and measurement overrides in rule objects', () => {
    expect(parseTopicMapping(JSON.stringify({
      'factory/#': { database: 'factory_db', measurement: 'machine_metrics' }
    }))).toEqual({
      'factory/#': { database: 'factory_db', measurement: 'machine_metrics' }
    });
  });

  it('rejects unknown rule fields instead of silently dropping them', () => {
    expect(() => parseTopicMapping('{"factory/#":{"database":"db","unknown":true}}'))
      .toThrow('Unknown rule field "unknown"');
  });

  it('rejects malformed topic-derived tag definitions', () => {
    expect(() => parseTopicMapping('{"factory/#":{"tags_from_topic":[{"position":-1,"tag_name":"line"}]}}'))
      .toThrow('non-negative integer position');
  });

  it('rejects malformed JSON and malformed legacy lines', () => {
    expect(() => parseTopicMapping('{"factory/#":')).toThrow('Invalid topic mapping JSON');
    expect(() => parseTopicMapping('factory/#')).toThrow('must use "topic = database"');
  });

  it('returns an empty mapping for a blank editor', () => {
    expect(parseTopicMapping('  ')).toEqual({});
    expect(formatTopicMapping({})).toBe('');
  });
});
