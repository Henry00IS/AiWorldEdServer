/** Comma separated list setting. */
import type { ServerConfiguration } from '../server_configuration.ts';
import {
  ConfigurationVariable,
  type ConfigurationFieldOfType,
  type ConfigurationVariableGroup,
} from './configuration_variable.ts';

/** List such as ALLOWED_ORIGINS, where every entry is checked against a pattern. */
export class ConfigurationVariableList extends ConfigurationVariable {
  /**
   * Creates the setting.
   *
   * @param name Environment variable name.
   * @param group Documentation group.
   * @param field Configuration field it sets.
   * @param entryPattern Pattern each entry must match.
   * @param entryHint What a valid entry looks like.
   * @param description One sentence for the documentation table.
   */
  constructor(
    name: string,
    group: ConfigurationVariableGroup,
    readonly field: ConfigurationFieldOfType<string[]>,
    readonly entryPattern: RegExp,
    readonly entryHint: string,
    description: string,
  ) {
    super(name, group, description);
  }

  /**
   * Splits the value at commas and stores the trimmed, non-empty entries.
   *
   * @param configuration Configuration to update.
   * @param raw Raw comma separated value.
   */
  apply(configuration: ServerConfiguration, raw: string): void {
    const entries = raw
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (entries.length === 0) throw this.invalid('a comma separated list');
    const badEntry = entries.find((entry) => !this.entryPattern.test(entry));
    if (badEntry !== undefined) throw this.invalid(`a comma separated list of ${this.entryHint} (got "${badEntry}")`);
    configuration[this.field] = entries;
  }

  /**
   * Describes valid entries.
   *
   * @returns Entry hint.
   */
  describeAccepted(): string {
    return `comma separated ${this.entryHint}`;
  }

  /**
   * Formats the current entries.
   *
   * @param configuration Configuration to read.
   * @returns Entries joined with commas.
   */
  describeValue(configuration: ServerConfiguration): string {
    return configuration[this.field].join(',');
  }
}
