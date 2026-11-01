/** Optional text setting (a secret or a file path) that is unset by default. */
import type { ServerConfiguration } from '../server_configuration.ts';
import {
  ConfigurationVariable,
  type ConfigurationFieldOfType,
  type ConfigurationVariableGroup,
} from './configuration_variable.ts';

/**
 * Optional value such as FORWARDED_SECRET or TLS_CERT; secrets are never
 * displayed.
 */
export class ConfigurationVariableOptionalText extends ConfigurationVariable {
  /**
   * Creates the setting.
   *
   * @param name Environment variable name.
   * @param group Documentation group.
   * @param field Configuration field it sets.
   * @param minimumLength Shortest accepted value.
   * @param secret Whether the value is hidden in summaries.
   * @param description One sentence for the documentation table.
   */
  constructor(
    name: string,
    group: ConfigurationVariableGroup,
    readonly field: ConfigurationFieldOfType<string | null>,
    readonly minimumLength: number,
    readonly secret: boolean,
    description: string,
  ) {
    super(name, group, description);
  }

  /**
   * Stores the value when it is long enough.
   *
   * @param configuration Configuration to update.
   * @param raw Raw text value.
   */
  apply(configuration: ServerConfiguration, raw: string): void {
    if (raw.length < this.minimumLength) throw this.invalid(`at least ${this.minimumLength} characters`);
    configuration[this.field] = raw;
  }

  /**
   * Describes valid values.
   *
   * @returns Length requirement or `path`.
   */
  describeAccepted(): string {
    return this.secret ? `at least ${this.minimumLength} characters` : 'file path';
  }

  /**
   * Formats the current value without revealing secrets.
   *
   * @param configuration Configuration to read.
   * @returns `unset`, `set` for secrets, or the path.
   */
  describeValue(configuration: ServerConfiguration): string {
    const value = configuration[this.field];
    if (value === null) return 'unset';
    return this.secret ? 'set' : value;
  }
}
