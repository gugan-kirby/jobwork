import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureDatabase, runMigrations } from '../src/migrate';
import { registerPgTypeParsers } from '../src/pg-types';

registerPgTypeParsers();

const BASE_URL = process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/jobwork_dev';
const TEST_DB = `jobwork_revdb_${randomBytes(4).toString('hex')}`;

function url(): string {
  const u = new URL(BASE_URL);
  u.pathname = `/${TEST_DB}`;
  return u.toString();
}

/**
 * F-12.5 schema rules: a round superseded by a revision names that revision, superseding
 * is reachable only while the round is live, and the revision keeps its reason.
 */
describe('requirement revision schema (F-12.5)', () => {
  let pg: Client;
  let enquiryId: string;
  let r1: string;
  let r2: string;
  let round = 0;

  const one = async <T>(sql: string, args: unknown[] = []): Promise<T> => (await pg.query(sql, args)).rows[0] as T;

  async function rfq(status: string): Promise<string> {
    round += 1;
    const id = (await one<{ id: string }>(
      `INSERT INTO sourcing.rfq (enquiry_id, requirement_id, round_no, status, deadline_at, released_at)
       VALUES ($1, $2, $3, 'draft', now() + interval '2 days', NULL) RETURNING id`,
      [enquiryId, r1, round],
    )).id;
    const path: Record<string, string[]> = {
      draft: [],
      open: ['open'],
      evaluation: ['open', 'evaluation'],
      awarded: ['open', 'evaluation', 'awarded'],
    };
    for (const step of path[status]!) {
      await pg.query(`UPDATE sourcing.rfq SET status = $2, released_at = coalesce(released_at, now()) WHERE id = $1`, [id, step]);
    }
    return id;
  }

  beforeAll(async () => {
    await ensureDatabase(url());
    await runMigrations(url(), join(__dirname, '..', 'migrations'));
    pg = new Client({ connectionString: url() });
    await pg.connect();
    const org = await one<{ id: string }>(`INSERT INTO iam.organization (type, legal_name, display_name) VALUES ('customer', 'Kovai Pumps', 'Kovai Pumps') RETURNING id`);
    enquiryId = (await one<{ id: string }>(`INSERT INTO sourcing.enquiry (customer_organization_id, status, reference, submitted_at, submitted_by) VALUES ($1, 'approved_for_sourcing', 'ENQ-2026-8801', now(), gen_random_uuid()) RETURNING id`, [org.id])).id;
    r1 = (await one<{ id: string }>(`INSERT INTO sourcing.requirement (enquiry_id, revision_no, kind, snapshot, content_hash) VALUES ($1, 1, 'reviewed', '{}', 'a') RETURNING id`, [enquiryId])).id;
    r2 = (await one<{ id: string }>(
      `INSERT INTO sourcing.requirement (enquiry_id, revision_no, kind, snapshot, content_hash, supersedes_id, revision_reason) VALUES ($1, 2, 'reviewed', '{}', 'b', $2, 'Tighter bore tolerance') RETURNING id`,
      [enquiryId, r1],
    )).id;
  });

  afterAll(async () => {
    await pg?.end();
  });

  it('supersedes a live round only by naming the revision that replaced it', async () => {
    for (const status of ['draft', 'open', 'evaluation']) {
      const id = await rfq(status);
      await expect(pg.query(`UPDATE sourcing.rfq SET status = 'superseded' WHERE id = $1`, [id])).rejects.toThrow(/chk_rfq_superseded/);
      await pg.query(`UPDATE sourcing.rfq SET status = 'superseded', superseded_by_requirement_id = $2 WHERE id = $1`, [id, r2]);
    }
  });

  it('never supersedes a round that is already history', async () => {
    const awarded = await rfq('awarded');
    await expect(
      pg.query(`UPDATE sourcing.rfq SET status = 'superseded', superseded_by_requirement_id = $2 WHERE id = $1`, [awarded, r2]),
    ).rejects.toThrow(/invalid rfq transition: awarded -> superseded/);
  });

  it('keeps the revision reason with the frozen revision, which stays immutable', async () => {
    expect(await one(`SELECT revision_reason FROM sourcing.requirement WHERE id = $1`, [r2])).toEqual({ revision_reason: 'Tighter bore tolerance' });
    await expect(pg.query(`UPDATE sourcing.requirement SET revision_reason = 'edited' WHERE id = $1`, [r2])).rejects.toThrow(/immutable/);
  });
});
