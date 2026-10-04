import { Controller, Post } from '@nestjs/common';
import { SCAN_WORKER_PRINCIPAL } from '@jobwork/service-auth';
import type { Actor } from '../../iam';
import { RfqDeadlineCommand } from '../application/rfq-deadline.command';
import { CurrentActor } from '../../../platform/http/actor.decorator';
import { ServiceOnly } from '../../../platform/http/service-principal.guard';

/**
 * The scheduled half of F-06.6, reachable only by the worker's service principal
 * (doc 20 §9). The state change stays an audited named command in the API; the worker
 * only decides *when* to ask.
 */
@ServiceOnly(SCAN_WORKER_PRINCIPAL.name)
@Controller('internal/rfqs')
export class InternalRfqController {
  constructor(private readonly deadlines: RfqDeadlineCommand) {}

  @Post('deadline-sweep')
  async sweep(@CurrentActor() actor: Actor): Promise<{ lapsed: number; rounds: number }> {
    return this.deadlines.sweep(actor);
  }
}
