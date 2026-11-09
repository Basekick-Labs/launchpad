import type { MqttTopicMapping, MqttTopicMappingRule } from './arcClient';

const RULE_KEYS = new Set(['database', 'measurement', 'tags_from_topic']);

/**
 * Keep the compact legacy editor for string-only mappings. When at least one
 * rule object is present, use JSON so every field and mixed value shape can be
 * round-tripped without lossy string coercion.
 */
export function formatTopicMapping(mapping?: MqttTopicMapping): string {
  if (!mapping || Object.keys(mapping).length === 0) return '';

  if (Object.values(mapping).every((value) => typeof value === 'string')) {
    return Object.entries(mapping)
      .map(([topic, database]) => `${topic} = ${database}`)
      .join('\n');
  }

  return JSON.stringify(mapping, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateRule(topic: string, value: unknown): MqttTopicMappingRule {
  if (!isRecord(value)) throw new Error(`Rule for "${topic}" must be a JSON object`);

  for (const key of Object.keys(value)) {
    if (!RULE_KEYS.has(key)) throw new Error(`Unknown rule field "${key}" for topic "${topic}"`);
  }

  if (Object.keys(value).length === 0) throw new Error(`Rule for "${topic}" must contain at least one field`);

  if ('database' in value && (typeof value.database !== 'string' || value.database.trim() === '')) {
    throw new Error(`Rule database for "${topic}" must be a non-empty string`);
  }
  if ('measurement' in value && (typeof value.measurement !== 'string' || value.measurement.trim() === '')) {
    throw new Error(`Rule measurement for "${topic}" must be a non-empty string`);
  }
  if ('tags_from_topic' in value) {
    if (!Array.isArray(value.tags_from_topic)) {
      throw new Error(`tags_from_topic for "${topic}" must be an array`);
    }
    if (value.tags_from_topic.length === 0) {
      throw new Error(`tags_from_topic for "${topic}" must list at least one tag`);
    }
    value.tags_from_topic.forEach((item, index) => {
      if (!isRecord(item) || !Number.isInteger(item.position) || (item.position as number) < 0 ||
          typeof item.tag_name !== 'string' || item.tag_name.trim() === '' ||
          Object.keys(item).some((key) => key !== 'position' && key !== 'tag_name')) {
        throw new Error(`tags_from_topic item ${index + 1} for "${topic}" needs a non-negative integer position and a tag_name`);
      }
    });
  }

  return value as MqttTopicMappingRule;
}

function validateMapping(value: unknown): MqttTopicMapping {
  if (!isRecord(value)) throw new Error('Topic mapping must be a JSON object keyed by MQTT topic filters');

  const mapping: MqttTopicMapping = {};
  for (const [topic, entry] of Object.entries(value)) {
    if (!topic.trim()) throw new Error('Topic mapping keys cannot be empty');
    if (typeof entry === 'string') {
      if (!entry.trim()) throw new Error(`Database for topic "${topic}" must be a non-empty string`);
      mapping[topic] = entry;
    } else {
      mapping[topic] = validateRule(topic, entry);
    }
  }
  return mapping;
}

/** Parse either the legacy one-rule-per-line syntax or the complete JSON map. */
export function parseTopicMapping(raw: string): MqttTopicMapping {
  const input = raw.trim();
  if (!input) return {};

  const lines = input.split('\n').map((line) => line.trim()).filter(Boolean);

  if (input.startsWith('{')) {
    let parsed: unknown;
    let jsonError: string | undefined;
    try {
      parsed = JSON.parse(input);
    } catch (error) {
      jsonError = error instanceof Error ? error.message : 'invalid JSON';
    }
    if (jsonError === undefined) return validateMapping(parsed);
    // A legacy topic can itself start with '{' ("{site}/temp = db"). Text that
    // isn't JSON but has an '=' on every line is the line format.
    if (!lines.every((line) => line.includes('='))) {
      throw new Error(`Invalid topic mapping JSON: ${jsonError}`);
    }
  }

  const mapping: MqttTopicMapping = {};
  for (const [index, line] of lines.entries()) {
    const delimiter = line.lastIndexOf('=');
    if (delimiter < 0) throw new Error(`Topic mapping line ${index + 1} must use "topic = database"`);
    const topic = line.slice(0, delimiter).trim();
    const database = line.slice(delimiter + 1).trim();
    if (!topic || !database) throw new Error(`Topic mapping line ${index + 1} needs both a topic and database`);
    mapping[topic] = database;
  }
  return mapping;
}

/**
 * The topic_mapping to send when updating a subscription: undefined when the
 * editor text is unchanged, so Arc keeps the stored mapping as is (#97), and
 * {} when the user cleared it. Throws on invalid input, like parseTopicMapping.
 */
export function topicMappingForUpdate(original: string, current: string): MqttTopicMapping | undefined {
  if (current === original) return undefined;
  return parseTopicMapping(current);
}
