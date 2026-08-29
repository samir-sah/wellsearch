import { pathToFileURL } from 'node:url';
import { createApp } from './app.js';
import { config, describeConfig } from './config/config.js';
import { logger } from './utils/logger.js';
import { createServices } from './services.js';

export async function startServer({
  serverConfig = config,
  serverLogger = logger,
  services: suppliedServices,
} = {}) {
  const services = suppliedServices ?? await createServices({
    config: serverConfig,
    logger: serverLogger,
  });
  const app = createApp({ services });

  const server = await new Promise((resolve, reject) => {
    const listeningServer = app.listen(serverConfig.port, serverConfig.host, () => resolve(listeningServer));
    listeningServer.once('error', reject);
  }).catch(async (error) => {
    if (!suppliedServices) await services.close().catch(() => {});
    throw error;
  });

  server.requestTimeout = serverConfig.server.requestTimeoutMs;
  server.headersTimeout = serverConfig.server.headersTimeoutMs;
  server.keepAliveTimeout = serverConfig.server.keepAliveTimeoutMs;
  server.maxRequestsPerSocket = 1_000;

  const address = server.address();
  serverLogger.info('server listening', {
    ...describeConfig(serverConfig),
    host: serverConfig.host,
    port: typeof address === 'object' && address ? address.port : serverConfig.port,
  });
  let shutdownPromise;
  async function close(reason = 'shutdown') {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      serverLogger.info('shutting down', { reason });
      const forceClose = setTimeout(() => server.closeAllConnections?.(), serverConfig.server.shutdownTimeoutMs);
      forceClose.unref?.();
      try {
        await new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeIdleConnections?.();
        });
      } finally {
        clearTimeout(forceClose);
      }
      await services.close();
      serverLogger.info('shutdown complete');
    })();
    return shutdownPromise;
  }

  return { app, server, services, close };
}

async function main() {
  const running = await startServer();
  let stopping = false;

  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    running.close(signal).then(
      () => { process.exitCode = 0; },
      (error) => {
        logger.error('shutdown failed', { error });
        process.exitCode = 1;
      },
    );
  };

  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));
}

const isEntrypoint = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  main().catch((error) => {
    logger.error('server startup failed', { error });
    process.exitCode = 1;
  });
}
