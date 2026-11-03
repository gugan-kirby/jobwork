import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { type Body, ok } from '../support/api';
import {
  acknowledgePo,
  as,
  bidBody,
  customerSite,
  qualityPlan,
  issuePurchaseOrders,
  openRound,
  receivedInFull,
  released,
  rfqVersion,
  salesOrder,
  sentQuote,
  shippedToJobWork,
  stockLots,
  supplierProduction,
  upload,
  workPackage,
  type Deal,
  type Round,
} from '../walk/support/flows';
import { FIXTURES } from '../walk/support/walk';
import { button, expect, field, link, pause, pick, PORTAL, read, run, signIn, tap, test, type } from './support/demo';

/**
 * The customer demo, for a client: one order told from the customer's side, on a phone.
 * `scene · N · <title>` tests are filmed; `offstage · …` tests are JobWork's and the
 * suppliers' part, done through the API with no browser, so nothing of theirs is recorded.
 *
 *   1 Sign in and look around       buyer: login, home, the menu
 *   2 Ask for a part                buyer: three-step enquiry with a drawing, submit
 *     offstage                      engineering asks one question
 *   3 Answer JobWork's question     buyer
 *     offstage                      approve, supplier copy, sourcing round, bids, award, quotation sent
 *   4 Read the quotation            buyer: quotation, download the PDF
 *   5 Accept and pay the advance    approver: accept, order placed, pay, invoice paid
 *     offstage                      purchase order, production, inspection, at JobWork
 *   6 Follow the order              buyer: home, order, notifications
 *     offstage                      delivery planned
 *   7 Pay the balance               approver
 *     offstage                      dispatched, proof of delivery
 *   8 Receive the parts             approver: accept the delivery, documents, sign out
 */
test.describe.configure({ mode: 'serial' });

const BUYER = 'buyer@kovai.test';
const APPROVER = 'approver@kovai.test';
const PART = 'Impeller housing';
const LOTS = [{ lot: 'LOT-A', quantity: '100' }];

let enquiryId = '';
let drawingVersionId = '';
let quoteId = '';
let orderId = '';
let round: Round;
let deal: Deal;
let dispatch: Body;

test('offstage · the delivery address is on file', async () => {
  await customerSite();
});

test('scene · 1 · Sign in and look around', async ({ page, director }) => {
  await signIn(page, director, BUYER, 'The buyer at Kovai Pumps', 'Home shows what needs attention and what is in progress');
  await read(page);
  await tap(page, button(page, 'Menu'), 'The menu: enquiries, quotations, orders, invoices, documents and help');
  await pause(page, 2500);
  await tap(page, button(page, 'Menu'));
});

test('scene · 2 · Ask for a part', async ({ page, director }) => {
  await signIn(page, director, BUYER, 'The buyer');
  director.say('Tap + to ask JobWork to make a part');
  await tap(page, link(page, 'New Enquiry'), 'Step 1 of 3 — what to make, from what, and how many');
  await expect(page).toHaveURL(/\/enquiries\/new/);

  await tap(page, page.locator('.jw-choice-item').filter({ hasText: /Job work/ }).first());
  await type(page, field(page, 'Part / job name'), PART);
  await pick(page, page.getByLabel('Material supplied by', { exact: false }), /JobWork/);
  await pick(page, page.getByLabel('Category', { exact: false }).first(), /machin/i);
  await pick(page, page.getByLabel('Sub category', { exact: false }).first(), /milling/i);
  await pick(page, page.getByLabel('Material', { exact: true }).first(), /alumin/i);
  await type(page, field(page, 'Grade or standard'), '6061-T6');
  await type(page, field(page, 'Quantity'), '100');
  director.say('Where the finished parts should be delivered');
  await pick(page, page.getByLabel('Deliver to', { exact: false }), /Kovai/);
  await type(page, field(page, 'What is this for?'), 'Housing for the drive impeller of a pump skid.', 40);
  director.say('Everything is saved as a draft while you type');
  await expect(page.getByText(/Draft saved/).first()).toBeVisible();
  await pause(page, 1500);
  await tap(page, button(page, 'Next'), 'Step 2 of 3 — attach the drawing and the requirements');

  await page.getByLabel('2D drawing', { exact: false }).setInputFiles(join(FIXTURES, 'drawing.pdf'));
  director.say('The drawing is virus-scanned and attached');
  await expect(page.getByText('Scanned clean and attached to this enquiry.').first()).toBeVisible({ timeout: 60_000 });
  await pause(page, 1500);
  director.say('Step 2 of 3 — finish, tolerance, inspection and the date needed');
  await type(page, field(page, 'Specifications / comments'), 'Break all sharp edges. Bore concentric to 0.02.', 40);
  await type(page, field(page, 'Surface finish'), 'Ra 1.6');
  await type(page, field(page, 'Tolerance class'), 'IT8');
  await pick(page, page.getByLabel('Inspection needed', { exact: false }), /Dimensional report/);
  await field(page, 'Required by').fill(new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10));
  await pause(page, 800);
  await tap(page, button(page, 'Next'), 'Step 3 of 3 — check everything before sending');

  await expect(page.getByRole('heading', { level: 1 })).toContainText('Review Enquiry');
  await read(page);
  director.say('Submit — JobWork receives the enquiry');
  await run(page, button(page, 'Submit enquiry'), 'The enquiry has a reference number and shows its progress');
  await expect(page).toHaveURL(/\/enquiries\/[0-9a-f-]{36}$/);
  enquiryId = page.url().split('/').pop()!;
  await read(page);
});

test('offstage · JobWork engineering asks a question', async () => {
  const eng = await as('engineering');
  const version = async (): Promise<number> => ((ok(await eng.get(`/intake/${enquiryId}`), 200, 'intake')['enquiry'] as Body)['aggregateVersion'] as number);
  ok(await eng.post(`/intake/${enquiryId}/triage`, { expectedVersion: await version() }), 201, 'triage');
  ok(await eng.post(`/intake/${enquiryId}/clarifications`, { expectedVersion: await version(), questions: [{ topic: 'tolerance', question: 'Is the 0.02 concentricity to the bore or to the spigot?' }] }), 201, 'ask');
});

test('scene · 3 · Answer JobWork\'s question', async ({ page, director }) => {
  await signIn(page, director, BUYER, 'The buyer', 'JobWork\'s engineer has a question about the enquiry');
  await tap(page, link(page, /Enquiries/));
  await tap(page, link(page, new RegExp(PART)));
  await expect(page).toHaveURL(new RegExp(`/enquiries/${enquiryId}$`));
  await into(page, field(page, 'Your answer'));
  director.say('The buyer answers it right on the enquiry');
  await type(page, field(page, 'Your answer'), 'To the bore, datum A on the drawing.', 45);
  await run(page, button(page, /Send answers?/), '…and can message JobWork at any time');
  await type(page, field(page, 'Message'), 'We can share a sample part if it helps.', 40);
  await run(page, button(page, 'Send'));
  await expect(page.getByText('We can share a sample part if it helps.').first()).toBeVisible();
  await pause(page, 2000);
});

test('offstage · JobWork sources the part and sends a quotation', async () => {
  test.setTimeout(240_000);
  const eng = await as('engineering');
  const intake = ok(await eng.get(`/intake/${enquiryId}`), 200, 'intake')['enquiry'] as Body;
  drawingVersionId = ((intake['documents'] as Body[])[0]!['documentVersionId']) as string;
  for (const doc of intake['documents'] as Body[]) {
    const copy = await upload('engineering', 'drawing_2d');
    ok(await eng.post(`/documents/versions/${doc['documentVersionId']}/supplier-copy`, { copyVersionId: copy.documentVersionId, note: '' }, { 'idempotency-key': randomUUID() }), 201, 'prepare copy');
    ok(await (await as('sourcing')).post(`/documents/versions/${doc['documentVersionId']}/supplier-copy/confirm`, { note: 'Title block removed; dimensions unchanged.' }, { 'idempotency-key': randomUUID() }), 201, 'confirm copy');
  }
  const again = ok(await eng.get(`/intake/${enquiryId}`), 200, 'intake')['enquiry'] as Body;
  ok(await eng.post(`/intake/${enquiryId}/approve`, { expectedVersion: again['aggregateVersion'] }), 201, 'approve');
  const { rfqId, itemId } = await openRound(enquiryId);
  const bidA = ok(await (await as('supplierA')).post(`/supplier/rfqs/${rfqId}/bid/submit`, bidBody(itemId, 4850)), 201, 'bid A')['bidVersionId'] as string;
  ok(await (await as('supplierB')).post(`/supplier/rfqs/${rfqId}/bid/submit`, bidBody(itemId, 5250)), 201, 'bid B');
  ok(await (await as('sourcing')).post(`/rfqs/${rfqId}/close`, { expectedVersion: await rfqVersion(rfqId) }), 201, 'close');
  round = { enquiryId, rfqId, itemId, bidA };
  quoteId = await sentQuote(round);
});

test('scene · 4 · Read the quotation', async ({ page, director }) => {
  await signIn(page, director, BUYER, 'The buyer', 'JobWork has sent a quotation for the impeller housing');
  await page.goto(`${PORTAL}/quotations`);
  await pause(page, 2000);
  await tap(page, page.locator(`a[href*="${quoteId}"]`).filter({ visible: true }).first(), 'One price from JobWork: parts, tax, delivery time and payment terms');
  await read(page);
  director.say('The quotation can be downloaded as a PDF');
  const download = page.waitForEvent('download', { timeout: 10_000 }).catch(() => null);
  await tap(page, button(page, 'Download'));
  await download;
  director.say('The manager, who can approve purchases, will accept it');
  await pause(page, 2500);
});

test('scene · 5 · Accept the quotation and pay the advance', async ({ page, director }) => {
  await signIn(page, director, APPROVER, 'The manager (approver)', 'The manager reviews the quotation');
  await page.goto(`${PORTAL}/quotations/${quoteId}`);
  await read(page, 400, 800);
  await tap(page, link(page, 'Accept quote'), 'Confirms the terms and places the order');
  await expect(page).toHaveURL(/\/accept$/);
  await read(page, 400, 800);
  await tap(page, page.getByRole('checkbox', { name: /I have read the quotation/ }));
  await run(page, button(page, 'Accept and place order'), 'Order placed — the advance invoice is ready');
  await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}\?accepted=1$/);
  orderId = new URL(page.url()).pathname.split('/').pop()!;
  await read(page);
  director.say('Pay the 50% advance online');
  await tap(page, button(page, /^Pay ₹/));
  await expect(page).toHaveURL(/\/pay\/[0-9a-f-]{36}$/);
  await pause(page, 2000);
  await run(page, button(page, /^Pay ₹/), 'Payment received');
  await expect(page.getByText('Payment received').first()).toBeVisible();
  await pause(page, 2000);
  await tap(page, link(page, 'See the invoice'), 'The invoice now shows as paid');
  await read(page);
});

test('offstage · the part is made, inspected and reaches JobWork', async () => {
  test.setTimeout(240_000);
  const purchaseOrderId = await issuePurchaseOrders(orderId);
  await acknowledgePo(purchaseOrderId);
  deal = { round, quoteId, orderId, purchaseOrderId };
  // The order's own drawing becomes the baseline sent to the supplier.
  const eng = await as('engineering');
  const assembled = ok(await eng.post(`/sales-orders/${orderId}/baselines`, { items: [{ documentVersionId: drawingVersionId, purpose: 'governing' }] }), 201, 'assemble baseline');
  const draft = (assembled['baselines'] as Body[]).find((b) => b['status'] === 'draft')!;
  ok(await eng.post(`/baselines/${draft['baselineId']}/release`, { expectedVersion: draft['aggregateVersion'] }), 201, 'release baseline');
  ok(await eng.post(`/sales-orders/${orderId}/transmittals`, { baselineId: draft['baselineId'] }), 201, 'transmit');
  const transmittal = (await supplierProduction(purchaseOrderId))['transmittal'] as Body;
  ok(await (await as('supplierA')).post(`/supplier/transmittals/${transmittal['transmittalId']}/acknowledge`, { expectedVersion: transmittal['aggregateVersion'], note: 'Drawing pack received.' }), 201, 'acknowledge transmittal');
  const sourcing = await as('sourcing');
  ok(await sourcing.post(`/purchase-orders/${purchaseOrderId}/work-package`, { plannedStart: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10), plannedFinish: new Date(Date.now() + 21 * 86_400_000).toISOString().slice(0, 10) }), 201, 'plan work package');
  await qualityPlan((await workPackage(deal))['workPackageId'] as string);
  const wp = await workPackage(deal);
  ok(await sourcing.post(`/work-packages/${wp['workPackageId']}/release`, { expectedVersion: wp['aggregateVersion'] }), 201, 'release work package');
  const workPackageId = wp['workPackageId'] as string;
  await released(deal, workPackageId, LOTS);
  await receivedInFull(await shippedToJobWork(deal, LOTS));
});

test('scene · 6 · Follow the order', async ({ page, director }) => {
  await signIn(page, director, BUYER, 'The buyer');
  await tap(page, link(page, /^Orders/), 'Orders shows every order and where it is');
  await pause(page, 2000);
  await tap(page, page.locator(`a[href*="${orderId}"]`).filter({ visible: true }).first(), 'The order: made, inspected, and now at JobWork ready to deliver');
  await read(page, 300, 1300);
  director.say('Notifications keep the buyer up to date');
  await page.goto(`${PORTAL}/notifications`);
  await read(page);
});

test('offstage · JobWork plans the delivery', async () => {
  const packingCheck = { neutralCartons: true, supplierMarksRemoved: true, jobworkLabelsApplied: true, packagingNoteFollowed: true };
  const ids = await stockLots(orderId);
  const packages = LOTS.map(({ lot, quantity }, n) => ({ packageNo: n + 1, weightG: 5000, items: [{ stockLotId: ids[lot], quantity }] }));
  dispatch = ok(await (await as('logistics')).post('/customer-dispatches', { salesOrderId: orderId, packages, packingCheck }), 201, 'plan dispatch');
  dispatch['packagesPlan'] = packages;
});

test('scene · 7 · Pay the balance', async ({ page, director }) => {
  const balance = ((await salesOrder(orderId))['invoices'] as Body[]).find((i) => i['kind'] === 'balance')!;
  await signIn(page, director, APPROVER, 'The manager', 'The parts are ready — the balance is due before dispatch');
  await page.goto(`${PORTAL}/invoices/${balance['invoiceId']}`);
  await read(page);
  director.say('Pay the balance online');
  await run(page, button(page, /^Pay ₹/));
  await expect(page).toHaveURL(/\/pay\//);
  await pause(page, 1500);
  await run(page, button(page, /^Pay ₹/), 'Payment received — JobWork can now dispatch');
  await expect(page.getByText('Payment received').first()).toBeVisible();
  await pause(page, 2500);
});

test('offstage · JobWork dispatches and the parts are delivered', async () => {
  const packingCheck = { neutralCartons: true, supplierMarksRemoved: true, jobworkLabelsApplied: true, packagingNoteFollowed: true };
  const logistics = await as('logistics');
  const balance = ((await salesOrder(orderId))['invoices'] as Body[]).find((i) => i['kind'] === 'balance')!;
  let s = dispatch;
  s = ok(await logistics.post(`/customer-dispatches/${s['shipmentId']}/replan`, { expectedVersion: s['aggregateVersion'], packages: dispatch['packagesPlan'], documents: { invoiceNumber: balance['number'] }, packingCheck }), 201, 'replan');
  s = ok(await (await as('sales')).post(`/customer-dispatches/${s['shipmentId']}/address-confirmations`, { expectedVersion: s['aggregateVersion'], note: 'Confirmed by phone with stores' }), 201, 'confirm address');
  s = ok(await logistics.post(`/customer-dispatches/${s['shipmentId']}/submit`, { expectedVersion: s['aggregateVersion'] }), 201, 'submit');
  s = ok(await logistics.post(`/customer-dispatches/${s['shipmentId']}/release`, { expectedVersion: s['aggregateVersion'] }), 201, 'release');
  s = ok(await logistics.post(`/shipments/${s['shipmentId']}/pickup`, { expectedVersion: s['aggregateVersion'], carrierMode: 'carrier', carrierName: 'Safexpress', trackingReference: `SX-${randomUUID().slice(0, 6)}` }), 201, 'pickup');
  ok(
    await logistics.post(`/shipments/${s['shipmentId']}/pod`, { expectedVersion: s['aggregateVersion'], receivedByName: 'R. Kumar', receivedAt: new Date().toISOString(), packagesReceived: LOTS.length, remarks: 'clean', source: 'driver' }),
    201,
    'proof of delivery',
  );
});

test('scene · 8 · Receive the parts', async ({ page, director }) => {
  await signIn(page, director, APPROVER, 'The manager', 'The parts have been delivered');
  await page.goto(`${PORTAL}/orders/${orderId}`);
  await read(page, 300, 900);
  await tap(page, link(page, /SD-|DL-|SH-/), 'Check the delivery and accept it');
  await expect(page).toHaveURL(/\/deliveries\/[0-9a-f-]{36}$/);
  await read(page, 300, 900);
  await type(page, field(page, 'Note (optional)'), 'All 100 received in good order.', 40);
  await run(page, button(page, 'Accept the delivery'), 'Delivery accepted');
  await pause(page, 2000);
  director.say('Delivery note, certificate of conformance and proof of delivery — all in one place');
  await page.goto(`${PORTAL}/orders/${orderId}/documents`);
  await read(page);
  await tap(page, link(page, /^Profile/), 'Sign out from the profile');
  await tap(page, button(page, 'Logout'));
  await expect(page).toHaveURL(/\/welcome$/);
  director.say('JobWork — custom parts, made and delivered');
  await pause(page, 3000);
});

async function into(page: import('@playwright/test').Page, target: import('@playwright/test').Locator): Promise<void> {
  await expect(target).toBeVisible();
  await target.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  await pause(page, 900);
}
