import { z } from 'zod';

/**
 * Threads, contact-leakage review and notifications (IN-10, `FR-1001`–`FR-1005`).
 *
 * A thread has two projections. The external one (customer, supplier) carries only
 * messages whose audience includes the reader, with JobWork staff shown as "JobWork"
 * and no other organization ever named. The internal one labels every audience and
 * author. They are separate types so a component cannot be handed the wrong one (`DS-11`).
 */

export const messageAudienceSchema = z.enum(['internal', 'customer', 'supplier', 'shared_technical']);
export type MessageAudience = z.infer<typeof messageAudienceSchema>;
export type ExternalAudience = Exclude<MessageAudience, 'internal'>;

export const messagePartySchema = z.enum(['internal', 'customer', 'supplier']);
export type MessageParty = z.infer<typeof messagePartySchema>;

export const conversationContextTypeSchema = z.enum(['enquiry', 'rfq', 'sales_order', 'purchase_order']);
export type ConversationContextType = z.infer<typeof conversationContextTypeSchema>;

// ------------------------------------------------------------------ leakage findings

export const leakageFindingKindSchema = z.enum([
  'email',
  'url',
  'handle',
  'phone',
  'engineering_number',
  'address',
  'party_identity',
]);
export type LeakageFindingKind = z.infer<typeof leakageFindingKindSchema>;

export const leakageFindingSchema = z.object({
  kind: leakageFindingKindSchema,
  confidence: z.enum(['high', 'low']),
  /** Offsets into the message text as written (UTF-16 code units), for highlighting. */
  start: z.number().int().min(0),
  end: z.number().int().min(0),
  text: z.string(),
  label: z.string(),
});
export type LeakageFinding = z.infer<typeof leakageFindingSchema>;

export const leakageActionSchema = z.enum(['allow', 'warn', 'quarantine']);
export type LeakageAction = z.infer<typeof leakageActionSchema>;

// ------------------------------------------------------------------ threads

export const postMessageRequestSchema = z.object({
  audience: messageAudienceSchema,
  /** JobWork writing to one supplier on an RFQ names which one; implied everywhere else. */
  supplierOrganizationId: z.uuid().optional(),
  body: z.string().trim().min(1, 'Write a message').max(8000),
});
export type PostMessageRequest = z.infer<typeof postMessageRequestSchema>;

/** Same shape as a post; nothing is stored. */
export const checkMessageRequestSchema = postMessageRequestSchema;
export type CheckMessageRequest = PostMessageRequest;

/** JobWork republishes a supplier's RFQ question to every invited supplier, in its own words. */
export const shareMessageRequestSchema = z.object({
  body: z.string().trim().min(1, 'Write the question as every supplier should read it').max(8000),
});
export type ShareMessageRequest = z.infer<typeof shareMessageRequestSchema>;

export interface ConversationContext {
  type: ConversationContextType;
  id: string;
  /** The record's reference, e.g. ENQ-2026-0042. */
  label: string;
}

export interface PostingOption {
  audience: MessageAudience;
  /** Plain words for the composer banner, e.g. "JobWork and Kovai Pumps". */
  label: string;
  supplierOrganizationId?: string;
}

/** A message as a customer or supplier sees it. */
export interface ExternalMessage {
  messageId: string;
  audience: ExternalAudience;
  /** "JobWork" for staff; the author's own name for the reader's own organization. */
  authorLabel: string;
  mine: boolean;
  body: string;
  postedAt: string;
  /** Only ever `held` on the reader's own message: it is waiting for JobWork. */
  status: 'visible' | 'held';
}

export interface ExternalConversation {
  viewer: 'external';
  context: ConversationContext;
  canPost: PostingOption[];
  messages: ExternalMessage[];
}

export interface InternalMessage {
  messageId: string;
  audience: MessageAudience;
  authorName: string;
  authorParty: MessageParty;
  authorOrganizationName: string;
  /** For supplier-audience messages: the supplier the exchange is with. */
  counterpartOrganizationId: string | null;
  counterpartName: string | null;
  body: string;
  postedAt: string;
  status: 'visible' | 'held' | 'rejected' | 'superseded';
  derivedFromMessageId: string | null;
  derivation: 'redacted' | 'shared' | null;
  review: { reviewId: string; status: LeakageReviewStatus; action: 'warn' | 'quarantine' } | null;
  /** A supplier's RFQ question JobWork may republish to every invited supplier. */
  shareable: boolean;
}

export interface InternalConversation {
  viewer: 'internal';
  context: ConversationContext;
  canPost: PostingOption[];
  messages: InternalMessage[];
}

export type ConversationView = ExternalConversation | InternalConversation;

export interface PostMessageResponse {
  messageId: string;
  status: 'visible' | 'held';
  action: LeakageAction;
  /** Findings the author may see (registry matches are shown to JobWork only). */
  findings: LeakageFinding[];
}

export interface CheckMessageResponse {
  action: LeakageAction;
  findings: LeakageFinding[];
}

// ------------------------------------------------------------------ leakage review

export const leakageReviewStatusSchema = z.enum(['open', 'noted', 'released', 'released_redacted', 'rejected']);
export type LeakageReviewStatus = z.infer<typeof leakageReviewStatusSchema>;

export interface LeakageReviewListItem {
  reviewId: string;
  status: LeakageReviewStatus;
  action: 'warn' | 'quarantine';
  createdAt: string;
  context: ConversationContext;
  audience: ExternalAudience;
  /** Who would have read it, in words: "Kovai Pumps (customer)", "every invited supplier". */
  readerLabel: string;
  authorName: string;
  findingCount: number;
  /** JobWork's page for the record the message is about. */
  href: string;
}

export interface LeakageReviewDetail extends LeakageReviewListItem {
  messageId: string;
  body: string;
  findings: LeakageFinding[];
  /** The body with every finding replaced by "[removed]" — a starting point, not a decision. */
  suggestedRedaction: string;
  aggregateVersion: number;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  derivedMessageId: string | null;
  canDecide: boolean;
  cannotDecideReason: string | null;
}

export const decideLeakageReviewRequestSchema = z
  .object({
    decision: z.enum(['release', 'release_redacted', 'reject']),
    reason: z.string().trim().min(3, 'Say why, in a sentence').max(1000),
    redactedBody: z.string().trim().min(1).max(8000).optional(),
    expectedVersion: z.number().int().positive(),
  })
  .refine((r) => (r.decision === 'release_redacted') === (r.redactedBody !== undefined), {
    message: 'A redacted release needs the redacted text, and only a redacted release takes one',
    path: ['redactedBody'],
  });
export type DecideLeakageReviewRequest = z.infer<typeof decideLeakageReviewRequestSchema>;

// ------------------------------------------------------------------ notifications

export interface NotificationItem {
  notificationId: string;
  title: string;
  body: string;
  /** App-relative path to the authenticated page the notification is about. */
  link: string;
  createdAt: string;
  readAt: string | null;
}

export interface NotificationFeed {
  notifications: NotificationItem[];
  unread: number;
}

export const dispatchNotificationsRequestSchema = z.object({ eventId: z.uuid() });
export type DispatchNotificationsRequest = z.infer<typeof dispatchNotificationsRequestSchema>;

export interface PendingDelivery {
  deliveryId: string;
  attemptNo: number;
  channel: 'email' | 'sms' | 'whatsapp';
  destination: string;
  subject: string;
  text: string;
}

export interface DispatchNotificationsResponse {
  notifications: number;
  deliveries: PendingDelivery[];
}

export const recordDeliveryRequestSchema = z.object({
  attemptNo: z.number().int().positive(),
  status: z.enum(['sent', 'failed']),
  providerReference: z.string().trim().max(200).optional(),
  errorCode: z.string().trim().max(100).optional(),
});
export type RecordDeliveryRequest = z.infer<typeof recordDeliveryRequestSchema>;

/**
 * Committed events that produce notifications (F-10.3). The API holds the rule for each;
 * the worker subscribes to exactly these. One list, so the two cannot drift.
 */
export const NOTIFIED_EVENT_TYPES = [
  'sourcing.enquiry_submitted',
  'sourcing.clarification_requested',
  'sourcing.clarification_answered',
  'sourcing.rfq_released.v1',
  'sourcing.bid_submitted.v1',
  'commercial.cost_sheet_approval_requested.v1',
  'commercial.quote_approval_requested.v1',
  'commercial.quote_sent.v1',
  'commercial.quote_accepted.v1',
  'orders.purchase_order_issued.v1',
  'finance.invoice_issued.v1',
  'finance.payment_received.v1',
  'dms.transmittal_issued.v1',
  'orders.milestone_evidence_submitted.v1',
  'orders.milestone_evidence_rejected.v1',
  'communication.message_posted.v1',
  'communication.message_released.v1',
  'communication.message_held.v1',
  'platform.sla_escalated.v1',
  'platform.queue_item_reassigned.v1',
  'sourcing.rfq_superseded.v1',
  'change.customer_decision_requested.v1',
  'change.interim_decision_issued.v1',
] as const;
export type NotifiedEventType = (typeof NOTIFIED_EVENT_TYPES)[number];
