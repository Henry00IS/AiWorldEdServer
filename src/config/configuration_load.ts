/**
 * Builds the effective configuration from defaults, the config file and the
 * environment.
 */
import { configurationFilePath, configurationFileRead, type ConfigurationValues } from './configuration_file.ts';
import { configurationValidate } from './configuration_validation.ts';
import { configurationDefault, type ServerConfiguration } from './server_configuration.ts';
import { CONFIGURATION_VARIABLES } from './variables/configuration_variable_table.ts';

/** Effective configuration plus where it came from. */
export interface ConfigurationLoaded {
  readonly configuration: ServerConfiguration;
  /** Config file that was read, or null. */
  readonly configFile: string | null;
}

/**
 * Applies the config file values, then the environment (which wins), on top of
 * the defaults, and checks the result. Empty values count as unset.
 *
 * @param environment Environment variables.
 * @param fileValues Values from the config file.
 * @returns Validated configuration.
 */
export function configurationFromEnvironment(
  environment: ConfigurationValues,
  fileValues: ConfigurationValues = {},
): ServerConfiguration {
  const configuration = configurationDefault();
  for (const variable of CONFIGURATION_VARIABLES) {
    const raw = environment[variable.name] || fileValues[variable.name];
    if (raw) variable.apply(configuration, raw);
  }
  configurationValidate(configuration);
  return configuration;
}

/**
 * Loads the configuration for the running process.
 *
 * @param commandLine Command line arguments after the program name.
 * @param environment Environment variables.
 * @returns Validated configuration and the config file used.
 */
export async function configurationLoad(
  commandLine: readonly string[],
  environment: ConfigurationValues,
): Promise<ConfigurationLoaded> {
  const configFile = configurationFilePath(commandLine, environment);
  const fileValues = configFile === null ? {} : await configurationFileRead(configFile);
  return { configuration: configurationFromEnvironment(environment, fileValues), configFile };
}
