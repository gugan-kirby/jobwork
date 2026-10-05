import type { WorkQueueKey } from '@jobwork/contracts';

/**
 * Every operations queue, defined once (F-OPS.2, F-11.1).
 *
 * `membership` is the question that puts an item in the queue, asked of the owning
 * module's own tables: it returns one row per item with `subject_id`, `reference`,
 * `title`, `href` and `waiting_since`. The command-center count, the queue screen and the
 * SLA sweep all read this same query, so a badge can never say three while the screen
 * shows two, and the sweep can never escalate something the screen does not list.
 *
 * `reference` reaches notifications and email, so it is a record number or a neutral
 * word — never a name, an amount or an address. `title` is for the screen only.
 */
export interface QueueDefinition {
  key: WorkQueueKey;
  label: string;
  detail: string;
  /** The list screen the command center links to. */
  href: string;
  /** Roles that may see and act on this queue. A count nobody can act on is noise or a leak. */
  roles: readonly string[];
  subjectType: string;
  membership: string;
}

const TRIAGE_ROLES = ['jobwork_sourcing', 'jobwork_engineering', 'platform_admin'];

export const QUEUE_DEFINITIONS: readonly QueueDefinition[] = [
  {
    key: 'enquiries_awaiting_triage',
    label: 'Enquiries awaiting triage',
    detail: 'Submitted by a customer and not yet reviewed.',
    href: '/intake',
    roles: TRIAGE_ROLES,
    subjectType: 'enquiry',
    membership: `
      SELECT e.id AS subject_id, e.reference, e.title, '/intake/' || e.id AS href,
             coalesce(e.submitted_at, e.created_at) AS waiting_since
        FROM sourcing.enquiry e
       WHERE e.status IN ('submitted', 'under_review')`,
  },
  {
    // Asked and unanswered: waiting on the customer, so it ages against JobWork's promise.
    key: 'clarifications_awaiting_customer',
    label: 'Clarifications with the customer',
    detail: 'Asked and unanswered. Chase before the enquiry goes cold.',
    href: '/intake',
    roles: TRIAGE_ROLES,
    subjectType: 'enquiry',
    membership: `
      SELECT e.id AS subject_id, e.reference, e.title, '/intake/' || e.id AS href,
             e.updated_at AS waiting_since
        FROM sourcing.enquiry e
       WHERE e.status = 'clarification_required'`,
  },
  {
    key: 'supplier_files_awaiting_decision',
    label: 'Supplier files awaiting a decision',
    detail: 'Complete files a supplier has sent for admission.',
    href: '/suppliers?status=submitted',
    roles: ['jobwork_sourcing', 'platform_admin'],
    subjectType: 'supplier_profile',
    membership: `
      SELECT p.id AS subject_id, 'Supplier file' AS reference, o.display_name AS title,
             '/suppliers/' || p.id AS href,
             coalesce(p.submitted_for_approval_at, p.updated_at) AS waiting_since
        FROM supplier.supplier_profile p
        JOIN iam.organization o ON o.id = p.organization_id
       WHERE p.status = 'submitted'`,
  },
  {
    key: 'supplier_applications_received',
    label: 'Workshops asking to join',
    detail: 'Applications from the public form, not yet admitted or declined.',
    href: '/suppliers/applications',
    roles: ['jobwork_sourcing', 'platform_admin'],
    subjectType: 'network_application',
    membership: `
      SELECT a.id AS subject_id, 'Application' AS reference, a.company_name AS title,
             '/suppliers/applications' AS href, a.created_at AS waiting_since
        FROM supplier.network_application a
       WHERE a.status = 'received'`,
  },
  {
    key: 'supplier_evidence_awaiting_review',
    label: 'Evidence awaiting review',
    detail: 'GST, PAN, bank and certificates waiting on a reviewer.',
    href: '/suppliers/verification',
    roles: ['jobwork_sourcing', 'jobwork_quality', 'platform_admin'],
    subjectType: 'verification_item',
    membership: `
      SELECT v.id AS subject_id, 'Evidence' AS reference,
             initcap(replace(v.kind, '_', ' ')) || ' — ' || o.display_name AS title,
             '/suppliers/' || p.id AS href,
             coalesce(v.submitted_at, v.updated_at) AS waiting_since
        FROM supplier.verification_item v
        JOIN supplier.supplier_profile p ON p.id = v.supplier_profile_id
        JOIN iam.organization o ON o.id = p.organization_id
       WHERE v.status IN ('submitted', 'under_review')`,
  },
  {
    // Admitted suppliers that cannot currently be matched — expired evidence, a
    // suspension, nothing published. Not a queue anyone submitted to, which is exactly
    // why it needs a number: nobody is going to notice it on their own.
    key: 'suppliers_unmatchable',
    label: 'Admitted suppliers not matchable',
    detail: 'In the network but out of matching — usually lapsed evidence.',
    href: '/suppliers?excludedOnly=true',
    roles: ['jobwork_sourcing', 'platform_admin'],
    subjectType: 'supplier_profile',
    membership: `
      SELECT p.id AS subject_id, 'Supplier' AS reference, o.display_name AS title,
             '/suppliers/' || p.id AS href, p.updated_at AS waiting_since
        FROM supplier.supplier_profile p
        JOIN iam.organization o ON o.id = p.organization_id
       WHERE p.status IN ('active', 'paused')
         AND (
           p.status <> 'active'
           OR o.status <> 'active'
           OR NOT EXISTS (
             SELECT 1 FROM supplier.supplier_capability sc
              WHERE sc.supplier_profile_id = p.id AND sc.status = 'published'
           )
           OR (
             SELECT count(DISTINCT v.kind) FROM supplier.verification_item v
              WHERE v.supplier_profile_id = p.id
                AND v.kind IN ('gst', 'pan', 'bank_account')
                AND v.status IN ('verified', 'expiring')
                AND (v.expires_at IS NULL OR v.expires_at > now())
           ) < 3
         )`,
  },
  {
    key: 'rfqs_in_evaluation',
    label: 'Rounds to evaluate',
    detail: 'Closed with bids in; waiting on a comparison and an award.',
    href: '/rfqs?status=evaluation',
    roles: ['jobwork_sourcing', 'jobwork_sales'],
    subjectType: 'rfq',
    membership: `
      SELECT r.id AS subject_id, r.reference, e.title, '/rfqs/' || r.id AS href,
             coalesce(r.closed_at, r.updated_at) AS waiting_since
        FROM sourcing.rfq r
        JOIN sourcing.enquiry e ON e.id = r.enquiry_id
       WHERE r.status = 'evaluation'`,
  },
  {
    key: 'approvals_pending',
    label: 'Approvals waiting',
    detail: 'Awards, cost sheets and quotations that need a second pair of eyes.',
    href: '/approvals',
    roles: ['jobwork_sourcing', 'jobwork_sales', 'jobwork_finance'],
    subjectType: 'approval_request',
    membership: `
      SELECT a.id AS subject_id, 'Approval' AS reference,
             initcap(replace(a.kind, '_', ' ')) || ' approval' AS title,
             '/approvals' AS href, a.requested_at AS waiting_since
        FROM commercial.approval_request a
       WHERE a.status = 'pending'`,
  },
  {
    // Accepted and waiting on the advance or a credit decision (doc 06 §7 commercial gate).
    key: 'orders_awaiting_release',
    label: 'Orders waiting on payment or credit',
    detail: 'Accepted quotations whose advance has not arrived and no credit covers them yet.',
    href: '/sales-orders?status=pending_commercial_release',
    roles: ['jobwork_finance', 'jobwork_sales'],
    subjectType: 'sales_order',
    membership: `
      SELECT o.id AS subject_id, o.number AS reference, o.title, '/sales-orders/' || o.id AS href,
             o.created_at AS waiting_since
        FROM orders.sales_order o
       WHERE o.status = 'pending_commercial_release'`,
  },
  {
    // Orders with an approved award behind them and no purchase order issued yet.
    key: 'purchase_orders_to_issue',
    label: 'Purchase orders to issue',
    detail: 'Accepted orders whose awarded suppliers have no purchase order yet.',
    href: '/sales-orders',
    roles: ['jobwork_sourcing'],
    subjectType: 'sales_order',
    membership: `
      SELECT o.id AS subject_id, o.number AS reference, o.title, '/sales-orders/' || o.id AS href,
             o.created_at AS waiting_since
        FROM orders.sales_order o
       WHERE o.status NOT IN ('cancelled', 'closed')
         AND NOT EXISTS (SELECT 1 FROM orders.purchase_order p WHERE p.sales_order_id = o.id)`,
  },
  {
    // Receipts nobody can tie to an invoice yet: suspense is a liability until it is cleared.
    key: 'payments_unmatched',
    label: 'Receipts in suspense',
    detail: 'Money received that is not yet tied to an invoice. Allocate it, with a colleague’s approval.',
    href: '/finance',
    roles: ['jobwork_finance'],
    subjectType: 'payment_transaction',
    membership: `
      SELECT t.id AS subject_id, 'Receipt' AS reference,
             'Receipt ' || coalesce(nullif(t.reference, ''), 'without a reference') AS title,
             '/finance' AS href, t.received_at AS waiting_since
        FROM finance.payment_transaction t
       WHERE t.status = 'suspense'`,
  },
  {
    // Orders with purchase orders out and no released production baseline yet.
    key: 'baselines_to_release',
    label: 'Baselines to release',
    detail: 'Purchase orders are out but no technical baseline has been released to manufacture to.',
    href: '/sales-orders',
    roles: ['jobwork_engineering', 'jobwork_sourcing'],
    subjectType: 'sales_order',
    membership: `
      SELECT o.id AS subject_id, o.number AS reference, o.title,
             '/sales-orders/' || o.id || '/production' AS href, o.created_at AS waiting_since
        FROM orders.sales_order o
       WHERE o.status NOT IN ('cancelled', 'closed')
         AND EXISTS (SELECT 1 FROM orders.purchase_order p WHERE p.sales_order_id = o.id)
         AND NOT EXISTS (SELECT 1 FROM dms.baseline b WHERE b.sales_order_id = o.id AND b.status = 'released')`,
  },
  {
    key: 'work_packages_to_release',
    label: 'Work packages waiting for release',
    detail: 'Planned work that cannot start until every release gate is green.',
    href: '/sales-orders',
    roles: ['jobwork_sourcing', 'jobwork_engineering'],
    subjectType: 'work_package',
    membership: `
      SELECT w.id AS subject_id, w.number AS reference, o.title,
             '/sales-orders/' || w.sales_order_id || '/production' AS href, w.created_at AS waiting_since
        FROM orders.work_package w
        JOIN orders.sales_order o ON o.id = w.sales_order_id
       WHERE w.status = 'planned'`,
  },
  {
    key: 'milestones_to_verify',
    label: 'Milestone evidence to verify',
    detail: 'Suppliers have submitted evidence. Submitted is not verified.',
    href: '/production',
    roles: ['jobwork_quality'],
    subjectType: 'milestone',
    membership: `
      SELECT m.id AS subject_id, w.number AS reference, m.title,
             '/sales-orders/' || w.sales_order_id || '/production' AS href,
             coalesce(m.submitted_at, m.started_at, now()) AS waiting_since
        FROM orders.milestone m
        JOIN orders.work_package w ON w.id = m.work_package_id
       WHERE m.status = 'evidence_submitted'`,
  },
  {
    // IN-14: results submitted, waiting for an independent JobWork quality decision.
    key: 'inspections_awaiting_review',
    label: 'Inspections awaiting review',
    detail: 'Results are in. Submitted is not passed: an independent reviewer decides.',
    href: '/quality',
    roles: ['jobwork_quality'],
    subjectType: 'inspection',
    membership: `
      SELECT i.id AS subject_id, i.number AS reference, w.number || ' · ' || i.stage AS title,
             '/quality/inspections/' || i.id AS href,
             coalesce(i.submitted_at, i.planned_at) AS waiting_since
        FROM quality.inspection i
        JOIN orders.work_package w ON w.id = i.work_package_id
       WHERE i.status IN ('results_submitted', 'under_review')`,
  },
  {
    // IN-15: every NCR until it is independently closed.
    key: 'ncrs_open',
    label: 'Open NCRs',
    detail: 'Nonconformances waiting for containment, a disposition, rework, reinspection or closure.',
    href: '/quality/ncrs',
    roles: ['jobwork_quality'],
    subjectType: 'ncr',
    membership: `
      SELECT n.id AS subject_id, n.number AS reference, n.title, '/quality/ncrs/' || n.id AS href, n.opened_at AS waiting_since
        FROM quality.ncr n
       WHERE n.status <> 'closed'`,
  },
  {
    // IN-16: supplier shipments submitted with green guards, waiting for JobWork to release them.
    key: 'shipments_to_release',
    label: 'Supplier shipments to release',
    detail: 'The supplier has packed and submitted; release checks the guards again and freezes the addresses.',
    href: '/logistics',
    roles: ['jobwork_logistics'],
    subjectType: 'shipment',
    membership: `
      SELECT s.id AS subject_id, s.number AS reference, s.number AS title, '/logistics/shipments/' || s.id AS href, s.updated_at AS waiting_since
        FROM logistics.shipment s
       WHERE s.status = 'ready_for_release'`,
  },
  {
    // A carrier's "delivered" is not a receipt: until JobWork receives it, it waits here.
    key: 'shipments_awaiting_receiving',
    label: 'Shipments awaiting receiving',
    detail: 'Released to the carrier and not yet received at JobWork. A carrier delivery with no receipt needs looking into.',
    href: '/logistics',
    roles: ['jobwork_logistics'],
    subjectType: 'shipment',
    membership: `
      SELECT s.id AS subject_id, s.number AS reference, s.number AS title, '/logistics/shipments/' || s.id AS href,
             coalesce(s.carrier_delivered_at, s.picked_up_at, s.released_at) AS waiting_since
        FROM logistics.shipment s
       WHERE s.status IN ('released', 'picked_up', 'in_transit', 'delivered_to_destination') AND s.leg IN ('supplier_to_jobwork', 'customer_to_jobwork')`,
  },
  {
    key: 'receiving_discrepancies_open',
    label: 'Receiving discrepancies',
    detail: 'Short, damaged or wrong at receiving: the shipment is on hold until each is resolved.',
    href: '/logistics',
    roles: ['jobwork_logistics', 'jobwork_quality'],
    subjectType: 'receiving_discrepancy',
    membership: `
      SELECT d.id AS subject_id, d.number AS reference, d.kind || ' on ' || s.number AS title, '/logistics/shipments/' || d.shipment_id AS href, d.created_at AS waiting_since
        FROM logistics.receiving_discrepancy d JOIN logistics.shipment s ON s.id = d.shipment_id
       WHERE d.status = 'open'`,
  },
  {
    key: 'customer_dispatches_to_release',
    label: 'Customer dispatches to release',
    detail: 'Packed and submitted with every guard green or overridden; release re-runs the gate and moves the stock out.',
    href: '/logistics',
    roles: ['jobwork_logistics'],
    subjectType: 'shipment',
    membership: `
      SELECT s.id AS subject_id, s.number AS reference, s.number AS title, '/logistics/shipments/' || s.id AS href, s.updated_at AS waiting_since
        FROM logistics.shipment s
       WHERE s.leg = 'jobwork_to_customer' AND s.status = 'ready_for_release'`,
  },
  {
    // POD is not acceptance, and a carrier's "delivered" is not a POD (BR-LOG-05): until one is recorded, it waits here.
    key: 'deliveries_awaiting_pod',
    label: 'Deliveries awaiting proof of delivery',
    detail: 'On the way to the customer, or reported delivered by the carrier, with no proof of delivery yet.',
    href: '/logistics',
    roles: ['jobwork_logistics'],
    subjectType: 'shipment',
    membership: `
      SELECT s.id AS subject_id, s.number AS reference, s.number AS title, '/logistics/shipments/' || s.id AS href,
             coalesce(s.carrier_delivered_at, s.picked_up_at) AS waiting_since
        FROM logistics.shipment s
       WHERE s.leg = 'jobwork_to_customer' AND s.status IN ('picked_up', 'in_transit', 'delivered_to_destination')`,
  },
  {
    key: 'delivery_exceptions_open',
    label: 'Delivery exceptions',
    detail: 'Address changes, refusals and the customer’s reports: the delivery is held until each is resolved or handed to a case.',
    href: '/logistics',
    roles: ['jobwork_support', 'jobwork_logistics'],
    subjectType: 'delivery_exception',
    membership: `
      SELECT x.id AS subject_id, x.number AS reference, replace(x.kind, '_', ' ') || ' on ' || s.number AS title, '/logistics/shipments/' || x.shipment_id AS href, x.created_at AS waiting_since
        FROM logistics.delivery_exception x JOIN logistics.shipment s ON s.id = x.shipment_id
       WHERE x.status = 'open'`,
  },
  {
    // Messages held by the contact-leakage gate, invisible to their readers until decided (F-10.4).
    key: 'leakage_reviews_open',
    label: 'Messages held for review',
    detail: 'They may name a party or carry contact details; nobody outside sees them until decided.',
    href: '/leakage-reviews',
    roles: ['jobwork_support', 'jobwork_sourcing'],
    subjectType: 'leakage_review',
    membership: `
      SELECT r.id AS subject_id, 'Held message' AS reference, 'Message held for review' AS title,
             '/leakage-reviews' AS href, r.created_at AS waiting_since
        FROM communication.leakage_review r
       WHERE r.status = 'open'`,
  },
  {
    // Invitations nobody has accepted: an organization sitting empty is a stalled onboarding.
    key: 'invitations_pending',
    label: 'Invitations not yet accepted',
    detail: 'People who cannot sign in yet. Resend if the link went stale.',
    href: '/organizations',
    roles: ['platform_admin', 'security_admin'],
    subjectType: 'invitation',
    membership: `
      SELECT i.id AS subject_id, 'Invitation' AS reference, i.email AS title,
             '/organizations/' || i.organization_id AS href, i.created_at AS waiting_since
        FROM iam.invitation i
       WHERE i.consumed_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()`,
  },
];

export function queueDefinition(key: string): QueueDefinition | undefined {
  return QUEUE_DEFINITIONS.find((q) => q.key === key);
}

/** The queues an actor may see and act on. */
export function queuesFor(roles: readonly string[]): QueueDefinition[] {
  return QUEUE_DEFINITIONS.filter((q) => q.roles.some((role) => roles.includes(role)));
}
