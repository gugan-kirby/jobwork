import { Module } from '@nestjs/common';
import { IamModule } from '../iam';
import { Conversations } from './application/conversation.command';
import { IdentityScreen } from './application/identity-screen';
import { LeakageGate } from './application/leakage-gate';
import { LeakageReviews } from './application/leakage-review.command';
import { Notifications } from './application/notification.command';
import { CommunicationRepository } from './infrastructure/communication.repository';
import { ContextResolver } from './infrastructure/context.resolver';
import { NotificationRepository } from './infrastructure/notification.repository';
import { ConversationsController } from './presentation/conversations.controller';
import { LeakageReviewsController } from './presentation/leakage-reviews.controller';
import { InternalNotificationsController, NotificationsController } from './presentation/notifications.controller';

/**
 * Threads, contact-leakage review and notifications (IN-10). Reads the records it hangs
 * conversations off (enquiries, RFQs, orders) through its own context resolver, and changes no
 * other module's state. Logistics borrows its registry to screen customer artifacts (IN-17).
 */
@Module({
  imports: [IamModule],
  controllers: [ConversationsController, LeakageReviewsController, NotificationsController, InternalNotificationsController],
  providers: [
    CommunicationRepository,
    ContextResolver,
    LeakageGate,
    LeakageReviews,
    Conversations,
    NotificationRepository,
    Notifications,
    IdentityScreen,
  ],
  exports: [CommunicationRepository, IdentityScreen],
})
export class CommunicationModule {}
