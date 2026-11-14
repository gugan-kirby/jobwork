import { randomUUID } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import { ok, type Body } from '../support/api';
import { accepted, acknowledgePo, as, atJobWork, calibratedGauge, decide, dispatched, inProduction, inspected, issuePurchaseOrders, libraryDrawing, proofOfDelivery, salesOrder, sentQuote, sourced, type Deal } from './support/flows';
import { axe, button, command, daysFromNow, expect, field, OPERATIONS, open, PORTAL, recall, remember, showOrderDetails, signInAs, test, visible } from './support/walk';

/** FW.17 Refusals and settlement from the list screens: a change and a deviation rejected, Pay Now on invoices and payments, a bill and a case rejected, a case action cancelled, three conversations, a rating. */
test.describe.configure({ mode: 'serial' });

const tag = (): string => randomUUID().slice(0, 6);

/** A quotation accepted, its advance invoice issued and still open. */
async function acceptedOrder(title: string): Promise<{ deal: Omit<Deal, 'purchaseOrderId'>; invoice: Body }> {
  const round = await sourced(title);
  const quoteId = await sentQuote(round);
  const orderId = await accepted(quoteId);
  return { deal: { round, quoteId, orderId }, invoice: ((await salesOrder(orderId))['invoices'] as Body[])[0]! };
}

/** The card's Pay Now; its name carries the invoice number for a screen reader. */
const payNowOf = (number: unknown): RegExp => new RegExp(`^Pay Now\\s*,\\s*${String(number)}$`);

/** Pay Now on the card of `number`, then the dev gateway's success on the payment page. */
async function payNow(page: Page, number: string): Promise<void> {
  await command(page, payNowOf(number));
  await expect(page).toHaveURL(/\/pay\/[0-9a-f-]{36}$/);
  await command(page, /^Pay ₹/);
  await expect(visible(page, 'Payment received')).toBeVisible();
}

/** A card of the portal or console, found by its title. */
const card = (page: Page, title: string | RegExp): Locator => page.locator('section.jw-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) }).last();

async function changeVersion(changeId: string): Promise<number> {
  return ok(await (await as('engineering')).get(`/changes/${changeId}`), 200, 'change')['aggregateVersion'] as number;
}

/** The customer's change, assessed (+₹1,500, 3 days) and approved inside JobWork: the approver decides next. */
async function changeAwaitingCustomer(orderId: string, title: string): Promise<string> {
  const change = ok(await (await as('buyer')).post(`/orders/${orderId}/changes`, { title, reason: 'Our assembly line needs a marked part number.', urgency: 'normal' }), 201, 'request change');
  const id = change['changeRequestId'] as string;
  const eng = await as('engineering');
  ok(await eng.post(`/changes/${id}/triage`, { expectedVersion: await changeVersion(id) }), 201, 'triage change');
  ok(await eng.post(`/changes/${id}/classify`, { expectedVersion: await changeVersion(id), classification: 'scope', supplierBrief: 'Laser-mark the part number on the flange face.', note: '' }), 201, 'classify change');
  const assembled = ok(await eng.post(`/sales-orders/${orderId}/baselines`, { items: [{ documentVersionId: await libraryDrawing(), purpose: 'governing' }] }), 201, 'draft baseline');
  const draft = (assembled['baselines'] as Body[]).find((b) => b['status'] === 'draft')!;
  const areas = Object.fromEntries(
    ['configuration', 'wip', 'process_tooling', 'quality', 'commercial', 'schedule', 'contract', 'logistics'].map((a) =>
      a === 'commercial' || a === 'schedule' ? [a, { applicable: true, answer: 'One more operation: marking adds cost and three days.' }] : [a, { applicable: false, reason: 'Marking does not touch this.' }],
    ),
  );
  ok(await eng.post(`/changes/${id}/impact`, { expectedVersion: await changeVersion(id), areas, customerPriceDeltaMinor: 150000, deliveryDateDeltaDays: 3, purchaseOrders: [], wip: [], candidateBaselineId: draft['baselineId'] }), 201, 'record impact');
  const completed = ok(await eng.post(`/changes/${id}/complete-impact`, { expectedVersion: await changeVersion(id) }), 201, 'complete impact');
  await decide('sales', completed['approvalRequestId'] as string);
  return id;
}

/** A failed first article, its NCR contained and a deviation approved inside JobWork: the approver decides next. */
async function deviationAwaitingCustomer(deal: Deal): Promise<void> {
  const { workPackageId } = await inProduction(deal);
  const failed = await inspected(workPackageId, 'fai', 'LOT-C17', await calibratedGauge(), '12.030');
  const q = await as('quality');
  const bore = (failed['characteristics'] as Body[]).find((c) => c['name'] === 'Bore diameter')!['characteristicId'];
  const results = (failed['results'] as Body[]).filter((r) => r['outcome'] === 'fail' && !r['supersededByResultId']).map((r) => r['resultId']);
  let ncr = ok(
    await q.post('/ncrs', { inspectionId: failed['inspectionId'], resultIds: results, title: 'Bore 12.03 on the first article', description: 'Bore 0.01 over the limit.', severity: 'major', affectedQuantity: '5', lots: ['LOT-C17'] }),
    201,
    'open NCR',
  );
  ok(await q.post(`/ncrs/${ncr['ncrId']}/containment`, { action: 'Lot held at the supplier.', location: 'Supplier stores' }), 201, 'contain');
  ncr = ok(await q.get(`/ncrs/${ncr['ncrId']}`), 200, 'NCR');
  ncr = ok(await q.post(`/ncrs/${ncr['ncrId']}/to-disposition`, { expectedVersion: ncr['aggregateVersion'] }), 201, 'to disposition');
  const deviation = ok(
    await q.post(`/ncrs/${ncr['ncrId']}/deviations`, {
      expectedVersion: ncr['aggregateVersion'],
      characteristicIds: [bore],
      quantity: '5',
      lots: ['LOT-C17'],
      expiresAt: new Date(Date.now() + 60 * 86_400_000).toISOString(),
      rationale: 'Mating shaft has 0.05 clearance; 0.01 oversize does not affect fit.',
      riskAssessment: 'Low',
      fitFunctionSafety: 'No effect on fit, function or safety.',
    }),
    201,
    'request deviation',
  );
  await decide('quality2', deviation['approvalRequestId'] as string);
}

test('customer · pays an open invoice with Pay Now from the invoice list', async ({ page }) => {
  const { deal, invoice } = await acceptedOrder(`Walk c17 cover ${tag()}`);
  remember('c17Deal', deal);
  await signInAs(page, 'approver');
  await open(page, `${PORTAL}/invoices`);
  await page.getByRole('radio', { name: /Unpaid/ }).click();
  await expect(button(page, payNowOf(invoice['number']))).toBeVisible();
  await axe(page, 'invoices (unpaid)');
  await payNow(page, invoice['number'] as string);
  await open(page, `${PORTAL}/invoices`);
  await page.getByRole('radio', { name: /^Paid/ }).click();
  await expect(page.getByRole('link', { name: new RegExp(`^${invoice['number']} Paid`) })).toBeVisible();
});

test('customer · pays another open invoice with Pay Now from payments', async ({ page }) => {
  const { deal, invoice } = await acceptedOrder(`Walk c17 bush ${tag()}`);
  remember('c17DealY', deal);
  await signInAs(page, 'approver');
  await open(page, `${PORTAL}/payments`);
  await page.getByRole('radio', { name: /Pending/ }).click();
  await expect(button(page, payNowOf(invoice['number']))).toBeVisible();
  await axe(page, 'payments (pending)');
  await payNow(page, invoice['number'] as string);
  await open(page, `${PORTAL}/payments`);
  await page.getByRole('radio', { name: /^Paid/ }).click();
  await expect(visible(page, invoice['number'] as string)).toBeVisible();
});

test('ops · finance rejects a supplier bill that should not be paid', async ({ page }) => {
  const deal = recall<Deal>('c17Deal');
  const purchaseOrderId = await issuePurchaseOrders(deal.orderId);
  await acknowledgePo(purchaseOrderId);
  remember('c17Deal', { ...deal, purchaseOrderId });
  const bill = ok(
    await (await as('supplierA')).post('/supplier/bills', { purchaseOrderId, supplierReference: `AE/C17-${tag()}`, billDate: daysFromNow(0), quantity: '100', taxableMinor: 485000, taxMinor: 87300 }),
    201,
    'submit bill',
  );
  await signInAs(page, 'finance');
  await open(page, `${OPERATIONS}/finance/bills`);
  await button(page, bill['number'] as string).click();
  const panel = card(page, new RegExp(`^${bill['number']} · `));
  await field(panel, 'Reason to reject').fill('Nothing has been received against this purchase order yet.');
  await command(page, 'Reject', panel);
  await expect(panel.getByText('Nothing has been received against this purchase order yet.')).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: bill['number'] as string }).getByRole('cell', { name: /^Rejected/ })).toBeVisible();
  await axe(page, 'supplier bills (bill rejected)');
});

test('customer · the approver rejects a change that moves the price and the date', async ({ page }) => {
  const deal = recall<Deal>('c17Deal');
  const title = `Mark the part number ${tag()}`;
  await changeAwaitingCustomer(deal.orderId, title);
  await signInAs(page, 'approver');
  await open(page, `${PORTAL}/orders/${deal.orderId}`);
  await showOrderDetails(page);
  const changes = card(page, 'Changes');
  const row = changes.locator('div').filter({ hasText: title }).filter({ has: page.getByRole('checkbox') }).last();
  await expect(row.getByText('decision needed')).toBeVisible();
  await row.getByRole('checkbox', { name: /^I understand this adds .+ to the order and moves delivery: 3 days later\.$/ }).check();
  await field(row, 'Note to JobWork (needed to reject)').fill('We will mark the parts in-house instead.');
  await command(page, 'Reject change', row);
  await expect(changes.getByText('not going ahead')).toBeVisible();
  await expect(changes.getByText(/You rejected this on .+: We will mark the parts in-house instead\./)).toBeVisible();
  await expect(changes.getByRole('checkbox', { name: /I understand/ })).toHaveCount(0);
  await axe(page, 'order (change rejected)');
});

test('customer · the approver rejects parts offered under a deviation', async ({ page }) => {
  const dealY = recall<Omit<Deal, 'purchaseOrderId'>>('c17DealY');
  const purchaseOrderId = await issuePurchaseOrders(dealY.orderId);
  await acknowledgePo(purchaseOrderId);
  await deviationAwaitingCustomer({ ...dealY, purchaseOrderId });
  await signInAs(page, 'approver');
  await open(page, `${PORTAL}/orders/${dealY.orderId}`);
  await showOrderDetails(page);
  const decisions = card(page, 'Quality decisions');
  await expect(decisions.getByText('decision needed')).toBeVisible();
  await decisions.getByRole('checkbox', { name: /I accept 5 parts/ }).check();
  await field(decisions, 'Note to JobWork (needed to reject)').fill('Bore is a press fit on our side; we need conforming parts.');
  await command(page, 'Reject', decisions);
  await expect(decisions.getByText(/Decided .+: rejected — Bore is a press fit on our side/)).toBeVisible();
  await expect(decisions.getByRole('checkbox')).toHaveCount(0);
  await axe(page, 'order (deviation rejected)');
});

test('ops · support rejects a case that is not JobWork’s to fix', async ({ page }) => {
  const deal = recall<Deal>('c17Deal');
  const raised = ok(
    await (await as('buyer')).post('/support/cases', { salesOrderId: deal.orderId, kind: 'dispute', title: `Price higher than expected ${tag()}`, description: 'We expected the earlier rate for this part.' }),
    201,
    'raise case',
  );
  await signInAs(page, 'support');
  await open(page, `${OPERATIONS}/support/${raised['caseId']}`);
  await field(page, 'Reason to reject').fill('The order was accepted at the quoted price; nothing to correct.');
  await command(page, 'Reject');
  await expect(visible(page, 'Not accepted')).toBeVisible();
  await expect(visible(page, 'The order was accepted at the quoted price; nothing to correct.')).toBeVisible();
  await expect(page.getByLabel('Add a note', { exact: false })).toHaveCount(0);
  await axe(page, 'case (rejected)');
});

test('ops · support cancels a resolution action no longer needed', async ({ page }) => {
  const deal = recall<Deal>('c17Deal');
  const what = `Send two replacement covers ${tag()}`;
  const support = await as('support');
  let c = ok(await (await as('buyer')).post('/support/cases', { salesOrderId: deal.orderId, kind: 'delivery_issue', title: 'Two covers short', description: 'The box held 98 covers.' }), 201, 'raise case');
  const caseId = c['caseId'] as string;
  c = ok(await support.post(`/cases/${caseId}/triage`, { expectedVersion: c['aggregateVersion'] }), 201, 'triage case');
  c = ok(await support.post(`/cases/${caseId}/investigate`, { expectedVersion: c['aggregateVersion'] }), 201, 'investigate case');
  c = ok(await support.post(`/cases/${caseId}/proposal`, { expectedVersion: c['aggregateVersion'], actions: [{ kind: 'replacement', description: what }] }), 201, 'propose');
  await decide('quality', c['approvalRequestId'] as string);
  await signInAs(page, 'support');
  await open(page, `${OPERATIONS}/support/${caseId}`);
  await expect(visible(page, 'Resolution agreed')).toBeVisible();
  const actions = card(page, 'Resolution actions');
  await field(actions, 'Reason to cancel').fill('The two covers turned up in a second carton.');
  await command(page, 'Cancel', actions);
  await expect(actions.getByText(/cancelled/)).toBeVisible();
  await expect(visible(page, 'Being checked')).toBeVisible();
  await axe(page, 'case (action cancelled)');
});

test('customer · writes to JobWork and to the supplier in the order conversation', async ({ page }) => {
  const deal = recall<Deal>('c17Deal');
  const [toJobWork, toSupplier] = [`Please pack the covers in two cartons, ref ${tag()}.`, `Can the flange face be deburred before packing, ref ${tag()}?`];
  remember('c17CustomerQuestion', toSupplier);
  await signInAs(page, 'buyer');
  await open(page, `${PORTAL}/orders/${deal.orderId}`);
  await showOrderDetails(page);
  const thread = page.locator('section.jw-card').filter({ hasText: 'Anything about this order, between you and JobWork.' });
  await field(thread, 'Message').fill(toJobWork);
  await command(page, 'Send', thread);
  await expect(thread.getByText(toJobWork)).toBeVisible();
  // ADR-0007: the order's named supplier is the second audience of the same thread.
  await thread.getByRole('radio').nth(1).check();
  await field(thread, 'Message').fill(toSupplier);
  await command(page, 'Send', thread);
  await expect(thread.getByText(toSupplier)).toBeVisible();
  await axe(page, 'order (conversation)');
});

test('supplier · writes in the purchase order conversation and answers the customer', async ({ page }) => {
  const deal = recall<Deal>('c17Deal');
  const [toJobWork, answer] = [`Material arrives on Monday, ref ${tag()}.`, `Yes, every flange face is deburred, ref ${tag()}.`];
  await signInAs(page, 'supplierA');
  await open(page, `${PORTAL}/supplier/orders/${deal.purchaseOrderId}`);
  const poThread = page.locator('section.jw-card').filter({ hasText: 'Anything about this purchase order, between you and JobWork.' });
  await field(poThread, 'Message').fill(toJobWork);
  await command(page, 'Send', poThread);
  await expect(poThread.getByText(toJobWork)).toBeVisible();
  const questions = page.locator('section.jw-card').filter({ hasText: 'Questions from the customer of this order.' });
  await expect(questions.getByText(recall('c17CustomerQuestion'))).toBeVisible();
  await field(questions, 'Message').fill(answer);
  await command(page, 'Send', questions);
  await expect(questions.getByText(answer)).toBeVisible();
  await expect(page.locator('body')).not.toContainText(/Kovai/);
  await axe(page, 'supplier PO (conversations)');
});

test('customer · rates the supplier once the order is complete', async ({ page }) => {
  const { deal } = await atJobWork(`Walk c17 rated plate ${tag()}`, [{ lot: 'LOT-R17', quantity: '100' }]);
  const shipment = await proofOfDelivery(await dispatched(deal.orderId, [['LOT-R17', '100']]));
  const approver = await as('approver');
  const delivery = ok(await approver.get(`/deliveries/${shipment['shipmentId']}`), 200, 'delivery');
  ok(await approver.post(`/deliveries/${shipment['shipmentId']}/accept`, { expectedVersion: delivery['aggregateVersion'], note: 'All received.' }), 201, 'accept delivery');
  await signInAs(page, 'buyer');
  await open(page, `${PORTAL}/orders/${deal.orderId}`);
  const rate = page.locator('section.jw-rate');
  await expect(button(rate, 'Submit Rating')).toBeDisabled();
  await rate.getByRole('radio', { name: '4 out of 5' }).click();
  await field(rate, 'Comments').fill('On time and well packed.');
  await axe(page, 'order (rate the supplier)');
  await command(page, 'Submit Rating', rate);
  await expect(page.getByText(/You rated .+ 4 out of 5/)).toBeVisible();
  await expect(button(page, 'Submit Rating')).toHaveCount(0);
});
