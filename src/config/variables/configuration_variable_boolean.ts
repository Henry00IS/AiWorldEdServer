/** On/off setting. */
import type { ServerConfiguration } from '../server_configuration.ts';
import {
  ConfigurationVariable,
  type ConfigurationFieldOfType,
  type ConfigurationVariableGroup,
} from './configuration_variable.ts';

/** Accepted spellings of on. */
const CONFIGURATION_BOOLEAN_TRUE = new Set(['true', '1', 'yes', 'on']);
/** Accepted spellings of off. */
const CONFIGURATION_BOOLEAN_FALSE = new Set(['false', '0', 'no', 'off']);

/**
 * Switch such as TRUST_PROXY. Anything but a known spelling is an error, so
 * typos never pass silently.
 */
export class ConfigurationVariableBoolean extends ConfigurationVariable {
  /**
   * Creates the setting.
   *
   * @param name Environment variable name.
   * @param group Documentation group.
   * @param field Configuration field it sets.
   * @param description One sentence for the documentation table.
   */
  constructor(
    name: string,
    group: ConfigurationVariableGroup,
    readonly field: ConfigurationFieldOfType<boolean>,
    description: string,
  ) {
    super(name, group, description);
  }

  /**
   * Stores true for true/1/yes/on and false for false/0/no/off (any case).
   *
   * @param configuration Configuration to update.
   * @param raw Raw text value.
   */
  apply(configuration: ServerConfiguration, raw: string): void {
    const lowered = raw.trim().toLowerCase();
    if (CONFIGURATION_BOOLEAN_TRUE.has(lowered)) configuration[this.field] = true;
    else if (CONFIGURATION_BOOLEAN_FALSE.has(lowered)) configuration[this.field] = false;
    else throw this.invalid('true or false');
  }

  /**
   * Describes the accepted spellings.
   *
   * @returns Accepted values.
   */
  describeAccepted(): string {
    return 'true / false';
  }

  /**
   * Formats the current value.
   *
   * @param configuration Configuration to read.
   * @returns `true` or `false`.
   */
  describeValue(configuration: ServerConfiguration): string {
    return String(configuration[this.field]);
  }
}
