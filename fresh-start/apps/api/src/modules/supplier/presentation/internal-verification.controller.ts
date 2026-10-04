import { Controller, Post, Req } from '@nestjs/common';
import {
  ExpireVerificationsCommand,
  type ExpirySweepResult,
} from '../application/expire-verifications.command';
import { DomainError } from '../../../platform/http/domain-error';
import {
  ServiceOnly,
  type ServiceActorRequest,
} from '../../../platform/http/service-principal.guard';
import { SCAN_WORKER_PRINCIPAL } from '@jobwork/service-auth';

/**
 * The scheduled verification sweep, reachable only by the worker's service principal
 * (doc 20 §9) — a user never triggers expiry, and expiry never depends on a person
 * remembering to run it.
 */
@ServiceOnly(SCAN_WORKER_PRINCIPAL.name)
@Controller('internal/suppliers/verification')
export class InternalVerificationController {
  constructor(private readonly expire: ExpireVerificationsCommand) {}

  @Post('sweep')
  async sweep(@Req() request: ServiceActorRequest): Promise<ExpirySweepResult> {
    if (!request.servicePrincipal) {
      throw new DomainError('SERVICE_AUTH_FAILED', 401, 'Service credential required');
    }
    return this.expire.execute(request.servicePrincipal);
  }
}
