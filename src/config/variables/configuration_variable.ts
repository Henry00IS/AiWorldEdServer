/**
 * Base class of one documented relay setting read from the environment or the
 * config file.
 */
import type { ServerConfiguration } from '../server_configuration.ts';

/** Names of the configuration fields whose type is exactly `Value`. */
export type ConfigurationFieldOfType<Value> = {
  [Field in keyof ServerConfiguration]: [ServerConfiguration[Field]] extends [Value]
    ? [Value] extends [ServerConfiguration[Field]]
      ? Field
      : never
    : never;
}[keyof ServerConfiguration];

/** Group a setting is listed under in the documentation and the startup summary. */
export type ConfigurationVariableGroup = 'network' | 'security' | 'rooms' | 'limits' | 'testing';

/**
 * One setting: its environment variable name, the field it sets and how a raw
 * text value is validated.
 */
export abstract class ConfigurationVariable {
  /**
   * Creates the setting.
   *
   * @param name Environment variable name, also the key in the config file.
   * @param group Documentation group.
   * @param description One sentence for the documentation table.
   */
  constructor(
    readonly name: string,
    readonly group: ConfigurationVariableGroup,
    readonly description: string,
  ) {}

  /**
   * Validates a raw value and stores it in the configuration.
   *
   * @param configuration Configuration to update.
   * @param raw Raw text value, never empty.
   */
  abstract apply(configuration: ServerConfiguration, raw: string): void;

  /**
   * Describes the accepted values for the documentation table.
   *
   * @returns Short human-readable description of valid values.
   */
  abstract describeAccepted(): string;

  /**
   * Formats the current value for the documentation table and the startup
   * summary.
   *
   * @param configuration Configuration to read.
   * @returns Displayable value; secrets are never shown.
   */
  abstract describeValue(configuration: ServerConfiguration): string;

  /**
   * Builds the error thrown for an invalid value.
   *
   * @param expectation What a valid value looks like.
   * @returns Error naming this variable.
   */
  protected invalid(expectation: string): Error {
    return new Error(`${this.name} must be ${expectation}`);
  }
}
