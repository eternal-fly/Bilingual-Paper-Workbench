import assert from 'node:assert/strict';

/** API strict output schemas require every object property, including nullable
 * fields. Walk the complete schema so nested notes and array items are checked. */
export function assertStrictOutputSchema(schema, location = '$') {
  if (!schema || typeof schema !== 'object') return;
  if (Array.isArray(schema)) { schema.forEach((value, index) => assertStrictOutputSchema(value, `${location}[${index}]`)); return; }
  if (schema.type === 'object' || schema.properties) {
    assert.equal(schema.additionalProperties, false, `${location} must reject extra properties`);
    assert.ok(Array.isArray(schema.required), `${location} requires an explicit required list`);
    assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties || {}).sort(), `${location} must require every property`);
  }
  for (const [key, value] of Object.entries(schema)) assertStrictOutputSchema(value, `${location}.${key}`);
}
