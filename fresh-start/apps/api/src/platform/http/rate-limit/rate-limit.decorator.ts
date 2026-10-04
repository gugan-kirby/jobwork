import { SetMetadata } from '@nestjs/common';
import type { OperationClass } from './policies';

export const RATE_LIMIT_KEY = 'jobwork:rate-limit';

/**
 * Names a route's operation class (doc 08 §14). Unnamed routes count as `read` (GET) or
 * `command` (anything else); a request from a service principal always counts as `service`.
 */
export const RateLimit = (operationClass: OperationClass): MethodDecorator & ClassDecorator =>
  SetMetadata(RATE_LIMIT_KEY, operationClass);

/** Exempt: liveness and readiness probes, which an orchestrator calls on a fixed beat. */
export const SkipRateLimit = (): MethodDecorator & ClassDecorator => SetMetadata(RATE_LIMIT_KEY, 'skip');
