import 'reflect-metadata';
import type { ArgumentsHost } from '@nestjs/common';
import { createLogger, type Logger } from '@jobwork/observability';
import { AppModule } from './app.module';
import { ConfigService } from './platform/config/config.service';
import { POOL_SOURCE, type PoolSource } from './platform/database/pool-source';
import { ProblemFilter } from './platform/http/problem.filter';
import { Container, type Token } from './runtime/container';
import { Reflector } from './runtime/reflector';
import { createHttpHandler, RuntimeAdapterHost, type FetchHandler } from './runtime/http';

/**
 * F-11.2: which hops may name the client in `X-Forwarded-For`. Per-address rate limits
 * are only as true as this: trusting too little makes every browser the web app's proxy;
 * trusting everyone lets a client pick its own address.
 */
export function trustProxy(value: string): string {
  // A hop count cannot tell a proxy from a client that reached the API directly, and
  // Fastify 5.12 dropped it for that reason (GHSA X-Forwarded-* spoofing): name the hops.
  if (value === 'true' || /^\d+$/.test(value)) {
    throw new Error(`TRUST_PROXY=${value} trusts any peer; name the proxy addresses (e.g. loopback or 10.0.0.0/8)`);
  }
  return value;
}

export interface Application {
  handle: FetchHandler;
  get<T>(token: abstract new (...args: never[]) => T): T;
  get<T = unknown>(token: Token): T;
  close(): Promise<void>;
}

export interface ApplicationOptions {
  /** Workers pass a per-request pool source (ADR-0009); Node shares one pool. */
  poolSource?: PoolSource;
  logger?: Logger;
}

/** The API as Node and a Worker both run it: the module graph, then one `fetch` handler (F-CW.2). */
export async function createApplication(options: ApplicationOptions = {}): Promise<Application> {
  const adapterHost = new RuntimeAdapterHost();
  // What NestJS supplied to every module without a declaration.
  const values = new Map<Token, unknown>([
    [Reflector, new Reflector()],
    [RuntimeAdapterHost, adapterHost],
  ]);
  if (options.poolSource) values.set(POOL_SOURCE, options.poolSource);

  const container = new Container(AppModule, values);
  container.instantiateAll();
  await container.init();

  const config = container.get(ConfigService);
  const problems = new ProblemFilter(options.logger ?? createLogger({ service: 'api' }));
  const handle = createHttpHandler(container, {
    // The runtime's context has every member the filter reads (`switchToHttp`).
    filter: { catch: (exception, host) => problems.catch(exception, host as unknown as ArgumentsHost) },
    adapterHost,
    trustProxy: trustProxy(config.env.TRUST_PROXY),
  });
  return {
    handle,
    get: (token: Token) => container.get(token),
    close: () => container.close(),
  } as Application;
}
