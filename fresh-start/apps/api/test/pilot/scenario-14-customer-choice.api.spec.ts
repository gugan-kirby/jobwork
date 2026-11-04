import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Body, Pilot, ok } from './driver';

/**
 * ADR-0007 P2: JobWork quotes two suppliers on one enquiry and the customer chooses. Nothing
 * closes until they do; accepting one awards it, closes the other, and only the chosen
 * supplier gets a purchase order.
 */
describe('Pilot 14: two named suppliers, the customer chooses', () => {
  let p: Pilot;
  let rfqId: string;
  let quoteA: string;
  let quoteB: string;
  let awardB: string;
  let bidAId: string;
  let bidBId: string;
  let orderId: string;

  async function choiceQuote(itemId: string, evaluationId: string, bidVersionId: string): Promise<{ quoteId: string; awardId: string }> {
    const award = ok(
      await p.proposeAward(rfqId, itemId, evaluationId, bidVersionId, { customerChoice: true, rationale: 'Offered to the customer', fallbackNote: 'The other supplier' }),
      201,
      'propose',
    );
    ok(await p.decide('sales', award['approvalRequestId'] as string), 201, 'approve award');
    const sheet = await p.approvedCostSheet(award['awardId'] as string);
    return { quoteId: await p.sentQuote(sheet.costSheetVersionId), awardId: award['awardId'] as string };
  }

  beforeAll(async () => {
    p = await Pilot.start('s14');
    const { enquiryId } = await p.approvedEnquiry();
    const round = await p.openRound(enquiryId);
    rfqId = round.rfqId;
    const bidA = await p.bid('supplierA', rfqId, round.itemId, 11_000);
    const bidB = await p.bid('supplierB', rfqId, round.itemId, 11_500);
    bidAId = bidA.bidVersionId;
    bidBId = bidB.bidVersionId;
    await p.closeRound(rfqId);
    const { evaluationId } = await p.evaluate(rfqId);
    ({ quoteId: quoteA } = await choiceQuote(round.itemId, evaluationId, bidAId));
    ({ quoteId: quoteB, awardId: awardB } = await choiceQuote(round.itemId, evaluationId, bidBId));
  }, 180_000);

  afterAll(async () => {
    await p?.stop();
  });

  it('shows the customer both suppliers, each under its own name, with nothing decided', async () => {
    const list = ok(await p.as.approver.get('/api/v1/quotations'), 200, 'list')['quotations'] as Body[];
    const names = list.filter((q) => [quoteA, quoteB].includes(q['quotationId'] as string)).map((q) => (q['supplier'] as Body)['name']);
    expect(new Set(names).size).toBe(2);
    const bids = await p.rows<{ status: string }>(`SELECT status FROM sourcing.supplier_bid_version WHERE id = ANY($1)`, [[bidAId, bidBId]]);
    expect(bids.every((b) => b.status !== 'rejected')).toBe(true);
    expect((await p.one<{ status: string }>(`SELECT status FROM sourcing.rfq WHERE id = $1`, [rfqId])).status).toBe('evaluation');
  });

  it('refuses a split award as a customer choice, since it names nobody', async () => {
    const res = await p.as.sourcing.post('/api/v1/awards', {
      rfqId,
      customerChoice: true,
      rationale: 'Split',
      fallbackNote: 'None',
      items: [{ rfqItemId: (await p.one<{ id: string }>(`SELECT id FROM sourcing.rfq_item WHERE rfq_id = $1`, [rfqId])).id, targetQuantity: 100, lines: [
        { bidVersionId: bidAId, bidQuantity: 100, quantity: 50 },
        { bidVersionId: bidBId, bidQuantity: 100, quantity: 50 },
      ] }],
    });
    expect(res.status).toBe(422);
    expect(res.body['code']).toBe('AWARD_CHOICE_ONE_SUPPLIER');
  });

  it('awards the supplier the customer accepts and closes the other', async () => {
    const accepted = ok(await p.accept(quoteA), 201, 'accept');
    expect((await p.one<{ status: string }>(`SELECT status FROM sourcing.rfq WHERE id = $1`, [rfqId])).status).toBe('awarded');
    const bids = await p.rows<{ id: string; status: string }>(`SELECT id, status FROM sourcing.supplier_bid_version WHERE id = ANY($1)`, [[bidAId, bidBId]]);
    expect(bids.find((b) => b.id === bidAId)?.status).toBe('selected');
    expect(bids.find((b) => b.id === bidBId)?.status).toBe('rejected');
    expect((await p.one<{ status: string }>(`SELECT status FROM commercial.award WHERE id = $1`, [awardB])).status).toBe('rejected');
    expect((await p.one<{ status: string }>(`SELECT status FROM commercial.customer_quote WHERE id = $1`, [quoteB])).status).toBe('withdrawn');

    orderId = accepted['orderId'] as string;
    const orders = await p.issuePurchaseOrders(orderId);
    expect(orders).toHaveLength(1);
  });

  it('takes one rating, after completion, and shows the earned average on the supplier card', async () => {
    const early = await p.as.approver.post(`/api/v1/orders/${orderId}/rating`, { score: 5 });
    expect(early.status).toBe(409);
    expect(early.body['code']).toBe('ORDER_NOT_COMPLETE');

    await p.pg.query(`ALTER TABLE orders.sales_order DISABLE TRIGGER USER`);
    await p.pg.query(`UPDATE orders.sales_order SET status = 'closed' WHERE id = $1`, [orderId]);
    await p.pg.query(`ALTER TABLE orders.sales_order ENABLE TRIGGER USER`);

    expect((await p.as.approver.post(`/api/v1/orders/${orderId}/rating`, { score: 9 })).status).toBe(400);
    const stranger = await p.as.supplierA.post(`/api/v1/orders/${orderId}/rating`, { score: 1 });
    expect(stranger.status).toBe(403);

    const rated = ok(await p.as.approver.post(`/api/v1/orders/${orderId}/rating`, { score: 4, note: 'Good finish' }), 201, 'rate');
    expect(rated['rating']).toEqual({ score: 4, note: 'Good finish' });
    expect(rated['supplier']).toMatchObject({ ratingAverage: 4, ratingCount: 1 });

    const again = await p.as.approver.post(`/api/v1/orders/${orderId}/rating`, { score: 1 });
    expect(again.status).toBe(409);
    expect(again.body['code']).toBe('ORDER_ALREADY_RATED');
    expect(await p.auditActions(orderId)).toContain('orders.supplier_rated');
  });
});
