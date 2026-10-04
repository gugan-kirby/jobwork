import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from '@jobwork/observability';
import { DomainError, RateLimited } from './domain-error';

interface ProblemBody {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  correlationId?: string;
  errors?: Array<{ path: string; message: string }>;
  retryAfterSeconds?: number;
}

/**
 * Maps every thrown error to RFC-style problem details (doc 08 §3).
 * Allowlist principle (ES-13): only DomainError and HttpException surface details;
 * anything else becomes an opaque 500 with a correlation id.
 */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();
    const correlationHeader = request.headers['x-correlation-id'];
    const correlationId =
      typeof correlationHeader === 'string' ? correlationHeader : undefined;

    let body: ProblemBody;
    if (exception instanceof DomainError) {
      body = {
        type: `https://jobwork.example/problems/${exception.code.toLowerCase().replace(/_/g, '-')}`,
        title: exception.title,
        status: exception.status,
        code: exception.code,
        ...(exception.detail !== undefined ? { detail: exception.detail } : {}),
        ...(correlationId !== undefined ? { correlationId } : {}),
        ...(exception.errors !== undefined ? { errors: exception.errors } : {}),
        ...(exception instanceof RateLimited ? { retryAfterSeconds: exception.retryAfterSeconds } : {}),
      };
      if (exception instanceof RateLimited) void reply.header('retry-after', String(exception.retryAfterSeconds));
    } else if (exception instanceof HttpException) {
      const status = exception.getStatus();
      body = {
        type: 'about:blank',
        title: exception.message,
        status,
        code: `HTTP_${status}`,
        ...(correlationId !== undefined ? { correlationId } : {}),
      };
    } else {
      this.logger.error(
        {
          err: exception instanceof Error ? exception.stack : String(exception),
          path: request.url,
        },
        'unhandled error',
      );
      body = {
        type: 'about:blank',
        title: 'Internal server error',
        status: 500,
        code: 'INTERNAL',
        ...(correlationId !== undefined ? { correlationId } : {}),
      };
    }

    void reply.status(body.status).header('content-type', 'application/problem+json').send(body);
  }
}
