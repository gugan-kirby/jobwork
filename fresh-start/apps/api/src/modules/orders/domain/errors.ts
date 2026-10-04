import { DomainError } from '../../../platform/http/domain-error';

/** Business refusals of the orders and finance module (IN-08). Codes are stable (`ES-12`). */

export class OrderNotFound extends DomainError {
  constructor() {
    super('ORDER_NOT_FOUND', 404, 'Order not found');
  }
}

export class PurchaseOrderNotFound extends DomainError {
  constructor() {
    super('PURCHASE_ORDER_NOT_FOUND', 404, 'Purchase order not found');
  }
}

export class InvoiceNotFound extends DomainError {
  constructor() {
    super('INVOICE_NOT_FOUND', 404, 'Invoice not found');
  }
}

export class PaymentIntentNotFound extends DomainError {
  constructor() {
    super('PAYMENT_INTENT_NOT_FOUND', 404, 'Payment not found');
  }
}

export class TransactionNotFound extends DomainError {
  constructor() {
    super('PAYMENT_TRANSACTION_NOT_FOUND', 404, 'Payment transaction not found');
  }
}

export class InstallmentNotFound extends DomainError {
  constructor() {
    super('INSTALLMENT_NOT_FOUND', 404, 'Instalment not found');
  }
}

export class CreditHoldNotFound extends DomainError {
  constructor() {
    super('CREDIT_HOLD_NOT_FOUND', 404, 'Credit hold not found');
  }
}

/** `FR-407`: what the customer is looking at is not what would be bound. */
export class QuoteContentMismatch extends DomainError {
  constructor(field: 'version' | 'content' | 'terms') {
    const detail =
      field === 'version'
        ? 'A newer revision of this quotation exists. Reload and read it before accepting.'
        : field === 'terms'
          ? 'The terms have changed since you loaded this page. Reload and read them again.'
          : 'The quotation content changed since you loaded this page. Reload and read it again.';
    super('QUOTE_CONTENT_MISMATCH', 409, 'This is not the revision you are accepting', detail);
  }
}

/** `D-07`: the actor may approve, but not this much. */
export class ApprovalLimitExceeded extends DomainError {
  constructor(limitMinor: number, totalMinor: number, currency: string) {
    super(
      'APPROVAL_LIMIT_EXCEEDED',
      403,
      'This quotation is above your acceptance limit',
      `Your limit is ${currency} ${(limitMinor / 100).toFixed(2)}; this quotation totals ${currency} ${(totalMinor / 100).toFixed(2)}. Ask an approver in your organization with a higher limit to accept it.`,
    );
  }
}

export class OrderVersionConflict extends DomainError {
  constructor(expected: number, actual: number) {
    super('VERSION_CONFLICT', 409, 'The order changed since you loaded it', `You were working from version ${expected}; it is now ${actual}. Reload before acting.`);
  }
}

export class OrderNotInStatus extends DomainError {
  constructor(status: string, needed: string) {
    super('ORDER_NOT_IN_STATUS', 409, 'The order is not at that step', `It is ${status.replace(/_/g, ' ')}; this needs ${needed.replace(/_/g, ' ')}.`);
  }
}

/** doc 06 §7: the commercial release gate did not pass; the reasons are the message. */
export class CommercialGateFailed extends DomainError {
  constructor(reasons: string[]) {
    super('COMMERCIAL_GATE_FAILED', 409, 'The order cannot be released commercially yet', reasons.join(' '));
  }
}

export class PurchaseOrderNotActionable extends DomainError {
  constructor(status: string) {
    super('PURCHASE_ORDER_NOT_ACTIONABLE', 409, 'This purchase order cannot be acted on', `It is ${status}.`);
  }
}

export class InvoiceNotPayable extends DomainError {
  constructor(status: string) {
    super(
      status === 'paid' ? 'INVOICE_ALREADY_PAID' : 'INVOICE_NOT_PAYABLE',
      409,
      status === 'paid' ? 'This invoice is already settled' : 'This invoice cannot be paid',
      status === 'void' ? 'It was voided.' : undefined,
    );
  }
}

export class InstallmentNotIssuable extends DomainError {
  constructor(status: string) {
    super('INSTALLMENT_NOT_ISSUABLE', 409, 'This instalment cannot be invoiced', `It is ${status}.`);
  }
}

export class PaymentIntentNotOpen extends DomainError {
  constructor(status: string) {
    super('PAYMENT_INTENT_NOT_OPEN', 409, 'This payment is no longer open', `It is ${status.replace(/_/g, ' ')}.`);
  }
}

export class WebhookRejected extends DomainError {
  constructor(reason: string) {
    super('WEBHOOK_REJECTED', 401, 'Webhook rejected', reason);
  }
}

export class SimulationUnavailable extends DomainError {
  constructor() {
    super('PAYMENT_SIMULATION_UNAVAILABLE', 404, 'Not available', 'Only the development gateway can simulate a payment.');
  }
}

export class AllocationInvalid extends DomainError {
  constructor(detail: string) {
    super('ALLOCATION_INVALID', 422, 'That allocation does not add up', detail);
  }
}

export class CreditHoldAlreadyReleased extends DomainError {
  constructor() {
    super('CREDIT_HOLD_RELEASED', 409, 'That hold was already released');
  }
}
