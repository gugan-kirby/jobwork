import { Injectable } from '@nestjs/common';
import type {
  DispatchNotificationsResponse,
  NotificationFeed,
  NotifiedEventType,
  PendingDelivery,
  RecordDeliveryRequest,
} from '@jobwork/contracts';
import type { Actor } from '../../iam';
import { render } from '../domain/templates';
import { ContextResolver } from '../infrastructure/context.resolver';
import { NotificationRepository } from '../infrastructure/notification.repository';
import { NOTIFICATION_RULES } from './notification-rules';
import { ConfigService } from '../../../platform/config/config.service';
import { DatabaseService } from '../../../platform/database/database.service';
import { DomainError } from '../../../platform/http/domain-error';

class OutboxEventNotFound extends DomainError {
  constructor() {
    // No committed event, no notification: a rolled-back command leaves nothing to send.
    super('OUTBOX_EVENT_NOT_FOUND', 404, 'No committed event with that id');
  }
}

class NotificationNotFound extends DomainError {
  constructor() {
    super('NOTIFICATION_NOT_FOUND', 404, 'Notification not found');
  }
}

class DeliveryNotFound extends DomainError {
  constructor() {
    super('DELIVERY_NOT_FOUND', 404, 'No delivery attempt with that id and number');
  }
}

const LOCALE = 'en-IN';

/**
 * Notifications (F-10.3, `FR-1003`–`FR-1005`, UC-38).
 *
 * Driven only by committed outbox events: the worker hands over an event id, and this
 * service decides who hears about it and renders the words. Each notification records
 * its source event, template version, locale, consent basis and correlation id. Asking
 * twice for the same event creates nothing new and reopens only deliveries that have not
 * succeeded — the worker can retry freely, and a provider that reports twice is ignored
 * the second time.
 */
@Injectable()
export class Notifications {
  constructor(
    private readonly repo: NotificationRepository,
    private readonly contexts: ContextResolver,
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
  ) {}

  async dispatch(eventId: string): Promise<DispatchNotificationsResponse> {
    const event = await this.repo.outboxEvent(eventId);
    if (!event) throw new OutboxEventNotFound();
    const rule = NOTIFICATION_RULES[event.eventType as NotifiedEventType];
    if (!rule) return { notifications: 0, deliveries: [] };

    const plans = await rule(event, { repo: this.repo, contexts: this.contexts });
    const deliveries: PendingDelivery[] = [];
    let notifications = 0;
    for (const plan of plans) {
      const templates = await this.repo.templates(plan.templateKey, LOCALE);
      if (!templates.inApp) throw new Error(`no in-app template version for ${plan.templateKey}`);
      const recipients = await this.repo.recipients(plan.audience, event.actor.id ?? null);
      if (recipients.length === 0) continue;

      // Rendered before any row is written: a template that refuses leaves nothing behind.
      const inApp = render(templates.inApp, { ...plan.variables, link: plan.link });
      const base = plan.audience.party === 'internal' ? this.config.env.OPERATIONS_URL : this.config.env.PORTAL_URL;
      const email = templates.email ? render(templates.email, { ...plan.variables, link: `${base.replace(/\/$/, '')}${plan.link}` }) : null;

      await this.db.withTransaction(async (tx) => {
        for (const recipient of recipients) {
          const notificationId = await this.repo.upsertNotification(tx, {
            recipient,
            templateKey: plan.templateKey,
            templateVersionId: templates.inApp!.id,
            locale: LOCALE,
            title: inApp.subject,
            body: inApp.body,
            link: plan.link,
            sourceEventId: event.id,
            correlationId: event.correlationId,
          });
          notifications += 1;
          if (!email || !templates.email) continue;
          const attempt = await this.repo.openAttempt(tx, {
            notificationId,
            channel: 'email',
            templateVersionId: templates.email.id,
            destination: recipient.email,
          });
          if (attempt) {
            deliveries.push({ ...attempt, channel: 'email', destination: recipient.email, subject: email.subject, text: email.body });
          }
        }
      });
    }
    return { notifications, deliveries };
  }

  async recordDelivery(deliveryId: string, request: RecordDeliveryRequest): Promise<{ outcome: 'recorded' | 'already_recorded' }> {
    const outcome = await this.repo.completeAttempt(deliveryId, {
      attemptNo: request.attemptNo,
      status: request.status,
      providerReference: request.providerReference ?? null,
      errorCode: request.errorCode ?? null,
    });
    if (outcome === 'unknown') throw new DeliveryNotFound();
    return { outcome };
  }

  // ---------------------------------------------------------------- the reader's own feed

  feed(actor: Actor): Promise<NotificationFeed> {
    return this.repo.feed(actor.userId, 50);
  }

  async unread(actor: Actor): Promise<{ unread: number }> {
    return { unread: await this.repo.unread(actor.userId) };
  }

  async markRead(actor: Actor, notificationId: string): Promise<NotificationFeed> {
    if (!/^[0-9a-f-]{36}$/i.test(notificationId) || !(await this.repo.markRead(actor.userId, notificationId))) {
      throw new NotificationNotFound();
    }
    return this.feed(actor);
  }

  async markAllRead(actor: Actor): Promise<NotificationFeed> {
    await this.repo.markAllRead(actor.userId);
    return this.feed(actor);
  }
}
