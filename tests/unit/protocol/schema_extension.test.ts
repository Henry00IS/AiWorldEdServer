/** Unit tests of extension objects, the only schema that tolerates unknown keys. */
import { expect, test } from 'bun:test';
import { schemaValidate, type Schema } from '../../../src/protocol/schema_validator.ts';

const SCHEMA: Schema = { type: 'extension', maxKeys: 2, key: /^[a-z][a-z.]*$/, maxDepth: 2, maxNodes: 5 };

test('well-formed unknown keys are accepted', () => {
  expect(schemaValidate(SCHEMA, { 'studio.build': 'nb', b: { c: 1 } })).toBeNull();
  expect(schemaValidate(SCHEMA, {})).toBeNull();
});

test('non-objects, bad keys and oversized extensions are rejected', () => {
  expect(schemaValidate(SCHEMA, [])).not.toBeNull();
  expect(schemaValidate(SCHEMA, null)).not.toBeNull();
  expect(schemaValidate(SCHEMA, { 'Bad Key': 1 })).not.toBeNull();
  expect(schemaValidate(SCHEMA, { a: 1, b: 2, c: 3 })).not.toBeNull();
  expect(schemaValidate(SCHEMA, { a: { b: { c: { d: 1 } } } })).not.toBeNull();
  expect(schemaValidate(SCHEMA, { a: [1, 2, 3, 4, 5, 6] })).not.toBeNull();
});
