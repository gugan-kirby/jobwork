import { Module } from '@nestjs/common';
import { IamModule } from '../iam';
import { LeakageGate } from './application/leakage-gate';
import { LeakageReviews } from './application/leakage-review.command';
import { CommunicationRepository } from './infrastructure/communication.repository';
import { ContextResolver } from './infrastructure/context.resolver';
import { LeakageReviewsController } from './presentation/leakage-reviews.controller';

/**
 * Threads, contact-leakage review and notifications (IN-10). Reads the records it hangs
 * conversations off (enquiries, RFQs, orders) through its own context resolver; no other
 * module depends on it, and it changes no other module's state.
 */
@Module({
  imports: [IamModule],
  controllers: [LeakageReviewsController],
  providers: [CommunicationRepository, ContextResolver, LeakageGate, LeakageReviews],
  exports: [CommunicationRepository],
})
export class CommunicationModule {}
