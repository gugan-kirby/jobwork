import { Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  checkMessageRequestSchema,
  postMessageRequestSchema,
  shareMessageRequestSchema,
  type CheckMessageResponse,
  type ConversationView,
  type PostMessageResponse,
} from '@jobwork/contracts';
import type { Actor } from '../../iam';
import { Conversations } from '../application/conversation.command';
import { CurrentActor } from '../../../platform/http/actor.decorator';
import { parseBody } from '../../../platform/http/validation';
import { RateLimit } from '../../../platform/http/rate-limit/rate-limit.decorator';

function idempotencyKey(request: FastifyRequest): string | undefined {
  const header = request.headers['idempotency-key'];
  return typeof header === 'string' ? header : undefined;
}

/** Threads bound to an enquiry, RFQ, sales order or purchase order (F-10.2). */
@Controller()
export class ConversationsController {
  constructor(private readonly conversations: Conversations) {}

  @Get('conversations/:contextType/:contextId')
  view(@CurrentActor() actor: Actor, @Param('contextType') type: string, @Param('contextId') id: string): Promise<ConversationView> {
    return this.conversations.view(actor, type, id);
  }

  /** The composer's pre-check: what the gate would do with this text. Stores nothing. */
  @RateLimit('message')
  @Post('conversations/:contextType/:contextId/messages/check')
  check(@CurrentActor() actor: Actor, @Param('contextType') type: string, @Param('contextId') id: string, @Req() request: FastifyRequest): Promise<CheckMessageResponse> {
    return this.conversations.check(actor, type, id, parseBody(checkMessageRequestSchema, request.body));
  }

  @RateLimit('message')
  @Post('conversations/:contextType/:contextId/messages')
  post(@CurrentActor() actor: Actor, @Param('contextType') type: string, @Param('contextId') id: string, @Req() request: FastifyRequest): Promise<PostMessageResponse> {
    return this.conversations.post(actor, type, id, parseBody(postMessageRequestSchema, request.body), { idempotencyKey: idempotencyKey(request) });
  }

  @RateLimit('message')
  @Post('messages/:messageId/share')
  share(@CurrentActor() actor: Actor, @Param('messageId') messageId: string, @Req() request: FastifyRequest): Promise<PostMessageResponse> {
    return this.conversations.share(actor, messageId, parseBody(shareMessageRequestSchema, request.body), { idempotencyKey: idempotencyKey(request) });
  }
}
