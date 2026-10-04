import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureDatabase, runMigrations } from '../src/migrate';
import { registerPgTypeParsers } from '../src/pg-types';

registerPgTypeParsers();

const BASE_URL = process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/jobwork_dev';
const TEST_DB = `jobwork_commdb_${randomBytes(4).toString('hex')}`;

function url(): string {
  const u = new URL(BASE_URL);
  u.pathname = `/${TEST_DB}`;
  return u.toString();
}

/**
 * The communication schema's teeth (F-10.1): what was said, to whom and by whom never
 * changes; only a held message's fate moves; templates are versioned, not edited; and
 * one committed event reaches each recipient once.
 */
describe('communication schema constraints (F-10.1)', () => {
  let pg: Client;
  let conversationId: string;
  let customerOrg: string;
  let supplierOrg: string;
  let internalOrg: string;
  let staffId: string;
  let customerUserId: string;
  let eventId: string;
  let templateId: string;

  const one = async <T>(sql: string, args: unknown[] = []): Promise<T> => (await pg.query(sql, args)).rows[0] as T;

  async function message(fields: Partial<Record<string, unknown>> = {}): Promise<string> {
    const row = {
      audience: 'customer',
      counterpart: null,
      author: staffId,
      authorOrg: internalOrg,
      party: 'internal',
      status: 'visible',
      ...fields,
    };
    return (await one<{ id: string }>(
      `INSERT INTO communication.message (conversation_id, audience, counterpart_organization_id, author_user_id, author_organization_id, author_party, body, body_sha256, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'Please confirm the bore tolerance.', 'h', $7) RETURNING id`,
      [conversationId, row.audience, row.counterpart, row.author, row.authorOrg, row.party, row.status],
    )).id;
  }

  beforeAll(async () => {
    await ensureDatabase(url());
    await runMigrations(url(), join(__dirname, '..', 'migrations'));
    pg = new Client({ connectionString: url() });
    await pg.connect();
    const org = async (type: string, name: string) =>
      (await one<{ id: string }>(`INSERT INTO iam.organization (type, legal_name, display_name) VALUES ($1, $2, $2) RETURNING id`, [type, name])).id;
    customerOrg = await org('customer', 'Kovai Pumps');
    supplierOrg = await org('supplier', 'Anand Engineering');
    internalOrg = await org('internal', 'JobWork');
    const user = async (email: string) =>
      (await one<{ id: string }>(`INSERT INTO iam.user_account (email, status) VALUES ($1, 'active') RETURNING id`, [email])).id;
    staffId = await user('sourcing@jobwork.test');
    customerUserId = await user('buyer@kovai.test');
    conversationId = (await one<{ id: string }>(
      `INSERT INTO communication.conversation (context_type, context_id) VALUES ('enquiry', gen_random_uuid()) RETURNING id`,
    )).id;
    eventId = (await one<{ id: string }>(
      `INSERT INTO platform.outbox_event (event_type, aggregate_type, aggregate_id, correlation_id) VALUES ('commercial.quote_sent.v1', 'customer_quote', 'q', 'corr-1') RETURNING id`,
    )).id;
    templateId = (await one<{ id: string }>(
      `SELECT id FROM communication.template_version WHERE template_key = 'customer.quote_sent' AND channel = 'in_app'`,
    )).id;
  });

  afterAll(async () => {
    await pg?.end();
  });

  it('keeps audience, author and body of a message forever', async () => {
    const id = await message();
    await expect(pg.query(`UPDATE communication.message SET body = 'edited' WHERE id = $1`, [id])).rejects.toThrow(/immutable/);
    await expect(pg.query(`UPDATE communication.message SET audience = 'internal' WHERE id = $1`, [id])).rejects.toThrow(/immutable/);
    await expect(pg.query(`UPDATE communication.message SET author_user_id = $2 WHERE id = $1`, [id, customerUserId])).rejects.toThrow(/immutable/);
    await expect(pg.query(`DELETE FROM communication.message WHERE id = $1`, [id])).rejects.toThrow(/append-only/);
  });

  it('lets only a held message change its fate, and only once', async () => {
    const visible = await message();
    await expect(pg.query(`UPDATE communication.message SET status = 'held' WHERE id = $1`, [visible])).rejects.toThrow(/cannot move/);
    const held = await message({ status: 'held' });
    await pg.query(`UPDATE communication.message SET status = 'visible', released_at = now() WHERE id = $1`, [held]);
    await expect(pg.query(`UPDATE communication.message SET status = 'rejected' WHERE id = $1`, [held])).rejects.toThrow(/cannot move/);
  });

  it('never holds or externally authors an internal note, and pins a supplier message to one supplier', async () => {
    await expect(message({ audience: 'internal', status: 'held' })).rejects.toThrow(/chk_message_internal_visible/);
    await expect(message({ audience: 'internal', author: customerUserId, authorOrg: customerOrg, party: 'customer' })).rejects.toThrow(/chk_message_internal_author/);
    await expect(message({ audience: 'supplier' })).rejects.toThrow(/chk_message_counterpart/);
    await expect(message({ audience: 'customer', counterpart: supplierOrg })).rejects.toThrow(/chk_message_counterpart/);
    await expect(message({ audience: 'shared_technical', author: customerUserId, authorOrg: customerOrg, party: 'customer' })).rejects.toThrow(/chk_message_shared_author/);
    expect(await message({ audience: 'supplier', counterpart: supplierOrg })).toBeTruthy();
  });

  it('records a warning as noted and demands a reason for every decision', async () => {
    const id = await message({ status: 'held' });
    await expect(pg.query(
      `INSERT INTO communication.leakage_review (message_id, action, findings, detector_version, status) VALUES ($1, 'warn', '[]', 'v1', 'open')`,
      [id],
    )).rejects.toThrow(/chk_review_warn/);
    const review = await one<{ id: string }>(
      `INSERT INTO communication.leakage_review (message_id, action, findings, detector_version, status) VALUES ($1, 'quarantine', '[]', 'v1', 'open') RETURNING id`,
      [id],
    );
    await expect(pg.query(
      `UPDATE communication.leakage_review SET status = 'released', decided_by = $2, decided_at = now(), decision_reason = '' WHERE id = $1`,
      [review.id, staffId],
    )).rejects.toThrow(/chk_review_reason/);
    await expect(pg.query(
      `UPDATE communication.leakage_review SET status = 'released_redacted', decided_by = $2, decided_at = now(), decision_reason = 'Removed the supplier name.' WHERE id = $1`,
      [review.id, staffId],
    )).rejects.toThrow(/chk_review_redacted/);
  });

  it('versions templates instead of editing them, and keys them to their audience', async () => {
    await expect(pg.query(`UPDATE communication.template_version SET body = 'changed' WHERE id = $1`, [templateId])).rejects.toThrow(/immutable/);
    await expect(pg.query(`DELETE FROM communication.template_version WHERE id = $1`, [templateId])).rejects.toThrow(/immutable/);
    await expect(pg.query(
      `INSERT INTO communication.template_version (template_key, version, channel, audience, subject, body, variables) VALUES ('customer.quote_sent', 2, 'in_app', 'supplier', 's', 'b', ARRAY['link'])`,
    )).rejects.toThrow(/chk_template_key_audience/);
  });

  it('delivers one committed event to a recipient once, and lets only the read state change', async () => {
    const insert = () => pg.query(
      `INSERT INTO communication.notification (recipient_user_id, recipient_organization_id, template_key, template_version_id, locale, consent_basis, title, body, link, source_event_id, correlation_id)
       VALUES ($1, $2, 'customer.quote_sent', $3, 'en-IN', 'transactional', 'Your quotation is ready', 'Valid until 1 Nov.', '/quotations/q', $4, 'corr-1') RETURNING id`,
      [customerUserId, customerOrg, templateId, eventId],
    );
    const first = (await insert()).rows[0] as { id: string };
    await expect(insert()).rejects.toThrow(/duplicate key/);
    await expect(pg.query(`UPDATE communication.notification SET title = 'changed' WHERE id = $1`, [first.id])).rejects.toThrow(/immutable/);
    await pg.query(`UPDATE communication.notification SET read_at = now() WHERE id = $1`, [first.id]);
    await expect(pg.query(`UPDATE communication.notification SET read_at = NULL WHERE id = $1`, [first.id])).rejects.toThrow(/already read/);
    await expect(pg.query(`DELETE FROM communication.notification WHERE id = $1`, [first.id])).rejects.toThrow(/append-only/);

    // Two reports of success for one delivery cannot both stand.
    const deliveryId = (await one<{ id: string }>(`SELECT gen_random_uuid() AS id`)).id;
    const attempt = (n: number) => pg.query(
      `INSERT INTO communication.delivery_attempt (delivery_id, notification_id, channel, template_version_id, destination, attempt_no, status, completed_at)
       VALUES ($1, $2, 'email', $3, 'buyer@kovai.test', $4, 'sent', now())`,
      [deliveryId, first.id, templateId, n],
    );
    await attempt(1);
    await expect(attempt(2)).rejects.toThrow(/uq_delivery_sent/);
  });

  it('refuses a notification link that is not an app path', async () => {
    await expect(pg.query(
      `INSERT INTO communication.notification (recipient_user_id, recipient_organization_id, template_key, template_version_id, locale, consent_basis, title, body, link, source_event_id, correlation_id)
       VALUES ($1, $2, 'customer.message_received', $3, 'en-IN', 'transactional', 't', 'b', 'https://evil.example/x', $4, 'corr-1')`,
      [customerUserId, customerOrg, templateId, eventId],
    )).rejects.toThrow(/notification_link_check/);
  });
});
