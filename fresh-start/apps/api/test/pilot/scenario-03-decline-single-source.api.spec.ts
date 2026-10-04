import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Body, ok, Pilot } from './driver';

/**
 * Pilot scenario 3 (doc 19 §10; doc 19 §4 "one response only"): one supplier declines, the
 * other bids, and the round becomes a single-source award. It needs a fallback and the
 * approval of a second sourcing lead; then it runs to an acknowledged purchase order like
 * any other.
 */
describe('Pilot 3: one decline, single-source approval', () => {
  let p: Pilot;
  let enquiryId: string;
  let rfqId: string;
  let itemId: string;
  let bidA: { bidVersionId: string };
  let evaluationId: string;
  let award: Body;
  let purchaseOrderId: string;

  beforeAll(async () => {
    p = await Pilot.start('s03');
    ({ enquiryId } = await p.approvedEnquiry());
    ({ rfqId, itemId } = await p.openRound(enquiryId));
  }, 180_000);

  afterAll(async () => {
    await p?.stop();
  });

  it('takes a decline with its reason, and the bid of the other supplier', async () => {
    ok(await p.as.supplierB.post(`/api/v1/supplier/rfqs/${rfqId}/decline`, { declineCode: 'capacity', reason: 'Our mills are full until March.' }), 201, 'supplier B declines');
    // A declined supplier cannot bid on the round afterwards.
    expect((await p.as.supplierB.post(`/api/v1/supplier/rfqs/${rfqId}/bid/submit`, p.bidBody(itemId, 4000))).status).toBeGreaterThanOrEqual(400);
    bidA = await p.bid('supplierA', rfqId, itemId, 4850);
    const invitations = ((await p.rfq(rfqId))['rfq'] as Body)['invitations'] as Body[];
    expect(invitations.map((i) => i['status']).sort()).toEqual(['declined', 'responded']);
  });

  it('closes early once every supplier answered, and flags the single source', async () => {
    const closed = await p.closeRound(rfqId);
    expect(closed).toMatchObject({ status: 'evaluation', responded: 1 });
    expect((await p.rfq(rfqId))['singleSourceRisk']).toBe(true);
    ({ evaluationId } = await p.evaluate(rfqId));
  });

  it('refuses a single-source award without a fallback, and accepts one with it', async () => {
    const bare = await p.proposeAward(rfqId, itemId, evaluationId, bidA.bidVersionId);
    expect(bare.status).toBe(422);
    expect(bare.body['code']).toBe('AWARD_FALLBACK_REQUIRED');
    const withFallback = await p.proposeAward(rfqId, itemId, evaluationId, bidA.bidVersionId, {
      fallbackNote: 'If Anand slips, re-source to the two Ambattur shops on the eligible list; drawing is standard.',
    });
    award = ok(withFallback, 201, 'propose single-source award');
    expect(award['singleSource']).toBe(true);
  });

  it('lets only a second sourcing lead approve it', async () => {
    const approvalId = award['approvalRequestId'] as string;
    // Sales may approve an ordinary award, not a single-source one.
    const sales = await p.decide('sales', approvalId);
    expect(sales.status).toBe(403);
    expect(sales.body['code']).toBe('APPROVAL_AUTHORITY_MISSING');
    // The proposer cannot approve their own.
    const self = await p.decide('sourcing', approvalId);
    expect(self.status).toBe(409);
    expect(self.body['code']).toBe('APPROVAL_SEPARATION');
    const approved = ok(await p.decide('sourcing2', approvalId), 201, 'second sourcing lead approves');
    expect(approved['status']).toBe('approved');
    const decision = await p.one<{ decided_by: string; authority_snapshot: Body }>(`SELECT decided_by, authority_snapshot FROM commercial.approval_decision WHERE request_id = $1`, [approvalId]);
    expect(decision.decided_by).toBe(p.users.sourcing2);
    expect(JSON.stringify(decision.authority_snapshot)).toContain('jobwork_sourcing');
  });

  it('runs on to an acknowledged purchase order with the only supplier who bid', async () => {
    const deal = await p.approvedAwardToPurchaseOrder(award['awardId'] as string);
    purchaseOrderId = deal.purchaseOrderId;
    expect(deal.purchaseOrders).toHaveLength(1);
    expect(deal.purchaseOrders[0]!['supplierOrganizationId']).toBe(p.orgs.supplierA);
    const bid = await p.one<{ total_amount_minor: string }>(`SELECT total_amount_minor FROM sourcing.supplier_bid_version WHERE id = $1`, [bidA.bidVersionId]);
    expect(deal.purchaseOrders[0]!['totalMinor']).toBe(Number(bid.total_amount_minor));
  });

  it('keeps the decline, the fallback and the approval in the record', async () => {
    const declined = await p.one<{ id: string; status: string; decline_code: string; decline_reason: string }>(
      `SELECT id, status, decline_code, decline_reason FROM sourcing.rfq_supplier WHERE rfq_id = $1 AND supplier_organization_id = $2`,
      [rfqId, p.orgs.supplierB],
    );
    expect(declined).toMatchObject({ status: 'declined', decline_code: 'capacity', decline_reason: 'Our mills are full until March.' });
    // The decline is audited on the invitation it answers.
    expect(await p.auditActions(declined.id)).toEqual(['sourcing.supplier_shortlisted', 'sourcing.supplier_invited', 'sourcing.rfq_declined']);
    const proposed = await p.auditTrail(award['awardId'] as string);
    expect(proposed.map((a) => a.action)).toEqual(['commercial.award_proposed', 'commercial.approval_decided']);
    const awardRow = await p.one<{ single_source: boolean; fallback_note: string }>(`SELECT single_source, fallback_note FROM commercial.award WHERE id = $1`, [award['awardId']]);
    expect(awardRow.single_source).toBe(true);
    expect(awardRow.fallback_note).toContain('re-source');
    expect(await p.auditActions(rfqId)).toEqual(['sourcing.rfq_created', 'sourcing.rfq_released', 'sourcing.rfq_closed']);
  });

  it('shows the declining supplier its own answer and nothing of the outcome', async () => {
    const view = await p.as.supplierB.get(`/api/v1/supplier/rfqs/${rfqId}`);
    expect(view.body['invitationStatus']).toBe('declined');
    p.expectNothingOf(view.body, ['Anand', 'Kovai', String(4850)], 'declining supplier RFQ');
    expect((await p.as.supplierB.get(`/api/v1/supplier/purchase-orders/${purchaseOrderId}`)).status).toBe(404);
    await p.dispatchNotifications();
    expect((await p.notices('supplierB')).map((n) => n.template_key)).toEqual(['supplier.rfq_invitation']);
  });
});
