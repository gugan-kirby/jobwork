import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { signRequest } from '@jobwork/object-store';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigService } from '../../src/platform/config/config.service';
import { type Body, ok, Pilot } from '../pilot/driver';
import type { TestClient } from '../helpers/http';

/**
 * IN-12 F-12.4 Phase 1 load bursts (doc 12 §1; `NFR-02`: normal API p95 under 500 ms).
 * Each burst asserts what must stay true under concurrency next to how long it took:
 *
 * - an RFQ deadline burst: every invited supplier submits at once, and every bid lands
 *   exactly once;
 * - a sibling-option acceptance race: many acceptances across three options of one offer,
 *   and exactly one wins;
 * - an upload finalize burst: many customers' files finalized at once, each recorded once.
 *
 * Run by the nightly (`pnpm --filter @jobwork/api perf`), not by every PR: it is about
 * behaviour under load on a booted API, and its timings are only meaningful on a quiet
 * machine.
 */
const SUPPLIERS = Number(process.env['PERF_SUPPLIERS'] ?? 24);
const ACCEPTANCES = Number(process.env['PERF_ACCEPTANCES'] ?? 30);
const UPLOADS = Number(process.env['PERF_UPLOADS'] ?? 20);
const P95_LIMIT_MS = 500;

interface Timed {
  status: number;
  body: Body;
  ms: number;
}

async function timed(call: () => Promise<{ status: number; body: Body }>): Promise<Timed> {
  const started = performance.now();
  const res = await call();
  return { ...res, ms: performance.now() - started };
}

function percentiles(samples: number[]): { n: number; p50: number; p95: number; p99: number; max: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number): number => Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!);
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: Math.round(sorted[sorted.length - 1]!) };
}

const report: Record<string, ReturnType<typeof percentiles>> = {};

describe('Phase 1 load bursts (F-12.4)', () => {
  let p: Pilot;

  beforeAll(async () => {
    p = await Pilot.start('perf');
  }, 180_000);

  afterAll(async () => {
    // Kept with the nightly's other performance reports (uploaded from var/perf/).
    const dir = join(__dirname, '..', '..', '..', '..', 'var', 'perf');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'phase1-load.json'), JSON.stringify({ at: new Date().toISOString(), p95LimitMs: P95_LIMIT_MS, bursts: report }, null, 2));
    process.stdout.write(`\nPHASE1-LOAD ${JSON.stringify(report)}\n`);
    await p?.stop();
  });

  it(`takes ${SUPPLIERS} bids submitted at the same moment, each exactly once`, async () => {
    const { enquiryId } = await p.approvedEnquiry();
    const suppliers: Array<{ profileId: string; client: TestClient }> = [];
    for (let i = 0; i < SUPPLIERS; i += 1) suppliers.push(await p.extraSupplier(`Burst Works ${i + 1}`, `estimator${i + 1}@burst.test`));

    const rfqId = ok(await p.as.sourcing.post('/api/v1/rfqs', { enquiryId, deadlineAt: new Date(Date.now() + 86_400_000).toISOString(), lateBidPolicy: 'reject', instructions: 'Burst.' }), 201, 'rfq')['rfqId'] as string;
    for (const s of suppliers) ok(await p.as.sourcing.post(`/api/v1/rfqs/${rfqId}/invitations`, { supplierProfileId: s.profileId }), 201, 'invite');
    ok(await p.as.sourcing.post(`/api/v1/rfqs/${rfqId}/release`, { expectedVersion: await p.rfqVersion(rfqId) }), 201, 'release');
    const itemId = ((ok(await suppliers[0]!.client.get(`/api/v1/supplier/rfqs/${rfqId}`), 200, 'rfq')['items'] as Body[])[0]!['rfqItemId']) as string;

    const results = await Promise.all(
      suppliers.map((s, i) => timed(() => s.client.post(`/api/v1/supplier/rfqs/${rfqId}/bid/submit`, p.bidBody(itemId, 4800 + i)))),
    );
    report['bid_submit_burst'] = percentiles(results.map((r) => r.ms));
    expect(results.map((r) => r.status)).toEqual(suppliers.map(() => 201));
    const live = await p.one<{ n: string }>(
      `SELECT count(*) AS n FROM sourcing.supplier_bid_version v JOIN sourcing.supplier_bid b ON b.id = v.supplier_bid_id WHERE b.rfq_id = $1 AND v.status = 'submitted'`,
      [rfqId],
    );
    expect(Number(live.n)).toBe(SUPPLIERS);
    expect(report['bid_submit_burst']!.p95).toBeLessThan(P95_LIMIT_MS);
  });

  it(`lets exactly one of ${ACCEPTANCES} simultaneous acceptances across three options win`, async () => {
    const { enquiryId } = await p.approvedEnquiry();
    const { rfqId, itemId } = await p.openRound(enquiryId);
    const bid = await p.bid('supplierA', rfqId, itemId, 4850);
    await p.bid('supplierB', rfqId, itemId, 5250);
    await p.closeRound(rfqId);
    const { evaluationId } = await p.evaluate(rfqId);
    const award = ok(await p.proposeAward(rfqId, itemId, evaluationId, bid.bidVersionId), 201, 'award');
    ok(await p.decide('sales', award['approvalRequestId'] as string), 201, 'approve award');
    const { costSheetVersionId } = await p.approvedCostSheet(award['awardId'] as string);
    const options = [
      await p.sentQuote(costSheetVersionId, {}, 'standard'),
      await p.sentQuote(costSheetVersionId, { deliveryLeadDays: 10 }, 'fast'),
      await p.sentQuote(costSheetVersionId, { deliveryLeadDays: 30 }, 'premium'),
    ];
    const bodies = await Promise.all(options.map((id) => p.acceptanceBody(id)));

    const results = await Promise.all(
      Array.from({ length: ACCEPTANCES }, (_, i) => timed(() => p.accept(options[i % 3]!, `race-${randomUUID()}`, bodies[i % 3]))),
    );
    report['acceptance_race'] = percentiles(results.map((r) => r.ms));
    const won = results.filter((r) => r.status === 201);
    expect(won).toHaveLength(1);
    expect(results.filter((r) => r.status !== 201).every((r) => r.status === 409)).toBe(true);
    expect(await p.rows(`SELECT id FROM commercial.acceptance WHERE customer_quote_id = ANY($1::uuid[])`, [options])).toHaveLength(1);
    const statuses = (await p.rows<{ status: string }>(`SELECT status FROM commercial.customer_quote WHERE id = ANY($1::uuid[]) ORDER BY status`, [options])).map((r) => r.status);
    expect(statuses).toEqual(['accepted', 'withdrawn', 'withdrawn']);
    expect(report['acceptance_race']!.p95).toBeLessThan(P95_LIMIT_MS);
  });

  it(`finalizes ${UPLOADS} uploads at once, each recorded once`, async () => {
    const config = new ConfigService();
    for (const bucket of [config.env.OBJECT_STORE_BUCKET_QUARANTINE, config.env.OBJECT_STORE_BUCKET_CLEAN]) {
      const signed = signRequest(
        { accessKeyId: config.env.OBJECT_STORE_ACCESS_KEY, secretAccessKey: config.env.OBJECT_STORE_SECRET_KEY, region: config.env.OBJECT_STORE_REGION },
        { endpoint: config.env.OBJECT_STORE_ENDPOINT, objectPath: bucket, method: 'PUT' },
      );
      const res = await fetch(signed.url, { method: 'PUT', headers: signed.headers });
      if (!res.ok && res.status !== 409) throw new Error(`object store not reachable for the upload burst: ${res.status}`);
    }
    // Every upload is initiated and its bytes stored first; the burst is the finalize.
    const prepared = await Promise.all(
      Array.from({ length: UPLOADS }, async (_, i) => {
        const bytes = Buffer.from(`%PDF-1.4\n% burst ${i} ${randomUUID()}\n%%EOF\n`);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const init = ok(await p.as.buyer.post('/api/v1/documents/uploads', { purpose: 'drawing_2d', filename: `burst-${i}.pdf`, declaredMediaType: 'application/pdf', byteSize: bytes.length, sha256 }), 201, 'initiate');
        const grant = init['grant'] as { method: string; url: string; headers: Record<string, string> };
        const put = await fetch(grant.url, { method: grant.method, headers: grant.headers, body: bytes });
        if (!put.ok) throw new Error(`upload PUT failed: ${put.status}`);
        return { session: init['uploadSessionId'] as string, byteSize: bytes.length, sha256 };
      }),
    );
    const results = await Promise.all(
      prepared.map((u) => timed(() => p.as.buyer.post(`/api/v1/documents/uploads/${u.session}/finalize`, { byteSize: u.byteSize, sha256: u.sha256, title: 'Burst drawing' }))),
    );
    report['upload_finalize_burst'] = percentiles(results.map((r) => r.ms));
    expect(results.map((r) => r.status)).toEqual(prepared.map(() => 201));
    const versions = new Set(results.map((r) => r.body['documentVersionId']));
    expect(versions.size).toBe(UPLOADS);
    expect(report['upload_finalize_burst']!.p95).toBeLessThan(P95_LIMIT_MS);
  });
});
