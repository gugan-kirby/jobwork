import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Body, Pilot, type SourcedDeal } from './driver';

/**
 * Pilot scenario 1 (doc 19 §10): a clean single-item RFQ with two suppliers and one
 * accepted JobWork quote, carried through to the supplier's acknowledged purchase order.
 */
describe('Pilot 1: clean RFQ, two suppliers, one accepted quote', () => {
  let p: Pilot;
  let enquiryId: string;
  let reference: string;
  let deal: SourcedDeal;

  beforeAll(async () => {
    p = await Pilot.start('s01');
    ({ enquiryId, reference } = await p.approvedEnquiry());
    deal = await p.sourceToPurchaseOrder(enquiryId);
    await p.dispatchNotifications();
  }, 180_000);

  afterAll(async () => {
    await p?.stop();
  });

  it('keeps every record as a version: one frozen requirement, immutable bids, the quote version the customer accepted', async () => {
    const revisions = (await p.intake(enquiryId))['revisions'] as Body[];
    expect(revisions.map((r) => [r['revisionNo'], r['kind']])).toEqual([[1, 'intake'], [2, 'reviewed']]);
    const rfq = await p.one<{ requirement_id: string }>(`SELECT requirement_id FROM sourcing.rfq WHERE id = $1`, [deal.rfqId]);
    const reviewed = await p.one<{ id: string }>(`SELECT id FROM sourcing.requirement WHERE enquiry_id = $1 AND revision_no = 2`, [enquiryId]);
    expect(rfq.requirement_id).toBe(reviewed.id);

    const bids = await p.rows<{ status: string; version_no: number }>(
      `SELECT v.status, v.version_no FROM sourcing.supplier_bid_version v JOIN sourcing.supplier_bid b ON b.id = v.supplier_bid_id WHERE b.rfq_id = $1 ORDER BY v.total_amount_minor`,
      [deal.rfqId],
    );
    // The award closes out every live bid explicitly: the winner selected, the other rejected.
    expect(bids).toEqual([{ status: 'selected', version_no: 1 }, { status: 'rejected', version_no: 1 }]);
    await expect(p.pg.query(`UPDATE sourcing.supplier_bid_version SET total_amount_minor = 1 WHERE id = $1`, [deal.winner.bidVersionId])).rejects.toThrow(/immutable/);

    const acceptance = await p.one<{ quote_version_id: string; content_hash: string }>(`SELECT quote_version_id, content_hash FROM commercial.acceptance WHERE customer_quote_id = $1`, [deal.quoteId]);
    const sent = await p.one<{ id: string; content_hash: string; status: string }>(`SELECT id, content_hash, status FROM commercial.quote_version WHERE customer_quote_id = $1`, [deal.quoteId]);
    expect(acceptance).toEqual({ quote_version_id: sent.id, content_hash: sent.content_hash });
  });

  it('holds authority at every step: separation of duties, roles, and the customer’s own approver', async () => {
    // The award was approved by sales, not its sourcing proposer.
    const award = await p.as.sourcing.get(`/api/v1/awards/${deal.awardId}`);
    expect(award.body['status']).toBe('approved');
    const decisions = await p.rows<{ decided_by: string }>(`SELECT d.decided_by FROM commercial.approval_decision d WHERE d.request_id = $1`, [deal.award['approvalRequestId']]);
    expect(decisions.map((d) => d.decided_by)).toEqual([p.users.sales]);
    // A requester cannot accept for the company; nobody accepts twice.
    const refused = await p.as.buyer.post(`/api/v1/quotations/${deal.quoteId}/accept`, await p.acceptanceBody(deal.quoteId));
    expect(refused.status).toBe(403);
    const again = await p.accept(deal.quoteId);
    expect(again.status).toBe(409);
    // Neither outside party reaches the internal records.
    expect((await p.as.supplierA.get(`/api/v1/rfqs/${deal.rfqId}`)).status).toBe(403);
    expect((await p.as.buyer.get(`/api/v1/sales-orders/${deal.orderId}`)).status).toBe(403);
  });

  it('writes the audit trail and the outbox event for every step', async () => {
    // Exactly one audit row per step, in the order the steps happened.
    expect(await p.auditActions(enquiryId)).toEqual(['sourcing.enquiry_draft_saved', 'sourcing.enquiry_submitted', 'sourcing.triage_started', 'sourcing.enquiry_approved_for_sourcing']);
    expect(await p.auditActions(deal.rfqId)).toEqual(['sourcing.rfq_created', 'sourcing.rfq_released', 'sourcing.rfq_closed']);
    expect(await p.auditActions(deal.awardId)).toEqual(['commercial.award_proposed', 'commercial.approval_decided']);
    expect(await p.auditActions(deal.quoteId)).toEqual(['commercial.quote_drafted', 'commercial.quote_approval_requested', 'commercial.quote_sent', 'commercial.quote_accepted']);
    expect(await p.auditActions(deal.orderId)).toEqual(['orders.sales_order_created']);
    expect(await p.auditActions(deal.purchaseOrderId)).toEqual(['orders.purchase_order_issued', 'orders.purchase_order_acknowledged']);
    // ...and the event the rest of the system reacts to.
    expect(await p.events(deal.rfqId)).toEqual(['sourcing.rfq_released.v1', 'sourcing.rfq_closed.v1']);
    expect(await p.events(deal.quoteId)).toEqual(['commercial.quote_approval_requested.v1', 'commercial.quote_sent.v1', 'commercial.quote_accepted.v1']);
    expect(await p.events(deal.orderId)).toEqual(['orders.sales_order_created.v1']);
    expect(await p.events(deal.purchaseOrderId)).toEqual(['orders.purchase_order_issued.v1', 'orders.purchase_order_acknowledged.v1']);
    // Every critical write was audited by a named person, never anonymously.
    const anonymous = await p.rows(`SELECT action FROM platform.audit_event WHERE actor_type = 'user' AND actor_id IS NULL`);
    expect(anonymous).toEqual([]);
  });

  it('shows each party only its own side', async () => {
    const quotation = await p.as.approver.get(`/api/v1/quotations/${deal.quoteId}`);
    p.expectNothingOf(quotation.body, ['Anand', 'Balaji', deal.winner.bidVersionId, 'buyTotal', 'margin'], 'customer quotation');
    const order = await p.as.approver.get(`/api/v1/orders/${deal.orderId}`);
    expect(order.status).toBe(200);
    p.expectNothingOf(order.body, ['Anand', 'Balaji', deal.purchaseOrderId], 'customer order');
    const enquiry = await p.as.buyer.get(`/api/v1/enquiries/${enquiryId}`);
    p.expectNothingOf(enquiry.body, ['Anand', 'Balaji', 'RFQ-'], 'customer enquiry');

    const rfq = await p.as.supplierA.get(`/api/v1/supplier/rfqs/${deal.rfqId}`);
    p.expectNothingOf(rfq.body, ['Kovai', reference, 'Balaji'], 'supplier RFQ');
    const po = await p.as.supplierA.get(`/api/v1/supplier/purchase-orders/${deal.purchaseOrderId}`);
    p.expectNothingOf(po.body, ['Kovai', reference, 'Balaji'], 'supplier PO');
    // The loser sees no PO; its own bid tells it the outcome. (No notice is sent for it:
    // `commercial.approval_decided.v1` is acknowledged, not notified. Recorded in the plan.)
    expect((await p.as.supplierB.get(`/api/v1/supplier/purchase-orders/${deal.purchaseOrderId}`)).status).toBe(404);
    const lost = await p.as.supplierB.get(`/api/v1/supplier/rfqs/${deal.rfqId}`);
    expect(((lost.body['bid'] as Body)['versions'] as Body[]).map((v) => v['status'])).toEqual(['rejected']);
    p.expectNothingOf(lost.body, ['Anand', 'Kovai', String(4850)], 'losing supplier RFQ');
  });

  it('tells each party what it needs to act on, in its own words', async () => {
    const supplierA = (await p.notices('supplierA')).map((n) => n.template_key);
    expect(supplierA).toEqual(expect.arrayContaining(['supplier.rfq_invitation', 'supplier.purchase_order_issued']));
    expect((await p.notices('supplierB')).map((n) => n.template_key)).toContain('supplier.rfq_invitation');
    expect((await p.notices('supplierB')).map((n) => n.template_key)).not.toContain('supplier.purchase_order_issued');
    const customer = [...(await p.notices('buyer')), ...(await p.notices('approver'))].map((n) => n.template_key);
    expect(customer.some((k) => k.startsWith('customer.'))).toBe(true);
    for (const actor of ['buyer', 'approver'] as const) p.expectNothingOf(await p.notices(actor), ['Anand', 'Balaji'], `${actor} notices`);
    for (const actor of ['supplierA', 'supplierB'] as const) p.expectNothingOf(await p.notices(actor), ['Kovai', reference], `${actor} notices`);
  });

  it('recovers from a repeated acceptance: the same key returns the same order, and only one exists', async () => {
    // A double click or a retry after a dropped connection replays the same request.
    const replay = await p.accept(deal.quoteId, deal.accept.key, deal.accept.body);
    expect(replay.status).toBe(201);
    expect(replay.body['orderId']).toBe(deal.orderId);
    // The same key with a different body is a different request, refused rather than guessed at.
    const altered = await p.accept(deal.quoteId, deal.accept.key, { ...deal.accept.body, acknowledgeTerms: true, deliverySiteId: null });
    expect(altered.status).toBeGreaterThanOrEqual(400);
    const orders = await p.rows(`SELECT id FROM orders.sales_order`);
    expect(orders).toHaveLength(1);
    expect(orders[0]!['id']).toBe(deal.orderId);
  });

  it('ends consistent: quantity conserved from enquiry to PO, and the money adds up on both legs', async () => {
    const so = (await p.as.sourcing.get(`/api/v1/sales-orders/${deal.orderId}`)).body;
    const quote = (await p.as.sales.get(`/api/v1/quotes/${deal.quoteId}`)).body;
    const version = (quote['versions'] as Body[])[0]!;
    const installments = so['installments'] as Body[];
    // Sell leg: the order's installments add up to the quote the customer accepted.
    expect(installments.reduce((t, i) => t + (i['amountMinor'] as number), 0)).toBe(version['totalMinor']);
    expect(version['totalMinor']).toBe((version['subtotalMinor'] as number) + (version['taxMinor'] as number));
    // Buy leg: the PO carries exactly the awarded bid; the quantity is the enquiry's 100.
    const bid = await p.one<{ total_amount_minor: string }>(`SELECT total_amount_minor FROM sourcing.supplier_bid_version WHERE id = $1`, [deal.winner.bidVersionId]);
    expect(deal.purchaseOrders[0]!['totalMinor']).toBe(Number(bid.total_amount_minor));
    const poLines = await p.rows<{ quantity: string }>(`SELECT quantity FROM orders.purchase_order_line WHERE purchase_order_id = $1`, [deal.purchaseOrderId]);
    expect(poLines.reduce((t, l) => t + Number(l.quantity), 0)).toBe(100);
    // JobWork sells for more than it buys.
    expect(version['subtotalMinor'] as number).toBeGreaterThan(Number(bid.total_amount_minor));
  });
});
