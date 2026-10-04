/**
 * What the worker does with each outbox event type (F-11.3).
 *
 * Every type the API commits must be here, in `HANDLED_EVENT_TYPES` (a side effect of the
 * worker's own) or among `NOTIFIED_EVENT_TYPES` (contracts): an unregistered type is
 * dead-lettered, and a dead letter is an alarm. `test/subscriptions.spec.ts` reads every
 * type the API source commits and holds it to these lists — before it existed, the five
 * supplier onboarding decisions dead-lettered on every approval since F-SO.
 *
 * Acknowledged types are committed and audited and need nothing from the worker yet;
 * a notification or projection that wants one moves it out of this list.
 */

/** Types with a worker handler of their own: mail, scanning. */
export const HANDLED_EVENT_TYPES = ['iam.invitation.issued.v1', 'iam.email_verification.issued.v1', 'dms.file_finalized'] as const;

export const ACKNOWLEDGED_EVENT_TYPES = [
  'commercial.approval_decided.v1',
  'commercial.award_proposed.v1',
  'commercial.quote_expired.v1',
  'commercial.quote_rejected.v1',
  'commercial.quote_revision_requested.v1',
  'commercial.quote_withdrawn.v1',
  'communication.message_rejected.v1',
  'dms.audience_granted',
  'dms.audience_revoked',
  'dms.baseline_released.v1',
  'dms.file_cleared',
  'dms.file_quarantined',
  'dms.transmittal_acknowledged.v1',
  'finance.allocation_proposed.v1',
  'finance.credit_hold_placed.v1',
  'finance.payment_failed.v1',
  'finance.payment_suspense.v1',
  'orders.containment_recorded.v1',
  'orders.milestone_delayed.v1',
  'orders.milestone_verified.v1',
  'orders.purchase_order_acknowledged.v1',
  'orders.sales_order_created.v1',
  'orders.sales_order_released.v1',
  'orders.work_package_completed.v1',
  'orders.work_package_released.v1',
  'sourcing.enquiry_approved_for_sourcing',
  'sourcing.enquiry_cancelled',
  'sourcing.enquiry_declined',
  'sourcing.rfq_closed.v1',
  'sourcing.rfq_deadline_passed.v1',
  'sourcing.rfq_declined.v1',
  'sourcing.requirement_revised.v1',
  // IN-13 change control: recorded, nothing to send.
  'change.change_proposed.v1',
  'change.approval_requested.v1',
  'change.customer_decided.v1',
  'change.change_released.v1',
  'change.change_implemented.v1',
  'change.change_closed.v1',
  'supplier.admitted.v1',
  'supplier.application_declined.v1',
  'supplier.application_received.v1',
  'supplier.approved.v1',
  'supplier.availability_changed.v1',
  'supplier.capability_published',
  'supplier.capacity_declared',
  'supplier.declaration_withdrawn.v1',
  'supplier.exited.v1',
  'supplier.machine_registered',
  'supplier.onboarding_submitted.v1',
  'supplier.reinstated.v1',
  'supplier.rejected.v1',
  'supplier.returned.v1',
  'supplier.suspended.v1',
  'supplier.verification_expired',
  'supplier.verification_expiring',
  'supplier.verification_returned',
  'supplier.verification_revoked',
  'supplier.verification_submitted',
  'supplier.verification_verified',
] as const;
