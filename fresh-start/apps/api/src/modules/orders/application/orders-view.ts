import { Injectable } from '@nestjs/common';
import type {
  CustomerInvoice,
  CustomerOrder,
  CustomerOrderListItem,
  CustomerPaymentIntent,
  Installment,
  Invoice,
  PaymentIntent,
  PaymentTransaction,
  PurchaseOrder,
  SalesOrder,
  SupplierPurchaseOrder,
} from '@jobwork/contracts';
import { CUSTOMER_STATUS_LABEL, customerStatusOf, type DeliveryFact, nextStepFor, timelineFor } from '../domain/customer-status';
import {
  FinanceRepository,
  type InstallmentRecord,
  type InvoiceRecord,
  type PaymentIntentRecord,
  type PaymentTransactionRecord,
} from '../infrastructure/finance.repository';
import { OrdersRepository, type PurchaseOrderRecord, type SalesOrderRecord } from '../infrastructure/orders.repository';
import { ProductionRepository } from '../infrastructure/production.repository';
import { MoneyFlow } from './money-flow';

const OPEN_INTENT = new Set(['created', 'pending_customer', 'authorized']);

/**
 * DTO mapping for three audiences. The internal shapes carry everything; the customer
 * shapes are built by construction with no supplier, purchase order or cost field
 * (`BR-COM-05`); the supplier shape has no customer and no sell price.
 */
@Injectable()
export class OrdersView {
  constructor(
    private readonly orders: OrdersRepository,
    private readonly finance: FinanceRepository,
    private readonly money: MoneyFlow,
    private readonly production: ProductionRepository,
  ) {}

  // ----------------------------------------------------------------- internal

  installment(row: InstallmentRecord): Installment {
    return {
      installmentId: row.id,
      seq: row.seq,
      kind: row.kind,
      label: row.label,
      amountMinor: row.amountMinor,
      currency: row.currency,
      trigger: row.trigger,
      status: row.status,
      invoiceId: row.invoiceId,
    };
  }

  invoice(row: InvoiceRecord): Invoice {
    return {
      invoiceId: row.id,
      number: row.number,
      salesOrderId: row.salesOrderId,
      salesOrderNumber: row.salesOrderNumber,
      installmentId: row.installmentId,
      customerOrganizationId: row.customerOrganizationId,
      kind: row.kind,
      currency: row.currency,
      lines: row.lines,
      subtotalMinor: row.subtotalMinor,
      taxRateBp: row.taxRateBp,
      taxMinor: row.taxMinor,
      totalMinor: row.totalMinor,
      paidMinor: row.paidMinor,
      openMinor: row.status === 'void' ? 0 : row.totalMinor - row.paidMinor,
      status: row.status,
      contentHash: row.contentHash,
      issuedAt: row.issuedAt.toISOString(),
      dueAt: row.dueAt.toISOString(),
      aggregateVersion: row.aggregateVersion,
    };
  }

  purchaseOrder(row: PurchaseOrderRecord): PurchaseOrder {
    return {
      purchaseOrderId: row.id,
      number: row.number,
      salesOrderId: row.salesOrderId,
      salesOrderNumber: row.salesOrderNumber,
      awardId: row.awardId,
      supplierOrganizationId: row.supplierOrganizationId,
      supplierDisplayName: row.supplierDisplayName,
      status: row.status,
      baselineStatus: row.baselineStatus,
      currency: row.currency,
      totalMinor: row.totalMinor,
      leadTimeDays: row.leadTimeDays,
      paymentTerms: row.paymentTerms,
      instructions: row.instructions,
      contentHash: row.contentHash,
      issuedAt: row.issuedAt.toISOString(),
      acknowledgedAt: row.acknowledgedAt ? row.acknowledgedAt.toISOString() : null,
      acknowledgmentNote: row.acknowledgmentNote,
      lines: row.lines,
      aggregateVersion: row.aggregateVersion,
    };
  }

  async salesOrder(row: SalesOrderRecord): Promise<SalesOrder> {
    const [installments, invoices, purchaseOrders, gate] = await Promise.all([
      this.finance.listInstallments(row.id),
      this.finance.listInvoicesForOrder(row.id),
      this.orders.listPurchaseOrdersForSalesOrder(row.id),
      this.money.gate(row),
    ]);
    return {
      salesOrderId: row.id,
      number: row.number,
      customerOrganizationId: row.customerOrganizationId,
      customerDisplayName: row.customerDisplayName,
      enquiryId: row.enquiryId,
      enquiryReference: row.enquiryReference,
      quoteId: row.customerQuoteId,
      quoteReference: row.quoteReference,
      acceptedQuoteVersionNo: row.acceptedQuoteVersionNo,
      title: row.title,
      currency: row.currency,
      totalMinor: row.totalMinor,
      deliveryLeadDays: row.deliveryLeadDays,
      deliverySiteId: row.deliverySiteId,
      status: row.status,
      commercialReleasedAt: row.commercialReleasedAt ? row.commercialReleasedAt.toISOString() : null,
      commercialReleaseBasis: row.commercialReleaseBasis,
      acceptance: {
        acceptanceId: row.acceptance.id,
        quoteVersionNo: row.acceptedQuoteVersionNo,
        contentHash: row.acceptance.contentHash,
        termsVersionNo: row.acceptance.termsVersionNo,
        termsHash: row.acceptance.termsHash,
        acceptedBy: row.acceptance.acceptedBy,
        acceptedByName: row.acceptance.acceptedByName,
        acceptedAt: row.acceptance.acceptedAt.toISOString(),
        authoritySnapshot: row.acceptance.authoritySnapshot,
      },
      contractHash: row.contractHash,
      lines: row.lines,
      installments: installments.map((i) => this.installment(i)),
      invoices: invoices.map((i) => this.invoice(i)),
      purchaseOrders: purchaseOrders.map((p) => this.purchaseOrder(p)),
      gate,
      aggregateVersion: row.aggregateVersion,
      createdAt: row.createdAt.toISOString(),
    };
  }

  intent(row: PaymentIntentRecord): PaymentIntent {
    return {
      paymentIntentId: row.id,
      invoiceId: row.invoiceId,
      invoiceNumber: row.invoiceNumber,
      salesOrderId: row.salesOrderId,
      amountMinor: row.amountMinor,
      currency: row.currency,
      provider: row.provider,
      providerIntentId: row.providerIntentId,
      checkoutUrl: row.checkoutUrl,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      lastEventAt: row.lastEventAt ? row.lastEventAt.toISOString() : null,
    };
  }

  transaction(row: PaymentTransactionRecord): PaymentTransaction {
    const allocated = row.allocations.reduce((sum, a) => sum + a.amountMinor, 0);
    return {
      transactionId: row.id,
      provider: row.provider,
      providerTransactionId: row.providerTransactionId,
      intentId: row.intentId,
      customerOrganizationId: row.customerOrganizationId,
      customerDisplayName: row.customerDisplayName,
      kind: row.kind,
      amountMinor: row.amountMinor,
      currency: row.currency,
      occurredAt: row.occurredAt.toISOString(),
      receivedAt: row.receivedAt.toISOString(),
      reference: row.reference,
      status: row.status,
      note: row.note,
      allocations: row.allocations.map((a) => ({ invoiceId: a.invoiceId, invoiceNumber: a.invoiceNumber, amountMinor: a.amountMinor, approvalRequestId: a.approvalRequestId })),
      unappliedMinor: row.status === 'suspense' ? row.amountMinor - allocated : 0,
    };
  }

  // ----------------------------------------------------------------- customer

  async customerInvoice(row: InvoiceRecord): Promise<CustomerInvoice> {
    const intents = await this.finance.listIntentsForInvoice(row.id);
    const pending = intents.find((i) => OPEN_INTENT.has(i.status) && i.expiresAt.getTime() > Date.now()) ?? null;
    const status = row.status === 'issued' ? 'unpaid' : row.status;
    const label = status === 'unpaid' ? 'Unpaid' : status === 'partially_paid' ? 'Partly paid' : status === 'paid' ? 'Paid' : 'Void';
    return {
      invoiceId: row.id,
      number: row.number,
      orderId: row.salesOrderId,
      orderNumber: row.salesOrderNumber,
      orderTitle: row.salesOrderTitle,
      kind: row.kind,
      currency: row.currency,
      lines: row.lines,
      subtotalMinor: row.subtotalMinor,
      taxRateBp: row.taxRateBp,
      taxMinor: row.taxMinor,
      totalMinor: row.totalMinor,
      paidMinor: row.paidMinor,
      openMinor: row.status === 'void' ? 0 : row.totalMinor - row.paidMinor,
      status,
      statusLabel: label,
      issuedAt: row.issuedAt.toISOString(),
      dueAt: row.dueAt.toISOString(),
      contentHash: row.contentHash,
      pendingPayment: pending ? { paymentIntentId: pending.id, status: pending.status, createdAt: pending.createdAt.toISOString() } : null,
    };
  }

  /** Leg 2 as the customer's timeline reads it (IN-17). */
  private async deliveryFacts(orderId: string): Promise<Array<DeliveryFact & { shipmentId: string }>> {
    const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
    return (await this.orders.customerDeliveryFacts(orderId)).map((d) => ({
      shipmentId: d.shipmentId,
      status: d.status,
      dispatchedAt: iso(d.dispatchedAt),
      carrier: d.carrier,
      tracking: d.tracking,
      deliveredAt: iso(d.deliveredAt),
      dueAt: iso(d.dueAt),
      acceptedAt: iso(d.acceptedAt),
      basis: d.basis,
      addressNeeded: d.addressNeeded,
    }));
  }

  private expectedDelivery(row: SalesOrderRecord): string | null {
    // A date is only promised once the order is released; before that it would be a guess (doc 06 §13).
    if (!row.commercialReleasedAt) return null;
    return new Date(row.commercialReleasedAt.getTime() + row.deliveryLeadDays * 86_400_000).toISOString().slice(0, 10);
  }

  async customerOrderListItem(row: SalesOrderRecord): Promise<CustomerOrderListItem> {
    const status = customerStatusOf(row.status);
    const invoices = await this.finance.listInvoicesForOrder(row.id);
    const open = invoices.find((i) => i.status === 'issued' || i.status === 'partially_paid');
    const deliveries = await this.deliveryFacts(row.id);
    const address = deliveries.find((d) => d.addressNeeded);
    const confirm = deliveries.find((d) => d.status === 'receiving_check');
    return {
      orderId: row.id,
      number: row.number,
      title: row.title,
      status,
      statusLabel: CUSTOMER_STATUS_LABEL[status],
      currency: row.currency,
      totalMinor: row.totalMinor,
      acceptedAt: row.acceptance.acceptedAt.toISOString(),
      expectedDeliveryAt: this.expectedDelivery(row),
      actionNeeded: open
        ? { kind: open.kind === 'advance' ? 'pay_advance' : 'pay_balance', label: open.kind === 'advance' ? 'Pay the advance' : 'Pay the balance', invoiceId: open.id, shipmentId: null }
        : address
          ? { kind: 'confirm_address', label: 'Confirm the delivery address', invoiceId: null, shipmentId: address.shipmentId }
          : confirm
            ? { kind: 'confirm_delivery', label: 'Confirm the delivery', invoiceId: null, shipmentId: confirm.shipmentId }
            : null,
    };
  }

  async customerOrder(row: SalesOrderRecord): Promise<CustomerOrder> {
    const status = customerStatusOf(row.status);
    const [installments, invoices, production, deliveries] = await Promise.all([
      this.finance.listInstallments(row.id),
      this.finance.listInvoicesForOrder(row.id),
      this.production.customerProgress(row.id),
      this.deliveryFacts(row.id),
    ]);
    const advance = installments.find((i) => i.kind === 'advance');
    const advanceInvoice = advance?.invoiceId ? invoices.find((i) => i.id === advance.invoiceId) : undefined;
    const open = invoices.find((i) => i.status === 'issued' || i.status === 'partially_paid') ?? null;
    return {
      orderId: row.id,
      number: row.number,
      title: row.title,
      status,
      statusLabel: CUSTOMER_STATUS_LABEL[status],
      quotation: { quotationId: row.customerQuoteId, reference: row.quoteReference ?? '', versionNo: row.acceptedQuoteVersionNo },
      enquiry: { enquiryId: row.enquiryId, reference: row.enquiryReference },
      currency: row.currency,
      lines: row.lines,
      totalMinor: row.totalMinor,
      acceptedAt: row.acceptance.acceptedAt.toISOString(),
      acceptedBy: row.acceptance.acceptedByName,
      deliveryLeadDays: row.deliveryLeadDays,
      expectedDeliveryAt: this.expectedDelivery(row),
      contractHash: row.contractHash,
      installments: installments.map((i) => this.installment(i)),
      invoices: await Promise.all(invoices.map((i) => this.customerInvoice(i))),
      timeline: timelineFor({
        status,
        acceptedAt: row.acceptance.acceptedAt.toISOString(),
        advanceInvoiced: Boolean(advanceInvoice),
        advancePaidAt: advanceInvoice?.status === 'paid' && row.commercialReleasedAt ? row.commercialReleasedAt.toISOString() : null,
        commercialReleasedAt: row.commercialReleasedAt ? row.commercialReleasedAt.toISOString() : null,
        releaseBasis: row.commercialReleaseBasis,
        baselineReleasedAt: production.baselineReleasedAt ? production.baselineReleasedAt.toISOString() : null,
        progress: production.progress,
        scheduleUnderReview: production.slipped,
        deliveries,
      }),
      progress: production.progress,
      scheduleUnderReview: production.slipped,
      nextStep: nextStepFor({ status, openInvoice: open ? { number: open.number, kind: open.kind } : null, deliveries }),
      aggregateVersion: row.aggregateVersion,
    };
  }

  customerIntent(row: PaymentIntentRecord, orderNumber: string, simulated: boolean): CustomerPaymentIntent {
    return {
      paymentIntentId: row.id,
      invoiceId: row.invoiceId,
      invoiceNumber: row.invoiceNumber,
      orderNumber,
      amountMinor: row.amountMinor,
      currency: row.currency,
      status: row.status,
      provider: row.provider,
      checkoutUrl: row.checkoutUrl,
      expiresAt: row.expiresAt.toISOString(),
      simulated,
    };
  }

  // ----------------------------------------------------------------- supplier

  supplierPurchaseOrder(row: PurchaseOrderRecord, workReleased = false): SupplierPurchaseOrder {
    const beforeWork: string[] = [];
    if (row.status === 'issued') beforeWork.push('Acknowledge this purchase order so JobWork knows you accept its lines, price and lead time.');
    if (row.baselineStatus === 'pending_baseline') {
      beforeWork.push('Wait for JobWork to release the technical baseline: the controlled drawing pack and inspection plan this order is made to.');
    }
    if (!workReleased) {
      beforeWork.push('Do not start production until JobWork releases the work package. Material bought or parts made before release are at your own risk.');
    }
    return {
      purchaseOrderId: row.id,
      number: row.number,
      status: row.status,
      baselineStatus: row.baselineStatus,
      rfqReference: row.rfqReference,
      currency: row.currency,
      totalMinor: row.totalMinor,
      leadTimeDays: row.leadTimeDays,
      paymentTerms: row.paymentTerms,
      instructions: row.instructions,
      contentHash: row.contentHash,
      issuedAt: row.issuedAt.toISOString(),
      acknowledgedAt: row.acknowledgedAt ? row.acknowledgedAt.toISOString() : null,
      acknowledgmentNote: row.acknowledgmentNote,
      lines: row.lines,
      beforeWork,
      aggregateVersion: row.aggregateVersion,
    };
  }
}
