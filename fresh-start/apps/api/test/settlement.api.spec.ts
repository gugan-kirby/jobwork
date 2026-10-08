import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Body, ok, Pilot, type SourcedDeal } from './pilot/driver';

/**
 * IN-18 F-18.1: supplier bills and settlement (UC-31; doc 10 §5; FR-805; BR-FIN-03, BR-FIN-04,
 * BR-FIN-07; doc 19 §7). The supplier bills against its own acknowledged purchase order; finance
 * matches the bill against the PO and what JobWork accepted; a bill beyond either goes to a second
 * finance member, never a silent adjustment. A matched bill posts the payable and opens a settlement
 * whose eligibility is read from facts; it is paid only while eligible, on its own journal, and the
 * customer's money is never touched.
 */
describe('supplier bills and settlement (F-18.1)', () => {
  let p: Pilot;
  let deal: SourcedDeal;
  let poTotal: number;
  let unit: number;
  let first: Body;
  let second: Body;

  const bill = (body: Body, actor: 'supplierA' | 'supplierB' | 'buyer' = 'supplierA') =>
    p.as[actor].post('/api/v1/supplier/bills', { purchaseOrderId: deal.purchaseOrderId, billDate: new Date().toISOString().slice(0, 10), ...body });
  const read = async (id: unknown): Promise<Body> => ok(await p.as.finance.get(`/api/v1/supplier-bills/${id}`), 200, 'read bill');
  const settlementOf = (b: Body): Body => b['settlement'] as Body;
  const recheck = async (b: Body): Promise<Body> => ok(await p.as.finance.post(`/api/v1/supplier-bills/${b['billId']}/settlement/recheck`, {}), 201, 'recheck');
  const lines = (journalId: string) =>
    p.rows<{ account_code: string; debit_minor: string; credit_minor: string; cost_object_type: string | null }>(
      `SELECT account_code, debit_minor::text, credit_minor::text, cost_object_type FROM finance.journal_line WHERE journal_id = $1 ORDER BY account_code`,
      [journalId],
    );
  const receivable = async (): Promise<string> =>
    (await p.one<{ net: string }>(`SELECT COALESCE(SUM(debit_minor - credit_minor), 0)::text AS net FROM finance.journal_line WHERE account_code = 'customer_receivable'`)).net;

  beforeAll(async () => {
    p = await Pilot.start('settlement');
    ({ deal } = await p.atJobWork());
    poTotal = Number((await p.one<{ total_minor: string }>(`SELECT total_minor::text FROM orders.purchase_order WHERE id = $1`, [deal.purchaseOrderId])).total_minor);
    unit = poTotal / 100;
  }, 300_000);

  afterAll(async () => {
    await p?.stop();
  });

  it('takes a bill only from the supplier, on its own purchase order, once per bill number', async () => {
    expect((await bill({ supplierReference: 'AE/101', quantity: '60', taxableMinor: 60 * unit, taxMinor: Math.round(60 * unit * 0.18) }, 'buyer')).status).toBe(403);
    expect((await bill({ supplierReference: 'BP/9', quantity: '60', taxableMinor: 60 * unit, taxMinor: 0 }, 'supplierB')).body['code']).toBe('PURCHASE_ORDER_NOT_FOUND');
    expect((await bill({ supplierReference: 'AE/101', quantity: '0', taxableMinor: 1, taxMinor: 0 })).status).toBe(400);
    expect((await bill({ supplierReference: 'AE/101', quantity: '60', taxableMinor: 60 * unit, taxMinor: 0, documentVersionId: await p.cleanDrawing(p.orgs.supplierB) })).body['code']).toBe('BILL_DOCUMENT_UNAVAILABLE');

    first = ok(await bill({ supplierReference: 'AE/101', quantity: '60', taxableMinor: 60 * unit, taxMinor: Math.round(60 * unit * 0.18), documentVersionId: await p.cleanDrawing(p.orgs.supplierA) }), 201, 'submit bill');
    expect(first).toMatchObject({ status: 'submitted', supplierReference: 'AE/101', quantity: '60', totalMinor: 60 * unit + Math.round(60 * unit * 0.18), supplierDisplayName: '', approvalRequestId: null, settlement: null });
    expect(first['number']).toMatch(/^SB-\d{4}-0001$/);
    expect((await bill({ supplierReference: 'AE/101', quantity: '1', taxableMinor: unit, taxMinor: 0 })).body['code']).toBe('BILL_DUPLICATE');

    expect(await p.auditActions(first['billId'] as string)).toEqual(['finance.supplier_bill_submitted']);
    expect(await p.events(first['billId'] as string)).toEqual(['finance.supplier_bill_submitted.v1']);
    const queue = ok(await p.as.finance.get('/api/v1/queues'), 200, 'queues');
    expect((queue['items'] as Body[]).some((i) => i['queueKey'] === 'supplier_bills_to_match' && i['reference'] === first['number'])).toBe(true);
  });

  it('shows each supplier only its own bills, and JobWork’s bills only to finance', async () => {
    expect((ok(await p.as.supplierA.get('/api/v1/supplier/bills'), 200, 'own') as unknown as Body[]).map((b) => b['billId'])).toEqual([first['billId']]);
    expect(ok(await p.as.supplierB.get('/api/v1/supplier/bills'), 200, 'other') as unknown as Body[]).toEqual([]);
    expect((await p.as.supplierB.get(`/api/v1/supplier/bills/${first['billId']}`)).status).toBe(404);
    expect((await p.as.buyer.get('/api/v1/supplier/bills')).status).toBe(403);
    expect((await p.as.sales.get('/api/v1/supplier-bills')).status).toBe(403);
    expect((await p.as.sales.get(`/api/v1/supplier-bills/${first['billId']}`)).status).toBe(403);
    expect((await p.as.supplierA.post(`/api/v1/supplier-bills/${first['billId']}/match`, { expectedVersion: 1 })).status).toBe(403);
    expect((await read(first['billId']))['supplierDisplayName']).toBe('Anand Engineering');
  });

  it('matches a bill within the PO and the receipt, posts the payable, and opens an eligible settlement', async () => {
    expect((await p.as.finance.post(`/api/v1/supplier-bills/${first['billId']}/match`, { expectedVersion: 7 })).body['code']).toBe('VERSION_CONFLICT');
    const matched = ok(await p.as.finance.post(`/api/v1/supplier-bills/${first['billId']}/match`, { expectedVersion: first['aggregateVersion'] }), 201, 'match');
    expect(matched).toMatchObject({ status: 'matched', match: { pass: true, reasons: [], receipt: { acceptedQuantity: '100' }, billedBeforeQuantity: '0' } });
    expect(settlementOf(matched)).toMatchObject({ status: 'eligible', eligibility: { pass: true, reasons: [] } });
    expect((await p.as.finance.post(`/api/v1/supplier-bills/${first['billId']}/match`, { expectedVersion: matched['aggregateVersion'] })).body['code']).toBe('BILL_STATUS');

    const { journal_id } = await p.one<{ journal_id: string }>(`SELECT journal_id FROM finance.supplier_bill WHERE id = $1`, [first['billId']]);
    expect(await lines(journal_id)).toEqual([
      { account_code: 'cost_of_goods', debit_minor: String(60 * unit), credit_minor: '0', cost_object_type: 'sales_order' },
      { account_code: 'gst_input', debit_minor: String(Math.round(60 * unit * 0.18)), credit_minor: '0', cost_object_type: null },
      { account_code: 'supplier_payable', debit_minor: '0', credit_minor: String(matched['totalMinor']), cost_object_type: 'purchase_order' },
    ]);
    // One transaction writes both; their order within it is not meaningful.
    expect((await p.auditActions(first['billId'] as string)).sort()).toEqual(['finance.supplier_bill_matched', 'finance.supplier_bill_submitted', 'finance.supplier_payable_posted']);
    first = matched;
  });

  it('sends a bill beyond the receipt value to a second finance member, never adjusting it', async () => {
    // 40 pieces remain; the bill asks ₹1,000 more than they are worth, beyond the ₹500 cap.
    second = ok(await bill({ supplierReference: 'AE/102', quantity: '40', taxableMinor: 40 * unit + 100_000, taxMinor: 0 }), 201, 'second bill');
    const failed = ok(await p.as.finance.post(`/api/v1/supplier-bills/${second['billId']}/match`, { expectedVersion: second['aggregateVersion'] }), 201, 'match fails');
    expect(failed).toMatchObject({ status: 'match_exception', taxableMinor: 40 * unit + 100_000, settlement: null, match: { pass: false, billedBeforeQuantity: '60', toleranceMinor: Math.min(Math.round(40 * unit * 0.01), 50_000) } });
    expect((failed['match'] as Body)['reasons']).toEqual([expect.stringContaining('owed at the PO price')]);

    expect((await p.as.finance.post(`/api/v1/supplier-bills/${second['billId']}/exception`, { expectedVersion: failed['aggregateVersion'], justification: 'short' })).status).toBe(400);
    const requested = ok(
      await p.as.finance.post(`/api/v1/supplier-bills/${second['billId']}/exception`, { expectedVersion: failed['aggregateVersion'], justification: 'Supplier paid express freight we asked for on the second lot.' }),
      201,
      'request exception',
    );
    expect((await p.as.finance.post(`/api/v1/supplier-bills/${second['billId']}/exception`, { expectedVersion: requested['aggregateVersion'], justification: 'Supplier paid express freight we asked for on the second lot.' })).body['code']).toBe('EXCEPTION_PENDING');
    const approvalId = requested['approvalRequestId'] as string;
    expect((await p.decide('finance', approvalId)).body['code']).toBe('APPROVAL_SEPARATION');
    expect((await p.decide('sales', approvalId)).status).toBe(403);
    ok(await p.decide('finance2', approvalId), 201, 'second finance member approves');

    second = await read(second['billId']);
    expect(second).toMatchObject({ status: 'exception_approved', taxableMinor: 40 * unit + 100_000 });
    expect(settlementOf(second)['status']).toBe('eligible');
    // The rail audits its decision on the bill, carrying what the effect did.
    expect((await p.auditActions(second['billId'] as string)).sort()).toEqual(['commercial.approval_decided', 'finance.bill_exception_requested', 'finance.supplier_bill_match_exception', 'finance.supplier_bill_submitted']);
    const decided = await p.one<{ data: Body }>(`SELECT data FROM platform.audit_event WHERE subject_id = $1 AND action = 'commercial.approval_decided'`, [second['billId']]);
    expect(JSON.stringify(decided.data)).toContain('journalId');
  });

  it('rejects a bill for pieces nobody accepted, and tells the supplier why', async () => {
    const third = ok(await bill({ supplierReference: 'AE/103', quantity: '5', taxableMinor: 5 * unit, taxMinor: 0 }), 201, 'third bill');
    const failed = ok(await p.as.finance.post(`/api/v1/supplier-bills/${third['billId']}/match`, { expectedVersion: third['aggregateVersion'] }), 201, 'match fails');
    expect((failed['match'] as Body)['reasons']).toEqual(expect.arrayContaining([expect.stringContaining('5 billed against 0 accepted and not yet billed')]));
    ok(await p.as.finance.post(`/api/v1/supplier-bills/${third['billId']}/reject`, { expectedVersion: failed['aggregateVersion'], reason: 'All 100 pieces are already billed' }), 201, 'reject');
    const seen = ok(await p.as.supplierA.get(`/api/v1/supplier/bills/${third['billId']}`), 200, 'supplier reads');
    expect(seen).toMatchObject({ status: 'rejected', decisionNote: 'All 100 pieces are already billed', settlement: null, approvalRequestId: null });
    expect((await p.as.finance.post(`/api/v1/supplier-bills/${third['billId']}/reject`, { expectedVersion: seen['aggregateVersion'], reason: 'Again' })).body['code']).toBe('BILL_STATUS');
  });

  it('holds the settlement while a dispute is open on the PO or the bank account is unverified, and frees it when they clear', async () => {
    const dispute = ok(
      await p.as.support.post('/api/v1/cases', { salesOrderId: deal.orderId, kind: 'dispute', title: 'Freight charge disputed', description: 'Express freight on lot B not agreed in the PO', purchaseOrderId: deal.purchaseOrderId }),
      201,
      'open dispute',
    );
    const held = await recheck(second);
    expect(settlementOf(held)).toMatchObject({ status: 'held', eligibility: { pass: false, reasons: [expect.stringContaining(`${dispute['number']} holds this supplier’s settlement`)] } });
    expect((await p.as.finance.post(`/api/v1/supplier-bills/${second['billId']}/settlement/schedule`, { expectedVersion: settlementOf(held)['aggregateVersion'], scheduledFor: new Date().toISOString().slice(0, 10) })).body['code']).toBe('SETTLEMENT_HELD');
    const queue = ok(await p.as.finance.get('/api/v1/queues'), 200, 'queues');
    expect((queue['items'] as Body[]).some((i) => i['queueKey'] === 'settlements_held')).toBe(true);
    ok(await p.as.support.post(`/api/v1/cases/${dispute['caseId']}/reject`, { expectedVersion: dispute['aggregateVersion'], reason: 'Freight was agreed by email; not a dispute' }), 201, 'reject dispute');

    await p.pg.query(`UPDATE supplier.verification_item SET expires_at = now() - interval '1 day' WHERE kind = 'bank_account' AND supplier_profile_id = $1`, [p.profiles.supplierA]);
    expect(settlementOf(await recheck(second))['eligibility']).toMatchObject({ pass: false, reasons: ['The supplier’s bank account is not verified.'] });
    await p.pg.query(`UPDATE supplier.verification_item SET expires_at = now() + interval '200 days' WHERE kind = 'bank_account' AND supplier_profile_id = $1`, [p.profiles.supplierA]);
    expect(settlementOf(await recheck(second))).toMatchObject({ status: 'eligible', eligibility: { pass: true } });
  });

  it('pays an eligible settlement on its own journal, once, and leaves the customer’s receivable alone', async () => {
    const before = await receivable();
    const s = settlementOf(first);
    const scheduled = ok(await p.as.finance.post(`/api/v1/supplier-bills/${first['billId']}/settlement/schedule`, { expectedVersion: s['aggregateVersion'], scheduledFor: new Date().toISOString().slice(0, 10) }), 201, 'schedule');
    expect(settlementOf(scheduled)['status']).toBe('scheduled');
    expect((await p.as.finance.post(`/api/v1/supplier-bills/${first['billId']}/settlement/pay`, { expectedVersion: settlementOf(scheduled)['aggregateVersion'], paymentReference: 'U' })).status).toBe(400);
    const paid = ok(await p.as.finance.post(`/api/v1/supplier-bills/${first['billId']}/settlement/pay`, { expectedVersion: settlementOf(scheduled)['aggregateVersion'], paymentReference: 'UTR-HDFC-0001' }), 201, 'pay');
    expect(settlementOf(paid)).toMatchObject({ status: 'paid', paymentReference: 'UTR-HDFC-0001', paidAt: expect.any(String) });
    expect((await p.as.finance.post(`/api/v1/supplier-bills/${first['billId']}/settlement/pay`, { expectedVersion: settlementOf(paid)['aggregateVersion'], paymentReference: 'UTR-HDFC-0002' })).body['code']).toBe('SETTLEMENT_STATUS');

    const { journal_id } = await p.one<{ journal_id: string }>(`SELECT journal_id FROM finance.settlement WHERE supplier_bill_id = $1`, [first['billId']]);
    expect(await lines(journal_id)).toEqual([
      { account_code: 'bank', debit_minor: '0', credit_minor: String(first['totalMinor']), cost_object_type: null },
      { account_code: 'supplier_payable', debit_minor: String(first['totalMinor']), credit_minor: '0', cost_object_type: 'purchase_order' },
    ]);
    expect(await receivable()).toBe(before);
    // Every journal balances (the deferred constraint holds at commit, and this reads it back).
    expect(await p.rows(`SELECT journal_id FROM finance.journal_line GROUP BY journal_id HAVING SUM(debit_minor) <> SUM(credit_minor)`)).toEqual([]);

    await p.dispatchNotifications();
    expect((await p.notices('supplierA')).some((n) => n.template_key === 'supplier.settlement_paid' && n.body.includes('UTR-HDFC-0001') && n.body.includes('AE/101'))).toBe(true);
    expect(await p.auditActions(first['billId'] as string)).toEqual(expect.arrayContaining(['finance.settlement_scheduled', 'finance.settlement_paid']));
  });

  it('leaves a paid settlement as it was when the customer later raises a chargeback', async () => {
    ok(await p.as.support.post('/api/v1/cases', { salesOrderId: deal.orderId, kind: 'chargeback', title: 'Card payment charged back', description: 'The bank reversed the advance payment', purchaseOrderId: deal.purchaseOrderId }), 201, 'chargeback case');
    const after = await read(first['billId']);
    expect(settlementOf(after)).toMatchObject({ status: 'paid', paymentReference: 'UTR-HDFC-0001' });
    expect((await recheck(after))['settlement']).toMatchObject({ status: 'paid' });
    await expect(p.pg.query(`UPDATE finance.settlement SET status = 'held' WHERE supplier_bill_id = $1`, [first['billId']])).rejects.toThrow(/paid settlement is final/);
  });

  it('holds payment to a supplier JobWork has suspended', async () => {
    const { aggregate_version } = await p.one<{ aggregate_version: number }>(`SELECT aggregate_version FROM supplier.supplier_profile WHERE id = $1`, [p.profiles.supplierA]);
    ok(await p.as.sourcing.post(`/api/v1/suppliers/${p.profiles.supplierA}/suspend`, { expectedVersion: aggregate_version, reason: 'Quality escalation under review' }), 201, 'suspend');
    const s = settlementOf(await recheck(second));
    expect(s).toMatchObject({ status: 'held', eligibility: { reasons: expect.arrayContaining(['The supplier is not active in the network.']) } });
    expect((await p.as.finance.post(`/api/v1/supplier-bills/${second['billId']}/settlement/pay`, { expectedVersion: s['aggregateVersion'], paymentReference: 'UTR-HDFC-0003' })).body['code']).toBe('SETTLEMENT_STATUS');
  });
});
