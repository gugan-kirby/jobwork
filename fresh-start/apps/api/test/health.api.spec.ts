import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { healthResponseSchema } from '@jobwork/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';

describe('GET /api/v1/health', () => {
  let app: NestFastifyApplication;
  let baseUrl: string;

  beforeAll(async () => {
    process.env['SESSION_SECRET'] = 'test-secret-value';
    process.env['NODE_ENV'] = 'test';
    process.env['DATABASE_URL'] =
      process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/jobwork_dev';
    app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
      logger: false,
    });
    app.setGlobalPrefix('api/v1');
    await app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns ok with db reachable and a valid contract shape', async () => {
    const res = await fetch(`${baseUrl.replace('[::1]', '127.0.0.1')}/api/v1/health`);
    expect(res.status).toBe(200);
    const body = healthResponseSchema.parse(await res.json());
    expect(body.db).toBe('ok');
    expect(body.status).toBe('ok');
  });
});
