#!/usr/bin/env node
// Prepares the database the end-to-end journeys run against (IN-12 F-12.4): dropped,
// migrated, and given its cast as rows, the way the pilot driver does (internal accounts
// have no self-service path; supplier eligibility is IN-04's to prove). Everything the
// journeys act on is then created over HTTP by `tests/world.setup.ts`.
//
// Runs as the first half of the API's webServer command, so the API starts on a ready
// database. Never point E2E_DATABASE at anything but a disposable local database.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const name = process.env.E2E_DATABASE ?? 'jobwork_e2e';
if (!/^jobwork_e2e[a-z0-9_]*$/.test(name)) throw new Error(`refusing to prepare ${name}: e2e databases are named jobwork_e2e…`);
// The server is the one DATABASE_URL names (CI carries credentials there); the
// maintenance database `postgres` is used to drop and create the journeys' database.
const base = new URL(process.env.E2E_ADMIN_URL ?? process.env.DATABASE_URL ?? 'postgres://localhost:5432/postgres');
base.pathname = '/postgres';
const admin = base.toString();
const url = new URL(admin);
url.pathname = `/${name}`;
const databaseUrl = url.toString();

const require = createRequire(import.meta.url);
const { hashPassword } = require(join(root, 'apps/api/dist/modules/iam/domain/password.js'));

export const PASSWORD = 'e2e-journey-password-1';
const PEOPLE = [
  { email: 'buyer@kovai.test', org: 'customer', roles: ['customer_requester', 'org_admin'] },
  { email: 'approver@kovai.test', org: 'customer', roles: ['customer_approver'] },
  { email: 'estimator@anand.test', org: 'supplierA', roles: ['org_admin', 'supplier_estimator'] },
  { email: 'estimator@balaji.test', org: 'supplierB', roles: ['org_admin', 'supplier_estimator'] },
  { email: 'engineering@jobwork.test', org: 'internal', roles: ['jobwork_engineering'] },
  { email: 'sourcing@jobwork.test', org: 'internal', roles: ['jobwork_sourcing'] },
  { email: 'sales@jobwork.test', org: 'internal', roles: ['jobwork_sales'] },
  { email: 'sales2@jobwork.test', org: 'internal', roles: ['jobwork_sales'] },
  { email: 'finance@jobwork.test', org: 'internal', roles: ['jobwork_finance'] },
];

const server = new pg.Client({ connectionString: admin });
await server.connect();
await server.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
await server.query(`CREATE DATABASE "${name}"`);
await server.end();
execFileSync('pnpm', ['--filter', '@jobwork/database', 'migrate'], { cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'inherit' });

const db = new pg.Client({ connectionString: databaseUrl });
await db.connect();
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
const org = async (type, legal) => (await one(`INSERT INTO iam.organization (type, legal_name, display_name) VALUES ($1, $2, $2) RETURNING id`, [type, legal])).id;
const orgs = {
  internal: await org('internal', 'JobWork Operations'),
  customer: await org('customer', 'Kovai Pumps'),
  supplierA: await org('supplier', 'Anand Engineering'),
  supplierB: await org('supplier', 'Balaji Precision'),
};
const hash = await hashPassword(PASSWORD);
for (const person of PEOPLE) {
  const user = await one(
    `INSERT INTO iam.user_account (email, password_hash, password_params_version, display_name, status, email_verified_at) VALUES ($1, $2, 1, $3, 'active', now()) RETURNING id`,
    [person.email, hash, person.email.split('@')[0]],
  );
  const membership = await one(`INSERT INTO iam.membership (user_id, organization_id) VALUES ($1, $2) RETURNING id`, [user.id, orgs[person.org]]);
  await db.query(`INSERT INTO iam.membership_role (membership_id, role_id) SELECT $1, id FROM iam.role WHERE key = ANY($2::text[])`, [membership.id, person.roles]);
}
const caps = (await db.query(`SELECT id, code FROM supplier.capability WHERE code IN ('cnc_milling', 'material_aluminium')`)).rows;
for (const [key, trade] of [['supplierA', 'Anand Engineering'], ['supplierB', 'Balaji Precision']]) {
  const profile = await one(
    `INSERT INTO supplier.supplier_profile (organization_id, region_class, status, decided_by, decided_at, submitted_by, trade_name, primary_contact_name, primary_contact_email, primary_contact_phone, summary)
     VALUES ($1, 'chennai_metro', 'active', gen_random_uuid(), now(), gen_random_uuid(), $2, 'Contact', 'contact@example.test', '+91 90000 00000', 'We machine things') RETURNING id`,
    [orgs[key], trade],
  );
  for (const cap of caps) await db.query(`INSERT INTO supplier.supplier_capability (supplier_profile_id, capability_id, version_no) VALUES ($1, $2, 1)`, [profile.id, cap.id]);
  for (const kind of ['gst', 'pan', 'bank_account']) {
    await db.query(
      `INSERT INTO supplier.verification_item (supplier_profile_id, kind, version_no, status, submitted_by, submitted_at, reviewed_by, reviewed_at, expires_at)
       VALUES ($1, $2, 1, 'verified', gen_random_uuid(), now(), gen_random_uuid(), now(), now() + interval '200 days')`,
      [profile.id, kind],
    );
  }
}
// Two scanned-clean drawings in the customer's library: one per enquiry the journeys need.
for (const title of ['Bracket drawing', 'Flange drawing']) {
  const doc = await one(`INSERT INTO dms.document (owning_organization_id, logical_type, title) VALUES ($1, 'drawing_2d', $2) RETURNING id`, [orgs.customer, title]);
  const file = await one(
    `INSERT INTO dms.file_object (storage_key, byte_size, declared_media_type, sha256, scan_state, owning_organization_id) VALUES ($1, 2048, 'application/pdf', $2, 'clean', $3) RETURNING id`,
    [`e2e/${randomBytes(8).toString('hex')}`, randomBytes(32).toString('hex'), orgs.customer],
  );
  await db.query(`INSERT INTO dms.document_version (document_id, version_no, file_object_id, original_filename, status, created_by) VALUES ($1, 1, $2, $3, 'available', gen_random_uuid())`, [doc.id, file.id, `${title.toLowerCase().replace(/ /g, '-')}.pdf`]);
}
await db.end();
console.log(`prepared ${name}: ${PEOPLE.length} people, 2 eligible suppliers, 2 clean drawings`);
