import 'reflect-metadata';
import { loadEnv } from './platform/config/load-env';

loadEnv();

import { serve } from '@hono/node-server';
import { createLogger } from '@jobwork/observability';
import { createApplication } from './app';
import { ConfigService } from './platform/config/config.service';

/** The API on Node: the same `fetch` handler a Worker serves (F-CW.2), behind Node's HTTP server. */
async function bootstrap(): Promise<void> {
  const logger = createLogger({ service: 'api' });
  const app = await createApplication({ logger });
  const config = app.get(ConfigService);

  const server = serve(
    {
      fetch: (request, env) => app.handle(request, { remoteAddress: env.incoming.socket.remoteAddress }),
      port: config.env.API_PORT,
      hostname: '0.0.0.0',
    },
    () => logger.info({ port: config.env.API_PORT, version: config.buildVersion }, 'api listening'),
  );

  // Finish in-flight requests, then release the pool and the metrics server (doc 12 §3).
  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'api stopping');
    server.close(() => {
      void app.close().finally(() => process.exit(0));
    });
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

bootstrap().catch((err) => {
  createLogger({ service: 'api' }).fatal(
    { err: err instanceof Error ? err.message : String(err) },
    'api failed to start',
  );
  process.exit(1);
});
