/**
 * Minimal, allocation-light structural validator for decoded JSON messages.
 * Objects are closed: unknown keys are rejected.
 */

/** Structural schema node. */
export type Schema =
  | { type: 'string'; min: number; max: number; pattern?: RegExp }
  | { type: 'int'; min: number; max: number }
  | { type: 'bool' }
  | { type: 'literal'; value: string | number | boolean }
  | { type: 'enum'; values: readonly string[] }
  | { type: 'array'; items: Schema; min: number; max: number }
  | { type: 'object'; required: Record<string, Schema>; optional?: Record<string, Schema> }
  | { type: 'opaque'; maxDepth: number; maxNodes: number };

/**
 * Validates a value against a schema.
 *
 * @param schema Schema to check against.
 * @param value Decoded JSON value.
 * @param path Path used in the returned error description.
 * @returns Null when valid, otherwise a short description of the first problem.
 */
export function schemaValidate(schema: Schema, value: unknown, path = '$'): string | null {
  switch (schema.type) {
    case 'string':
      return schemaValidateString(schema, value, path);
    case 'int':
      return Number.isSafeInteger(value) && (value as number) >= schema.min && (value as number) <= schema.max ? null : `${path}: int`;
    case 'bool':
      return typeof value === 'boolean' ? null : `${path}: bool`;
    case 'literal':
      return value === schema.value ? null : `${path}: literal`;
    case 'enum':
      return typeof value === 'string' && schema.values.includes(value) ? null : `${path}: enum`;
    case 'array':
      return schemaValidateArray(schema, value, path);
    case 'object':
      return schemaValidateObject(schema, value, path);
    case 'opaque':
      return schemaOpaqueWithinBounds(value, schema.maxDepth, { remaining: schema.maxNodes }) ? null : `${path}: opaque too deep or large`;
  }
}

/**
 * @param schema String schema.
 * @param value Candidate value.
 * @param path Error path.
 * @returns Null when valid, otherwise an error description.
 */
function schemaValidateString(schema: Extract<Schema, { type: 'string' }>, value: unknown, path: string): string | null {
  if (typeof value !== 'string') return `${path}: string`;
  if (value.length < schema.min || value.length > schema.max) return `${path}: length`;
  if (schema.pattern && !schema.pattern.test(value)) return `${path}: pattern`;
  return null;
}

/**
 * @param schema Array schema.
 * @param value Candidate value.
 * @param path Error path.
 * @returns Null when valid, otherwise an error description.
 */
function schemaValidateArray(schema: Extract<Schema, { type: 'array' }>, value: unknown, path: string): string | null {
  if (!Array.isArray(value)) return `${path}: array`;
  if (value.length < schema.min || value.length > schema.max) return `${path}: array length`;
  for (let index = 0; index < value.length; index++) {
    const error = schemaValidate(schema.items, value[index], `${path}[${index}]`);
    if (error) return error;
  }
  return null;
}

/**
 * @param schema Object schema.
 * @param value Candidate value.
 * @param path Error path.
 * @returns Null when valid, otherwise an error description.
 */
function schemaValidateObject(schema: Extract<Schema, { type: 'object' }>, value: unknown, path: string): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return `${path}: object`;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!Object.hasOwn(schema.required, key) && !(schema.optional && Object.hasOwn(schema.optional, key))) return `${path}.${key}: unknown field`;
  }
  for (const [key, child] of Object.entries(schema.required)) {
    if (!Object.hasOwn(record, key)) return `${path}.${key}: missing`;
    const error = schemaValidate(child, record[key], `${path}.${key}`);
    if (error) return error;
  }
  return schemaValidateOptionalFields(schema.optional, record, path);
}

/**
 * @param optional Optional field schemas.
 * @param record Object being validated.
 * @param path Error path.
 * @returns Null when valid, otherwise an error description.
 */
function schemaValidateOptionalFields(optional: Record<string, Schema> | undefined, record: Record<string, unknown>, path: string): string | null {
  if (!optional) return null;
  for (const [key, child] of Object.entries(optional)) {
    if (!Object.hasOwn(record, key)) continue;
    const error = schemaValidate(child, record[key], `${path}.${key}`);
    if (error) return error;
  }
  return null;
}

/**
 * Bounds depth and node count of an opaque JSON value.
 *
 * @param value Decoded JSON value.
 * @param depthRemaining Remaining nesting depth.
 * @param budget Shared node budget, decremented per visited node.
 * @returns True when within bounds.
 */
function schemaOpaqueWithinBounds(value: unknown, depthRemaining: number, budget: { remaining: number }): boolean {
  if (--budget.remaining < 0) return false;
  if (typeof value !== 'object' || value === null) return true;
  if (depthRemaining <= 0) return false;
  const children = Array.isArray(value) ? value : Object.values(value);
  for (const child of children) {
    if (!schemaOpaqueWithinBounds(child, depthRemaining - 1, budget)) return false;
  }
  return true;
}
