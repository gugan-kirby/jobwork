import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** What `world.setup.ts` leaves for the journeys: record ids and test-only MFA secrets. */
export interface World {
  /** Enquiry submitted and waiting in the intake queue. */
  intakeEnquiryId: string;
  intakeReference: string;
  /** Deal A: a sent quotation waiting for the customer's decision. */
  openQuoteId: string;
  openRfqId: string;
  /** Deal B: accepted; the order exists and supplier A's PO waits for acknowledgment. */
  orderId: string;
  purchaseOrderId: string;
  /** An award proposed and waiting for approval. */
  pendingApprovalId: string;
  secrets: Record<string, string>;
}

export const STATE_FILE = join(__dirname, '..', '.state', 'world.json');

export function world(): World {
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as World;
}
