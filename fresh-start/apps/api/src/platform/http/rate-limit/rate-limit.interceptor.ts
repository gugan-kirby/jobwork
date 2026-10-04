import { createHash } from 'node:crypto';
import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { from, type Observable, switchMap } from 'rxjs';
import { createLogger, type Logger } from '@jobwork/observability';
import type Redis from 'ioredis';
import { ConfigService } from '../../config/config.service';
import { RateLimited } from '../domain-error';
import { type Dimension, type OperationClass, type RatePolicies, resolvePolicies } from './policies';
import { RATE_LIMIT_KEY } from './rate-limit.decorator';
import { createRedis, MemoryRateLimitStore, RedisRateLimitStore, ResilientRateLimitStore, type RateLimitStore } from './store';

type LimitedRequest = FastifyRequest & {
  actor?: { userId?: string; organizationId?: string | null };
  servicePrincipal?: { name: string };
  cookies?: Record<string, string | undefined>;
};

const hash = (value: string): string => createHash('sha256').update(value).digest('base64url').slice(0, 22);

/**
 * Budgets per operation class, checked before the handler runs (F-11.2; doc 08 §14).
 *
 * An interceptor rather than a guard because it runs after the session and
 * service-principal guards, so a budget can be counted per person and per organization
 * — not only per address, which every user behind one office NAT would share. Each
 * dimension's key is a hash: the store never holds an address or an e-mail in clear.
 *
 * `RATE_LIMIT_MODE=observe` logs what would have been refused without refusing it, for
 * tuning budgets against real traffic; `off` is for test suites that sign in hundreds of
 * times from one address.
 */
@Injectable()
export class RateLimitInterceptor implements NestInterceptor, OnModuleInit, OnModuleDestroy {
  private readonly log: Logger = createLogger({ service: 'api' }).child({ module: 'http.rate_limit' });
  private readonly policies: RatePolicies;
  private readonly mode: 'enforce' | 'observe' | 'off';
  private readonly prefix: string;
  private readonly redis: Redis | null;
  readonly store: RateLimitStore;

  constructor(
    private readonly reflector: Reflector,
    config: ConfigService,
  ) {
    this.mode = config.env.RATE_LIMIT_MODE;
    this.prefix = config.env.RATE_LIMIT_PREFIX;
    this.policies = resolvePolicies(config.env.RATE_LIMIT_POLICIES);
    const memory = new MemoryRateLimitStore();
    if (this.mode === 'off' || !config.env.REDIS_URL) {
      this.redis = null;
      this.store = memory;
    } else {
      this.redis = createRedis(config.env.REDIS_URL);
      // ioredis reports connection loss as an event; without a listener Node treats it as fatal.
      this.redis.on('error', () => undefined);
      this.store = new ResilientRateLimitStore(new RedisRateLimitStore(this.redis), memory, this.log);
    }
  }

  /**
   * Waits for Redis, briefly. Without the wait the first requests after a deploy race the
   * handshake, find the client not ready, and put every instance into its 30-second
   * degraded mode at once. A Redis that is down never blocks the boot for more than a second.
   */
  async onModuleInit(): Promise<void> {
    if (!this.redis) return;
    const connected = this.redis.connect().then(
      () => true,
      () => false,
    );
    const ready = await Promise.race([connected, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000).unref())]);
    if (!ready) this.log.warn({ outcome: 'degraded' }, 'http.rate_limit_store_unavailable_at_start');
  }

  onModuleDestroy(): void {
    this.redis?.disconnect();
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (this.mode === 'off' || context.getType() !== 'http') return next.handle();
    const declared = this.reflector.getAllAndOverride<OperationClass | 'skip' | undefined>(RATE_LIMIT_KEY, [context.getHandler(), context.getClass()]);
    if (declared === 'skip') return next.handle();
    const request = context.switchToHttp().getRequest<LimitedRequest>();
    const operationClass: OperationClass = request.servicePrincipal
      ? 'service'
      : declared ?? (request.method === 'GET' || request.method === 'HEAD' ? 'read' : 'command');
    return from(this.check(operationClass, request)).pipe(switchMap(() => next.handle()));
  }

  private identify(dimension: Dimension, request: LimitedRequest): string | null {
    switch (dimension) {
      case 'ip':
        return request.ip ?? null;
      case 'user':
        return request.actor?.userId ?? null;
      case 'organization':
        return request.actor?.organizationId ?? null;
      case 'principal':
        return request.servicePrincipal?.name ?? null;
      case 'account': {
        const body = request.body as { email?: unknown } | undefined;
        return typeof body?.email === 'string' ? body.email.trim().toLowerCase() : null;
      }
      case 'session': {
        const raw = request.headers.cookie ?? '';
        const match = raw.match(/(?:^|;\s*)jw_session=([^;]+)/);
        return match?.[1] ?? null;
      }
      case 'provider': {
        const params = request.params as Record<string, string | undefined> | undefined;
        return params?.['provider'] ?? null;
      }
    }
  }

  private async check(operationClass: OperationClass, request: LimitedRequest): Promise<void> {
    const now = Date.now();
    let retryAfterMs = 0;
    let spent: Dimension | null = null;
    for (const budget of this.policies[operationClass]) {
      const id = this.identify(budget.dimension, request);
      if (!id) continue;
      const windowMs = budget.windowSeconds * 1000;
      const key = `${this.prefix}:${operationClass}:${budget.dimension}:${hash(id)}`;
      const { current, previous } = await this.store.hit(key, windowMs, now);
      const elapsed = now % windowMs;
      const estimate = previous * (1 - elapsed / windowMs) + current;
      if (estimate > budget.limit) {
        const wait = windowMs - elapsed;
        if (wait > retryAfterMs) {
          retryAfterMs = wait;
          spent = budget.dimension;
        }
      }
    }
    if (!spent) return;
    const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
    this.log.warn({ operationClass, dimension: spent, retryAfterSeconds, enforced: this.mode === 'enforce' }, 'http.rate_limited');
    if (this.mode === 'enforce') throw new RateLimited(retryAfterSeconds);
  }
}
