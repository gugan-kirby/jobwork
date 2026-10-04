import { Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  dispatchNotificationsRequestSchema,
  recordDeliveryRequestSchema,
  type DispatchNotificationsResponse,
  type NotificationFeed,
} from '@jobwork/contracts';
import { SCAN_WORKER_PRINCIPAL } from '@jobwork/service-auth';
import type { Actor } from '../../iam';
import { Notifications } from '../application/notification.command';
import { CurrentActor } from '../../../platform/http/actor.decorator';
import { ServiceOnly } from '../../../platform/http/service-principal.guard';
import { parseBody } from '../../../platform/http/validation';

/** The reader's own notification feed (F-10.3). Nobody reads anyone else's. */
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: Notifications) {}

  @Get()
  feed(@CurrentActor() actor: Actor): Promise<NotificationFeed> {
    return this.notifications.feed(actor);
  }

  @Get('unread-count')
  unread(@CurrentActor() actor: Actor): Promise<{ unread: number }> {
    return this.notifications.unread(actor);
  }

  @Post('read-all')
  readAll(@CurrentActor() actor: Actor): Promise<NotificationFeed> {
    return this.notifications.markAllRead(actor);
  }

  @Post(':notificationId/read')
  read(@CurrentActor() actor: Actor, @Param('notificationId') notificationId: string): Promise<NotificationFeed> {
    return this.notifications.markRead(actor, notificationId);
  }
}

/** The worker's side: turn a committed event into notifications, then report each delivery. */
@ServiceOnly(SCAN_WORKER_PRINCIPAL.name)
@Controller('internal/notifications')
export class InternalNotificationsController {
  constructor(private readonly notifications: Notifications) {}

  @Post('dispatch')
  dispatch(@Req() request: FastifyRequest): Promise<DispatchNotificationsResponse> {
    return this.notifications.dispatch(parseBody(dispatchNotificationsRequestSchema, request.body).eventId);
  }

  @Post('deliveries/:deliveryId/result')
  result(@Param('deliveryId') deliveryId: string, @Req() request: FastifyRequest): Promise<{ outcome: 'recorded' | 'already_recorded' }> {
    return this.notifications.recordDelivery(deliveryId, parseBody(recordDeliveryRequestSchema, request.body));
  }
}
