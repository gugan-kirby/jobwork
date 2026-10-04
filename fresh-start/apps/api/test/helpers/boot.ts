import 'reflect-metadata';
import cookie from '@fastify/cookie';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createLogger, withCorrelation } from '@jobwork/observability';
import { v7 as uuidv7 } from 'uuid';
import { AppModule } from '../../src/app.module';
import { ProblemFilter } from '../../src/platform/http/problem.filter';

/** Boots the real application wiring (mirrors main.ts) against whatever env is set. */
export async function createTestApp(): Promise<{ app: NestFastifyApplication; baseUrl: string }> {
  // Mirrors main.ts's TRUST_PROXY default, so a test can play a client address through
  // X-Forwarded-For the way the web apps' rewrite proxy does.
  const adapter = new FastifyAdapter({ trustProxy: 'loopback' });
  adapter.getInstance().addHook('onRequest', (request, _reply, done) => {
    const correlationId = uuidv7();
    request.headers['x-correlation-id'] = correlationId;
    withCorrelation({ correlationId }, done);
  });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    logger: false,
    abortOnError: false,
    rawBody: true,
  });
  await app.register(cookie, { secret: process.env['SESSION_SECRET'] ?? 'test-secret-value' });
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new ProblemFilter(createLogger({ service: 'api-test', level: 'silent' })));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  return { app, baseUrl };
}
