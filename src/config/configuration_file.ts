/**
 * Optional JSON config file. Its keys are the environment variable names, so
 * the documentation lists every setting once.
 */
import { CONFIGURATION_VARIABLES_BY_NAME } from './variables/configuration_variable_table.ts';

/** Raw setting values by variable name. */
export type ConfigurationValues = Readonly<Record<string, string | undefined>>;

/**
 * Parses config file text into raw setting values. Numbers and booleans are
 * accepted as JSON values, lists as arrays of strings.
 *
 * @param text File contents.
 * @param source File path, used in error messages.
 * @returns Raw values by variable name.
 */
export function configurationFileParse(text: string, source: string): ConfigurationValues {
  const parsed: unknown = configurationFileJson(text, source);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error(`${source}: the config file must be a JSON object`);
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) values[name] = configurationFileValue(name, value, source);
  return values;
}

/**
 * Parses JSON with an error that names the file.
 *
 * @param text File contents.
 * @param source File path.
 * @returns Parsed JSON value.
 */
function configurationFileJson(text: string, source: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${source}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
}

/**
 * Converts one config file entry into the text form of an environment value.
 *
 * @param name Key in the file.
 * @param value JSON value.
 * @param source File path.
 * @returns Raw text value.
 */
function configurationFileValue(name: string, value: unknown, source: string): string {
  if (!CONFIGURATION_VARIABLES_BY_NAME.has(name)) throw new Error(`${source}: unknown setting "${name}"`);
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return value.join(',');
  throw new Error(`${source}: ${name} must be a string, number, boolean or list of strings`);
}

/**
 * Reads and parses a config file.
 *
 * @param path File path.
 * @returns Raw values by variable name.
 */
export async function configurationFileRead(path: string): Promise<ConfigurationValues> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`config file not found: ${path}`);
  return configurationFileParse(await file.text(), path);
}

/**
 * Finds the config file path: `--config <path>`, `--config=<path>`, else
 * CONFIG_FILE.
 *
 * @param commandLine Command line arguments after the program name.
 * @param environment Environment variables.
 * @returns Path, or null when no config file is used.
 */
export function configurationFilePath(commandLine: readonly string[], environment: ConfigurationValues): string | null {
  const flagIndex = commandLine.indexOf('--config');
  if (flagIndex >= 0) return commandLine[flagIndex + 1] ?? configurationFileFlagMissing();
  const inline = commandLine.find((argument) => argument.startsWith('--config='));
  if (inline !== undefined) return inline.slice('--config='.length) || configurationFileFlagMissing();
  return environment['CONFIG_FILE'] || null;
}

/**
 * Throws for a `--config` flag without a path.
 *
 * @returns Never returns.
 */
function configurationFileFlagMissing(): never {
  throw new Error('--config needs a file path');
}
