import argon2 from 'argon2';
import { Client } from 'pg';

/**
 * Development/staging seed (doc 05 §16: reference + bootstrap only, no production use).
 * Idempotent: safe to re-run. Creates the internal organization and the first admin,
 * mirroring the "create admins only through a protected path" rule — this IS that path
 * for non-production environments.
 */
async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/jobwork_dev';
  const adminEmail = process.env['DEV_SEED_ADMIN_EMAIL'] ?? 'admin@jobwork.local';
  const adminPassword = process.env['DEV_SEED_ADMIN_PASSWORD'] ?? 'admin-dev-password-1';
  // The portal is an external surface: exercising it needs a customer member, since
  // an internal account is held to MFA before any transactional command (AUTH-15).
  const buyerEmail = process.env['DEV_SEED_BUYER_EMAIL'] ?? 'buyer@demo.local';
  const buyerPassword = process.env['DEV_SEED_BUYER_PASSWORD'] ?? 'demo-portal-password-1';
  // Supplier evidence is decided by sourcing, and the reviewer may never be the person
  // who submitted it (doc 03 §5) — so a dev environment needs its own sourcing account
  // to exercise admission end to end.
  const sourcingEmail = process.env['DEV_SEED_SOURCING_EMAIL'] ?? 'sourcing@jobwork.local';
  const sourcingPassword = process.env['DEV_SEED_SOURCING_PASSWORD'] ?? 'sourcing-dev-password-1';

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');

    let orgRes = await client.query<{ id: string }>(
      `SELECT id FROM iam.organization WHERE type = 'internal' AND display_name = $1`,
      ['JobWork Operations'],
    );
    let orgId = orgRes.rows[0]?.id;
    if (!orgId) {
      orgRes = await client.query<{ id: string }>(
        `INSERT INTO iam.organization (type, legal_name, display_name)
         VALUES ('internal', 'JobWork', 'JobWork Operations') RETURNING id`,
      );
      orgId = orgRes.rows[0]?.id;
      console.log('created internal organization');
    }
    if (!orgId) throw new Error('failed to resolve internal organization');

    let userRes = await client.query<{ id: string }>(
      `SELECT id FROM iam.user_account WHERE email = $1`,
      [adminEmail],
    );
    let userId = userRes.rows[0]?.id;
    if (!userId) {
      const hash = await argon2.hash(adminPassword, {
        type: argon2.argon2id,
        memoryCost: 19_456,
        timeCost: 2,
        parallelism: 1,
      });
      userRes = await client.query<{ id: string }>(
        `INSERT INTO iam.user_account
           (email, password_hash, password_params_version, display_name, status, email_verified_at)
         VALUES ($1, $2, 1, 'Platform Admin', 'active', now()) RETURNING id`,
        [adminEmail, hash],
      );
      userId = userRes.rows[0]?.id;
      console.log(`created admin user ${adminEmail}`);
    }
    if (!userId) throw new Error('failed to resolve admin user');

    let memRes = await client.query<{ id: string }>(
      `SELECT id FROM iam.membership WHERE user_id = $1 AND organization_id = $2 AND status <> 'ended'`,
      [userId, orgId],
    );
    let membershipId = memRes.rows[0]?.id;
    if (!membershipId) {
      memRes = await client.query<{ id: string }>(
        `INSERT INTO iam.membership (user_id, organization_id) VALUES ($1, $2) RETURNING id`,
        [userId, orgId],
      );
      membershipId = memRes.rows[0]?.id;
      console.log('created admin membership');
    }
    if (!membershipId) throw new Error('failed to resolve membership');

    for (const roleKey of ['platform_admin', 'security_admin', 'org_admin']) {
      await client.query(
        `INSERT INTO iam.membership_role (membership_id, role_id)
         SELECT $1, r.id FROM iam.role r WHERE r.key = $2
         ON CONFLICT DO NOTHING`,
        [membershipId, roleKey],
      );
    }

    // IN-16: JobWork's single Chennai receiving hub, where leg-1 shipments are addressed.
    const hub = await client.query(
      `SELECT 1 FROM iam.organization_site WHERE organization_id = $1 AND kind = 'works' AND status = 'active'`,
      [orgId],
    );
    if (hub.rowCount === 0) {
      await client.query(
        `INSERT INTO iam.organization_site (organization_id, label, kind, address_line1, city, state, postal_code, contact_name, contact_phone)
         VALUES ($1, 'JobWork receiving hub', 'works', 'Unit 4, SIDCO Industrial Estate, Guindy', 'Chennai', 'Tamil Nadu', '600032', 'Receiving desk', '+91 44 0000 0000')`,
        [orgId],
      );
      console.log('created receiving hub site');
    }

    await seedInternalMember(client, orgId, {
      email: sourcingEmail,
      password: sourcingPassword,
      displayName: 'Dev Sourcing',
      roles: ['jobwork_sourcing'],
    });

    await seedMember(client, {
      organizationType: 'customer',
      organizationName: 'Demo Precision',
      legalName: 'Demo Precision Works',
      email: buyerEmail,
      password: buyerPassword,
      displayName: 'Demo Buyer',
      roles: ['customer_requester'],
    });

    await client.query('COMMIT');
    console.log(
      `seed complete — sign in as ${adminEmail} (internal admin), ${sourcingEmail} (sourcing) or ${buyerEmail} (portal)`,
    );
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}


/** A second internal member inside the organization the admin already lives in. */
async function seedInternalMember(
  client: Client,
  organizationId: string,
  input: { email: string; password: string; displayName: string; roles: string[] },
): Promise<void> {
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM iam.user_account WHERE email = $1`,
    [input.email],
  );
  let userId = existing.rows[0]?.id;
  if (!userId) {
    const hash = await argon2.hash(input.password, {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });
    const created = await client.query<{ id: string }>(
      `INSERT INTO iam.user_account
         (email, password_hash, password_params_version, display_name, status, email_verified_at)
       VALUES ($1, $2, 1, $3, 'active', now()) RETURNING id`,
      [input.email, hash, input.displayName],
    );
    userId = created.rows[0]?.id;
    console.log(`created user ${input.email}`);
  }
  if (!userId) throw new Error(`failed to resolve user ${input.email}`);

  // The live-membership uniqueness is a partial index, so this re-reads rather than
  // relying on ON CONFLICT, which cannot target it.
  const existingMembership = await client.query<{ id: string }>(
    `SELECT id FROM iam.membership
      WHERE user_id = $1 AND organization_id = $2 AND status <> 'ended'`,
    [userId, organizationId],
  );
  const membershipId =
    existingMembership.rows[0]?.id ??
    (
      await client.query<{ id: string }>(
        `INSERT INTO iam.membership (user_id, organization_id) VALUES ($1, $2) RETURNING id`,
        [userId, organizationId],
      )
    ).rows[0]?.id;
  if (!membershipId) throw new Error(`failed to resolve membership for ${input.email}`);

  for (const roleKey of input.roles) {
    await client.query(
      `INSERT INTO iam.membership_role (membership_id, role_id)
       SELECT $1, r.id FROM iam.role r WHERE r.key = $2
       ON CONFLICT DO NOTHING`,
      [membershipId, roleKey],
    );
  }
}

/** Idempotent organization + member + roles, for the non-internal demo accounts. */
async function seedMember(
  client: Client,
  input: {
    organizationType: 'customer' | 'supplier';
    organizationName: string;
    legalName: string;
    email: string;
    password: string;
    displayName: string;
    roles: string[];
  },
): Promise<void> {
  const existingOrg = await client.query<{ id: string }>(
    `SELECT id FROM iam.organization WHERE display_name = $1`,
    [input.organizationName],
  );
  const orgId =
    existingOrg.rows[0]?.id ??
    (
      await client.query<{ id: string }>(
        `INSERT INTO iam.organization (type, legal_name, display_name)
         VALUES ($1, $2, $3) RETURNING id`,
        [input.organizationType, input.legalName, input.organizationName],
      )
    ).rows[0]?.id;
  if (!orgId) throw new Error(`failed to resolve organization ${input.organizationName}`);

  const existingUser = await client.query<{ id: string }>(
    `SELECT id FROM iam.user_account WHERE email = $1`,
    [input.email],
  );
  let userId = existingUser.rows[0]?.id;
  if (!userId) {
    const hash = await argon2.hash(input.password, {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });
    userId = (
      await client.query<{ id: string }>(
        `INSERT INTO iam.user_account
           (email, password_hash, password_params_version, display_name, status, email_verified_at)
         VALUES ($1, $2, 1, $3, 'active', now()) RETURNING id`,
        [input.email, hash, input.displayName],
      )
    ).rows[0]?.id;
    console.log(`created user ${input.email}`);
  }
  if (!userId) throw new Error(`failed to resolve user ${input.email}`);

  const existingMembership = await client.query<{ id: string }>(
    `SELECT id FROM iam.membership WHERE user_id = $1 AND organization_id = $2 AND status <> 'ended'`,
    [userId, orgId],
  );
  const membershipId =
    existingMembership.rows[0]?.id ??
    (
      await client.query<{ id: string }>(
        `INSERT INTO iam.membership (user_id, organization_id) VALUES ($1, $2) RETURNING id`,
        [userId, orgId],
      )
    ).rows[0]?.id;
  if (!membershipId) throw new Error(`failed to resolve membership for ${input.email}`);

  for (const roleKey of input.roles) {
    await client.query(
      `INSERT INTO iam.membership_role (membership_id, role_id)
       SELECT $1, r.id FROM iam.role r WHERE r.key = $2
       ON CONFLICT DO NOTHING`,
      [membershipId, roleKey],
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
