/** Integer setting with an inclusive range. */
import type { ServerConfiguration } from '../server_configuration.ts';
import {
  ConfigurationVariable,
  type ConfigurationFieldOfType,
  type ConfigurationVariableGroup,
} from './configuration_variable.ts';

/** Integer limit such as a connection count, a byte size or a timeout. */
export class ConfigurationVariableInteger extends ConfigurationVariable {
  /**
   * Creates the setting.
   *
   * @param name Environment variable name.
   * @param group Documentation group.
   * @param field Configuration field it sets.
   * @param minimum Smallest accepted value.
   * @param maximum Largest accepted value.
   * @param description One sentence for the documentation table.
   */
  constructor(
    name: string,
    group: ConfigurationVariableGroup,
    readonly field: ConfigurationFieldOfType<number>,
    readonly minimum: number,
    readonly maximum: number,
    description: string,
  ) {
    super(name, group, description);
  }

  /**
   * Stores the value when it is a whole number within the range.
   *
   * @param configuration Configuration to update.
   * @param raw Raw text value.
   */
  apply(configuration: ServerConfiguration, raw: string): void {
    const value = /^-?\d+$/.test(raw.trim()) ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(value) || value < this.minimum || value > this.maximum)
      throw this.invalid(`an integer between ${this.minimum} and ${this.maximum}`);
    configuration[this.field] = value;
  }

  /**
   * Describes the accepted range.
   *
   * @returns Range text.
   */
  describeAccepted(): string {
    return `${this.minimum} to ${this.maximum}`;
  }

  /**
   * Formats the current value.
   *
   * @param configuration Configuration to read.
   * @returns Decimal value.
   */
  describeValue(configuration: ServerConfiguration): string {
    return String(configuration[this.field]);
  }
}
