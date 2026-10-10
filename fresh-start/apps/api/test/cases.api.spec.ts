import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Body, ok, Pilot, type SourcedDeal } from './pilot/driver';

/**
 * IN-18 F-18.2: support cases, credit notes, refunds, recoveries and returns (UC-34; doc 06 §15;
 * doc 10 §15; FR-906; BR-FIN-04, BR-FIN-06; doc 19 §8). A case resolves through actions each carried
 * out by the module that owns it and verified by someone else; it closes only when every action is
 * verified or cancelled, and closing lifts the delivery holds it carried. A credit note leaves the
 * invoice as it was. A recovery from the supplier holds its settlement and never reaches the customer.
 */
describe('support cases and remedies (F-18.2)', () => {
  let p: Pilot;
  let deal: SourcedDeal;
  let d1: Body;
  let d2: Body;
  let damage: Body;
  let inbound: Body;

  const caseOf = async (id: unknown): Promise<Body> => ok(await p.as.support.get(`/api/v1/cases/${id}`), 200, 'read case');
  const customerCase = async (id: unknown): Promise<Body> => ok(await p.as.buyer.get(`/api/v1/support/cases/${id}`), 200, 'customer reads case');
  const delivery = async (id: unknown): Promise<Body> => ok(await p.as.buyer.get(`/api/v1/deliveries/${id}`), 200, 'delivery');
  const action = (c: Body, kind: string): Body => (c['actions'] as Body[]).find((a) => a['kind'] === kind)!;
  const invoices = async (): Promise<Body[]> => ok(await p.as.finance.get(`/api/v1/sales-orders/${deal.orderId}`), 200, 'order')['invoices'] as Body[];
  const total = (ledger: Record<string, string>): number => Object.values(ledger).reduce((t, q) => t + Number(q), 0);

  async function investigating(body: Body, opener: 'support' | 'buyer' = 'support'): Promise<Body> {
    const path = opener === 'support' ? '/api/v1/cases' : '/api/v1/support/cases';
    const opened = ok(await p.as[opener].post(path, { salesOrderId: deal.orderId, title: 'Something to put right', description: 'Found on arrival at stores', ...body }), 201, 'open case');
    let c = ok(await p.as.support.post(`/api/v1/cases/${opened['caseId']}/triage`, { expectedVersion: opened['aggregateVersion'] }), 201, 'triage');
    c = ok(await p.as.support.post(`/api/v1/cases/${c['caseId']}/investigate`, { expectedVersion: c['aggregateVersion'] }), 201, 'investigate');
    return c;
  }

  async function approved(c: Body, actions: Body[], approver: 'finance' | 'finance2' | 'quality' = 'finance', extra: Body = {}): Promise<Body> {
    const proposed = ok(await p.as.support.post(`/api/v1/cases/${c['caseId']}/proposal`, { expectedVersion: c['aggregateVersion'], actions, ...extra }), 201, 'propose');
    ok(await p.decide(approver, proposed['approvalRequestId'] as string), 201, 'approve resolution');
    return caseOf(c['caseId']);
  }

  const execute = (actor: 'finance' | 'finance2' | 'logistics' | 'support', a: Body, body: Body = {}) => p.as[actor].post(`/api/v1/case-actions/${a['actionId']}/execute`, body);
  const verify = (actor: 'finance' | 'finance2' | 'quality' | 'support', a: Body) => p.as[actor].post(`/api/v1/case-actions/${a['actionId']}/verify`, { note: 'Checked against the record' });

  beforeAll(async () => {
    p = await Pilot.start('cases');
    await p.customerSite();
    ({ deal, inbound } = await p.atJobWork());
    // The customer allowed partial deliveries at enquiry.
    await p.pg.query(`UPDATE sourcing.enquiry SET partial_delivery = 'allowed' WHERE id = (SELECT enquiry_id FROM orders.sales_order WHERE id = $1)`, [deal.orderId]);
    d1 = await p.proofOfDelivery(await p.dispatchToCustomer(deal.orderId, [['LOT-A', '30']]));
    const reported = ok(await p.as.buyer.post(`/api/v1/deliveries/${d1['shipmentId']}/issues`, { kind: 'damage', lotMarking: p.markingOf(d1), quantity: '2', description: 'Two dented on the flange' }), 201, 'report damage');
    damage = (reported['exceptions'] as Body[]).find((e) => e['kind'] === 'damage')!;
    d2 = await p.proofOfDelivery(await p.dispatchToCustomer(deal.orderId, [['LOT-B', '40']]));
  }, 300_000);

  afterAll(async () => {
    await p?.stop();
  });

  it('lets the customer open a case on its own order, follow it, and withdraw it before work starts', async () => {
    const base = { salesOrderId: deal.orderId, kind: 'warranty', title: 'Thread worn', description: 'Two threads stripped at assembly' };
    expect((await p.as.outsider.post('/api/v1/support/cases', base)).body['code']).toBe('ORDER_NOT_FOUND');
    expect((await p.as.supplierA.post('/api/v1/support/cases', base)).body['code']).toBe('ORDER_NOT_FOUND');
    expect((await p.as.buyer.post('/api/v1/support/cases', { ...base, purchaseOrderId: deal.purchaseOrderId })).status).toBe(403);
    expect((await p.as.buyer.post('/api/v1/support/cases', { ...base, deliveryExceptionIds: [damage['exceptionId']] })).status).toBe(403);
    expect((await p.as.buyer.post('/api/v1/support/cases', { ...base, evidenceDocumentVersionIds: [await p.cleanDrawing(p.orgs.supplierA)] })).body['code']).toBe('EVIDENCE_UNAVAILABLE');

    const opened = ok(await p.as.buyer.post('/api/v1/support/cases', { ...base, evidenceDocumentVersionIds: [await p.cleanDrawing(p.orgs.customer)] }), 201, 'customer opens');
    expect(opened).toMatchObject({ status: 'open', statusLabel: 'Received', canWithdraw: true, remedies: [], orderNumber: (await p.one<{ number: string }>(`SELECT number FROM orders.sales_order WHERE id = $1`, [deal.orderId])).number });
    expect(opened['number']).toMatch(/^CASE-\d{4}-0001$/);
    expect((opened['events'] as Body[])[0]).toMatchObject({ kind: 'opened', authorParty: 'customer', evidenceCount: 1 });
    expect(Object.keys(opened)).not.toContain('purchaseOrderId');
    expect((await p.as.outsider.get(`/api/v1/support/cases/${opened['caseId']}`)).status).toBe(404);

    const withdrawn = ok(await p.as.buyer.post(`/api/v1/support/cases/${opened['caseId']}/withdraw`, { expectedVersion: opened['aggregateVersion'], reason: 'Our fitter cross-threaded them' }), 201, 'withdraw');
    expect(withdrawn).toMatchObject({ status: 'withdrawn', canWithdraw: false });
    expect((await p.as.buyer.post(`/api/v1/support/cases/${opened['caseId']}/events`, { note: 'One more thing' })).body['code']).toBe('CASE_CLOSED');
  });

  it('takes the delivery’s damage report over into a case, which holds the delivery and talks to the customer', async () => {
    const opened = ok(
      await p.as.support.post('/api/v1/cases', { salesOrderId: deal.orderId, kind: 'delivery_issue', title: 'Two dented on the flange', description: 'Reported at delivery', shipmentId: d1['shipmentId'], deliveryExceptionIds: [damage['exceptionId']] }),
      201,
      'support opens',
    );
    expect(opened).toMatchObject({ openedByParty: 'jobwork', linkedExceptions: [{ number: damage['number'], kind: 'damage' }] });
    expect(await delivery(d1['shipmentId'])).toMatchObject({ status: 'issue_reported', exceptions: [expect.objectContaining({ kind: 'damage', resolution: 'handed_to_case', caseReference: opened['number'] })] });
    expect((await p.as.support.post('/api/v1/cases', { salesOrderId: deal.orderId, kind: 'delivery_issue', title: 'Again', description: 'Again', deliveryExceptionIds: [damage['exceptionId']] })).body['code']).toBe('EXCEPTION_RESOLVED');

    const seen = await customerCase(opened['caseId']);
    expect(seen).toMatchObject({ status: 'open', canWithdraw: false, shipmentNumber: d1['number'] });
    expect((await p.as.buyer.post(`/api/v1/support/cases/${opened['caseId']}/withdraw`, { expectedVersion: seen['aggregateVersion'], reason: 'Never mind' })).body['code']).toBe('NOT_YOURS');

    let c = ok(await p.as.support.post(`/api/v1/cases/${opened['caseId']}/triage`, { expectedVersion: opened['aggregateVersion'] }), 201, 'triage');
    expect((await p.as.support.post(`/api/v1/cases/${c['caseId']}/proposal`, { expectedVersion: c['aggregateVersion'], actions: [{ kind: 'concession', description: 'Keep them' }] })).body['code']).toBe('CASE_STATUS');
    ok(await p.as.support.post(`/api/v1/cases/${c['caseId']}/events`, { note: 'Carrier photos show a crushed carton corner', audience: 'internal' }), 201, 'internal note');
    ok(await p.as.buyer.post(`/api/v1/support/cases/${c['caseId']}/events`, { note: 'Photos attached at the gate', evidenceDocumentVersionIds: [await p.cleanDrawing(p.orgs.customer)] }), 201, 'customer note');
    c = ok(await p.as.support.post(`/api/v1/cases/${c['caseId']}/investigate`, { expectedVersion: (await caseOf(c['caseId']))['aggregateVersion'] }), 201, 'investigate');

    const customerNotes = ((await customerCase(c['caseId']))['events'] as Body[]).map((e) => e['note']);
    expect(customerNotes).toContain('Photos attached at the gate');
    expect(customerNotes).not.toContain('Carrier photos show a crushed carton corner');
    await p.dispatchNotifications();
    expect((await p.notices('buyer')).some((n) => n.template_key === 'customer.case_update' && n.title.includes(opened['number'] as string))).toBe(true);

    // Money goes to finance to decide; a credit note for the two pieces and a concession on the rest.
    expect((await p.as.support.post(`/api/v1/cases/${c['caseId']}/proposal`, { expectedVersion: c['aggregateVersion'], actions: [{ kind: 'credit_note', description: 'Two pieces' }] })).body['code']).toBe('AMOUNT_REQUIRED');
    const proposed = ok(
      await p.as.support.post(`/api/v1/cases/${c['caseId']}/proposal`, {
        expectedVersion: c['aggregateVersion'],
        actions: [
          { kind: 'credit_note', description: 'Credit for two dented pieces', amountMinor: 23_600 },
          { kind: 'concession', description: 'Customer keeps the two pieces for non-critical use' },
        ],
      }),
      201,
      'propose',
    );
    expect((await customerCase(c['caseId']))['remedies']).toEqual([]);
    expect((await p.decide('quality', proposed['approvalRequestId'] as string)).status).toBe(403);
    ok(await p.decide('finance', proposed['approvalRequestId'] as string), 201, 'finance approves');
    expect(await customerCase(c['caseId'])).toMatchObject({
      status: 'resolution_approved',
      remedies: [
        { kind: 'credit_note', amountMinor: 23_600, status: 'planned' },
        { kind: 'concession', amountMinor: null, status: 'planned' },
      ],
    });
  });

  it('carries out each action by its owner, verifies it by someone else, and closes only when all are verified', async () => {
    let c = (ok(await p.as.support.get(`/api/v1/cases?salesOrderId=${deal.orderId}&open=true`), 200, 'list') as unknown as Body[]).find((x) => x['kind'] === 'delivery_issue')!;
    const credit = action(c, 'credit_note');
    const balance = (await invoices()).find((i) => i['kind'] === 'balance')!;
    const before = await p.one(`SELECT number, total_minor::text, status, content_hash FROM finance.invoice WHERE id = $1`, [balance['invoiceId']]);

    expect((await execute('support', credit, { invoiceId: balance['invoiceId'] })).status).toBe(403);
    expect((await execute('finance', credit)).body['code']).toBe('INVOICE_REQUIRED');
    c = ok(await execute('finance', credit, { invoiceId: balance['invoiceId'], note: 'Issued against the balance invoice' }), 201, 'credit note');
    expect(c['status']).toBe('executing');
    expect((await execute('finance', credit, { invoiceId: balance['invoiceId'] })).body['code']).toBe('ACTION_STATUS');
    const done = action(c, 'credit_note');
    expect(done['result']).toMatchObject({ creditNoteNumber: expect.stringMatching(/^CN-\d{4}-0001$/) });

    // BR-FIN-06: the invoice stands; the credit note is its own record with its own journal.
    expect(await p.one(`SELECT number, total_minor::text, status, content_hash FROM finance.invoice WHERE id = $1`, [balance['invoiceId']])).toEqual(before);
    const cn = await p.one<{ id: string; taxable_minor: string; tax_minor: string; journal_id: string }>(`SELECT id, taxable_minor::text, tax_minor::text, journal_id FROM finance.credit_note WHERE invoice_id = $1`, [balance['invoiceId']]);
    expect(Number(cn.taxable_minor) + Number(cn.tax_minor)).toBe(23_600);
    expect(Number(cn.tax_minor)).toBe(3_600);
    expect(await p.rows(`SELECT account_code, debit_minor::text, credit_minor::text FROM finance.journal_line WHERE journal_id = $1 ORDER BY account_code`, [cn.journal_id])).toEqual([
      { account_code: 'customer_receivable', debit_minor: '0', credit_minor: '23600' },
      { account_code: 'gst_output', debit_minor: '3600', credit_minor: '0' },
      { account_code: 'revenue', debit_minor: '20000', credit_minor: '0' },
    ]);
    await expect(p.pg.query(`UPDATE finance.credit_note SET reason = 'other' WHERE id = $1`, [cn.id])).rejects.toThrow(/immutable/);

    expect((await execute('support', action(c, 'concession'))).body['code']).toBe('NOTE_REQUIRED');
    c = ok(await execute('support', action(c, 'concession'), { note: 'Customer agreed by email' }), 201, 'concession');
    expect(c['status']).toBe('verifying');
    expect((await p.as.support.post(`/api/v1/cases/${c['caseId']}/close`, { expectedVersion: c['aggregateVersion'], reason: 'All done' })).body['code']).toBe('ACTIONS_UNVERIFIED');

    expect((await verify('finance', action(c, 'credit_note'))).body['code']).toBe('VERIFIER_SEPARATION');
    expect((await verify('support', action(c, 'concession'))).body['code']).toBe('VERIFIER_SEPARATION');
    ok(await verify('finance2', action(c, 'credit_note')), 201, 'verify credit note');
    c = ok(await verify('quality', action(c, 'concession')), 201, 'verify concession');
    expect((await verify('quality', action(c, 'concession'))).body['code']).toBe('ACTION_STATUS');

    expect((await delivery(d1['shipmentId']))['status']).toBe('issue_reported');
    c = ok(await p.as.support.post(`/api/v1/cases/${c['caseId']}/close`, { expectedVersion: c['aggregateVersion'], reason: 'Credit issued; customer keeps the pieces' }), 201, 'close');
    expect(c).toMatchObject({ status: 'closed', closedAt: expect.any(String) });
    // The hold lifts: the delivery waits for the customer's acceptance again.
    expect(await delivery(d1['shipmentId'])).toMatchObject({ status: 'awaiting_your_confirmation', actions: { accept: true } });
    expect(await customerCase(c['caseId'])).toMatchObject({ status: 'closed', remedies: [expect.objectContaining({ kind: 'credit_note', status: 'verified' }), expect.objectContaining({ kind: 'concession', status: 'verified' })] });
    expect(await p.auditActions(c['caseId'] as string)).toEqual(expect.arrayContaining(['support.case_opened', 'support.resolution_proposed', 'support.resolution_action_done', 'support.resolution_action_verified', 'support.case_closed']));
  });

  it('refuses a credit note beyond what the invoice can still take, and closes a case whose only action is cancelled', async () => {
    const advance = (await invoices()).find((i) => i['kind'] === 'advance')!;
    let c = await investigating({ kind: 'dispute', title: 'Price dispute', description: 'Customer disputes the advance' });
    c = await approved(c, [{ kind: 'credit_note', description: 'Credit the whole advance and more', amountMinor: (advance['totalMinor'] as number) + 1 }]);
    expect((await execute('finance', action(c, 'credit_note'), { invoiceId: advance['invoiceId'] })).body['code']).toBe('CREDIT_BEYOND_INVOICE');
    expect(await p.one(`SELECT count(*)::int AS n FROM finance.credit_note WHERE invoice_id = $1`, [advance['invoiceId']])).toEqual({ n: 0 });

    c = ok(await p.as.support.post(`/api/v1/case-actions/${action(c, 'credit_note')['actionId']}/cancel`, { note: 'Dispute settled without a credit' }), 201, 'cancel the only action');
    expect(c['status']).toBe('verifying');
    c = ok(await p.as.support.post(`/api/v1/cases/${c['caseId']}/close`, { expectedVersion: c['aggregateVersion'], reason: 'Settled by call' }), 201, 'close');
    expect(c['status']).toBe('closed');
  });

  it('cancels an action only while the agreed resolution is being carried out', async () => {
    let c = await investigating({ kind: 'warranty', title: 'Bore worn', description: 'Two bores worn after a month' });
    const proposed = ok(await p.as.support.post(`/api/v1/cases/${c['caseId']}/proposal`, { expectedVersion: c['aggregateVersion'], actions: [{ kind: 'replacement', description: 'Two replacement pieces' }] }), 201, 'propose');
    const planned = action(proposed, 'replacement');
    expect((await p.as.support.post(`/api/v1/case-actions/${planned['actionId']}/cancel`, { note: 'Changed our mind' })).body['code']).toBe('CASE_STATUS');
    ok(await p.decide('quality', proposed['approvalRequestId'] as string, 'rejected', 'Inspect the returned pieces first'), 201, 'send back');
    c = await caseOf(c['caseId']);
    expect(c['status']).toBe('investigating');
    expect((await p.as.support.post(`/api/v1/case-actions/${planned['actionId']}/cancel`, { note: 'Changed our mind' })).body['code']).toBe('CASE_STATUS');
    c = await approved(c, [{ kind: 'replacement', description: 'Two replacement pieces after inspection' }], 'quality');
    expect(c['status']).toBe('resolution_approved');
    expect((c['actions'] as Body[]).map((a) => a['description'])).toEqual(['Two replacement pieces after inspection']);
    c = ok(await execute('support', action(c, 'replacement'), { note: 'Two pieces sent on SH-REPL' }), 201, 'replacement');
    c = ok(await verify('quality', action(c, 'replacement')), 201, 'verify');
    ok(await p.as.support.post(`/api/v1/cases/${c['caseId']}/close`, { expectedVersion: c['aggregateVersion'], reason: 'Replaced' }), 201, 'close');
  });

  it('brings a delivery back onto its own lots and sends it to the supplier for rework, conserving every piece', async () => {
    const lots = await p.one<{ n: number }>(`SELECT count(*)::int AS n FROM logistics.stock_lot WHERE sales_order_id = $1`, [deal.orderId]);
    const start = await p.ledger(deal.orderId);
    expect(total(start)).toBe(100);
    let c = await investigating({ kind: 'delivery_issue', title: 'Bore oversize on the whole lot', description: 'Incoming inspection rejected all forty', shipmentId: d2['shipmentId'], purchaseOrderId: deal.purchaseOrderId });
    const lotB = (await p.stockLots(deal.orderId))['LOT-B']!;
    expect((await p.as.support.post(`/api/v1/cases/${c['caseId']}/proposal`, { expectedVersion: c['aggregateVersion'], actions: [{ kind: 'rework', description: 'Rework the bores' }] })).body['code']).toBe('LOT_REQUIRED');
    c = await approved(c, [
      { kind: 'return_to_jobwork', description: 'Collect the forty from the customer' },
      { kind: 'rework', description: 'Rework the bores at the supplier', stockLotId: lotB, quantity: '40' },
    ], 'quality');

    expect((await execute('finance', action(c, 'return_to_jobwork'))).status).toBe(403);
    c = ok(await execute('logistics', action(c, 'return_to_jobwork'), { note: 'Collection booked' }), 201, 'return leg');
    const back = ok(await p.as.logistics.get(`/api/v1/shipments/${(action(c, 'return_to_jobwork')['result'] as Body)['shipmentId']}`), 200, 'return shipment');
    expect(back).toMatchObject({ leg: 'customer_to_jobwork', status: 'released', returnsShipmentId: d2['shipmentId'] });
    expect(p.markingOf(back)).toBe(p.markingOf(d2));
    expect((await execute('logistics', action(c, 'return_to_jobwork'))).body['code']).toBe('ACTION_STATUS');
    const picked = ok(await p.as.logistics.post(`/api/v1/shipments/${back['shipmentId']}/pickup`, { expectedVersion: back['aggregateVersion'], carrierMode: 'carrier', carrierName: 'Safexpress', trackingReference: 'SX-RET-1' }), 201, 'pickup return');
    expect((await p.receivedInFull(picked))['status']).toBe('accepted');
    // Thirty of LOT-A never left; the forty come back onto LOT-B.
    expect(await p.ledger(deal.orderId)).toMatchObject({ 'JW-STOCK': '70', 'OUT-DISPATCHED': '30' });

    expect((await execute('logistics', action(c, 'rework'), { from: 'stock' })).body['code']).toBe('CHALLAN_REQUIRED');
    c = ok(await execute('logistics', action(c, 'rework'), { from: 'stock', challanNumber: 'JW-DC-0007' }), 201, 'rework leg');
    expect(c['status']).toBe('verifying');
    const after = await p.ledger(deal.orderId);
    expect(after).toMatchObject({ 'JW-STOCK': '30', 'OUT-REWORK': '40', 'OUT-DISPATCHED': '30' });
    expect(total(after)).toBe(100);
    expect(await p.one(`SELECT count(*)::int AS n FROM logistics.stock_lot WHERE sales_order_id = $1`, [deal.orderId])).toEqual(lots);
    const out = ok(await p.as.logistics.get(`/api/v1/shipments/${(action(c, 'rework')['result'] as Body)['shipmentId']}`), 200, 'rework shipment');
    expect(out).toMatchObject({ leg: 'jobwork_to_supplier', status: 'released', documents: expect.objectContaining({ challanNumber: 'JW-DC-0007' }) });

    for (const kind of ['return_to_jobwork', 'rework']) c = ok(await verify('quality', action(c, kind)), 201, `verify ${kind}`);
    ok(await p.as.support.post(`/api/v1/cases/${c['caseId']}/close`, { expectedVersion: c['aggregateVersion'], reason: 'Returned and sent for rework' }), 201, 'close');
  });

  it('refunds a customer who paid when the supplier failed, books the recovery against the supplier, and holds its settlement until verified', async () => {
    const bill = ok(await p.as.supplierA.post('/api/v1/supplier/bills', { purchaseOrderId: deal.purchaseOrderId, supplierReference: 'AE/201', billDate: new Date().toISOString().slice(0, 10), quantity: '30', taxableMinor: 30 * 12_350, taxMinor: 0 }), 201, 'bill');
    let b = ok(await p.as.finance.post(`/api/v1/supplier-bills/${bill['billId']}/match`, { expectedVersion: bill['aggregateVersion'] }), 201, 'match');
    expect((b['settlement'] as Body)['status']).toBe('eligible');

    // The customer opened the case, so it names no purchase order until JobWork links one.
    let c = await investigating({ kind: 'warranty', title: 'Cracked flanges', description: 'Ten flanges cracked in service' }, 'buyer');
    const actions = [
      { kind: 'refund', description: 'Refund ten pieces', amountMinor: 145_730 },
      { kind: 'supplier_recovery', description: 'Recover ten pieces from the supplier', amountMinor: 123_500 },
    ];
    expect((await p.as.support.post(`/api/v1/cases/${c['caseId']}/proposal`, { expectedVersion: c['aggregateVersion'], actions })).body['code']).toBe('PURCHASE_ORDER_REQUIRED');
    expect((await p.as.support.post(`/api/v1/cases/${c['caseId']}/proposal`, { expectedVersion: c['aggregateVersion'], actions, purchaseOrderId: '00000000-0000-4000-8000-000000000099' })).body['code']).toBe('PURCHASE_ORDER_NOT_FOUND');
    c = await approved(c, actions, 'finance2', { purchaseOrderId: deal.purchaseOrderId });
    expect(c['purchaseOrderId']).toBe(deal.purchaseOrderId);

    b = ok(await p.as.finance.post(`/api/v1/supplier-bills/${bill['billId']}/settlement/recheck`, {}), 201, 'recheck');
    expect(b['settlement']).toMatchObject({ status: 'held', eligibility: { reasons: [expect.stringContaining(`${c['number']} holds this supplier’s settlement`)] } });

    expect((await execute('finance', action(c, 'refund'))).body['code']).toBe('REFERENCE_REQUIRED');
    c = ok(await execute('finance', action(c, 'refund'), { reference: 'NEFT-REF-1001' }), 201, 'refund');
    c = ok(await execute('finance', action(c, 'supplier_recovery'), { reference: 'DN-AE-0001' }), 201, 'recovery');
    const journal = async (kind: string): Promise<Body[]> =>
      p.rows(`SELECT l.account_code, l.debit_minor::text, l.credit_minor::text FROM finance.journal_line l JOIN finance.journal j ON j.id = l.journal_id WHERE j.source_type = $1 ORDER BY l.account_code`, [kind]);
    expect(await journal('refund')).toEqual([
      { account_code: 'bank', debit_minor: '0', credit_minor: '145730' },
      { account_code: 'customer_receivable', debit_minor: '145730', credit_minor: '0' },
    ]);
    expect(await journal('supplier_recovery')).toEqual([
      { account_code: 'cost_of_goods', debit_minor: '0', credit_minor: '123500' },
      { account_code: 'supplier_recovery', debit_minor: '123500', credit_minor: '0' },
    ]);

    // The customer sees its refund; the supplier, its purchase order and the recovery stay JobWork's.
    const seen = await customerCase(c['caseId']);
    expect(seen['remedies']).toEqual([{ kind: 'refund', description: 'Refund ten pieces', amountMinor: 145_730, status: 'done' }]);
    p.expectNothingOf(seen, ['Anand', deal.purchaseOrderId, deal.purchaseOrders[0]!['number'] as string, 'supplier_recovery', '123500', 'DN-AE-0001'], 'customer case');

    for (const kind of ['refund', 'supplier_recovery']) c = ok(await verify('support', action(c, kind)), 201, `verify ${kind}`);
    b = ok(await p.as.finance.post(`/api/v1/supplier-bills/${bill['billId']}/settlement/recheck`, {}), 201, 'recheck');
    expect((b['settlement'] as Body)['status']).toBe('eligible');
    ok(await p.as.support.post(`/api/v1/cases/${c['caseId']}/close`, { expectedVersion: c['aggregateVersion'], reason: 'Refunded and recovered' }), 201, 'close');
  });

  it('names only a delivery of the case’s own order (TP.6)', async () => {
    const body = { salesOrderId: deal.orderId, kind: 'delivery_issue', title: 'Wrong leg', description: 'Names the supplier’s shipment' };
    expect((await p.as.support.post('/api/v1/cases', { ...body, shipmentId: inbound['shipmentId'] })).body['code']).toBe('SHIPMENT_NOT_FOUND');
    expect((await p.as.buyer.post('/api/v1/support/cases', { ...body, shipmentId: inbound['shipmentId'] })).body['code']).toBe('SHIPMENT_NOT_FOUND');
    expect((await p.as.buyer.post('/api/v1/support/cases', { ...body, shipmentId: '00000000-0000-4000-8000-000000000099' })).body['code']).toBe('SHIPMENT_NOT_FOUND');
    // The case center is JobWork's: a customer is refused before anything is written.
    const before = await p.one<{ n: number }>(`SELECT count(*)::int AS n FROM support.case`);
    expect((await p.as.buyer.post('/api/v1/cases', { salesOrderId: deal.orderId, kind: 'warranty', title: 'Via the wrong door', description: 'Probe' })).status).toBe(403);
    expect(await p.one(`SELECT count(*)::int AS n FROM support.case`)).toEqual(before);
  });

  it('keeps every case out of the supplier’s sight and the case center to JobWork', async () => {
    const any = (ok(await p.as.support.get('/api/v1/cases'), 200, 'list') as unknown as Body[])[0]!;
    expect((await p.as.supplierA.get('/api/v1/cases')).status).toBe(403);
    expect((await p.as.supplierA.get(`/api/v1/cases/${any['caseId']}`)).status).toBe(403);
    expect((await p.as.supplierA.get(`/api/v1/support/cases/${any['caseId']}`)).status).toBe(404);
    expect((await p.as.buyer.get(`/api/v1/cases/${any['caseId']}`)).status).toBe(403);
    expect((await p.as.buyer.post(`/api/v1/cases/${any['caseId']}/close`, { expectedVersion: 1, reason: 'Close it' })).status).toBe(403);
    expect((await p.as.supplierA.post(`/api/v1/case-actions/${(any['actions'] as Body[])[0]!['actionId']}/verify`, { note: 'Looks fine' })).status).toBe(403);
    expect((await p.as.outsider.get('/api/v1/support/cases')).body).toEqual([]);
  });
});
