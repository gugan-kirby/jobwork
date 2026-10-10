import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Body, ok, Pilot } from './pilot/driver';

/**
 * F-FP: the fixed-price path. The customer names the price it hopes to pay (FR-308); JobWork offers
 * the supplier a price it sets (FR-408) and sets the customer's price itself (FR-409). The supplier
 * never sees the customer, its target, or the customer's price.
 */
describe('fixed-price path (F-FP)', () => {
  let p: Pilot;

  beforeAll(async () => {
    p = await Pilot.start('fixedprice');
  }, 120_000);

  afterAll(async () => {
    await p?.stop();
  });

  describe('F-FP.1 the customer’s target price', () => {
    let enquiryId: string;

    it('keeps the target with the item, in the frozen revision, and shows it to JobWork', async () => {
      expect((await p.as.buyer.post('/api/v1/enquiries/draft', p.draftBody({}, { targetUnitPriceMinor: -1 }))).status).toBe(400);
      expect((await p.as.buyer.post('/api/v1/enquiries/draft', p.draftBody({}, { targetUnitPriceMinor: 12.5 }))).status).toBe(400);

      const draft = ok(await p.as.buyer.post('/api/v1/enquiries/draft', p.draftBody({}, { targetUnitPriceMinor: 13_000 })), 201, 'draft');
      expect(((draft['items'] as Body[])[0]!)['targetUnitPriceMinor']).toBe(13_000);
      expect(draft['currency']).toBe('INR');
      const seen = ok(await p.as.buyer.get(`/api/v1/enquiries/${draft['enquiryId']}`), 200, 'customer reads draft');
      expect((((seen['draft'] as Body)['items'] as Body[])[0]!)['targetUnitPriceMinor']).toBe(13_000);

      ok(await p.as.buyer.post(`/api/v1/enquiries/${draft['enquiryId']}/submit`, { expectedVersion: draft['aggregateVersion'] }), 201, 'submit');
      enquiryId = draft['enquiryId'] as string;
      const intake = (await p.intake(enquiryId))['enquiry'] as Body;
      expect(intake).toMatchObject({ currency: 'INR', items: [expect.objectContaining({ targetUnitPriceMinor: 13_000 })] });
      const revision = await p.one<{ snapshot: Body }>(`SELECT snapshot FROM sourcing.requirement WHERE enquiry_id = $1 ORDER BY revision_no DESC LIMIT 1`, [enquiryId]);
      expect(((revision.snapshot['items'] as Body[])[0]!)['targetUnitPriceMinor']).toBe(13_000);
    });

    it('leaves an enquiry without a target hashed exactly as before', async () => {
      const { enquiryId: plain } = await p.submitEnquiry();
      const revision = await p.one<{ snapshot: Body }>(`SELECT snapshot FROM sourcing.requirement WHERE enquiry_id = $1`, [plain]);
      expect(Object.keys((revision.snapshot['items'] as Body[])[0]!)).not.toContain('targetUnitPriceMinor');
    });

    it('never sends the target to a supplier', async () => {
      await p.triage(enquiryId);
      await p.approveForSourcing(enquiryId);
      const { rfqId } = await p.openRound(enquiryId);
      const view = ok(await p.as.supplierA.get(`/api/v1/supplier/rfqs/${rfqId}`), 200, 'supplier round');
      p.expectNothingOf(view, ['13000', '130.00', 'targetUnitPrice', 'Kovai'], 'supplier RFQ view');
    });
  });

  describe('F-FP.2 the fixed-price offer', () => {
    const offer = (unitPriceMinor: number) => ({ pricingMode: 'fixed', offer: { paymentTerms: '30 days from JobWork’s acceptance of the goods', lines: [{ lineNo: 1, unitPriceMinor }] } });
    const accept = (actor: 'supplierA' | 'supplierB', rfqId: string, body: Body = {}) =>
      p.as[actor].post(`/api/v1/supplier/rfqs/${rfqId}/offer/accept`, { leadTimeDays: 21, validityUntil: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10), note: 'Material in stock', ...body });
    const sourced = async (): Promise<string> => (await p.approvedEnquiry({ targetUnitPriceMinor: 13_000 })).enquiryId;
    let rfqId: string;

    it('creates a fixed round only with a price for every line, and keeps the price fixed', async () => {
      const enquiryId = await sourced();
      const base = { enquiryId, deadlineAt: new Date(Date.now() + 7 * 86_400_000).toISOString() };
      expect((await p.as.sourcing.post('/api/v1/rfqs', { ...base, pricingMode: 'fixed' })).status).toBe(400);
      expect((await p.as.sourcing.post('/api/v1/rfqs', { ...base, offer: offer(11_000).offer })).status).toBe(400);
      expect((await p.as.sourcing.post('/api/v1/rfqs', { ...base, pricingMode: 'fixed', offer: { paymentTerms: '30 days', lines: [{ lineNo: 2, unitPriceMinor: 11_000 }] } })).body['code']).toBe('OFFER_LINES');

      ({ rfqId } = await p.openRound(enquiryId, ['supplierA', 'supplierB'], offer(11_000)));
      const internal = ok(await p.as.sourcing.get(`/api/v1/rfqs/${rfqId}`), 200, 'internal round')['rfq'] as Body;
      expect(internal).toMatchObject({ pricingMode: 'fixed', offerPaymentTerms: expect.stringContaining('30 days'), items: [expect.objectContaining({ offeredUnitPriceMinor: 11_000 })] });
      await expect(p.pg.query(`UPDATE sourcing.rfq_item SET offered_unit_price_minor = 9000 WHERE rfq_id = $1`, [rfqId])).rejects.toThrow(/fixed once written/);
    });

    it('shows the supplier JobWork’s offer and nothing of the customer, and refuses a free price', async () => {
      const seen = ok(await p.as.supplierA.get(`/api/v1/supplier/rfqs/${rfqId}`), 200, 'supplier round');
      expect(seen).toMatchObject({ pricingMode: 'fixed', offerPaymentTerms: expect.any(String), items: [expect.objectContaining({ offeredUnitPriceMinor: 11_000 })] });
      p.expectNothingOf(seen, ['13000', 'targetUnitPrice', 'Kovai', p.orgs.customer], 'supplier fixed offer');
      const itemId = ((seen['items'] as Body[])[0]!)['rfqItemId'] as string;
      expect((await p.as.supplierA.post(`/api/v1/supplier/rfqs/${rfqId}/bid/submit`, p.bidBody(itemId, 10_500))).body['code']).toBe('FIXED_PRICE_ROUND');
      expect((await p.as.supplierA.post(`/api/v1/supplier/rfqs/${rfqId}/bid/draft`, { draft: { leadTimeDays: 10 } })).body['code']).toBe('FIXED_PRICE_ROUND');
    });

    it('lets a supplier decline on price, and turns the first acceptance into a bid at exactly the offer', async () => {
      ok(await p.as.supplierB.post(`/api/v1/supplier/rfqs/${rfqId}/decline`, { declineCode: 'commercial', reason: 'Below our cost at this quantity' }), 201, 'B declines');
      const accepted = ok(await accept('supplierA', rfqId, { unitPriceMinor: 99_999 }), 201, 'A accepts');
      const line = await p.one<{ unit_price_minor: string; setup_amount_minor: string; quantity: string }>(`SELECT unit_price_minor::text, setup_amount_minor::text, quantity::text FROM sourcing.bid_line WHERE supplier_bid_version_id = $1`, [accepted['bidVersionId']]);
      expect(line).toEqual({ unit_price_minor: '11000', setup_amount_minor: '0', quantity: '100.0000' });
      expect(await p.one(`SELECT payment_terms, status FROM sourcing.supplier_bid_version WHERE id = $1`, [accepted['bidVersionId']])).toEqual({ payment_terms: '30 days from JobWork’s acceptance of the goods', status: 'submitted' });
      expect((ok(await p.as.sourcing.get(`/api/v1/rfqs/${rfqId}`), 200, 'round')['rfq'] as Body)['status']).toBe('evaluation');
      expect((await accept('supplierA', rfqId)).body['code']).toBe('OFFER_TAKEN');
      await expect(p.pg.query(`INSERT INTO sourcing.bid_line (supplier_bid_version_id, rfq_item_id, line_no, quantity, unit, unit_price_minor) SELECT $1, rfq_item_id, 2, 5, 'piece', 1 FROM sourcing.bid_line WHERE supplier_bid_version_id = $1`, [accepted['bidVersionId']])).rejects.toThrow(/offered price only/);
      expect(await p.auditActions(rfqId)).toContain('sourcing.offer_accepted');
    });

    it('gives the offer to exactly one of two suppliers accepting at once, and tells the other it was taken', async () => {
      const { rfqId: race } = await p.openRound(await sourced(), ['supplierA', 'supplierB'], offer(11_500));
      const [a, b] = await Promise.all([accept('supplierA', race), accept('supplierB', race)]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      expect([a, b].find((r) => r.status === 409)!.body['code']).toBe('OFFER_TAKEN');
      const loser = a.status === 409 ? 'supplierA' : 'supplierB';
      expect(ok(await p.as[loser].get(`/api/v1/supplier/rfqs/${race}`), 200, 'loser view')['invitationStatus']).toBe('offer_taken');
      expect(await p.one(`SELECT count(*)::int AS n FROM sourcing.supplier_bid_version v JOIN sourcing.supplier_bid b ON b.id = v.supplier_bid_id WHERE b.rfq_id = $1`, [race])).toEqual({ n: 1 });
    });

    it('carries the accepted offer through award, quote and acceptance to a PO at the offered price', async () => {
      const seen = ok(await p.as.sourcing.get(`/api/v1/rfqs/${rfqId}`), 200, 'round');
      const itemId = (((seen['rfq'] as Body)['items'] as Body[])[0]!)['rfqItemId'] as string;
      const bidVersionId = (await p.one<{ id: string }>(`SELECT v.id FROM sourcing.supplier_bid_version v JOIN sourcing.supplier_bid b ON b.id = v.supplier_bid_id WHERE b.rfq_id = $1`, [rfqId])).id;
      const { evaluationId } = await p.evaluate(rfqId);
      // One acceptance means one bid: the single-source rule applies as to any round (doc 19 §4).
      expect((await p.proposeAward(rfqId, itemId, evaluationId, bidVersionId)).body['code']).toBe('AWARD_FALLBACK_REQUIRED');
      const award = ok(await p.proposeAward(rfqId, itemId, evaluationId, bidVersionId, { fallbackNote: 'If Anand slips, re-offer to Balaji at the same price.' }), 201, 'propose award');
      ok(await p.decide('sourcing2', award['approvalRequestId'] as string), 201, 'second sourcing lead approves');
      const deal = await p.approvedAwardToPurchaseOrder(award['awardId'] as string);
      const po = ok(await p.as.supplierA.get(`/api/v1/supplier/purchase-orders/${deal.purchaseOrderId}`), 200, 'supplier PO');
      expect(((po['lines'] as Body[])[0]!)['unitPriceMinor']).toBe(11_000);
      p.expectNothingOf(po, ['13000', 'Kovai', p.orgs.customer], 'supplier PO');
    });
  });

  describe('F-FP.3 JobWork sets the customer price', () => {
    it('quotes the customer exactly the price JobWork set, with the margin following and the floor still guarded', async () => {
      const { enquiryId } = await p.approvedEnquiry({ targetUnitPriceMinor: 13_000 });
      const { rfqId } = await p.openRound(enquiryId, ['supplierA', 'supplierB'], { pricingMode: 'fixed', offer: { paymentTerms: '30 days from receipt', lines: [{ lineNo: 1, unitPriceMinor: 11_000 }] } });
      const accepted = ok(await p.as.supplierA.post(`/api/v1/supplier/rfqs/${rfqId}/offer/accept`, { leadTimeDays: 21, validityUntil: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10) }), 201, 'accept');
      const itemId = ((((ok(await p.as.sourcing.get(`/api/v1/rfqs/${rfqId}`), 200, 'round')['rfq'] as Body)['items'] as Body[])[0]!)['rfqItemId']) as string;
      const { evaluationId } = await p.evaluate(rfqId);
      const award = ok(await p.proposeAward(rfqId, itemId, evaluationId, accepted['bidVersionId'] as string, { fallbackNote: 'Re-offer to Balaji at the same price.' }), 201, 'award');
      ok(await p.decide('sourcing2', award['approvalRequestId'] as string), 201, 'approve award');
      const sheetUrl = `/api/v1/awards/${award['awardId']}/cost-sheet`;

      expect((await p.as.sales.post(sheetUrl, { targetMarginBp: 1500, sellLines: [{ lineNo: 1, unitSellMinor: 14_000 }] })).status).toBe(400);
      expect((await p.as.sales.post(sheetUrl, { sellLines: [{ lineNo: 2, unitSellMinor: 14_000 }] })).body['code']).toBe('SELL_LINES_MISMATCH');

      // ₹115 against ₹110 is 4.3 %: under the 10 % floor, so finance decides, and returns it.
      let sheet = ok(await p.as.sales.post(sheetUrl, { sellLines: [{ lineNo: 1, unitSellMinor: 11_500 }], note: 'Match the customer’s budget' }), 201, 'under the floor');
      const costSheetId = sheet['costSheetId'] as string;
      let requested = ok(await p.as.sales.post(`/api/v1/cost-sheets/${costSheetId}/request-approval`, {}), 201, 'request');
      let approvalId = (requested['versions'] as Body[])[0]!['approvalRequestId'] as string;
      const request = ok(await p.as.finance.get(`/api/v1/approvals/${approvalId}`), 200, 'approval');
      expect(request['requiredRoles']).toEqual(['jobwork_finance']);
      expect((request['context'] as Body)['exception']).toBe('below_margin_floor');
      ok(await p.decide('finance', approvalId, 'returned', 'Ten percent is our floor; price it at ₹140.'), 201, 'return');

      sheet = ok(await p.as.sales.post(sheetUrl, { sellLines: [{ lineNo: 1, unitSellMinor: 14_000 }], note: 'Customer price set by JobWork' }), 201, 'at the customer price');
      const version = (sheet['versions'] as Body[])[0]!;
      expect(version).toMatchObject({ buyTotalMinor: 1_100_000, landedTotalMinor: 1_100_000, sellTotalMinor: 1_400_000, marginMinor: 300_000, marginBp: 2143 });
      expect(version['sellLines']).toEqual([expect.objectContaining({ lineNo: 1, quantity: 100, unitSellMinor: 14_000, amountMinor: 1_400_000 })]);
      requested = ok(await p.as.sales.post(`/api/v1/cost-sheets/${costSheetId}/request-approval`, {}), 201, 'request again');
      approvalId = (requested['versions'] as Body[])[0]!['approvalRequestId'] as string;
      ok(await p.decide('finance', approvalId), 201, 'approve');
      const approved = (ok(await p.as.sales.get(`/api/v1/cost-sheets/${costSheetId}`), 200, 'sheet')['versions'] as Body[]).find((v) => v['status'] === 'approved')!;

      const quoteId = await p.sentQuote(approved['costSheetVersionId'] as string);
      const quotation = ok(await p.as.approver.get(`/api/v1/quotations/${quoteId}`), 200, 'customer quotation');
      expect((quotation['lines'] as Body[])[0]).toMatchObject({ unitPriceMinor: 14_000, quantity: 100 });
      p.expectNothingOf(quotation, ['11000', '110.00', 'Anand', '300000'], 'customer quotation');

      const accept = ok(await p.accept(quoteId, `accept-${quoteId}`, await p.acceptanceBody(quoteId)), 201, 'accept quote');
      const pos = await p.issuePurchaseOrders(accept['orderId'] as string);
      const po = ok(await p.as.supplierA.get(`/api/v1/supplier/purchase-orders/${pos[0]!['purchaseOrderId']}`), 200, 'supplier PO');
      expect(((po['lines'] as Body[])[0]!)['unitPriceMinor']).toBe(11_000);
      p.expectNothingOf(po, ['14000', '140.00', '13000', 'Kovai'], 'supplier PO');
    });
  });
});
