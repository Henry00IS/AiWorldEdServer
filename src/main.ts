/** Entry point: reads the environment and starts the relay. */
import { configurationFromEnvironment } from './config/server_configuration.ts';
import { collabServerStart } from './server/server_collab.ts';

const configuration = configurationFromEnvironment(process.env);
const server = collabServerStart(configuration);
console.log(
  `aiworlded-server listening on ${configuration.hostname}:${server.port} ` +
    `(proxy secret ${configuration.forwardedSecret ? 'configured' : 'NOT configured: proxied requests will be rejected'}, ` +
    `internal test rooms ${configuration.internalTestRoomsEnabled ? 'enabled' : 'disabled'}` +
    `${configuration.internalTestRoomsViaProxy ? ' (also via proxy)' : ''}, ` +
    `per IP: ${configuration.connectionsPerIp} connections, ${configuration.roomsPerIp} rooms)`,
);

/** Stops the server gracefully on termination signals. */
async function shutdownGracefully(): Promise<void> {
  await server.stop();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdownGracefully());
process.on('SIGINT', () => void shutdownGracefully());
