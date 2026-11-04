import type { DisclosedSupplier } from '@jobwork/contracts';

type Queryable = { query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }> };

/**
 * The supplier as a customer may see it (ADR-0007): trading name, works city, whether it is
 * an admitted member of the network, and the rating customers gave it. Nothing else about
 * a supplier leaves through this path: no contact, no address line, no cost.
 */
export async function disclosedSupplier(db: Queryable, organizationId: string): Promise<DisclosedSupplier | null> {
  const res = await db.query(
    `SELECT COALESCE(NULLIF(p.trade_name, ''), o.display_name) AS name, s.city, s.state,
            COALESCE(p.status = 'active', false) AS verified,
            round(r.average, 1)::float8 AS "ratingAverage", r.count::int AS "ratingCount"
       FROM iam.organization o
       LEFT JOIN supplier.supplier_profile p ON p.organization_id = o.id
       LEFT JOIN iam.organization_site s ON s.id = p.works_site_id
       CROSS JOIN LATERAL (
         SELECT avg(score) AS average, count(*) AS count FROM supplier.rating WHERE supplier_organization_id = o.id
       ) r
      WHERE o.id = $1`,
    [organizationId],
  );
  return (res.rows[0] as DisclosedSupplier | undefined) ?? null;
}
