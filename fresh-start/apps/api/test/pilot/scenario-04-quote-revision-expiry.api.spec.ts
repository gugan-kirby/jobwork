import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Body, daysFromNow, ok, Pilot } from './driver';

/**
 * Pilot scenario 4 (doc 19 §10; doc 19 §4 "quote accepted as it expires/supersedes"): the
 * customer asks for a revision; a tab still showing the old version tries to accept and
 * gets a stable conflict; the revised quote lapses before anyone accepts it; JobWork
 * re-quotes; two approvers accept at once and exactly one order results.
 */
describe('Pilot 4: quote revision, concurrency and expiry retry', () => {
  let p: Pilot;
  let costSheetVersionId: string;
  let quoteId: string;
  let staleTab: Body;
  let requoteId: string;
  let orderId: string;

  beforeAll(async () => {
    p = await Pilot.start('s04');
    const { enquiryId } = await p.approvedEnquiry();
    const { rfqId, itemId } = await p.openRound(enquiryId);
    const bid = await p.bid('supplierA', rfqId, itemId, 4850);
    await p.bid('supplierB', rfqId, itemId, 5250);
    await p.closeRound(rfqId);
    const { evaluationId } = await p.evaluate(rfqId);
    const award = ok(await p.proposeAward(rfqId, itemId, evaluationId, bid.bidVersionId), 201, 'propose award');
    ok(await p.decide('sales', award['approvalRequestId'] as string), 201, 'approve award');
    ({ costSheetVersionId } = await p.approvedCostSheet(award['awardId'] as string));
    quoteId = await p.sentQuote(costSheetVersionId);
    // The approver opens the quotation and leaves the tab open.
    staleTab = await p.acceptanceBody(quoteId);
  }, 180_000);

  afterAll(async () => {
    await p?.stop();
  });

  it('takes the customer’s revision request and issues version 2 through the same approval', async () => {
    const seen = await p.as.buyer.get(`/api/v1/quotations/${quoteId}`);
    ok(await p.as.buyer.post(`/api/v1/quotations/${quoteId}/request-revision`, { expectedVersion: seen.body['aggregateVersion'], reason: 'Can you sharpen the price for a repeat order?' }), 201, 'request revision');
    const internal = ok(await p.as.sales.get(`/api/v1/quotes/${quoteId}`), 200, 'read quote');
    const v1 = (internal['versions'] as Body[])[0]!;
    ok(
      await p.as.sales.post(`/api/v1/quotes/${quoteId}/replace`, {
        expectedVersion: internal['aggregateVersion'],
        revisionReason: 'Two per cent off for the repeat order.',
        content: {
          lines: (v1['lines'] as Body[]).map((l) => ({ ...l, unitPriceMinor: Math.round((l['unitPriceMinor'] as number) * 0.98) })),
          taxRateBp: 1800,
          freightMinor: 0,
          deliveryLeadDays: v1['deliveryLeadDays'],
          paymentTerms: v1['paymentTerms'],
          validityUntil: v1['validityUntil'],
          assumptions: v1['assumptions'] ?? '',
          exclusions: '',
          scopeNote: '',
        },
      }),
      201,
      'replace quote',
    );
    await p.approveAndSend(quoteId);
    const versions = ((await p.as.sales.get(`/api/v1/quotes/${quoteId}`)).body['versions'] as Body[]).map((v) => [v['versionNo'], v['status']]);
    expect(versions).toEqual([[2, 'sent'], [1, 'superseded']]);
    expect((v1['totalMinor'] as number) > (((await p.as.sales.get(`/api/v1/quotes/${quoteId}`)).body['versions'] as Body[])[0]!['totalMinor'] as number)).toBe(true);
  });

  it('refuses the stale tab with a stable conflict and points at the current version', async () => {
    const stale = await p.accept(quoteId, undefined, staleTab);
    expect(stale.status).toBe(409);
    expect(['VERSION_CONFLICT', 'QUOTE_CONTENT_MISMATCH']).toContain(stale.body['code']);
    const current = await p.as.approver.get(`/api/v1/quotations/${quoteId}`);
    expect(current.body['versionNo']).toBe(2);
    expect((current.body['actions'] as Body)['canAccept']).toBe(true);
  });

  it('refuses acceptance once version 2 has lapsed, and the sweep records the expiry', async () => {
    // Validity is frozen content; the only honest way to age it is to move the date under
    // it (trigger lifted for the edit, as the IN-07 suite does).
    await p.pg.query(`ALTER TABLE commercial.quote_version DISABLE TRIGGER trg_quote_version_immutable`);
    await p.pg.query(`UPDATE commercial.quote_version SET validity_until = current_date - 1 WHERE customer_quote_id = $1`, [quoteId]);
    await p.pg.query(`ALTER TABLE commercial.quote_version ENABLE TRIGGER trg_quote_version_immutable`);
    const late = await p.accept(quoteId);
    expect(late.status).toBe(409);
    expect(late.body['code']).toBe('QUOTE_EXPIRED');
    const sweep = ok(await p.service('/internal/quotes/expiry-sweep'), 201, 'expiry sweep');
    expect(sweep['expired']).toBe(1);
    expect((await p.as.approver.get(`/api/v1/quotations/${quoteId}`)).body['status']).toBe('expired');
  });

  it('re-quotes as a new offer and takes exactly one of two simultaneous acceptances', async () => {
    requoteId = await p.sentQuote(costSheetVersionId, { validityUntil: daysFromNow(10) });
    expect(requoteId).not.toBe(quoteId);
    const body = await p.acceptanceBody(requoteId);
    const [first, second] = await Promise.all([p.accept(requoteId, 'tab-one', body), p.accept(requoteId, 'tab-two', body)]);
    expect([first.status, second.status].sort()).toEqual([201, 409]);
    orderId = ((first.status === 201 ? first : second).body['orderId']) as string;
    expect(await p.rows(`SELECT id FROM orders.sales_order`)).toEqual([{ id: orderId }]);
  });

  it('keeps every version as the customer saw it, and the order matches what was accepted', async () => {
    const old = await p.rows<{ version_no: number; status: string }>(`SELECT version_no, status FROM commercial.quote_version WHERE customer_quote_id = $1 ORDER BY version_no`, [quoteId]);
    expect(old.map((v) => [v.version_no, v.status])).toEqual([[1, 'superseded'], [2, 'expired']]);
    const accepted = await p.one<{ quote_version_id: string }>(`SELECT quote_version_id FROM commercial.acceptance WHERE customer_quote_id = $1`, [requoteId]);
    const version = await p.one<{ id: string; total_minor: string }>(`SELECT id, total_minor FROM commercial.quote_version WHERE customer_quote_id = $1`, [requoteId]);
    expect(accepted.quote_version_id).toBe(version.id);
    const so = (await p.as.sourcing.get(`/api/v1/sales-orders/${orderId}`)).body;
    expect((so['installments'] as Body[]).reduce((t, i) => t + (i['amountMinor'] as number), 0)).toBe(Number(version.total_minor));
  });

  it('audits the whole life of the first quote, and tells the customer each time a version is sent', async () => {
    expect(await p.auditActions(quoteId)).toEqual([
      'commercial.quote_drafted',
      'commercial.quote_approval_requested',
      'commercial.quote_sent',
      'commercial.quote_revision_requested',
      'commercial.quote_replaced',
      'commercial.quote_approval_requested',
      'commercial.quote_sent',
      'commercial.quote_expired',
    ]);
    expect(await p.auditActions(requoteId)).toEqual(['commercial.quote_drafted', 'commercial.quote_approval_requested', 'commercial.quote_sent', 'commercial.quote_accepted']);
    await p.dispatchNotifications();
    const sent = [...(await p.notices('buyer')), ...(await p.notices('approver'))].filter((n) => n.template_key === 'customer.quote_sent');
    // Three versions were sent; each reached the customer.
    expect(sent.length).toBeGreaterThanOrEqual(3);
    p.expectNothingOf(sent, ['Anand', 'Balaji'], 'quote notices');
  });
});
