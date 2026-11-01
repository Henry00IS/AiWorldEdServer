/**
 * Prints the relay settings as a Markdown table, grouped like the
 * documentation, with every default. Usage: `bun run config:table`.
 */
import { configurationDefault } from '../src/config/server_configuration.ts';
import type { ConfigurationVariable } from '../src/config/variables/configuration_variable.ts';
import { CONFIGURATION_VARIABLES } from '../src/config/variables/configuration_variable_table.ts';

/**
 * Formats one setting as a table row.
 *
 * @param variable Setting to describe.
 * @returns Markdown table row.
 */
function configurationTableRow(variable: ConfigurationVariable): string {
  const cells = [
    `\`${variable.name}\``,
    variable.group,
    variable.describeValue(configurationDefault()).replaceAll('|', '\\|'),
    variable.describeAccepted().replaceAll('|', '\\|'),
    variable.description.replaceAll('|', '\\|'),
  ];
  return `| ${cells.join(' | ')} |`;
}

/**
 * Builds the whole Markdown table.
 *
 * @returns Table text with a header row.
 */
export function configurationTable(): string {
  const header = ['| Variable | Group | Default | Accepted | Meaning |', '| --- | --- | --- | --- | --- |'];
  return [...header, ...CONFIGURATION_VARIABLES.map(configurationTableRow)].join('\n');
}

if (import.meta.main) console.log(configurationTable());
