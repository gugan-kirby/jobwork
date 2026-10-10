import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Body, ok, Pilot, type SourcedDeal } from './pilot/driver';

/**
 * IN-18 F-18.3: margin realization (doc 05 §8; doc 01 §7; BR-COM-05). Planned margin is the
 * approved cost sheet behind the accepted quote; realized margin is what the order's postings say:
 * revenue net of credit notes, less the supplier's billed work net of recoveries. Variance waits for
 * every live purchase order to carry a matched bill. JobWork finance and sales only.
 */
describe('margin realization (F-18.3)', () => {
  let p: Pilot;
  let deal: SourcedDeal;

  const margin = async (): Promise<Body> => ok(await p.as.finance.get(`/api/v1/finance/margin/${deal.orderId}`), 200, 'margin');
  const posted = async (account: string): Promise<{ debit: number; credit: number }> => {
    const r = await p.one<{ debit: string; credit: string }>(
      `SELECT COALESCE(SUM(debit_minor), 0)::text AS debit, COALESCE(SUM(credit_minor), 0)::text AS credit FROM finance.journal_line
        WHERE account_code = $2 AND ((cost_object_type = 'sales_order' AND cost_object_id = $1)
           OR (cost_object_type = 'purchase_order' AND cost_object_id IN (SELECT id FROM orders.purchase_order WHERE sales_order_id = $1)))`,
      [deal.orderId, account],
    );
    return { debit: Number(r.debit), credit: Number(r.credit) };
  };

  beforeAll(async () => {
    p = await Pilot.start('margin');
    await p.customerSite();
    ({ deal } = await p.atJobWork());
    // The balance invoice is issued and paid on the first delivery.
    await p.proofOfDelivery(await p.dispatchToCustomer(deal.orderId, [['LOT-A', '60'], ['LOT-B', '40']]));
  }, 300_000);

  afterAll(async () => {
    await p?.stop();
  });

  it('plans from the approved cost sheet and holds the variance until the purchase order is billed', async () => {
    const plan = await p.one<{ sell: string; landed: string; margin: string; bp: number }>(
      `SELECT v.sell_total_minor::text AS sell, v.landed_total_minor::text AS landed, v.margin_minor::text AS margin, v.margin_bp AS bp
         FROM orders.sales_order so JOIN commercial.customer_quote q ON q.id = so.customer_quote_id JOIN commercial.cost_sheet_version v ON v.id = q.cost_sheet_version_id
        WHERE so.id = $1`,
      [deal.orderId],
    );
    const m = await margin();
    expect(m['planned']).toEqual({ sellMinor: Number(plan.sell), landedMinor: Number(plan.landed), marginMinor: Number(plan.margin), marginBp: plan.bp });
    const revenue = (await posted('revenue')).credit;
    expect(revenue).toBeGreaterThan(0);
    expect(m['actual']).toMatchObject({ revenueMinor: revenue, creditNotesMinor: 0, costOfGoodsMinor: 0, recoveriesMinor: 0, changeCostMinor: 0, warrantyCostMinor: 0, marginMinor: revenue });
    expect(m).toMatchObject({ salesOrderId: deal.orderId, currency: 'INR', billsComplete: false, varianceMinor: null });

    const listed = ok(await p.as.sales.get('/api/v1/finance/margin'), 200, 'sales lists') as unknown as Body[];
    expect(listed.map((x) => x['salesOrderId'])).toContain(deal.orderId);
  });

  it('realizes the margin net of a credit note and a supplier recovery, with the variance once billed', async () => {
    const bill = ok(
      await p.as.supplierA.post('/api/v1/supplier/bills', { purchaseOrderId: deal.purchaseOrderId, supplierReference: 'AE/301', billDate: new Date().toISOString().slice(0, 10), quantity: '100', taxableMinor: 100 * 12_350, taxMinor: 0 }),
      201,
      'bill',
    );
    ok(await p.as.finance.post(`/api/v1/supplier-bills/${bill['billId']}/match`, { expectedVersion: bill['aggregateVersion'] }), 201, 'match');
    let m = await margin();
    const revenue = (m['actual'] as Body)['revenueMinor'] as number;
    const planned = (m['planned'] as Body)['marginMinor'] as number;
    expect(m['actual']).toMatchObject({ costOfGoodsMinor: 1_235_000, marginMinor: revenue - 1_235_000 });
    expect(m).toMatchObject({ billsComplete: true, varianceMinor: revenue - 1_235_000 - planned });

    // A case credits the customer for two pieces and recovers them from the supplier.
    const opened = ok(await p.as.support.post('/api/v1/cases', { salesOrderId: deal.orderId, kind: 'warranty', title: 'Two flanges cracked', description: 'Found at assembly', purchaseOrderId: deal.purchaseOrderId }), 201, 'open');
    let c = ok(await p.as.support.post(`/api/v1/cases/${opened['caseId']}/triage`, { expectedVersion: opened['aggregateVersion'] }), 201, 'triage');
    c = ok(await p.as.support.post(`/api/v1/cases/${c['caseId']}/investigate`, { expectedVersion: c['aggregateVersion'] }), 201, 'investigate');
    const proposed = ok(
      await p.as.support.post(`/api/v1/cases/${c['caseId']}/proposal`, {
        expectedVersion: c['aggregateVersion'],
        actions: [
          { kind: 'credit_note', description: 'Credit two pieces', amountMinor: 23_600 },
          { kind: 'supplier_recovery', description: 'Recover two pieces', amountMinor: 24_700 },
        ],
      }),
      201,
      'propose',
    );
    ok(await p.decide('finance2', proposed['approvalRequestId'] as string), 201, 'approve');
    c = ok(await p.as.support.get(`/api/v1/cases/${c['caseId']}`), 200, 'case');
    const action = (kind: string): Body => (c['actions'] as Body[]).find((a) => a['kind'] === kind)!;
    const balance = (ok(await p.as.finance.get(`/api/v1/sales-orders/${deal.orderId}`), 200, 'order')['invoices'] as Body[]).find((i) => i['kind'] === 'balance')!;
    c = ok(await p.as.finance.post(`/api/v1/case-actions/${action('credit_note')['actionId']}/execute`, { invoiceId: balance['invoiceId'] }), 201, 'credit note');
    c = ok(await p.as.finance.post(`/api/v1/case-actions/${action('supplier_recovery')['actionId']}/execute`, { reference: 'DN-AE-0002' }), 201, 'recovery');

    m = await margin();
    const realized = revenue - 20_000 - (1_235_000 - 24_700);
    expect(m['actual']).toEqual({
      revenueMinor: revenue,
      creditNotesMinor: 20_000,
      costOfGoodsMinor: 1_235_000,
      recoveriesMinor: 24_700,
      changeCostMinor: 0,
      warrantyCostMinor: 0,
      marginMinor: realized,
      marginBp: Math.round((realized * 10_000) / (revenue - 20_000)),
    });
    expect(m['varianceMinor']).toBe(realized - planned);
    // The view adds up exactly what the journal holds.
    expect((await posted('revenue')).debit).toBe(20_000);
    expect((await posted('cost_of_goods')).credit).toBe(24_700);
  });

  it('is JobWork finance and sales only', async () => {
    for (const actor of ['buyer', 'approver', 'supplierA', 'quality', 'support', 'logistics'] as const) {
      expect((await p.as[actor].get('/api/v1/finance/margin')).status, actor).toBe(403);
      expect((await p.as[actor].get(`/api/v1/finance/margin/${deal.orderId}`)).status, actor).toBe(403);
    }
    expect((await p.as.sales.get(`/api/v1/finance/margin/${deal.orderId}`)).status).toBe(200);
    expect((await p.as.finance.get('/api/v1/finance/margin/00000000-0000-4000-8000-000000000099')).body['code']).toBe('ORDER_NOT_FOUND');
    expect((await p.as.finance.get('/api/v1/finance/margin/not-a-uuid')).status).toBe(400);
  });
});
