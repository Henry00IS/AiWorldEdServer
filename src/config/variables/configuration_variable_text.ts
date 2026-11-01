/** Required text setting checked against a pattern. */
import type { ServerConfiguration } from '../server_configuration.ts';
import {
  ConfigurationVariable,
  type ConfigurationFieldOfType,
  type ConfigurationVariableGroup,
} from './configuration_variable.ts';

/** Text such as the bind address or the WebSocket path. */
export class ConfigurationVariableText extends ConfigurationVariable {
  /**
   * Creates the setting.
   *
   * @param name Environment variable name.
   * @param group Documentation group.
   * @param field Configuration field it sets.
   * @param pattern Pattern the whole value must match.
   * @param patternHint What a valid value looks like, for errors and docs.
   * @param description One sentence for the documentation table.
   */
  constructor(
    name: string,
    group: ConfigurationVariableGroup,
    readonly field: ConfigurationFieldOfType<string>,
    readonly pattern: RegExp,
    readonly patternHint: string,
    description: string,
  ) {
    super(name, group, description);
  }

  /**
   * Stores the trimmed value when it matches the pattern.
   *
   * @param configuration Configuration to update.
   * @param raw Raw text value.
   */
  apply(configuration: ServerConfiguration, raw: string): void {
    const value = raw.trim();
    if (!this.pattern.test(value)) throw this.invalid(this.patternHint);
    configuration[this.field] = value;
  }

  /**
   * Describes valid values.
   *
   * @returns Pattern hint.
   */
  describeAccepted(): string {
    return this.patternHint;
  }

  /**
   * Formats the current value.
   *
   * @param configuration Configuration to read.
   * @returns The value.
   */
  describeValue(configuration: ServerConfiguration): string {
    return configuration[this.field];
  }
}
