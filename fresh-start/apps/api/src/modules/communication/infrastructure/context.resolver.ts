import { Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import type { ConversationContextType, ExternalAudience } from '@jobwork/contracts';
import type { Registry, RegistryEntry } from '../domain/leakage';
import { DatabaseService } from '../../../platform/database/database.service';

type Db = Pool | PoolClient;

export interface ContextSupplier {
  organizationId: string;
  name: string;
  /** May this supplier still write here (an open invitation, a live PO)? */
  active: boolean;
}

/** A business record a thread hangs off, as far as communication needs to know it. */
export interface ResolvedContext {
  type: ConversationContextType;
  id: string;
  /** Reference both sides can say out loud: ENQ-, RFQ-, SO-, PO-. */
  label: string;
  customerOrganizationId: string;
  customerName: string;
  suppliers: ContextSupplier[];
  /** Where each audience opens this record. */
  links: { external: string; internal: string };
  /** Whether external parties may still write (a cancelled enquiry or closed RFQ is read-only). */
  open: boolean;
}

/** Mail providers whose domains identify nobody. */
const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'yahoo.in', 'outlook.com', 'hotmail.com', 'live.com',
  'rediffmail.com', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com', 'zoho.com', 'aol.com', 'mail.com',
]);

function emailDomain(email: string): string | null {
  const domain = email.trim().toLowerCase().split('@')[1];
  return domain && !FREE_MAIL.has(domain) ? domain : null;
}

const OPEN_INVITATION = ['invited', 'acknowledged', 'clarifying', 'responded'];
const READABLE_INVITATION = [...OPEN_INVITATION, 'declined', 'no_response'];

/**
 * Resolves conversation contexts and the identity registry the leakage detector checks a
 * message against. Every query is keyed by the context the caller already authorized
 * against; nothing here decides who may read — the commands do, from what this returns.
 */
@Injectable()
export class ContextResolver {
  constructor(private readonly db: DatabaseService) {}

  async resolve(type: ConversationContextType, id: string, client: Db = this.db.pool): Promise<ResolvedContext | null> {
    switch (type) {
      case 'enquiry': {
        const row = (await client.query<{ reference: string; customer_organization_id: string; customer_name: string; status: string }>(
          `SELECT e.reference, e.customer_organization_id, o.display_name AS customer_name, e.status
             FROM sourcing.enquiry e JOIN iam.organization o ON o.id = e.customer_organization_id
            WHERE e.id = $1 AND e.status <> 'draft' AND e.reference IS NOT NULL`,
          [id],
        )).rows[0];
        if (!row) return null;
        return {
          type, id, label: row.reference,
          customerOrganizationId: row.customer_organization_id, customerName: row.customer_name,
          suppliers: [],
          links: { external: `/enquiries/${id}`, internal: `/intake/${id}` },
          open: row.status !== 'cancelled',
        };
      }
      case 'rfq': {
        const row = (await client.query<{ reference: string; customer_organization_id: string; customer_name: string; status: string }>(
          `SELECT r.reference, e.customer_organization_id, o.display_name AS customer_name, r.status
             FROM sourcing.rfq r
             JOIN sourcing.enquiry e ON e.id = r.enquiry_id
             JOIN iam.organization o ON o.id = e.customer_organization_id
            WHERE r.id = $1 AND r.status <> 'draft'`,
          [id],
        )).rows[0];
        if (!row) return null;
        const suppliers = await client.query<{ organization_id: string; name: string; status: string }>(
          `SELECT rs.supplier_organization_id AS organization_id, o.display_name AS name, rs.status
             FROM sourcing.rfq_supplier rs JOIN iam.organization o ON o.id = rs.supplier_organization_id
            WHERE rs.rfq_id = $1 AND rs.status = ANY($2::text[])
            ORDER BY o.display_name`,
          [id, READABLE_INVITATION],
        );
        const open = !['awarded', 'no_bid', 'expired', 'cancelled', 'superseded'].includes(row.status);
        return {
          type, id, label: row.reference,
          customerOrganizationId: row.customer_organization_id, customerName: row.customer_name,
          suppliers: suppliers.rows.map((s) => ({ organizationId: s.organization_id, name: s.name, active: open && OPEN_INVITATION.includes(s.status) })),
          links: { external: `/rfqs/${id}`, internal: `/rfqs/${id}` },
          open,
        };
      }
      case 'sales_order': {
        const row = (await client.query<{ number: string; customer_organization_id: string; customer_name: string; status: string }>(
          `SELECT so.number, so.customer_organization_id, o.display_name AS customer_name, so.status
             FROM orders.sales_order so JOIN iam.organization o ON o.id = so.customer_organization_id
            WHERE so.id = $1`,
          [id],
        )).rows[0];
        if (!row) return null;
        const suppliers = await client.query<{ organization_id: string; name: string }>(
          `SELECT DISTINCT po.supplier_organization_id AS organization_id, o.display_name AS name
             FROM orders.purchase_order po JOIN iam.organization o ON o.id = po.supplier_organization_id
            WHERE po.sales_order_id = $1`,
          [id],
        );
        return {
          type, id, label: row.number,
          customerOrganizationId: row.customer_organization_id, customerName: row.customer_name,
          suppliers: suppliers.rows.map((s) => ({ organizationId: s.organization_id, name: s.name, active: false })),
          links: { external: `/orders/${id}`, internal: `/sales-orders/${id}` },
          open: row.status !== 'cancelled',
        };
      }
      case 'purchase_order': {
        const row = (await client.query<{
          number: string; sales_order_id: string; supplier_organization_id: string; supplier_name: string;
          customer_organization_id: string; customer_name: string; status: string;
        }>(
          `SELECT po.number, po.sales_order_id, po.supplier_organization_id, s.display_name AS supplier_name,
                  so.customer_organization_id, c.display_name AS customer_name, po.status
             FROM orders.purchase_order po
             JOIN orders.sales_order so ON so.id = po.sales_order_id
             JOIN iam.organization s ON s.id = po.supplier_organization_id
             JOIN iam.organization c ON c.id = so.customer_organization_id
            WHERE po.id = $1`,
          [id],
        )).rows[0];
        if (!row) return null;
        const open = row.status !== 'cancelled';
        return {
          type, id, label: row.number,
          customerOrganizationId: row.customer_organization_id, customerName: row.customer_name,
          suppliers: [{ organizationId: row.supplier_organization_id, name: row.supplier_name, active: open }],
          links: { external: `/supplier/orders/${id}`, internal: `/sales-orders/${row.sales_order_id}` },
          open,
        };
      }
    }
  }

  /**
   * Who a message's reader must not learn about: every customer and supplier other than
   * the reader's own organization (doc 11 §9). JobWork's own contacts are allowed.
   *
   * The registry is read per check. At pilot scale that is a few hundred rows; when it is
   * not, this becomes a cached automaton invalidated on organization/profile changes.
   */
  async registryFor(
    context: ResolvedContext,
    audience: ExternalAudience,
    counterpartOrganizationId: string | null,
    client: Db = this.db.pool,
  ): Promise<Registry> {
    const reader =
      audience === 'customer' ? [context.customerOrganizationId] : audience === 'supplier' && counterpartOrganizationId ? [counterpartOrganizationId] : [];

    const orgs = await client.query<{
      type: 'customer' | 'supplier'; legal_name: string; display_name: string; trade_name: string | null;
      website: string | null; primary_contact_name: string | null; primary_contact_email: string | null; primary_contact_phone: string | null;
    }>(
      `SELECT o.type, o.legal_name, o.display_name, sp.trade_name, sp.website,
              sp.primary_contact_name, sp.primary_contact_email, sp.primary_contact_phone
         FROM iam.organization o LEFT JOIN supplier.supplier_profile sp ON sp.organization_id = o.id
        WHERE o.type IN ('customer', 'supplier') AND NOT (o.id = ANY($1::uuid[]))`,
      [reader],
    );
    const members = await client.query<{ type: 'customer' | 'supplier' | 'internal'; email: string; phone: string | null }>(
      `SELECT o.type, u.email, u.phone
         FROM iam.membership m
         JOIN iam.user_account u ON u.id = m.user_id
         JOIN iam.organization o ON o.id = m.organization_id
        WHERE m.status <> 'ended'
          AND (o.type = 'internal' OR NOT (o.id = ANY($1::uuid[])))`,
      [reader],
    );

    const shielded: RegistryEntry[] = [];
    const push = (party: 'customer' | 'supplier', kind: RegistryEntry['kind'], value: string | null) => {
      if (value && value.trim()) shielded.push({ party, kind, value });
    };
    for (const o of orgs.rows) {
      push(o.type, 'name', o.legal_name);
      if (o.display_name !== o.legal_name) push(o.type, 'name', o.display_name);
      push(o.type, 'name', o.trade_name);
      push(o.type, 'domain', o.website);
      // A contact's full name identifies a party; a lone first name would match half of Chennai.
      if (o.primary_contact_name && o.primary_contact_name.trim().split(/\s+/).length >= 2) push(o.type, 'name', o.primary_contact_name);
      push(o.type, 'email', o.primary_contact_email);
      push(o.type, 'phone', o.primary_contact_phone);
      const domain = o.primary_contact_email ? emailDomain(o.primary_contact_email) : null;
      if (domain) push(o.type, 'domain', domain);
    }

    const allowed: Registry['allowed'] = [];
    for (const m of members.rows) {
      if (m.type === 'internal') {
        allowed.push({ kind: 'email', value: m.email });
        const domain = emailDomain(m.email);
        if (domain) allowed.push({ kind: 'domain', value: domain });
        if (m.phone) allowed.push({ kind: 'phone', value: m.phone });
        continue;
      }
      push(m.type, 'email', m.email);
      push(m.type, 'phone', m.phone);
      const domain = emailDomain(m.email);
      if (domain) push(m.type, 'domain', domain);
    }
    return { shielded, allowed };
  }
}
