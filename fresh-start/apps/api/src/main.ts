import 'reflect-metadata';
import { loadEnv } from './platform/config/load-env';

loadEnv();

import cookie from '@fastify/cookie';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createLogger, withCorrelation } from '@jobwork/observability';
import { v7 as uuidv7 } from 'uuid';
import { AppModule } from './app.module';
import { ConfigService } from './platform/config/config.service';
import { ProblemFilter } from './platform/http/problem.filter';

/**
 * F-11.2: which hops may name the client in `X-Forwarded-For`. Per-address rate limits
 * are only as true as this: trusting too little makes every browser the web app's proxy;
 * trusting everyone lets a client pick its own address.
 */
function trustProxy(value: string): boolean | string {
  if (value === 'false') return false;
  // A hop count cannot tell a proxy from a client that reached the API directly, and
  // Fastify 5.12 dropped it for that reason (GHSA X-Forwarded-* spoofing): name the hops.
  if (value === 'true' || /^\d+$/.test(value)) {
    throw new Error(`TRUST_PROXY=${value} trusts any peer; name the proxy addresses (e.g. loopback or 10.0.0.0/8)`);
  }
  return value;
}

async function bootstrap(): Promise<void> {
  const logger = createLogger({ service: 'api' });
  const adapter = new FastifyAdapter({ trustProxy: trustProxy(process.env['TRUST_PROXY'] ?? 'loopback') });

  adapter.getInstance().addHook('onRequest', (request, _reply, done) => {
    const incoming = request.headers['x-correlation-id'];
    const correlationId =
      typeof incoming === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(incoming)
        ? incoming
        : uuidv7();
    request.headers['x-correlation-id'] = correlationId;
    withCorrelation({ correlationId }, done);
  });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    logger: false,
    // Webhook signatures are computed over the bytes the provider sent, not our re-serialization.
    rawBody: true,
  });
  const config = app.get(ConfigService);

  await app.register(cookie, { secret: config.env.SESSION_SECRET });
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new ProblemFilter(logger));
  app.enableShutdownHooks();

  await app.listen({ port: config.env.API_PORT, host: '0.0.0.0' });
  logger.info({ port: config.env.API_PORT, version: config.buildVersion }, 'api listening');
}

bootstrap().catch((err) => {
  createLogger({ service: 'api' }).fatal(
    { err: err instanceof Error ? err.message : String(err) },
    'api failed to start',
  );
  process.exit(1);
});
