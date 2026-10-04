import type { ConversationContextType, NotifiedEventType } from '@jobwork/contracts';
import type { NotificationRepository, OutboxEvent, RecipientAudience } from '../infrastructure/notification.repository';
import type { ContextResolver } from '../infrastructure/context.resolver';
import { REVIEWER_ROLES } from './leakage-review.command';

/**
 * Which committed event tells whom, with which template, about what (F-10.3).
 *
 * Variables come only from references the recipient can already see — a quote's
 * reference, an invoice number, a record label — never from a raw aggregate. A rule that
 * reached for a supplier's name in a customer template would be refused by the
 * template's allowlist anyway; the rules are written so it never comes to that.
 */

export interface PlannedNotification {
  templateKey: string;
  audience: RecipientAudience;
  variables: Record<string, string>;
  /** App-relative path to the authenticated page. */
  link: string;
}

export interface RuleLookups {
  repo: NotificationRepository;
  contexts: ContextResolver;
}

type Rule = (event: OutboxEvent, lookups: RuleLookups) => Promise<PlannedNotification[]>;

const CUSTOMER = ['customer_requester', 'customer_approver', 'org_admin'];
const SUPPLIER = ['supplier_estimator', 'supplier_production', 'supplier_quality', 'org_admin'];
const TRIAGE = ['jobwork_sourcing', 'jobwork_engineering'];

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

/** A calendar date as people in Chennai say it: 15 Oct 2026. */
export function dateLabel(value: string | Date | null): string {
  if (!value) return 'the stated date';
  const date = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00+05:30`) : new Date(value);
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
}

const customer = (organizationId: string): RecipientAudience => ({ party: 'customer', organizationIds: [organizationId], roles: CUSTOMER });
const suppliers = (organizationIds: string[]): RecipientAudience => ({ party: 'supplier', organizationIds, roles: SUPPLIER });
const internal = (roles: readonly string[]): RecipientAudience => ({ party: 'internal', roles });

async function messageRule(event: OutboxEvent, { contexts }: RuleLookups): Promise<PlannedNotification[]> {
  const context = await contexts.resolve(str(event.data['contextType']) as ConversationContextType, str(event.data['contextId']));
  if (!context) return [];
  const variables = { contextLabel: context.label };
  const audience = str(event.data['audience']);
  if (str(event.data['authorParty']) === 'internal') {
    if (audience === 'customer') {
      return [{ templateKey: 'customer.message_received', audience: customer(context.customerOrganizationId), variables, link: context.links.external }];
    }
    if (audience === 'supplier' && str(event.data['counterpartOrganizationId'])) {
      return [{ templateKey: 'supplier.message_received', audience: suppliers([str(event.data['counterpartOrganizationId'])]), variables, link: context.links.external }];
    }
    if (audience === 'shared_technical') {
      return [{ templateKey: 'supplier.message_received', audience: suppliers(context.suppliers.map((s) => s.organizationId)), variables, link: context.links.external }];
    }
    return [];
  }
  // A customer or supplier wrote to JobWork: the people who work that record hear of it.
  const roles = context.type === 'enquiry' || context.type === 'sales_order' ? ['jobwork_sourcing', 'jobwork_sales'] : ['jobwork_sourcing'];
  return [{ templateKey: 'internal.message_received', audience: internal(roles), variables, link: context.links.internal }];
}


/** The supplier's own inspection, decided by JobWork quality. JobWork's own inspections notify nobody outside. */
function inspectionDecided(e: OutboxEvent, outcome: 'passed' | 'failed') {
  if (e.data['inspectedBySupplier'] !== true) return [];
  return [
    {
      templateKey: 'supplier.inspection_decided',
      audience: suppliers([str(e.data['supplierOrganizationId'])]),
      variables: { inspectionNumber: str(e.data['number']), purchaseOrderNumber: str(e.data['purchaseOrderNumber']), outcomeLabel: outcome === 'passed' ? 'passed' : 'failed — see the reviewer’s note' },
      link: `/supplier/inspections/${e.aggregateId}`,
    },
  ];
}

export const NOTIFICATION_RULES: Record<NotifiedEventType, Rule> = {
  // ------------------------------------------------------------- customer
  'sourcing.clarification_requested': async (e, { repo }) => {
    const enquiry = await repo.enquiry(e.aggregateId);
    return enquiry
      ? [{ templateKey: 'customer.clarification_requested', audience: customer(enquiry.customerOrganizationId), variables: { enquiryReference: enquiry.reference }, link: `/enquiries/${e.aggregateId}` }]
      : [];
  },
  'commercial.quote_sent.v1': async (e) => [
    {
      templateKey: 'customer.quote_sent',
      audience: customer(str(e.data['customerOrganizationId'])),
      variables: { quoteReference: str(e.data['reference']), validityUntil: dateLabel(str(e.data['validityUntil']) || null) },
      link: `/quotations/${str(e.data['quoteId'])}`,
    },
  ],
  'finance.invoice_issued.v1': async (e) => [
    {
      templateKey: 'customer.invoice_issued',
      audience: customer(str(e.data['customerOrganizationId'])),
      variables: { invoiceNumber: str(e.data['number']), dueDate: dateLabel(str(e.data['dueAt']) || null) },
      link: `/invoices/${str(e.data['invoiceId'])}`,
    },
  ],
  'finance.payment_received.v1': async (e) => [
    {
      templateKey: 'customer.payment_received',
      audience: customer(str(e.data['customerOrganizationId'])),
      variables: { invoiceNumber: str(e.data['number']) },
      link: `/invoices/${str(e.data['invoiceId'])}`,
    },
  ],

  // ------------------------------------------------------------- supplier
  'sourcing.rfq_released.v1': async (e, { repo }) => {
    const rfq = await repo.rfq(e.aggregateId);
    return rfq
      ? [{ templateKey: 'supplier.rfq_invitation', audience: suppliers(rfq.invitedOrganizationIds), variables: { rfqReference: rfq.reference, deadline: dateLabel(rfq.deadlineAt) }, link: `/rfqs/${e.aggregateId}` }]
      : [];
  },
  // F-12.5: a round closed under suppliers who bid on it; their bids stand as submitted.
  'sourcing.rfq_superseded.v1': async (e) => {
    const organizations = strings(e.data['supplierOrganizationIds']);
    return organizations.length > 0
      ? [{ templateKey: 'supplier.rfq_superseded', audience: suppliers(organizations), variables: { rfqReference: str(e.data['reference']) || 'Your RFQ' }, link: `/rfqs/${e.aggregateId}` }]
      : [];
  },
  // IN-13: the customer decides a change that moves its price, date or scope.
  'change.customer_decision_requested.v1': async (e) => [
    {
      templateKey: 'customer.change_decision_needed',
      audience: customer(str(e.data['customerOrganizationId'])),
      variables: { changeNumber: str(e.data['number']), orderNumber: str(e.data['orderNumber']) },
      link: `/orders/${str(e.data['salesOrderId'])}`,
    },
  ],
  // IN-13: a supplier is told to stop or continue while a change is decided.
  'change.interim_decision_issued.v1': async (e) => [
    {
      templateKey: 'supplier.change_interim_decision',
      audience: suppliers([str(e.data['supplierOrganizationId'])]),
      variables: { purchaseOrderNumber: str(e.data['purchaseOrderNumber']), decisionLabel: e.data['decision'] === 'stop' ? 'stop work on it until further notice' : 'continue as planned' },
      link: `/supplier/orders/${str(e.data['purchaseOrderId'])}`,
    },
  ],
  // IN-14: a supplier is told when JobWork plans an inspection it must carry out, and how it was decided.
  'quality.inspection_planned.v1': async (e) =>
    e.data['inspectedBySupplier'] === true
      ? [
          {
            templateKey: 'supplier.inspection_planned',
            audience: suppliers([str(e.data['supplierOrganizationId'])]),
            variables: { purchaseOrderNumber: str(e.data['purchaseOrderNumber']), stageLabel: str(e.data['stageLabel']), sampleSize: String(e.data['sampleSize'] ?? '') },
            link: `/supplier/inspections/${e.aggregateId}`,
          },
        ]
      : [],
  'quality.inspection_passed.v1': async (e) => inspectionDecided(e, 'passed'),
  'quality.inspection_failed.v1': async (e) => inspectionDecided(e, 'failed'),
  'orders.purchase_order_issued.v1': async (e) => [
    {
      templateKey: 'supplier.purchase_order_issued',
      audience: suppliers([str(e.data['supplierOrganizationId'])]),
      variables: { purchaseOrderNumber: str(e.data['number']) },
      link: `/supplier/orders/${str(e.data['purchaseOrderId'])}`,
    },
  ],
  'dms.transmittal_issued.v1': async (e, { repo }) => {
    const po = await repo.transmittalPurchaseOrder(e.aggregateId);
    return po
      ? [{ templateKey: 'supplier.transmittal_issued', audience: suppliers([str(e.data['recipientOrganizationId'])]), variables: { transmittalNumber: str(e.data['number']) }, link: `/supplier/orders/${po.purchaseOrderId}` }]
      : [];
  },
  'orders.milestone_evidence_rejected.v1': async (e, { repo }) => {
    const po = await repo.milestonePurchaseOrder(e.aggregateId);
    return po
      ? [{ templateKey: 'supplier.evidence_rejected', audience: suppliers([po.supplierOrganizationId]), variables: { purchaseOrderNumber: po.number }, link: `/supplier/orders/${po.purchaseOrderId}` }]
      : [];
  },

  // ------------------------------------------------------------- JobWork
  'sourcing.enquiry_submitted': async (e, { repo }) => {
    const enquiry = await repo.enquiry(e.aggregateId);
    return enquiry
      ? [{ templateKey: 'internal.enquiry_submitted', audience: internal(TRIAGE), variables: { enquiryReference: enquiry.reference }, link: `/intake/${e.aggregateId}` }]
      : [];
  },
  'sourcing.clarification_answered': async (e, { repo }) => {
    const enquiry = await repo.enquiry(e.aggregateId);
    return enquiry
      ? [{ templateKey: 'internal.clarification_answered', audience: internal(TRIAGE), variables: { enquiryReference: enquiry.reference }, link: `/intake/${e.aggregateId}` }]
      : [];
  },
  'sourcing.bid_submitted.v1': async (e, { repo }) => {
    const rfqId = str(e.data['rfqId']);
    const rfq = rfqId ? await repo.rfq(rfqId) : null;
    return rfq
      ? [{ templateKey: 'internal.bid_submitted', audience: internal(['jobwork_sourcing']), variables: { rfqReference: rfq.reference }, link: `/rfqs/${rfqId}` }]
      : [];
  },
  'commercial.quote_approval_requested.v1': async (e, { repo }) => {
    const reference = await repo.quoteReference(e.aggregateId);
    const roles = Array.isArray(e.data['requiredRoles']) ? (e.data['requiredRoles'] as string[]) : [];
    return reference && roles.length
      ? [{ templateKey: 'internal.approval_requested', audience: internal(roles), variables: { subjectLabel: `Quotation ${reference}` }, link: '/approvals' }]
      : [];
  },
  'commercial.cost_sheet_approval_requested.v1': async (e, { repo }) => {
    const reference = await repo.costSheetRfqReference(e.aggregateId);
    const roles = Array.isArray(e.data['requiredRoles']) ? (e.data['requiredRoles'] as string[]) : [];
    return reference && roles.length
      ? [{ templateKey: 'internal.approval_requested', audience: internal(roles), variables: { subjectLabel: `Cost sheet for ${reference}` }, link: '/approvals' }]
      : [];
  },
  'commercial.quote_accepted.v1': async (e) => [
    {
      templateKey: 'internal.quote_accepted',
      audience: internal(['jobwork_sales', 'jobwork_sourcing']),
      variables: { quoteReference: str(e.data['reference']) },
      link: `/quotes/${str(e.data['quoteId'])}`,
    },
  ],
  'orders.milestone_evidence_submitted.v1': async (e, { repo }) => {
    const po = await repo.milestonePurchaseOrder(e.aggregateId);
    return po
      ? [{ templateKey: 'internal.evidence_submitted', audience: internal(['jobwork_quality']), variables: { purchaseOrderNumber: po.number }, link: '/production' }]
      : [];
  },

  // ------------------------------------------------------------- threads
  'communication.message_posted.v1': messageRule,
  'communication.message_released.v1': messageRule,
  'communication.message_held.v1': async (e, { contexts }) => {
    const context = await contexts.resolve(str(e.data['contextType']) as ConversationContextType, str(e.data['contextId']));
    return context
      ? [{ templateKey: 'internal.leakage_review_opened', audience: internal(REVIEWER_ROLES), variables: { contextLabel: context.label }, link: '/leakage-reviews' }]
      : [];
  },

  // ------------------------------------------------------------- queues (F-11.1)
  // The queue's label and the item's reference only: the reference is a record number or
  // a neutral word by construction (queue registry), so a name never rides along.
  'platform.sla_escalated.v1': async (e) => {
    const variables = { reference: str(e.data['reference']), queueLabel: str(e.data['queueLabel']) };
    const link = `/queues?queue=${encodeURIComponent(str(e.data['queueKey']))}`;
    const acting = strings(e.data['actingRoles']);
    if (str(e.data['notify']) === 'escalation') {
      const roles = [...new Set([...acting, ...strings(e.data['escalationRoles'])])];
      return [{ templateKey: 'internal.sla_escalated', audience: internal(roles), variables, link }];
    }
    const assignee = str(e.data['assigneeUserId']);
    const audience: RecipientAudience = assignee ? { ...internal(acting), userIds: [assignee] } : internal(acting);
    return [{ templateKey: 'internal.sla_due', audience, variables, link }];
  },
  'platform.queue_item_reassigned.v1': async (e) => [
    {
      templateKey: 'internal.queue_item_assigned',
      audience: { ...internal(strings(e.data['actingRoles'])), userIds: [str(e.data['assigneeUserId'])] },
      variables: { reference: str(e.data['reference']), queueLabel: str(e.data['queueLabel']) },
      link: `/queues?queue=${encodeURIComponent(str(e.data['queueKey']))}`,
    },
  ],
};
