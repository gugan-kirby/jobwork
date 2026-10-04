import { Injectable, type OnApplicationBootstrap, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Server } from 'node:http';
import { Counter, createLogger, createRegistry, Gauge, Histogram, type Registry, safeLabel, startMetricsServer } from '@jobwork/observability';
import { ConfigService } from '../config/config.service';
import { DatabaseService } from '../database/database.service';

type InstrumentedRequest = FastifyRequest & {
  actor?: { organizationType?: string | null };
  servicePrincipal?: { name: string };
};

/** One API process's metrics (doc 12 §6–7; F-11.3). Served on `METRICS_PORT`, never on the API port. */
@Injectable()
export class MetricsService implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  readonly registry: Registry;
  /** RED: rate, errors and duration by route template, method, status and caller type. */
  readonly httpDuration: Histogram<'method' | 'route' | 'status_code' | 'caller'>;
  /** Named commands by outcome: `ok`, `rejected` (a business rule said no), `conflict` (stale version, replayed key), `error`. */
  readonly commands: Counter<'operation' | 'outcome'>;
  readonly commandDuration: Histogram<'operation'>;
  readonly rateLimited: Counter<'operation_class' | 'dimension'>;
  /** Sign-in signals for the security dashboard (doc 12 §7): failures, lockouts, MFA failures. */
  readonly authEvents: Counter<'event'>;
  private server: Server | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly adapterHost: HttpAdapterHost,
    db: DatabaseService,
  ) {
    this.registry = createRegistry({ service: 'api', version: config.buildVersion });
    const registers = [this.registry];
    this.httpDuration = new Histogram({
      name: 'http_server_request_duration_seconds',
      help: 'API request duration by route template, method, status code and caller type.',
      labelNames: ['method', 'route', 'status_code', 'caller'],
      buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 1.5, 2.5, 5, 10],
      registers,
    });
    this.commands = new Counter({ name: 'jobwork_commands_total', help: 'Named commands by operation and outcome.', labelNames: ['operation', 'outcome'], registers });
    this.commandDuration = new Histogram({
      name: 'jobwork_command_duration_seconds',
      help: 'Named command duration, transaction included.',
      labelNames: ['operation'],
      buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers,
    });
    this.rateLimited = new Counter({ name: 'jobwork_rate_limited_total', help: 'Requests refused (or, in observe mode, that would have been) by a rate-limit budget.', labelNames: ['operation_class', 'dimension'], registers });
    this.authEvents = new Counter({ name: 'jobwork_auth_events_total', help: 'Sign-in events: login_succeeded, login_failed, lockout, mfa_failed.', labelNames: ['event'], registers });
    // USE for the one resource most likely to saturate first (doc 12 §11).
    new Gauge({
      name: 'jobwork_db_pool_connections',
      help: 'Database pool connections by state.',
      labelNames: ['state'],
      registers,
      collect() {
        this.set({ state: 'total' }, db.pool.totalCount);
        this.set({ state: 'idle' }, db.pool.idleCount);
        this.set({ state: 'waiting' }, db.pool.waitingCount);
      },
    });
  }

  onModuleInit(): void {
    const fastify = this.adapterHost.httpAdapter?.getInstance<FastifyInstance>();
    if (!fastify) return;
    fastify.addHook('onResponse', (request: InstrumentedRequest, reply: FastifyReply, done: () => void) => {
      const caller = request.servicePrincipal ? 'service' : request.actor?.organizationType ?? 'anonymous';
      this.httpDuration.observe(
        {
          method: request.method,
          route: safeLabel(request.routeOptions?.url, 'unmatched'),
          status_code: String(reply.statusCode),
          caller: safeLabel(caller, 'anonymous'),
        },
        reply.elapsedTime / 1000,
      );
      done();
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    const port = this.config.env.METRICS_PORT;
    if (!port) return;
    this.server = await startMetricsServer(this.registry, { port, host: this.config.env.METRICS_HOST });
    createLogger({ service: 'api' }).info({ port, host: this.config.env.METRICS_HOST }, 'metrics listening');
  }

  async onModuleDestroy(): Promise<void> {
    const server = this.server;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Command outcome classes from the thrown error's HTTP status (doc 08 §3 problem codes). */
  recordCommand(operation: string, seconds: number, error: unknown): void {
    const status = typeof error === 'object' && error !== null && 'status' in error ? Number((error as { status: unknown }).status) : null;
    const outcome = error === undefined ? 'ok' : status === 409 ? 'conflict' : status !== null && status >= 400 && status < 500 ? 'rejected' : 'error';
    const op = safeLabel(operation);
    this.commands.inc({ operation: op, outcome });
    this.commandDuration.observe({ operation: op }, seconds);
  }
}
