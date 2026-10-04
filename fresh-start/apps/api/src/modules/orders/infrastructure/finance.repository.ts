import { Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import type { BalanceTrigger, InvoiceLine, InvoiceStatus, PaymentIntentStatus } from '@jobwork/contracts';
import { DatabaseService } from '../../../platform/database/database.service';

type Queryable = Pool | PoolClient;

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

export interface InstallmentRecord {
  id: string;
  salesOrderId: string;
  seq: number;
  kind: 'advance' | 'balance' | 'change';
  label: string;
  amountMinor: number;
  currency: string;
  trigger: BalanceTrigger;
  status: 'pending' | 'invoiced' | 'paid' | 'waived';
  invoiceId: string | null;
}

export interface InvoiceRecord {
  id: string;
  number: string;
  salesOrderId: string;
  salesOrderNumber: string;
  salesOrderTitle: string;
  installmentId: string | null;
  customerOrganizationId: string;
  customerDisplayName: string;
  kind: 'advance' | 'balance' | 'final' | 'change';
  currency: string;
  lines: InvoiceLine[];
  subtotalMinor: number;
  taxRateBp: number;
  taxMinor: number;
  totalMinor: number;
  contentHash: string;
  issuedAt: Date;
  issuedBy: string;
  dueAt: Date;
  paidMinor: number;
  status: InvoiceStatus;
  aggregateVersion: number;
}

export interface CreditProfileRecord {
  id: string;
  customerOrganizationId: string;
  limitMinor: number;
  currency: string;
  termsDays: number;
  approvedBy: string;
  approvedAt: Date;
  validUntil: string | null;
  note: string;
  aggregateVersion: number;
}

export interface CreditHoldRecord {
  id: string;
  customerOrganizationId: string;
  reason: string;
  placedBy: string;
  placedAt: Date;
  releasedBy: string | null;
  releasedAt: Date | null;
  releaseReason: string | null;
}

export interface PaymentIntentRecord {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  salesOrderId: string;
  customerOrganizationId: string;
  amountMinor: number;
  currency: string;
  provider: string;
  providerIntentId: string;
  checkoutUrl: string;
  status: PaymentIntentStatus;
  createdBy: string;
  createdAt: Date;
  expiresAt: Date;
  lastEventAt: Date | null;
}

export interface AllocationRecord {
  id: string;
  transactionId: string;
  invoiceId: string;
  invoiceNumber: string;
  amountMinor: number;
  allocatedBy: string | null;
  allocatedAt: Date;
  approvalRequestId: string | null;
}

export interface PaymentTransactionRecord {
  id: string;
  provider: string;
  providerTransactionId: string;
  intentId: string | null;
  customerOrganizationId: string | null;
  customerDisplayName: string | null;
  kind: 'authorize' | 'capture' | 'refund' | 'reversal' | 'bank_transfer';
  amountMinor: number;
  currency: string;
  occurredAt: Date;
  receivedAt: Date;
  reference: string;
  status: 'recorded' | 'allocated' | 'suspense' | 'ignored';
  journalId: string | null;
  note: string;
  allocations: AllocationRecord[];
}

export interface UnappliedCreditRecord {
  id: string;
  customerOrganizationId: string;
  customerDisplayName: string;
  transactionId: string;
  amountMinor: number;
  currency: string;
  createdAt: Date;
}

export interface JournalLineInput {
  account: string;
  debitMinor?: number;
  creditMinor?: number;
  costObjectType?: string;
  costObjectId?: string;
}

/**
 * Persistence for the money side: instalments, invoices, journals, credit, intents,
 * provider transactions, allocations and webhook receipts. No method here decides
 * anything; the balanced-journal rule is the database's and the commands' job.
 */
@Injectable()
export class FinanceRepository {
  constructor(private readonly db: DatabaseService) {}

  private q(tx?: Queryable): Queryable {
    return tx ?? this.db.pool;
  }

  // ----------------------------------------------------------------- instalments

  async createInstallments(
    rows: Array<{ salesOrderId: string; seq: number; kind: 'advance' | 'balance'; label: string; amountMinor: number; currency: string; trigger: BalanceTrigger }>,
    tx: Queryable,
  ): Promise<InstallmentRecord[]> {
    const out: InstallmentRecord[] = [];
    for (const row of rows) {
      const res = await tx.query<{ id: string }>(
        `INSERT INTO finance.installment (sales_order_id, seq, kind, label, amount_minor, currency, trigger)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [row.salesOrderId, row.seq, row.kind, row.label, row.amountMinor, row.currency, row.trigger],
      );
      out.push({ id: res.rows[0]!.id, ...row, status: 'pending', invoiceId: null });
    }
    return out;
  }

  async listInstallments(salesOrderId: string, tx?: Queryable): Promise<InstallmentRecord[]> {
    const res = await this.q(tx).query(
      `SELECT id, sales_order_id AS "salesOrderId", seq, kind, label, amount_minor AS "amountMinor", currency, trigger, status, invoice_id AS "invoiceId"
         FROM finance.installment WHERE sales_order_id = $1 ORDER BY seq`,
      [salesOrderId],
    );
    return res.rows.map((row: Record<string, unknown>) => ({ ...(row as unknown as InstallmentRecord), amountMinor: num(row['amountMinor']) }));
  }

  async setInstallmentStatus(input: { installmentId: string; status: InstallmentRecord['status']; invoiceId?: string | undefined }, tx: Queryable): Promise<void> {
    await tx.query(
      `UPDATE finance.installment SET status = $2, invoice_id = COALESCE($3, invoice_id), updated_at = now() WHERE id = $1`,
      [input.installmentId, input.status, input.invoiceId ?? null],
    );
  }

  // ----------------------------------------------------------------- invoices

  async createInvoice(
    input: {
      number: string;
      salesOrderId: string;
      installmentId: string | null;
      customerOrganizationId: string;
      kind: InvoiceRecord['kind'];
      currency: string;
      lines: InvoiceLine[];
      subtotalMinor: number;
      taxRateBp: number;
      taxMinor: number;
      totalMinor: number;
      contentHash: string;
      issuedBy: string;
      dueAt: Date;
    },
    tx: Queryable,
  ): Promise<string> {
    const res = await tx.query<{ id: string }>(
      `INSERT INTO finance.invoice
         (number, sales_order_id, installment_id, customer_organization_id, kind, currency, lines, subtotal_minor, tax_rate_bp,
          tax_minor, total_minor, content_hash, issued_by, due_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [
        input.number, input.salesOrderId, input.installmentId, input.customerOrganizationId, input.kind, input.currency,
        JSON.stringify(input.lines), input.subtotalMinor, input.taxRateBp, input.taxMinor, input.totalMinor, input.contentHash, input.issuedBy, input.dueAt,
      ],
    );
    return res.rows[0]!.id;
  }

  async findInvoice(id: string, tx?: Queryable, forUpdate = false): Promise<InvoiceRecord | null> {
    const res = await this.q(tx).query(
      `SELECT i.id, i.number, i.sales_order_id AS "salesOrderId", o.number AS "salesOrderNumber", o.title AS "salesOrderTitle",
              i.installment_id AS "installmentId", i.customer_organization_id AS "customerOrganizationId", c.display_name AS "customerDisplayName",
              i.kind, i.currency, i.lines, i.subtotal_minor AS "subtotalMinor", i.tax_rate_bp AS "taxRateBp", i.tax_minor AS "taxMinor",
              i.total_minor AS "totalMinor", i.content_hash AS "contentHash", i.issued_at AS "issuedAt", i.issued_by AS "issuedBy",
              i.due_at AS "dueAt", i.paid_minor AS "paidMinor", i.status, i.aggregate_version AS "aggregateVersion"
         FROM finance.invoice i
         JOIN orders.sales_order o ON o.id = i.sales_order_id
         JOIN iam.organization c ON c.id = i.customer_organization_id
        WHERE i.id = $1 ${forUpdate ? 'FOR UPDATE OF i' : ''}`,
      [id],
    );
    const row = res.rows[0] as InvoiceRecord | undefined;
    if (!row) return null;
    return { ...row, subtotalMinor: num(row.subtotalMinor), taxMinor: num(row.taxMinor), totalMinor: num(row.totalMinor), paidMinor: num(row.paidMinor) };
  }

  private async invoicesByIds(ids: string[], tx?: Queryable): Promise<InvoiceRecord[]> {
    const out: InvoiceRecord[] = [];
    for (const id of ids) {
      const row = await this.findInvoice(id, tx);
      if (row) out.push(row);
    }
    return out;
  }

  async listInvoicesForOrder(salesOrderId: string, tx?: Queryable): Promise<InvoiceRecord[]> {
    const res = await this.q(tx).query<{ id: string }>(`SELECT id FROM finance.invoice WHERE sales_order_id = $1 ORDER BY issued_at`, [salesOrderId]);
    return this.invoicesByIds(res.rows.map((r) => r.id), tx);
  }

  async listInvoicesForCustomer(customerOrganizationId: string): Promise<InvoiceRecord[]> {
    const res = await this.db.pool.query<{ id: string }>(
      `SELECT id FROM finance.invoice WHERE customer_organization_id = $1 ORDER BY issued_at DESC`,
      [customerOrganizationId],
    );
    return this.invoicesByIds(res.rows.map((r) => r.id));
  }

  async listInvoices(filter: { status?: InvoiceStatus | undefined }, limit: number): Promise<InvoiceRecord[]> {
    const res = await this.db.pool.query<{ id: string }>(
      `SELECT id FROM finance.invoice WHERE ($1::text IS NULL OR status = $1) ORDER BY issued_at DESC LIMIT $2`,
      [filter.status ?? null, limit],
    );
    return this.invoicesByIds(res.rows.map((r) => r.id));
  }

  /** Records a receipt against an invoice; the status follows the money (check constraint). */
  async applyPayment(input: { invoiceId: string; amountMinor: number }, tx: Queryable): Promise<{ paidMinor: number; status: InvoiceStatus }> {
    const res = await tx.query<{ paid_minor: string; status: InvoiceStatus }>(
      `UPDATE finance.invoice
          SET paid_minor = paid_minor + $2,
              status = CASE WHEN paid_minor + $2 >= total_minor THEN 'paid' WHEN paid_minor + $2 > 0 THEN 'partially_paid' ELSE status END,
              aggregate_version = aggregate_version + 1, updated_at = now()
        WHERE id = $1 RETURNING paid_minor, status`,
      [input.invoiceId, input.amountMinor],
    );
    return { paidMinor: num(res.rows[0]!.paid_minor), status: res.rows[0]!.status };
  }

  /** Open receivables for a customer, optionally excluding one order's own invoices. */
  async openReceivables(customerOrganizationId: string, excludeSalesOrderId: string | null, tx?: Queryable): Promise<number> {
    const res = await this.q(tx).query<{ open: string }>(
      `SELECT COALESCE(SUM(total_minor - paid_minor), 0) AS open
         FROM finance.invoice
        WHERE customer_organization_id = $1 AND status IN ('issued', 'partially_paid')
          AND ($2::uuid IS NULL OR sales_order_id <> $2)`,
      [customerOrganizationId, excludeSalesOrderId],
    );
    return num(res.rows[0]!.open);
  }

  /** The price delta of the order amendment a change installment carries (IN-13). */
  async changeAmendmentAmount(installmentId: string, tx: Queryable): Promise<number | null> {
    const res = await tx.query<{ price_delta_minor: string }>(`SELECT price_delta_minor FROM orders.order_amendment WHERE installment_id = $1`, [installmentId]);
    return res.rows[0] ? Number(res.rows[0].price_delta_minor) : null;
  }

  // ----------------------------------------------------------------- journals

  async postJournal(
    input: { sourceType: string; sourceId: string | null; description: string; currency: string; correlationId: string; lines: JournalLineInput[] },
    tx: Queryable,
  ): Promise<string> {
    const res = await tx.query<{ id: string }>(
      `INSERT INTO finance.journal (source_type, source_id, description, currency, correlation_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [input.sourceType, input.sourceId, input.description, input.currency, input.correlationId],
    );
    const id = res.rows[0]!.id;
    for (const line of input.lines) {
      if ((line.debitMinor ?? 0) === 0 && (line.creditMinor ?? 0) === 0) continue;
      await tx.query(
        `INSERT INTO finance.journal_line (journal_id, account_code, debit_minor, credit_minor, cost_object_type, cost_object_id)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, line.account, line.debitMinor ?? 0, line.creditMinor ?? 0, line.costObjectType ?? null, line.costObjectId ?? null],
      );
    }
    return id;
  }

  // ----------------------------------------------------------------- credit

  async findCreditProfile(customerOrganizationId: string, tx?: Queryable): Promise<CreditProfileRecord | null> {
    const res = await this.q(tx).query(
      `SELECT id, customer_organization_id AS "customerOrganizationId", limit_minor AS "limitMinor", currency, terms_days AS "termsDays",
              approved_by AS "approvedBy", approved_at AS "approvedAt", valid_until AS "validUntil", note, aggregate_version AS "aggregateVersion"
         FROM finance.credit_profile WHERE customer_organization_id = $1`,
      [customerOrganizationId],
    );
    const row = res.rows[0] as CreditProfileRecord | undefined;
    return row ? { ...row, limitMinor: num(row.limitMinor) } : null;
  }

  async upsertCreditProfile(
    input: { customerOrganizationId: string; limitMinor: number; currency: string; termsDays: number; approvedBy: string; validUntil: string | null; note: string },
    tx: Queryable,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO finance.credit_profile (customer_organization_id, limit_minor, currency, terms_days, approved_by, valid_until, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (customer_organization_id) DO UPDATE
         SET limit_minor = EXCLUDED.limit_minor, currency = EXCLUDED.currency, terms_days = EXCLUDED.terms_days,
             approved_by = EXCLUDED.approved_by, approved_at = now(), valid_until = EXCLUDED.valid_until, note = EXCLUDED.note,
             aggregate_version = finance.credit_profile.aggregate_version + 1, updated_at = now()`,
      [input.customerOrganizationId, input.limitMinor, input.currency, input.termsDays, input.approvedBy, input.validUntil, input.note],
    );
  }

  async listActiveHolds(customerOrganizationId: string, tx?: Queryable): Promise<CreditHoldRecord[]> {
    const res = await this.q(tx).query(
      `SELECT id, customer_organization_id AS "customerOrganizationId", reason, placed_by AS "placedBy", placed_at AS "placedAt",
              released_by AS "releasedBy", released_at AS "releasedAt", release_reason AS "releaseReason"
         FROM finance.credit_hold WHERE customer_organization_id = $1 AND released_at IS NULL ORDER BY placed_at`,
      [customerOrganizationId],
    );
    return res.rows as CreditHoldRecord[];
  }

  async findHold(holdId: string, tx?: Queryable): Promise<CreditHoldRecord | null> {
    const res = await this.q(tx).query(
      `SELECT id, customer_organization_id AS "customerOrganizationId", reason, placed_by AS "placedBy", placed_at AS "placedAt",
              released_by AS "releasedBy", released_at AS "releasedAt", release_reason AS "releaseReason"
         FROM finance.credit_hold WHERE id = $1`,
      [holdId],
    );
    return (res.rows[0] as CreditHoldRecord | undefined) ?? null;
  }

  async createHold(input: { customerOrganizationId: string; reason: string; placedBy: string }, tx: Queryable): Promise<string> {
    const res = await tx.query<{ id: string }>(
      `INSERT INTO finance.credit_hold (customer_organization_id, reason, placed_by) VALUES ($1,$2,$3) RETURNING id`,
      [input.customerOrganizationId, input.reason, input.placedBy],
    );
    return res.rows[0]!.id;
  }

  async releaseHold(input: { holdId: string; releasedBy: string; reason: string }, tx: Queryable): Promise<void> {
    await tx.query(
      `UPDATE finance.credit_hold SET released_by = $2, released_at = now(), release_reason = $3 WHERE id = $1 AND released_at IS NULL`,
      [input.holdId, input.releasedBy, input.reason],
    );
  }

  // ----------------------------------------------------------------- payment intents

  async createIntent(
    input: {
      invoiceId: string;
      salesOrderId: string;
      customerOrganizationId: string;
      amountMinor: number;
      currency: string;
      provider: string;
      providerIntentId: string;
      checkoutUrl: string;
      createdBy: string;
      expiresAt: Date;
      id: string;
    },
    tx: Queryable,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO finance.payment_intent
         (id, invoice_id, sales_order_id, customer_organization_id, amount_minor, currency, provider, provider_intent_id, checkout_url, status, created_by, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending_customer',$10,$11)`,
      [input.id, input.invoiceId, input.salesOrderId, input.customerOrganizationId, input.amountMinor, input.currency, input.provider, input.providerIntentId, input.checkoutUrl, input.createdBy, input.expiresAt],
    );
  }

  private readonly intentSelect = `
      SELECT p.id, p.invoice_id AS "invoiceId", i.number AS "invoiceNumber", p.sales_order_id AS "salesOrderId",
             p.customer_organization_id AS "customerOrganizationId", p.amount_minor AS "amountMinor", p.currency, p.provider,
             p.provider_intent_id AS "providerIntentId", p.checkout_url AS "checkoutUrl", p.status, p.created_by AS "createdBy",
             p.created_at AS "createdAt", p.expires_at AS "expiresAt", p.last_event_at AS "lastEventAt"
        FROM finance.payment_intent p JOIN finance.invoice i ON i.id = p.invoice_id`;

  async findIntent(id: string, tx?: Queryable, forUpdate = false): Promise<PaymentIntentRecord | null> {
    const res = await this.q(tx).query(`${this.intentSelect} WHERE p.id = $1 ${forUpdate ? 'FOR UPDATE OF p' : ''}`, [id]);
    const row = res.rows[0] as PaymentIntentRecord | undefined;
    return row ? { ...row, amountMinor: num(row.amountMinor) } : null;
  }

  async findIntentByProvider(provider: string, providerIntentId: string, tx: Queryable): Promise<PaymentIntentRecord | null> {
    const res = await tx.query(`${this.intentSelect} WHERE p.provider = $1 AND p.provider_intent_id = $2 FOR UPDATE OF p`, [provider, providerIntentId]);
    const row = res.rows[0] as PaymentIntentRecord | undefined;
    return row ? { ...row, amountMinor: num(row.amountMinor) } : null;
  }

  async listIntentsForInvoice(invoiceId: string, tx?: Queryable): Promise<PaymentIntentRecord[]> {
    const res = await this.q(tx).query(`${this.intentSelect} WHERE p.invoice_id = $1 ORDER BY p.created_at DESC`, [invoiceId]);
    return (res.rows as PaymentIntentRecord[]).map((row) => ({ ...row, amountMinor: num(row.amountMinor) }));
  }

  /** Intents still waiting on the customer after their expiry: the reconcile sweep's work list. */
  async listStaleIntents(now: Date, tx?: Queryable): Promise<string[]> {
    const res = await this.q(tx).query<{ id: string }>(
      `SELECT id FROM finance.payment_intent WHERE status IN ('created', 'pending_customer') AND expires_at < $1 ORDER BY expires_at LIMIT 500`,
      [now],
    );
    return res.rows.map((r) => r.id);
  }

  async setIntentStatus(input: { intentId: string; status: PaymentIntentStatus }, tx: Queryable): Promise<void> {
    await tx.query(
      `UPDATE finance.payment_intent SET status = $2, last_event_at = now(), updated_at = now() WHERE id = $1`,
      [input.intentId, input.status],
    );
  }

  // ----------------------------------------------------------------- transactions and allocations

  /** Returns null when the provider transaction id was already recorded (the replay guard). */
  async createTransaction(
    input: {
      provider: string;
      providerTransactionId: string;
      intentId: string | null;
      customerOrganizationId: string | null;
      kind: PaymentTransactionRecord['kind'];
      amountMinor: number;
      currency: string;
      occurredAt: Date;
      reference: string;
      status: PaymentTransactionRecord['status'];
      note: string;
    },
    tx: Queryable,
  ): Promise<string | null> {
    const res = await tx.query<{ id: string }>(
      `INSERT INTO finance.payment_transaction
         (provider, provider_transaction_id, intent_id, customer_organization_id, kind, amount_minor, currency, occurred_at, reference, status, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (provider, provider_transaction_id) DO NOTHING RETURNING id`,
      [input.provider, input.providerTransactionId, input.intentId, input.customerOrganizationId, input.kind, input.amountMinor, input.currency, input.occurredAt, input.reference, input.status, input.note],
    );
    return res.rows[0]?.id ?? null;
  }

  async findTransaction(id: string, tx?: Queryable, forUpdate = false): Promise<PaymentTransactionRecord | null> {
    const res = await this.q(tx).query(
      `SELECT t.id, t.provider, t.provider_transaction_id AS "providerTransactionId", t.intent_id AS "intentId",
              t.customer_organization_id AS "customerOrganizationId", c.display_name AS "customerDisplayName", t.kind,
              t.amount_minor AS "amountMinor", t.currency, t.occurred_at AS "occurredAt", t.received_at AS "receivedAt", t.reference,
              t.status, t.journal_id AS "journalId", t.note
         FROM finance.payment_transaction t
         LEFT JOIN iam.organization c ON c.id = t.customer_organization_id
        WHERE t.id = $1 ${forUpdate ? 'FOR UPDATE OF t' : ''}`,
      [id],
    );
    const row = res.rows[0] as Omit<PaymentTransactionRecord, 'allocations'> | undefined;
    if (!row) return null;
    return { ...row, amountMinor: num(row.amountMinor), allocations: await this.listAllocations(id, tx) };
  }

  async listAllocations(transactionId: string, tx?: Queryable): Promise<AllocationRecord[]> {
    const res = await this.q(tx).query(
      `SELECT a.id, a.transaction_id AS "transactionId", a.invoice_id AS "invoiceId", i.number AS "invoiceNumber", a.amount_minor AS "amountMinor",
              a.allocated_by AS "allocatedBy", a.allocated_at AS "allocatedAt", a.approval_request_id AS "approvalRequestId"
         FROM finance.payment_allocation a JOIN finance.invoice i ON i.id = a.invoice_id
        WHERE a.transaction_id = $1 ORDER BY a.allocated_at`,
      [transactionId],
    );
    return (res.rows as AllocationRecord[]).map((row) => ({ ...row, amountMinor: num(row.amountMinor) }));
  }

  async listTransactions(filter: { status?: PaymentTransactionRecord['status'] | undefined; customerOrganizationId?: string | undefined }, limit: number): Promise<PaymentTransactionRecord[]> {
    const res = await this.db.pool.query<{ id: string }>(
      `SELECT id FROM finance.payment_transaction
        WHERE ($1::text IS NULL OR status = $1) AND ($2::uuid IS NULL OR customer_organization_id = $2)
        ORDER BY received_at DESC LIMIT $3`,
      [filter.status ?? null, filter.customerOrganizationId ?? null, limit],
    );
    const out: PaymentTransactionRecord[] = [];
    for (const { id } of res.rows) {
      const row = await this.findTransaction(id);
      if (row) out.push(row);
    }
    return out;
  }

  async setTransactionStatus(input: { transactionId: string; status: PaymentTransactionRecord['status']; journalId?: string | undefined; customerOrganizationId?: string | undefined }, tx: Queryable): Promise<void> {
    await tx.query(
      `UPDATE finance.payment_transaction
          SET status = $2, journal_id = COALESCE($3, journal_id), customer_organization_id = COALESCE($4, customer_organization_id)
        WHERE id = $1`,
      [input.transactionId, input.status, input.journalId ?? null, input.customerOrganizationId ?? null],
    );
  }

  async createAllocation(
    input: { transactionId: string; invoiceId: string; amountMinor: number; allocatedBy: string | null; approvalRequestId: string | null; journalId: string },
    tx: Queryable,
  ): Promise<string> {
    const res = await tx.query<{ id: string }>(
      `INSERT INTO finance.payment_allocation (transaction_id, invoice_id, amount_minor, allocated_by, approval_request_id, journal_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [input.transactionId, input.invoiceId, input.amountMinor, input.allocatedBy, input.approvalRequestId, input.journalId],
    );
    return res.rows[0]!.id;
  }

  async createUnappliedCredit(input: { customerOrganizationId: string; transactionId: string; amountMinor: number; currency: string }, tx: Queryable): Promise<string> {
    const res = await tx.query<{ id: string }>(
      `INSERT INTO finance.unapplied_credit (customer_organization_id, transaction_id, amount_minor, currency) VALUES ($1,$2,$3,$4) RETURNING id`,
      [input.customerOrganizationId, input.transactionId, input.amountMinor, input.currency],
    );
    return res.rows[0]!.id;
  }

  async listUnappliedCredits(customerOrganizationId: string | null, tx?: Queryable): Promise<UnappliedCreditRecord[]> {
    const res = await this.q(tx).query(
      `SELECT u.id, u.customer_organization_id AS "customerOrganizationId", c.display_name AS "customerDisplayName", u.transaction_id AS "transactionId",
              u.amount_minor AS "amountMinor", u.currency, u.created_at AS "createdAt"
         FROM finance.unapplied_credit u JOIN iam.organization c ON c.id = u.customer_organization_id
        WHERE u.consumed_at IS NULL AND ($1::uuid IS NULL OR u.customer_organization_id = $1)
        ORDER BY u.created_at`,
      [customerOrganizationId],
    );
    return (res.rows as UnappliedCreditRecord[]).map((row) => ({ ...row, amountMinor: num(row.amountMinor) }));
  }

  /** Captured gateway money and credits belonging to one customer: the customer's own ledger view. */
  async listCustomerReceipts(customerOrganizationId: string): Promise<Array<{ transaction: PaymentTransactionRecord; orderNumber: string | null }>> {
    const res = await this.db.pool.query<{ id: string; orderNumber: string | null }>(
      `SELECT DISTINCT t.id, so.number AS "orderNumber", t.received_at
         FROM finance.payment_transaction t
         LEFT JOIN finance.payment_allocation a ON a.transaction_id = t.id
         LEFT JOIN finance.invoice i ON i.id = a.invoice_id
         LEFT JOIN orders.sales_order so ON so.id = i.sales_order_id
        WHERE t.customer_organization_id = $1 AND t.status IN ('allocated', 'recorded')
        ORDER BY t.received_at DESC`,
      [customerOrganizationId],
    );
    const out: Array<{ transaction: PaymentTransactionRecord; orderNumber: string | null }> = [];
    for (const row of res.rows) {
      const transaction = await this.findTransaction(row.id);
      if (transaction) out.push({ transaction, orderNumber: row.orderNumber });
    }
    return out;
  }

  // ----------------------------------------------------------------- webhook receipts

  /** Claims the delivery; null means it was already claimed (a duplicate or a replay). */
  async claimWebhookReceipt(
    input: { provider: string; deliveryId: string; eventType: string; bodySha256: string; signatureOk: boolean; outcome: 'processed' | 'duplicate' | 'rejected' | 'suspense' | 'ignored'; note: string },
    tx: Queryable,
  ): Promise<string | null> {
    const res = await tx.query<{ id: string }>(
      `INSERT INTO finance.webhook_receipt (provider, delivery_id, event_type, body_sha256, signature_ok, outcome, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (provider, delivery_id) DO NOTHING RETURNING id`,
      [input.provider, input.deliveryId, input.eventType, input.bodySha256, input.signatureOk, input.outcome, input.note],
    );
    return res.rows[0]?.id ?? null;
  }

  async setReceiptOutcome(input: { receiptId: string; outcome: 'processed' | 'duplicate' | 'rejected' | 'suspense' | 'ignored'; transactionId: string | null; note: string }, tx: Queryable): Promise<void> {
    await tx.query(
      `UPDATE finance.webhook_receipt SET outcome = $2, transaction_id = $3, note = $4 WHERE id = $1`,
      [input.receiptId, input.outcome, input.transactionId, input.note],
    );
  }

  async pendingAllocationRequests(): Promise<Array<{ approvalRequestId: string; context: Record<string, unknown>; requestedByName: string; requestedAt: Date }>> {
    const res = await this.db.pool.query(
      `SELECT r.id AS "approvalRequestId", r.context, COALESCE(u.display_name, '') AS "requestedByName", r.requested_at AS "requestedAt"
         FROM commercial.approval_request r LEFT JOIN iam.user_account u ON u.id = r.requested_by
        WHERE r.kind = 'allocation' AND r.status = 'pending' ORDER BY r.requested_at`,
    );
    return res.rows as Array<{ approvalRequestId: string; context: Record<string, unknown>; requestedByName: string; requestedAt: Date }>;
  }
}
