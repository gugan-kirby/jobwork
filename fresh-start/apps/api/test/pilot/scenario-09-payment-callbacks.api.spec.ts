import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Body, ok, Pilot, type SourcedDeal } from './driver';

/**
 * Pilot scenario 9 (doc 19 §10; doc 12 §3 provider behaviour): the payment provider
 * delivers the same success twice, under two delivery ids, late, stale and forged; a
 * payment nobody can match lands in suspense. The advance is applied exactly once, and
 * finance clears the suspense against the balance invoice under maker-checker, so the
 * order ends paid in full with nothing left over.
 *
 * The provider's own intent id is read from the row: it is the gateway's reference, not
 * something any JobWork screen shows.
 */
describe('Pilot 9: duplicate and delayed payment callbacks, reconciliation', () => {
  let p: Pilot;
  let deal: SourcedDeal;
  let advanceInvoiceId: string;
  let advance: { intentId: string; providerIntentId: string; amountMinor: number };
  const transactionId = `txn_${randomUUID()}`;
  const deliveryId = `evt_${randomUUID()}`;

  beforeAll(async () => {
    p = await Pilot.start('s09');
    const { enquiryId } = await p.approvedEnquiry();
    deal = await p.sourceToPurchaseOrder(enquiryId);
    advanceInvoiceId = ((deal.order['invoices'] as Body[])[0]!['invoiceId']) as string;
    const intent = ok(await p.as.approver.post(`/api/v1/invoices/${advanceInvoiceId}/pay`), 201, 'start payment');
    const row = await p.one<{ provider_intent_id: string; amount_minor: string }>(`SELECT provider_intent_id, amount_minor FROM finance.payment_intent WHERE id = $1`, [intent['paymentIntentId']]);
    advance = { intentId: intent['paymentIntentId'] as string, providerIntentId: row.provider_intent_id, amountMinor: Number(row.amount_minor) };
  }, 180_000);

  afterAll(async () => {
    await p?.stop();
  });

  it('applies the captured advance once, however often the provider says so', async () => {
    const capture = { id: deliveryId, type: 'payment.captured', intentId: advance.providerIntentId, transactionId, amountMinor: advance.amountMinor };
    const first = await p.paymentCallback(capture);
    expect(first).toMatchObject({ status: 200, body: { outcome: 'processed' } });
    // The same delivery again, then the same payment under a new delivery id.
    expect((await p.paymentCallback(capture)).body['outcome']).toBe('duplicate');
    expect((await p.paymentCallback({ ...capture, id: `evt_${randomUUID()}` })).body['outcome']).toBe('duplicate');
    // An authorization that arrives after the capture changes nothing.
    expect((await p.paymentCallback({ ...capture, id: `evt_${randomUUID()}`, type: 'payment.authorized' })).body['outcome']).toBe('ignored');

    const invoice = (await p.as.approver.get(`/api/v1/invoices/${advanceInvoiceId}`)).body;
    expect(invoice).toMatchObject({ status: 'paid', paidMinor: advance.amountMinor, openMinor: 0 });
    const applied = await p.rows(`SELECT id FROM finance.payment_transaction WHERE provider_transaction_id = $1`, [transactionId]);
    expect(applied).toHaveLength(1);
  });

  it('refuses a stale or a forged callback outright (both are audited, below)', async () => {
    const stale = await p.paymentCallback({ type: 'payment.captured', intentId: advance.providerIntentId, transactionId: `txn_${randomUUID()}`, amountMinor: 1 }, { ageSeconds: 600 });
    expect(stale.status).toBe(401);
    const forged = await fetch(`${p.baseUrl}/api/v1/webhooks/payments/dev`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dev-signature': 'f'.repeat(64), 'x-dev-timestamp': String(Math.floor(Date.now() / 1000)), 'x-dev-delivery-id': `evt_${randomUUID()}` },
      body: JSON.stringify({ id: 'evt_forged', type: 'payment.captured', data: { intentId: advance.providerIntentId, transactionId: 'txn_forged', amountMinor: 1, currency: 'INR', occurredAt: new Date().toISOString() } }),
    });
    expect(forged.status).toBe(401);
  });

  it('parks money nobody can match in suspense, and finance clears it against the balance under maker-checker', async () => {
    // The balance invoice is issued by finance.
    const so = ok(await p.as.finance.get(`/api/v1/sales-orders/${deal.orderId}`), 200, 'finance reads order');
    const balance = (so['installments'] as Body[]).find((i) => i['kind'] === 'balance')!;
    const issued = ok(await p.as.finance.post(`/api/v1/sales-orders/${deal.orderId}/invoices`, { expectedVersion: so['aggregateVersion'], installmentId: balance['installmentId'] }), 201, 'issue balance invoice');
    const balanceInvoice = (issued['invoices'] as Body[]).find((i) => i['kind'] === 'balance')!;

    const stray = await p.paymentCallback({ type: 'payment.captured', intentId: 'dev_pi_from_a_bank_transfer', transactionId: `txn_${randomUUID()}`, amountMinor: balanceInvoice['totalMinor'] as number });
    expect(stray.body['outcome']).toBe('suspense');
    const suspended = stray.body['transactionId'] as string;
    const queue = ok(await p.as.finance.get('/api/v1/finance/reconciliation'), 200, 'reconciliation queue');
    expect((queue['suspense'] as Body[]).map((t) => t['transactionId'])).toContain(suspended);

    const proposed = ok(
      await p.as.finance.post('/api/v1/finance/allocations', { transactionId: suspended, invoiceId: balanceInvoice['invoiceId'], amountMinor: balanceInvoice['totalMinor'], note: 'Customer confirmed the transfer by phone.' }),
      201,
      'propose allocation',
    );
    const pending = (proposed['pendingAllocations'] as Body[]).find((a) => a['transactionId'] === suspended)!;
    expect((await p.decide('finance', pending['approvalRequestId'] as string)).status).toBe(409);
    ok(await p.decide('finance2', pending['approvalRequestId'] as string), 201, 'second finance user approves');

    const after = ok(await p.as.finance.get('/api/v1/finance/reconciliation'), 200, 'reconciliation queue');
    expect((after['suspense'] as Body[]).map((t) => t['transactionId'])).not.toContain(suspended);
    expect((await p.as.approver.get(`/api/v1/invoices/${balanceInvoice['invoiceId']}`)).body['status']).toBe('paid');
  });

  it('ends with the order paid in full, once, and nothing left unapplied', async () => {
    const invoices = await p.rows<{ total_minor: string }>(`SELECT total_minor FROM finance.invoice WHERE sales_order_id = $1`, [deal.orderId]);
    const quote = await p.one<{ total_minor: string }>(`SELECT total_minor FROM commercial.quote_version WHERE customer_quote_id = $1`, [deal.quoteId]);
    expect(invoices.reduce((t, i) => t + Number(i.total_minor), 0)).toBe(Number(quote.total_minor));
    const payments = ok(await p.as.approver.get('/api/v1/payments'), 200, 'customer payments');
    expect(payments['unappliedCreditMinor']).toBe(0);
  });

  it('audits every payment fact, including the ones it refused', async () => {
    const actions = (await p.rows<{ action: string }>(`SELECT action FROM platform.audit_event WHERE action LIKE 'finance.%' ORDER BY occurred_at, id`)).map((a) => a.action);
    expect(actions.filter((a) => a === 'finance.payment_captured')).toHaveLength(1);
    expect(actions).toEqual(expect.arrayContaining(['finance.payment_intent_created', 'finance.payment_suspense', 'finance.invoice_issued', 'finance.allocation_proposed', 'finance.webhook_rejected']));
    await p.dispatchNotifications();
    const received = [...(await p.notices('buyer')), ...(await p.notices('approver'))].filter((n) => n.template_key === 'customer.payment_received');
    expect(received.length).toBeGreaterThanOrEqual(1);
  });
});
