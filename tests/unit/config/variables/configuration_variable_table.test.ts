/**
 * Every documented setting validates its range and is listed in the
 * self-hosting guide.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { configurationDefault } from '../../../../src/config/server_configuration.ts';
import { ConfigurationVariableInteger } from '../../../../src/config/variables/configuration_variable_integer.ts';
import { CONFIGURATION_VARIABLES } from '../../../../src/config/variables/configuration_variable_table.ts';

/** Integer settings only. */
const INTEGER_VARIABLES = CONFIGURATION_VARIABLES.filter(
  (variable): variable is ConfigurationVariableInteger => variable instanceof ConfigurationVariableInteger,
);

describe('configuration variable table', () => {
  test('setting names are unique', () => {
    const names = CONFIGURATION_VARIABLES.map((variable) => variable.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test('every integer setting accepts its bounds and rejects values just outside them and fractions', () => {
    for (const variable of INTEGER_VARIABLES) {
      const configuration = configurationDefault();
      variable.apply(configuration, String(variable.minimum));
      variable.apply(configuration, String(variable.maximum));
      expect(configuration[variable.field]).toBe(variable.maximum);
      expect(() => variable.apply(configuration, String(variable.minimum - 1))).toThrow(variable.name);
      expect(() => variable.apply(configuration, String(variable.maximum + 1))).toThrow(variable.name);
      expect(() => variable.apply(configuration, '1.5')).toThrow(variable.name);
    }
  });

  test('every integer default lies within its documented range', () => {
    const defaults = configurationDefault();
    for (const variable of INTEGER_VARIABLES) {
      expect(defaults[variable.field]).toBeGreaterThanOrEqual(variable.minimum);
      expect(defaults[variable.field]).toBeLessThanOrEqual(variable.maximum);
    }
  });

  test('docs/SELF_HOSTING.md documents every setting', async () => {
    const guide = await Bun.file(join(import.meta.dir, '../../../../docs/SELF_HOSTING.md')).text();
    const missing = CONFIGURATION_VARIABLES.filter((variable) => !guide.includes(`\`${variable.name}\``));
    expect(missing.map((variable) => variable.name)).toEqual([]);
  });
});
