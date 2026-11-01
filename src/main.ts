/**
 * Entry point: loads the configuration, starts the relay and prints a startup
 * summary.
 */
import { configurationLoad } from './config/configuration_load.ts';
import { configurationSummary, configurationWarnings } from './config/configuration_summary.ts';
import { collabServerStart, type CollabServer } from './server/server_collab.ts';

/**
 * Prints one JSON log line.
 *
 * @param record Log record.
 */
function mainLog(record: Record<string, unknown>): void {
  console.log(JSON.stringify(record));
}

/**
 * Prints a startup error as one JSON line and exits with status 1.
 *
 * @param error Thrown value.
 * @returns Never returns.
 */
function mainFail(error: unknown): never {
  mainLog({ event: 'relay.error', message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
}

/**
 * Stops the relay gracefully and exits.
 *
 * @param server Running relay.
 */
async function mainShutdown(server: CollabServer): Promise<void> {
  await server.stop();
  process.exit(0);
}

/**
 * Loads the configuration, starts the relay, logs the summary and warnings, and
 * installs the termination signal handlers.
 */
async function mainStart(): Promise<void> {
  const { configuration, configFile } = await configurationLoad(process.argv.slice(2), process.env);
  const server = collabServerStart(configuration);
  mainLog({ ...configurationSummary(configuration, server.port, configFile) });
  for (const warning of configurationWarnings(configuration)) mainLog({ event: 'relay.warning', message: warning });
  process.on('SIGTERM', () => void mainShutdown(server));
  process.on('SIGINT', () => void mainShutdown(server));
}

await mainStart().catch(mainFail);
