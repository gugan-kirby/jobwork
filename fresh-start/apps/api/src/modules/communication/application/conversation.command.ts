import { Injectable } from '@nestjs/common';
import type {
  CheckMessageRequest,
  CheckMessageResponse,
  ConversationContextType,
  ConversationView,
  ExternalAudience,
  ExternalMessage,
  InternalMessage,
  LeakageAction,
  LeakageFinding,
  MessageAudience,
  MessageParty,
  PostingOption,
  PostMessageRequest,
  PostMessageResponse,
  ShareMessageRequest,
} from '@jobwork/contracts';
import { type Actor, requireOrganization, requireTransactionalStrength } from '../../iam';
import { DETECTOR_VERSION } from '../domain/leakage';
import { findingsForAuthor } from '../domain/leakage-policy';
import {
  AudienceNotAllowed,
  ConversationClosed,
  ConversationContextNotFound,
  MessageNotShareable,
} from '../domain/errors';
import { CommunicationRepository, type MessageRecord } from '../infrastructure/communication.repository';
import { ContextResolver, type ResolvedContext } from '../infrastructure/context.resolver';
import { LeakageGate } from './leakage-gate';
import { messageEvent } from './leakage-review.command';
import { contextFromActor, type OutboxSpec } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';

/** JobWork staff who work threads. Account administrators are not among them (doc 03 §7). */
const INTERNAL_ROLES = [
  'jobwork_sourcing', 'jobwork_engineering', 'jobwork_sales', 'jobwork_support',
  'jobwork_quality', 'jobwork_finance', 'jobwork_logistics',
];
const CUSTOMER_ROLES = ['customer_requester', 'customer_approver', 'org_admin'];
const SUPPLIER_ROLES = ['supplier_estimator', 'supplier_production', 'supplier_quality', 'org_admin'];

type Opts = { idempotencyKey?: string | undefined };

/** What one reader may do in one conversation. */
interface Access {
  party: MessageParty;
  organizationId: string;
  /** External readers only: the audiences their listing selects. */
  readable: ExternalAudience[];
  canPost: PostingOption[];
}

/**
 * Audience-bound threads (`FR-1001`, doc 14 §11, UC-04/UC-13).
 *
 * Every message names its audience when it is written and keeps it. A customer reads the
 * customer audience of its own enquiries and orders; a supplier reads its own private
 * exchange with JobWork and what JobWork published to every invited supplier; JobWork
 * reads everything, labelled. External listings select by audience in SQL (`BR-AUTH-06`).
 */
@Injectable()
export class Conversations {
  constructor(
    private readonly repo: CommunicationRepository,
    private readonly contexts: ContextResolver,
    private readonly gate: LeakageGate,
    private readonly executor: CommandExecutor,
  ) {}

  // ---------------------------------------------------------------- access

  private access(actor: Actor, context: ResolvedContext): Access | null {
    const organizationId = actor.organizationId;
    if (!organizationId) return null;

    if (actor.isInternal) {
      if (!actor.roles.some((r) => INTERNAL_ROLES.includes(r))) return null;
      const canPost: PostingOption[] = [{ audience: 'internal', label: 'JobWork staff only' }];
      if (context.open) {
        if (context.type === 'enquiry' || context.type === 'sales_order') {
          canPost.push({ audience: 'customer', label: `JobWork and ${context.customerName}` });
        }
        if (context.type === 'rfq' || context.type === 'purchase_order') {
          for (const s of context.suppliers.filter((x) => x.active)) {
            canPost.push({ audience: 'supplier', label: `JobWork and ${s.name}`, supplierOrganizationId: s.organizationId });
          }
        }
        if (context.type === 'rfq' && context.suppliers.some((s) => s.active)) {
          canPost.push({ audience: 'shared_technical', label: 'Every invited supplier (no names shown)' });
        }
      }
      return { party: 'internal', organizationId, readable: [], canPost };
    }

    if (actor.organizationType === 'customer') {
      if (context.type !== 'enquiry' && context.type !== 'sales_order') return null;
      if (context.customerOrganizationId !== organizationId) return null;
      if (!actor.roles.some((r) => CUSTOMER_ROLES.includes(r))) return null;
      return {
        party: 'customer',
        organizationId,
        readable: ['customer'],
        canPost: context.open ? [{ audience: 'customer', label: 'JobWork' }] : [],
      };
    }

    if (actor.organizationType === 'supplier') {
      if (context.type !== 'rfq' && context.type !== 'purchase_order') return null;
      const mine = context.suppliers.find((s) => s.organizationId === organizationId);
      if (!mine || !actor.roles.some((r) => SUPPLIER_ROLES.includes(r))) return null;
      return {
        party: 'supplier',
        organizationId,
        readable: context.type === 'rfq' ? ['supplier', 'shared_technical'] : ['supplier'],
        canPost: mine.active ? [{ audience: 'supplier', label: 'JobWork' }] : [],
      };
    }
    return null;
  }

  private async load(actor: Actor, type: string, id: string): Promise<{ context: ResolvedContext; access: Access }> {
    if (!isContextType(type) || !UUID.test(id)) throw new ConversationContextNotFound();
    const context = await this.contexts.resolve(type, id);
    // One answer for "does not exist" and "not yours" (doc 03 §7).
    const access = context ? this.access(actor, context) : null;
    if (!context || !access) throw new ConversationContextNotFound();
    return { context, access };
  }

  /** The audience and counterpart a request resolves to, or a refusal. */
  private target(
    access: Access,
    context: ResolvedContext,
    request: { audience: MessageAudience; supplierOrganizationId?: string | undefined },
  ): { audience: MessageAudience; counterpartOrganizationId: string | null } {
    if (access.canPost.length === 0) throw new ConversationClosed();
    let counterpart: string | null = null;
    if (request.audience === 'supplier') {
      counterpart = access.party === 'supplier'
        ? access.organizationId
        : request.supplierOrganizationId ?? (context.type === 'purchase_order' ? context.suppliers[0]?.organizationId ?? null : null);
    }
    const allowed = access.canPost.some(
      (o) => o.audience === request.audience && (request.audience !== 'supplier' || access.party === 'supplier' || o.supplierOrganizationId === counterpart),
    );
    if (!allowed) {
      throw new AudienceNotAllowed(
        request.audience === 'internal' ? 'Internal notes are for JobWork staff.' : 'Choose one of the audiences this conversation offers.',
      );
    }
    return { audience: request.audience, counterpartOrganizationId: counterpart };
  }

  // ---------------------------------------------------------------- reads

  async view(actor: Actor, type: string, id: string): Promise<ConversationView> {
    const { context, access } = await this.load(actor, type, id);
    const conversationId = await this.repo.conversationId(context.type, context.id);
    const ref = { type: context.type, id: context.id, label: context.label };

    if (access.party === 'internal') {
      const messages = conversationId ? await this.repo.internalMessages(conversationId) : [];
      return { viewer: 'internal', context: ref, canPost: access.canPost, messages: messages.map((m) => toInternal(m)) };
    }
    const messages = conversationId
      ? await this.repo.externalMessages(conversationId, { organizationId: access.organizationId, audiences: access.readable })
      : [];
    return { viewer: 'external', context: ref, canPost: access.canPost, messages: messages.map((m) => toExternal(m, actor)) };
  }

  async check(actor: Actor, type: string, id: string, request: CheckMessageRequest): Promise<CheckMessageResponse> {
    const { context, access } = await this.load(actor, type, id);
    const target = this.target(access, context, request);
    if (target.audience === 'internal') return { action: 'allow', findings: [] };
    const result = await this.gate.check({
      context,
      audience: target.audience as ExternalAudience,
      counterpartOrganizationId: target.counterpartOrganizationId,
      authorParty: access.party,
      body: request.body,
    });
    return { action: result.action, findings: findingsForAuthor(result.findings, access.party) };
  }

  // ---------------------------------------------------------------- writes

  async post(actor: Actor, type: string, id: string, request: PostMessageRequest, opts: Opts): Promise<PostMessageResponse> {
    const { context, access } = await this.load(actor, type, id);
    if (access.party === 'internal') requireTransactionalStrength(actor);
    const target = this.target(access, context, request);
    return this.write(actor, context, access.party, {
      audience: target.audience,
      counterpartOrganizationId: target.counterpartOrganizationId,
      body: request.body,
      derivedFromMessageId: null,
    }, 'communication.post-message', { contextType: context.type, contextId: context.id, ...request }, opts);
  }

  /**
   * A supplier's RFQ question, republished by JobWork to every invited supplier in
   * JobWork's own words (doc 14 §11). The asking supplier is never shown; the source
   * message stays where it was, linked.
   */
  async share(actor: Actor, messageId: string, request: ShareMessageRequest, opts: Opts): Promise<PostMessageResponse> {
    if (!actor.isInternal || !actor.roles.some((r) => INTERNAL_ROLES.includes(r))) throw new ConversationContextNotFound();
    requireTransactionalStrength(actor);
    if (!UUID.test(messageId)) throw new ConversationContextNotFound();
    const source = await this.repo.message(messageId);
    if (!source) throw new ConversationContextNotFound();
    if (source.contextType !== 'rfq' || source.audience !== 'supplier' || source.authorParty !== 'supplier' || source.status !== 'visible') {
      throw new MessageNotShareable('Only a supplier’s visible question on an RFQ can be published to every invited supplier.');
    }
    const { context, access } = await this.load(actor, source.contextType, source.contextId);
    this.target(access, context, { audience: 'shared_technical' });
    return this.write(actor, context, 'internal', {
      audience: 'shared_technical',
      counterpartOrganizationId: null,
      body: request.body,
      derivedFromMessageId: source.id,
    }, 'communication.share-message', { messageId, ...request }, opts);
  }

  private async write(
    actor: Actor,
    context: ResolvedContext,
    party: MessageParty,
    m: { audience: MessageAudience; counterpartOrganizationId: string | null; body: string; derivedFromMessageId: string | null },
    operation: string,
    input: Record<string, unknown>,
    opts: Opts,
  ): Promise<PostMessageResponse> {
    const organizationId = requireOrganization(actor);
    return this.executor.execute(
      {
        operation,
        handler: async (tx) => {
          let action: LeakageAction = 'allow';
          let findings: LeakageFinding[] = [];
          if (m.audience !== 'internal') {
            ({ action, findings } = await this.gate.check(
              { context, audience: m.audience as ExternalAudience, counterpartOrganizationId: m.counterpartOrganizationId, authorParty: party, body: m.body },
              tx,
            ));
          }
          const status = action === 'quarantine' ? 'held' : 'visible';

          const conversationId = await this.repo.ensureConversation(tx, context.type, context.id);
          if (m.audience === 'customer') await this.repo.addParticipant(tx, conversationId, context.customerOrganizationId, 'customer');
          if (m.counterpartOrganizationId) await this.repo.addParticipant(tx, conversationId, m.counterpartOrganizationId, 'supplier');

          const messageId = await this.repo.insertMessage(tx, {
            conversationId,
            audience: m.audience,
            counterpartOrganizationId: m.counterpartOrganizationId,
            authorUserId: actor.userId,
            authorOrganizationId: organizationId,
            authorParty: party,
            body: m.body,
            status,
            derivedFromMessageId: m.derivedFromMessageId,
            derivation: m.derivedFromMessageId ? 'shared' : null,
          });
          const reviewId = action === 'allow'
            ? null
            : await this.repo.insertReview(tx, { messageId, action, findings, detectorVersion: DETECTOR_VERSION });

          const record = { id: messageId, conversationId, audience: m.audience, counterpartOrganizationId: m.counterpartOrganizationId, authorParty: party };
          const ref = { type: context.type, id: context.id };
          const outbox: OutboxSpec[] = status === 'held'
            ? [messageEvent('communication.message_held.v1', record, ref, { reviewId })]
            : m.audience === 'internal'
              ? []
              : [messageEvent('communication.message_posted.v1', record, ref, m.derivedFromMessageId ? { derivedFromMessageId: m.derivedFromMessageId } : {})];

          return {
            result: { messageId, status, action, findings: findingsForAuthor(findings, party) } satisfies PostMessageResponse,
            audit: [
              {
                action: m.derivedFromMessageId ? 'communication.message.shared' : 'communication.message.posted',
                subjectType: 'message',
                subjectId: messageId,
                subjectVersion: 1,
                // The body is the record, kept in its own table; the audit carries its shape only.
                data: {
                  contextType: context.type, contextId: context.id, audience: m.audience, status, action,
                  findingKinds: [...new Set(findings.map((f) => f.kind))],
                  ...(m.derivedFromMessageId ? { derivedFromMessageId: m.derivedFromMessageId } : {}),
                },
              },
            ],
            outbox,
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isContextType(value: string): value is ConversationContextType {
  return value === 'enquiry' || value === 'rfq' || value === 'sales_order' || value === 'purchase_order';
}

/** The external projection: staff are "JobWork", colleagues are named, nobody else exists. */
function toExternal(m: MessageRecord, actor: Actor): ExternalMessage {
  const ownOrganization = m.authorOrganizationId === actor.organizationId;
  return {
    messageId: m.id,
    audience: m.audience as ExternalAudience,
    authorLabel: ownOrganization ? m.authorName : 'JobWork',
    mine: m.authorUserId === actor.userId,
    body: m.body,
    postedAt: m.postedAt.toISOString(),
    status: m.status === 'held' ? 'held' : 'visible',
  };
}

function toInternal(m: MessageRecord): InternalMessage {
  return {
    messageId: m.id,
    audience: m.audience,
    authorName: m.authorName,
    authorParty: m.authorParty,
    authorOrganizationName: m.authorOrganizationName,
    counterpartOrganizationId: m.counterpartOrganizationId,
    counterpartName: m.counterpartName,
    body: m.body,
    postedAt: m.postedAt.toISOString(),
    status: m.status,
    derivedFromMessageId: m.derivedFromMessageId,
    derivation: m.derivation,
    review: m.reviewId && m.reviewStatus && m.reviewAction ? { reviewId: m.reviewId, status: m.reviewStatus, action: m.reviewAction } : null,
    shareable: m.contextType === 'rfq' && m.audience === 'supplier' && m.authorParty === 'supplier' && m.status === 'visible',
  };
}
