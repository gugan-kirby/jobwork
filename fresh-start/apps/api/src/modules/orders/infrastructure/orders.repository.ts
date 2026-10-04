import { Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import type { PurchaseOrderStatus, SalesOrderStatus } from '@jobwork/contracts';
import { DatabaseService } from '../../../platform/database/database.service';

type Queryable = Pool | PoolClient;

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

export interface SalesOrderLineRecord {
  lineNo: number;
  description: string;
  quantity: number;
  unit: string;
  unitPriceMinor: number;
  amountMinor: number;
}

export interface AcceptanceRecord {
  id: string;
  customerQuoteId: string;
  quoteVersionId: string;
  contentHash: string;
  termsVersionId: string;
  termsVersionNo: number;
  termsHash: string;
  acceptedBy: string;
  acceptedByName: string;
  organizationId: string;
  authoritySnapshot: { roles: string[]; limitMinor: number | null; currency: string | null };
  acceptedAt: Date;
}

export interface SalesOrderRecord {
  id: string;
  number: string;
  customerOrganizationId: string;
  customerDisplayName: string;
  enquiryId: string;
  enquiryReference: string | null;
  customerQuoteId: string;
  quoteReference: string | null;
  acceptedQuoteVersionId: string;
  acceptedQuoteVersionNo: number;
  acceptanceId: string;
  contractSnapshotId: string;
  contractHash: string;
  title: string;
  currency: string;
  totalMinor: number;
  deliveryLeadDays: number;
  deliverySiteId: string | null;
  status: SalesOrderStatus;
  commercialReleasedAt: Date | null;
  commercialReleaseBasis: string | null;
  aggregateVersion: number;
  createdAt: Date;
  lines: SalesOrderLineRecord[];
  acceptance: AcceptanceRecord;
}

export interface PurchaseOrderLineRecord {
  lineNo: number;
  rfqItemId: string;
  bidVersionId: string;
  description: string;
  quantity: number;
  unit: string;
  unitPriceMinor: number;
  setupAmountMinor: number;
  amountMinor: number;
}

export interface PurchaseOrderRecord {
  id: string;
  number: string;
  salesOrderId: string;
  salesOrderNumber: string;
  awardId: string;
  rfqReference: string | null;
  supplierOrganizationId: string;
  supplierDisplayName: string;
  supplierProfileId: string;
  status: PurchaseOrderStatus;
  baselineStatus: 'pending_baseline' | 'baseline_released';
  currency: string;
  totalMinor: number;
  leadTimeDays: number;
  paymentTerms: string;
  instructions: string;
  contentHash: string;
  issuedBy: string;
  issuedAt: Date;
  acknowledgedBy: string | null;
  acknowledgedAt: Date | null;
  acknowledgmentNote: string;
  aggregateVersion: number;
  lines: PurchaseOrderLineRecord[];
}

/** What a purchase order is made from: the approved award's lines for one supplier. */
export interface AwardSupplierLines {
  supplierOrganizationId: string;
  supplierDisplayName: string;
  supplierProfileId: string;
  leadTimeDays: number;
  paymentTerms: string;
  lines: Array<Omit<PurchaseOrderLineRecord, 'lineNo'>>;
}

const NUMBER_TABLES = {
  SO: 'orders.sales_order',
  PO: 'orders.purchase_order',
  INV: 'finance.invoice',
} as const;

/**
 * Persistence for sales orders, purchase orders and the acceptance evidence that binds
 * them. Reads say whose they are for: `listSalesOrdersForCustomer` never joins a
 * supplier; `listPurchaseOrdersForSupplier` never joins the customer.
 */
@Injectable()
export class OrdersRepository {
  constructor(private readonly db: DatabaseService) {}

  private q(tx?: Queryable): Queryable {
    return tx ?? this.db.pool;
  }

  /**
   * Human numbers are allocated under an advisory lock on the series, so two acceptances
   * in the same second cannot both become SO-2026-0007 (and one fail on the unique index).
   */
  async allocateNumber(kind: keyof typeof NUMBER_TABLES, now: Date, tx: Queryable): Promise<string> {
    const year = now.getUTCFullYear();
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${NUMBER_TABLES[kind]}.number`]);
    const res = await tx.query<{ next: number }>(
      `SELECT COALESCE(MAX(NULLIF(split_part(number, '-', 3), '')::int), 0) + 1 AS next
         FROM ${NUMBER_TABLES[kind]} WHERE number LIKE $1`,
      [`${kind}-${year}-%`],
    );
    return `${kind}-${year}-${String(res.rows[0]!.next).padStart(4, '0')}`;
  }

  // ----------------------------------------------------------------- acceptance

  /**
   * Serializes every acceptance in one offer set (doc 02 §8 step 1). Taken before the quote
   * row, so two options accepted at once queue here instead of deadlocking on each other.
   */
  async lockOfferSet(offerSetId: string, tx: Queryable): Promise<void> {
    await tx.query(`SELECT id FROM commercial.quote_offer_set WHERE id = $1 FOR UPDATE`, [offerSetId]);
  }

  async enquiryDeliverySite(enquiryId: string, tx: Queryable): Promise<string | null> {
    const res = await tx.query<{ delivery_site_id: string | null }>(`SELECT delivery_site_id FROM sourcing.enquiry WHERE id = $1`, [enquiryId]);
    return res.rows[0]?.delivery_site_id ?? null;
  }

  async siteBelongsTo(siteId: string, organizationId: string, tx: Queryable): Promise<boolean> {
    const res = await tx.query(
      `SELECT 1 FROM iam.organization_site WHERE id = $1 AND organization_id = $2 AND status = 'active'`,
      [siteId, organizationId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** A command that changes an order's children still moves the order's version. */
  async touchSalesOrder(orderId: string, tx: Queryable): Promise<void> {
    await tx.query(`UPDATE orders.sales_order SET aggregate_version = aggregate_version + 1, updated_at = now() WHERE id = $1`, [orderId]);
  }

  async customerApprovalLimit(membershipId: string, currency: string, tx: Queryable): Promise<{ amountMinor: number } | null> {
    const res = await tx.query<{ amount_minor: string }>(
      `SELECT amount_minor FROM iam.approval_limit
        WHERE membership_id = $1 AND limit_type = 'quote_acceptance' AND currency = $2
          AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())
        ORDER BY valid_from DESC LIMIT 1`,
      [membershipId, currency],
    );
    return res.rows[0] ? { amountMinor: num(res.rows[0].amount_minor) } : null;
  }

  async createAcceptance(
    input: {
      customerQuoteId: string;
      quoteVersionId: string;
      contentHash: string;
      termsVersionId: string;
      termsHash: string;
      acceptedBy: string;
      organizationId: string;
      authoritySnapshot: AcceptanceRecord['authoritySnapshot'];
      idempotencyKey: string | null;
      correlationId: string;
    },
    tx: Queryable,
  ): Promise<string> {
    const res = await tx.query<{ id: string }>(
      `INSERT INTO commercial.acceptance
         (customer_quote_id, quote_version_id, content_hash, terms_version_id, terms_hash, accepted_by,
          organization_id, authority_snapshot, idempotency_key, correlation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10) RETURNING id`,
      [
        input.customerQuoteId, input.quoteVersionId, input.contentHash, input.termsVersionId, input.termsHash,
        input.acceptedBy, input.organizationId, JSON.stringify(input.authoritySnapshot), input.idempotencyKey, input.correlationId,
      ],
    );
    return res.rows[0]!.id;
  }

  async createContractSnapshot(input: { acceptanceId: string; snapshot: unknown; contentHash: string }, tx: Queryable): Promise<string> {
    const res = await tx.query<{ id: string }>(
      `INSERT INTO commercial.contract_snapshot (acceptance_id, snapshot, content_hash) VALUES ($1, $2::jsonb, $3) RETURNING id`,
      [input.acceptanceId, JSON.stringify(input.snapshot), input.contentHash],
    );
    return res.rows[0]!.id;
  }

  async findContractSnapshot(id: string): Promise<{ snapshot: unknown; contentHash: string } | null> {
    const res = await this.db.pool.query<{ snapshot: unknown; contentHash: string }>(
      `SELECT snapshot, content_hash AS "contentHash" FROM commercial.contract_snapshot WHERE id = $1`,
      [id],
    );
    return res.rows[0] ?? null;
  }

  // ----------------------------------------------------------------- sales orders

  async createSalesOrder(
    input: {
      number: string;
      customerOrganizationId: string;
      enquiryId: string;
      customerQuoteId: string;
      acceptedQuoteVersionId: string;
      acceptanceId: string;
      contractSnapshotId: string;
      title: string;
      currency: string;
      totalMinor: number;
      deliveryLeadDays: number;
      deliverySiteId: string | null;
      lines: SalesOrderLineRecord[];
    },
    tx: Queryable,
  ): Promise<string> {
    const res = await tx.query<{ id: string }>(
      `INSERT INTO orders.sales_order
         (number, customer_organization_id, enquiry_id, customer_quote_id, accepted_quote_version_id, acceptance_id,
          contract_snapshot_id, title, currency, total_minor, delivery_lead_days, delivery_site_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [
        input.number, input.customerOrganizationId, input.enquiryId, input.customerQuoteId, input.acceptedQuoteVersionId,
        input.acceptanceId, input.contractSnapshotId, input.title, input.currency, input.totalMinor, input.deliveryLeadDays, input.deliverySiteId,
      ],
    );
    const id = res.rows[0]!.id;
    for (const line of input.lines) {
      await tx.query(
        `INSERT INTO orders.sales_order_line (sales_order_id, line_no, description, quantity, unit, unit_price_minor, amount_minor)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, line.lineNo, line.description, line.quantity, line.unit, line.unitPriceMinor, line.amountMinor],
      );
    }
    return id;
  }

  async findSalesOrder(id: string, tx?: Queryable, forUpdate = false): Promise<SalesOrderRecord | null> {
    const res = await this.q(tx).query(
      `SELECT o.id, o.number, o.customer_organization_id AS "customerOrganizationId", c.display_name AS "customerDisplayName",
              o.enquiry_id AS "enquiryId", e.reference AS "enquiryReference", o.customer_quote_id AS "customerQuoteId",
              q.reference AS "quoteReference", o.accepted_quote_version_id AS "acceptedQuoteVersionId",
              v.version_no AS "acceptedQuoteVersionNo", o.acceptance_id AS "acceptanceId",
              o.contract_snapshot_id AS "contractSnapshotId", s.content_hash AS "contractHash", o.title, o.currency,
              o.total_minor AS "totalMinor", o.delivery_lead_days AS "deliveryLeadDays", o.delivery_site_id AS "deliverySiteId",
              o.status, o.commercial_released_at AS "commercialReleasedAt", o.commercial_release_basis AS "commercialReleaseBasis",
              o.aggregate_version AS "aggregateVersion", o.created_at AS "createdAt"
         FROM orders.sales_order o
         JOIN iam.organization c ON c.id = o.customer_organization_id
         JOIN sourcing.enquiry e ON e.id = o.enquiry_id
         JOIN commercial.customer_quote q ON q.id = o.customer_quote_id
         JOIN commercial.quote_version v ON v.id = o.accepted_quote_version_id
         JOIN commercial.contract_snapshot s ON s.id = o.contract_snapshot_id
        WHERE o.id = $1 ${forUpdate ? 'FOR UPDATE OF o' : ''}`,
      [id],
    );
    const head = res.rows[0] as Omit<SalesOrderRecord, 'lines' | 'acceptance'> | undefined;
    if (!head) return null;
    const [lines, acceptance] = await Promise.all([this.listLines(id, tx), this.findAcceptance(head.acceptanceId, tx)]);
    if (!acceptance) return null;
    return { ...head, totalMinor: num(head.totalMinor), lines, acceptance };
  }

  private async listLines(orderId: string, tx?: Queryable): Promise<SalesOrderLineRecord[]> {
    const res = await this.q(tx).query(
      `SELECT line_no AS "lineNo", description, quantity, unit, unit_price_minor AS "unitPriceMinor", amount_minor AS "amountMinor"
         FROM orders.sales_order_line WHERE sales_order_id = $1 ORDER BY line_no`,
      [orderId],
    );
    return res.rows.map((row: Record<string, unknown>) => ({
      ...(row as unknown as SalesOrderLineRecord),
      quantity: num(row['quantity']),
      unitPriceMinor: num(row['unitPriceMinor']),
      amountMinor: num(row['amountMinor']),
    }));
  }

  async findAcceptance(id: string, tx?: Queryable): Promise<AcceptanceRecord | null> {
    const res = await this.q(tx).query(
      `SELECT a.id, a.customer_quote_id AS "customerQuoteId", a.quote_version_id AS "quoteVersionId", a.content_hash AS "contentHash",
              a.terms_version_id AS "termsVersionId", t.version_no AS "termsVersionNo", a.terms_hash AS "termsHash",
              a.accepted_by AS "acceptedBy", COALESCE(u.display_name, '') AS "acceptedByName", a.organization_id AS "organizationId",
              a.authority_snapshot AS "authoritySnapshot", a.accepted_at AS "acceptedAt"
         FROM commercial.acceptance a
         JOIN commercial.terms_version t ON t.id = a.terms_version_id
         LEFT JOIN iam.user_account u ON u.id = a.accepted_by
        WHERE a.id = $1`,
      [id],
    );
    return (res.rows[0] as AcceptanceRecord | undefined) ?? null;
  }

  async listSalesOrders(filter: { status?: SalesOrderStatus | undefined; customerOrganizationId?: string | undefined }, limit: number): Promise<SalesOrderRecord[]> {
    const res = await this.db.pool.query<{ id: string }>(
      `SELECT id FROM orders.sales_order
        WHERE ($1::text IS NULL OR status = $1) AND ($2::uuid IS NULL OR customer_organization_id = $2)
        ORDER BY created_at DESC LIMIT $3`,
      [filter.status ?? null, filter.customerOrganizationId ?? null, limit],
    );
    const out: SalesOrderRecord[] = [];
    for (const { id } of res.rows) {
      const order = await this.findSalesOrder(id);
      if (order) out.push(order);
    }
    return out;
  }

  /** Customer read: the caller's organization's orders only. */
  listSalesOrdersForCustomer(customerOrganizationId: string): Promise<SalesOrderRecord[]> {
    return this.listSalesOrders({ customerOrganizationId }, 200);
  }

  async setSalesOrderStatus(
    input: { orderId: string; status: SalesOrderStatus; commercialRelease?: { basis: string } | undefined },
    tx: Queryable,
  ): Promise<void> {
    await tx.query(
      `UPDATE orders.sales_order
          SET status = $2,
              commercial_released_at = CASE WHEN $3::text IS NULL THEN commercial_released_at ELSE now() END,
              commercial_release_basis = COALESCE($3, commercial_release_basis),
              aggregate_version = aggregate_version + 1, updated_at = now()
        WHERE id = $1`,
      [input.orderId, input.status, input.commercialRelease?.basis ?? null],
    );
  }

  // ----------------------------------------------------------------- awards → purchase orders

  /** The approved award a quotation was priced from: quote → cost sheet version → cost sheet → award. */
  async awardForQuote(customerQuoteId: string, tx: Queryable): Promise<{ awardId: string; rfqId: string; rfqReference: string | null } | null> {
    const res = await tx.query<{ awardId: string; rfqId: string; rfqReference: string | null }>(
      `SELECT a.id AS "awardId", a.rfq_id AS "rfqId", r.reference AS "rfqReference"
         FROM commercial.customer_quote q
         JOIN commercial.cost_sheet_version csv ON csv.id = q.cost_sheet_version_id
         JOIN commercial.cost_sheet cs ON cs.id = csv.cost_sheet_id
         JOIN commercial.award a ON a.id = cs.award_id
         JOIN sourcing.rfq r ON r.id = a.rfq_id
        WHERE q.id = $1 AND a.status = 'approved'`,
      [customerQuoteId],
    );
    return res.rows[0] ?? null;
  }

  /** Award lines grouped by supplier, with what each supplier bid for lead time and terms. */
  async awardLinesBySupplier(awardId: string, tx: Queryable): Promise<AwardSupplierLines[]> {
    const res = await tx.query(
      `SELECT l.supplier_organization_id AS "supplierOrganizationId", o.display_name AS "supplierDisplayName",
              sp.id AS "supplierProfileId", l.rfq_item_id AS "rfqItemId", l.bid_version_id AS "bidVersionId",
              i.part_name AS "partName", i.description AS "itemDescription", l.quantity, l.unit,
              l.unit_price_minor AS "unitPriceMinor", l.setup_amount_minor AS "setupAmountMinor",
              l.line_total_minor AS "lineTotalMinor", bv.lead_time_days AS "leadTimeDays", bv.payment_terms AS "paymentTerms",
              i.line_no AS "itemLineNo"
         FROM commercial.award_line l
         JOIN iam.organization o ON o.id = l.supplier_organization_id
         JOIN supplier.supplier_profile sp ON sp.organization_id = l.supplier_organization_id
         JOIN sourcing.rfq_item i ON i.id = l.rfq_item_id
         JOIN sourcing.supplier_bid_version bv ON bv.id = l.bid_version_id
        WHERE l.award_id = $1
        ORDER BY o.display_name, i.line_no`,
      [awardId],
    );
    const groups = new Map<string, AwardSupplierLines>();
    for (const raw of res.rows as Array<Record<string, unknown>>) {
      const key = raw['supplierOrganizationId'] as string;
      const group =
        groups.get(key) ??
        {
          supplierOrganizationId: key,
          supplierDisplayName: raw['supplierDisplayName'] as string,
          supplierProfileId: raw['supplierProfileId'] as string,
          leadTimeDays: 0,
          paymentTerms: (raw['paymentTerms'] as string) ?? '',
          lines: [],
        };
      group.leadTimeDays = Math.max(group.leadTimeDays, num(raw['leadTimeDays']));
      const description = `${raw['partName'] as string}${raw['itemDescription'] ? ` — ${raw['itemDescription'] as string}` : ''}`;
      group.lines.push({
        rfqItemId: raw['rfqItemId'] as string,
        bidVersionId: raw['bidVersionId'] as string,
        description,
        quantity: num(raw['quantity']),
        unit: raw['unit'] as string,
        unitPriceMinor: num(raw['unitPriceMinor']),
        setupAmountMinor: num(raw['setupAmountMinor']),
        amountMinor: num(raw['lineTotalMinor']),
      });
      groups.set(key, group);
    }
    return [...groups.values()];
  }

  async createPurchaseOrder(
    input: {
      number: string;
      salesOrderId: string;
      awardId: string;
      supplierOrganizationId: string;
      supplierProfileId: string;
      currency: string;
      totalMinor: number;
      leadTimeDays: number;
      paymentTerms: string;
      instructions: string;
      contentHash: string;
      issuedBy: string;
      lines: PurchaseOrderLineRecord[];
    },
    tx: Queryable,
  ): Promise<string> {
    const res = await tx.query<{ id: string }>(
      `INSERT INTO orders.purchase_order
         (number, sales_order_id, award_id, supplier_organization_id, supplier_profile_id, currency, total_minor,
          lead_time_days, payment_terms, instructions, content_hash, issued_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [
        input.number, input.salesOrderId, input.awardId, input.supplierOrganizationId, input.supplierProfileId, input.currency,
        input.totalMinor, input.leadTimeDays, input.paymentTerms, input.instructions, input.contentHash, input.issuedBy,
      ],
    );
    const id = res.rows[0]!.id;
    for (const line of input.lines) {
      await tx.query(
        `INSERT INTO orders.purchase_order_line
           (purchase_order_id, line_no, rfq_item_id, bid_version_id, description, quantity, unit, unit_price_minor, setup_amount_minor, amount_minor)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, line.lineNo, line.rfqItemId, line.bidVersionId, line.description, line.quantity, line.unit, line.unitPriceMinor, line.setupAmountMinor, line.amountMinor],
      );
    }
    return id;
  }

  async findPurchaseOrder(id: string, tx?: Queryable, forUpdate = false): Promise<PurchaseOrderRecord | null> {
    const res = await this.q(tx).query(
      `SELECT p.id, p.number, p.sales_order_id AS "salesOrderId", so.number AS "salesOrderNumber", p.award_id AS "awardId",
              r.reference AS "rfqReference", p.supplier_organization_id AS "supplierOrganizationId", o.display_name AS "supplierDisplayName",
              p.supplier_profile_id AS "supplierProfileId", p.status, p.baseline_status AS "baselineStatus", p.currency,
              p.total_minor AS "totalMinor", p.lead_time_days AS "leadTimeDays", p.payment_terms AS "paymentTerms", p.instructions,
              p.content_hash AS "contentHash", p.issued_by AS "issuedBy", p.issued_at AS "issuedAt", p.acknowledged_by AS "acknowledgedBy",
              p.acknowledged_at AS "acknowledgedAt", p.acknowledgment_note AS "acknowledgmentNote", p.aggregate_version AS "aggregateVersion"
         FROM orders.purchase_order p
         JOIN orders.sales_order so ON so.id = p.sales_order_id
         JOIN commercial.award a ON a.id = p.award_id
         JOIN sourcing.rfq r ON r.id = a.rfq_id
         JOIN iam.organization o ON o.id = p.supplier_organization_id
        WHERE p.id = $1 ${forUpdate ? 'FOR UPDATE OF p' : ''}`,
      [id],
    );
    const head = res.rows[0] as Omit<PurchaseOrderRecord, 'lines'> | undefined;
    if (!head) return null;
    const lines = await this.q(tx).query(
      `SELECT line_no AS "lineNo", rfq_item_id AS "rfqItemId", bid_version_id AS "bidVersionId", description, quantity, unit,
              unit_price_minor AS "unitPriceMinor", setup_amount_minor AS "setupAmountMinor", amount_minor AS "amountMinor"
         FROM orders.purchase_order_line WHERE purchase_order_id = $1 ORDER BY line_no`,
      [id],
    );
    return {
      ...head,
      totalMinor: num(head.totalMinor),
      lines: lines.rows.map((row: Record<string, unknown>) => ({
        ...(row as unknown as PurchaseOrderLineRecord),
        quantity: num(row['quantity']),
        unitPriceMinor: num(row['unitPriceMinor']),
        setupAmountMinor: num(row['setupAmountMinor']),
        amountMinor: num(row['amountMinor']),
      })),
    };
  }

  async listPurchaseOrdersForSalesOrder(salesOrderId: string, tx?: Queryable): Promise<PurchaseOrderRecord[]> {
    const res = await this.q(tx).query<{ id: string }>(
      `SELECT id FROM orders.purchase_order WHERE sales_order_id = $1 ORDER BY number`,
      [salesOrderId],
    );
    const out: PurchaseOrderRecord[] = [];
    for (const { id } of res.rows) {
      const po = await this.findPurchaseOrder(id, tx);
      if (po) out.push(po);
    }
    return out;
  }

  /** Supplier read: the caller's organization's purchase orders only. */
  async listPurchaseOrdersForSupplier(supplierOrganizationId: string): Promise<PurchaseOrderRecord[]> {
    const res = await this.db.pool.query<{ id: string }>(
      `SELECT id FROM orders.purchase_order WHERE supplier_organization_id = $1 ORDER BY issued_at DESC`,
      [supplierOrganizationId],
    );
    const out: PurchaseOrderRecord[] = [];
    for (const { id } of res.rows) {
      const po = await this.findPurchaseOrder(id);
      if (po) out.push(po);
    }
    return out;
  }

  async acknowledgePurchaseOrder(input: { purchaseOrderId: string; by: string; note: string }, tx: Queryable): Promise<void> {
    await tx.query(
      `UPDATE orders.purchase_order
          SET status = 'acknowledged', acknowledged_by = $2, acknowledged_at = now(), acknowledgment_note = $3,
              aggregate_version = aggregate_version + 1, updated_at = now()
        WHERE id = $1`,
      [input.purchaseOrderId, input.by, input.note],
    );
  }
}
