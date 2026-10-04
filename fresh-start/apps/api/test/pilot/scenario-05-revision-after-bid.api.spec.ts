import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Body, ok, Pilot, type SourcedDeal } from './driver';

/**
 * Pilot scenario 5 (doc 19 §10; F-12.5): engineering tightens the tolerance after a
 * supplier has bid. The round is superseded and both suppliers are told; the bid stays
 * exactly as submitted and can never be awarded; a new round quotes the revised part, and
 * the purchase order rests on that round's bid.
 */
describe('Pilot 5: engineering revision after a supplier bid', () => {
  let p: Pilot;
  let enquiryId: string;
  let reference: string;
  let round1: { rfqId: string; itemId: string };
  let staleBid: { bidVersionId: string; contentHash: string };
  let deal: SourcedDeal;
  const reason = 'Bore tolerance tightened to IT6 after the customer’s fit trial';

  beforeAll(async () => {
    p = await Pilot.start('s05');
    ({ enquiryId, reference } = await p.approvedEnquiry());
    round1 = await p.openRound(enquiryId);
    staleBid = await p.bid('supplierA', round1.rfqId, round1.itemId, 4850);
  }, 180_000);

  afterAll(async () => {
    await p?.stop();
  });

  it('supersedes the live round with the reason, and tells both invited suppliers', async () => {
    const enquiry = (await p.intake(enquiryId))['enquiry'] as Body;
    const revised = ok(
      await p.as.engineering.post(`/api/v1/intake/${enquiryId}/revise`, {
        expectedVersion: enquiry['aggregateVersion'],
        reason,
        items: [{ enquiryItemId: (enquiry['items'] as Body[])[0]!['enquiryItemId'], toleranceClass: 'IT6' }],
      }),
      201,
      'revise requirement',
    );
    expect((revised['supersededRounds'] as Body[]).map((r) => r['rfqId'])).toEqual([round1.rfqId]);
    expect((await p.as.supplierA.get(`/api/v1/supplier/rfqs/${round1.rfqId}`)).body['status']).toBe('superseded');
    await p.dispatchNotifications();
    for (const supplier of ['supplierA', 'supplierB'] as const) {
      const notices = await p.notices(supplier);
      expect(notices.map((n) => n.template_key)).toContain('supplier.rfq_superseded');
      p.expectNothingOf(notices, ['Kovai', reference, reason], `${supplier} notices`);
    }
  });

  it('leaves the old bid exactly as submitted, and unawardable', async () => {
    const stored = await p.one<{ content_hash: string; status: string }>(`SELECT content_hash, status FROM sourcing.supplier_bid_version WHERE id = $1`, [staleBid.bidVersionId]);
    expect(stored.content_hash).toBe(staleBid.contentHash);
    expect(stored.status).toBe('submitted');
    const refused = await p.proposeAward(round1.rfqId, round1.itemId, '00000000-0000-4000-8000-000000000000', staleBid.bidVersionId);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    // Nor can the supplier revise its bid on a round that no longer stands.
    expect((await p.as.supplierA.post(`/api/v1/supplier/rfqs/${round1.rfqId}/bid/submit`, p.bidBody(round1.itemId, 4700, { revisionReason: 'Sharper' }))).status).toBeGreaterThanOrEqual(400);
  });

  it('quotes the revised part in a new round and runs it to an acknowledged purchase order', async () => {
    const round2 = await p.openRound(enquiryId);
    const lines = (await p.as.supplierA.get(`/api/v1/supplier/rfqs/${round2.rfqId}`)).body['items'] as Body[];
    expect(JSON.stringify(lines)).toContain('IT6');
    const winner = await p.bid('supplierA', round2.rfqId, round2.itemId, 5100);
    const loser = await p.bid('supplierB', round2.rfqId, round2.itemId, 5400);
    deal = await p.awardToPurchaseOrder({ ...round2, winner, loser });
    const poLines = await p.rows<{ bid_version_id: string }>(`SELECT bid_version_id FROM orders.purchase_order_line WHERE purchase_order_id = $1`, [deal.purchaseOrderId]);
    expect(poLines.map((l) => l.bid_version_id)).toEqual([winner.bidVersionId]);
  });

  it('binds every record to the revision it was made against', async () => {
    const latest = await p.one<{ id: string; revision_no: number; revision_reason: string }>(
      `SELECT id, revision_no, revision_reason FROM sourcing.requirement WHERE enquiry_id = $1 ORDER BY revision_no DESC LIMIT 1`,
      [enquiryId],
    );
    expect(latest.revision_reason).toBe(reason);
    const rounds = await p.rows<{ id: string; status: string; requirement_id: string; superseded_by_requirement_id: string | null }>(
      `SELECT id, status, requirement_id, superseded_by_requirement_id FROM sourcing.rfq WHERE enquiry_id = $1 ORDER BY round_no`,
      [enquiryId],
    );
    expect(rounds.map((r) => r.status)).toEqual(['superseded', 'awarded']);
    expect(rounds[0]!.superseded_by_requirement_id).toBe(latest.id);
    expect(rounds[1]!.requirement_id).toBe(latest.id);
  });

  it('audits the revision on the enquiry and the round, with its reason', async () => {
    const enquiryTrail = await p.auditTrail(enquiryId);
    expect(enquiryTrail.find((a) => a.action === 'sourcing.requirement_revised')?.reason).toBe(reason);
    expect(await p.auditActions(round1.rfqId)).toEqual(['sourcing.rfq_created', 'sourcing.rfq_released', 'sourcing.rfq_superseded']);
    expect(await p.events(round1.rfqId)).toEqual(['sourcing.rfq_released.v1', 'sourcing.rfq_superseded.v1']);
    expect(await p.events(enquiryId)).toContain('sourcing.requirement_revised.v1');
  });

  it('shows the customer none of it: no rounds, no suppliers, no superseded bids', async () => {
    const view = await p.as.buyer.get(`/api/v1/enquiries/${enquiryId}`);
    p.expectNothingOf(view.body, ['superseded', 'Anand', 'Balaji', 'RFQ-', staleBid.bidVersionId], 'customer enquiry');
    const quotation = await p.as.approver.get(`/api/v1/quotations/${deal.quoteId}`);
    p.expectNothingOf(quotation.body, ['Anand', 'Balaji', 'superseded'], 'customer quotation');
  });
});
