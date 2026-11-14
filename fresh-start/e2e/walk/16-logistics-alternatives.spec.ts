import { ok, type Body } from '../support/api';
import { as, atJobWork, decide, dispatched, inProduction, orderedDeal, pay, proofOfDelivery, released, salesOrder, stockLots, supplierSite, type Deal } from './support/flows';
import { axe, button, choose, command, expect, field, OPERATIONS, open, PORTAL, recall, remember, signInAs, test, visible } from './support/walk';

/** FW.16 Logistics, the other branches: a supplier replans and cancels a shipment, a receiving shortage resolved, a delivery edited and an override asked, the customer confirms, redirects, refuses and withdraws a report. */
test.describe.configure({ mode: 'serial' });

/** This run's ids: kept in memory first (the story file is shared by chapters running side by side), and in the story for `-g` reruns. */
const run: Record<string, unknown> = {};
const keep = (key: string, value: unknown): void => {
  run[key] = value;
  remember(`c16${key}`, value);
};
const get = <T = string>(key: string): T => (key in run ? (run[key] as T) : recall<T>(`c16${key}`));

const PACKING = { neutralCartons: true, supplierMarksRemoved: true, jobworkLabelsApplied: true, packagingNoteFollowed: true };
const shipment = async (id: string): Promise<Body> => ok(await (await as('logistics')).get(`/shipments/${id}`), 200, 'shipment');

/** Supplier A plans a shipment of one released lot. */
async function planned(deal: Deal, lot: string, quantity: string, challan: string): Promise<Body> {
  return ok(
    await (await as('supplierA')).post('/supplier/shipments', { purchaseOrderId: deal.purchaseOrderId, originSiteId: await supplierSite(), packages: [{ packageNo: 1, weightG: 9000, items: [{ lotCode: lot, quantity }] }], documents: { challanNumber: challan, eWaybillNumber: '1811 0000 0016' } }),
    201,
    'plan shipment',
  );
}

test('supplier · A changes the packages and documents of a planned shipment', async ({ page }) => {
  const stamp = Date.now().toString(36);
  await supplierSite();
  const deal = await orderedDeal(`Walk C16 shipment ${stamp}`);
  const { workPackageId } = await inProduction(deal);
  await released(deal, workPackageId, [{ lot: 'LOT-C16S', quantity: '60' }]);
  const s = await planned(deal, 'LOT-C16S', '60', `DC-C16-${stamp}`);
  keep('stamp', stamp);
  keep('supplierDeal', deal);
  keep('plannedShipmentId', s['shipmentId']);

  await signInAs(page, 'supplierA');
  await open(page, `${PORTAL}/supplier/shipments/${s['shipmentId']}`);
  await expect(visible(page, 'Contents — 60 pcs')).toBeVisible();
  await button(page, 'Change packages or documents').click();
  await field(page, 'Delivery challan no.').fill(`DC-C16-${stamp}-R`);
  await field(page, 'Pieces').fill('50');
  await field(page, 'Weight kg').fill('7.5');
  await axe(page, 'supplier shipment editor (replanning)');
  await command(page, 'Save changes');
  await expect(visible(page, 'Contents — 50 pcs')).toBeVisible();
  await expect(visible(page, `Challan DC-C16-${stamp}-R`)).toBeVisible();
  await expect(button(page, 'Save changes')).toHaveCount(0);
  await axe(page, 'supplier shipment (replanned)');
});

test('supplier · A cancels the planned shipment', async ({ page }) => {
  await signInAs(page, 'supplierA');
  await open(page, `${PORTAL}/supplier/shipments/${get('plannedShipmentId')}`);
  await field(page, 'Why').fill('The transporter cannot collect this week; we will ship with the next lot.');
  await command(page, 'Cancel shipment');
  await expect(page.getByText(/^.?cancelled — /).first()).toBeVisible();
  await expect(button(page, 'Cancel shipment')).toHaveCount(0);
  await expect(button(page, 'Submit for release')).toHaveCount(0);
  await axe(page, 'supplier shipment (cancelled)');
});

test('ops · logistics resolves a shortage found at receiving', async ({ page }) => {
  const deal = get<Deal>('supplierDeal');
  const a = await as('supplierA');
  const logistics = await as('logistics');
  let s = await planned(deal, 'LOT-C16S', '60', `DC-C16-${get('stamp')}-2`);
  s = ok(await a.post(`/supplier/shipments/${s['shipmentId']}/submit`, { expectedVersion: s['aggregateVersion'] }), 201, 'submit shipment');
  s = ok(await logistics.post(`/shipments/${s['shipmentId']}/release`, { expectedVersion: s['aggregateVersion'] }), 201, 'release shipment');
  s = ok(await a.post(`/supplier/shipments/${s['shipmentId']}/pickup`, { expectedVersion: s['aggregateVersion'], carrierMode: 'carrier', carrierName: 'Safe Carriers', trackingReference: `LR-C16-${get('stamp')}` }), 201, 'pickup');
  const item = ((s['packages'] as Body[])[0]!['items'] as Body[])[0]!;
  // Five pieces fewer in the box than on the challan.
  ok(
    await logistics.post(`/shipments/${s['shipmentId']}/receive`, { expectedVersion: s['aggregateVersion'], sealIntact: true, packages: [{ packageNo: 1, condition: 'ok' }], lines: [{ itemId: item['itemId'], countedQuantity: '55', acceptedQuantity: '55' }] }),
    201,
    'receive short',
  );

  await signInAs(page, 'logistics');
  await open(page, `${OPERATIONS}/logistics/shipments/${s['shipmentId']}`);
  await expect(visible(page, /RD-\d{4}-\d{4} · Shortage · 5 pieces/)).toBeVisible();
  await choose(page.getByLabel('Resolution', { exact: true }), /Accept the shortage/);
  await field(page, 'Why').fill('Supplier confirms five pieces stayed on its bench; they follow with the next lot.');
  await field(page, 'Carrier claim or supplier case (optional)').fill(`SUP-C16-${get('stamp')}`);
  await command(page, /^Resolve RD-/);
  await expect(visible(page, /Accept the shortage \(stays owed\) · Supplier confirms five pieces/)).toBeVisible();
  await expect(button(page, /^Resolve RD-/)).toHaveCount(0);
  await axe(page, 'shipment (shortage resolved)');
});

test('ops · logistics edits a planned delivery down to 60 pieces and asks sales to override', async ({ page }) => {
  const { deal } = await atJobWork(`Walk C16 delivery ${get('stamp')}`, [{ lot: 'LOT-C16D', quantity: '100' }]);
  const ids = await stockLots(deal.orderId);
  const s = ok(await (await as('logistics')).post('/customer-dispatches', { salesOrderId: deal.orderId, packages: [{ packageNo: 1, weightG: 5000, items: [{ stockLotId: ids['LOT-C16D'], quantity: '100' }] }], packingCheck: PACKING }), 201, 'plan dispatch');
  keep('orderId', deal.orderId);
  keep('firstDeliveryId', s['shipmentId']);

  await signInAs(page, 'logistics');
  await open(page, `${OPERATIONS}/logistics/shipments/${s['shipmentId']}`);
  await page.getByRole('link', { name: 'Edit packages and documents' }).click();
  await expect(page).toHaveURL(new RegExp(`/logistics/dispatch/new\\?shipmentId=${s['shipmentId']}$`));
  await expect(page.getByRole('heading', { level: 1 })).toContainText(`Edit ${s['number']}`);
  await field(page, 'Pieces').fill('60');
  await field(page, 'Package 1 weight (kg, optional)').fill('6');
  await field(page, 'Delivery challan (optional)').fill(`JW-DC-C16-${get('stamp')}`);
  const invoice = page.getByLabel('Tax invoice that travels with it', { exact: false });
  if (!(await invoice.inputValue())) await choose(invoice, /INV-/);
  await axe(page, 'delivery editor');
  await command(page, 'Save 60 pieces');
  await expect(page).toHaveURL(new RegExp(`/logistics/shipments/${s['shipmentId']}$`));
  await expect(visible(page, '60 pieces in 1 package')).toBeVisible();
  await expect(visible(page, `Challan JW-DC-C16-${get('stamp')}`)).toBeVisible();
  // One complete delivery was asked for: sixty of a hundred needs sales to let it leave.
  await expect(visible(page, /this ships 60 of the 100 outstanding/)).toBeVisible();
  await button(page, 'Ask sales to override').click();
  await field(page, 'Why sales should let it leave').fill('The customer’s line needs sixty this week; the rest follows in ten days.');
  await command(page, 'Ask sales to override');
  await expect(visible(page, 'override asked of sales, waiting')).toBeVisible();
  await axe(page, 'delivery (override asked)');
});

test('customer · confirms the delivery address', async ({ page }) => {
  await signInAs(page, 'buyer');
  await open(page, `${PORTAL}/orders/${get('orderId')}/deliveries/${get('firstDeliveryId')}`);
  await expect(visible(page, 'Confirm the delivery address')).toBeVisible();
  await command(page, 'Confirm');
  await expect(page.getByText('Confirm the delivery address')).toHaveCount(0);
  await axe(page, 'customer delivery (address confirmed)');
});

test('customer · asks for the second delivery to go to another address', async ({ page }) => {
  const orderId = get('orderId');
  const logistics = await as('logistics');
  // Sales lets the sixty leave; the first delivery goes out and is handed over.
  let first = await shipment(get('firstDeliveryId'));
  const override = (first['guards'] as Body[]).find((g) => g['key'] === 'commitment')!['override'] as Body;
  await decide('sales', override['approvalRequestId'] as string);
  const balance = ((await salesOrder(orderId))['invoices'] as Body[]).find((i) => i['kind'] === 'balance')!;
  if (balance['status'] !== 'paid') await pay(balance['invoiceId'] as string);
  first = await shipment(get('firstDeliveryId'));
  first = ok(await logistics.post(`/customer-dispatches/${first['shipmentId']}/submit`, { expectedVersion: first['aggregateVersion'] }), 201, 'submit first delivery');
  first = ok(await logistics.post(`/customer-dispatches/${first['shipmentId']}/release`, { expectedVersion: first['aggregateVersion'] }), 201, 'release first delivery');
  first = ok(await logistics.post(`/shipments/${first['shipmentId']}/pickup`, { expectedVersion: first['aggregateVersion'], carrierMode: 'carrier', carrierName: 'Safexpress', trackingReference: `SX-C16-${get('stamp')}` }), 201, 'pickup first delivery');
  await proofOfDelivery(first);
  // The other forty leave as the second delivery, on their way.
  const second = await dispatched(orderId, [['LOT-C16D', '40']]);
  keep('secondDeliveryId', second['shipmentId']);
  const label = `Walk C16 dock ${get('stamp')}`;
  const site = ok(
    await (await as('buyer')).post('/organizations/me/sites', { kind: 'delivery', label, addressLine1: 'Plot 4, SIPCOT Perundurai', city: 'Erode', state: 'Tamil Nadu', postalCode: '638052', contactName: 'K. Selvi', contactPhone: '+91 98425 11111' }),
    201,
    'second address',
  );

  try {
    await signInAs(page, 'buyer');
    await open(page, `${PORTAL}/orders/${orderId}/deliveries/${second['shipmentId']}`);
    await button(page, 'Ask for another address').click();
    await choose(page.getByLabel('Deliver to', { exact: true }), new RegExp(label));
    await field(page, 'Why').fill('Our Erode plant takes these forty; the line moved.');
    await command(page, 'Ask JobWork');
    await expect(visible(page, `Address change · to ${label}`)).toBeVisible();
    await expect(button(page, 'Ask for another address')).toHaveCount(0);
    await axe(page, 'customer delivery (address change asked)');
  } finally {
    // The extra address is this chapter's own; it leaves the shared address book as it found it.
    ok(await (await as('buyer')).post(`/organizations/me/sites/${site['siteId']}/archive`), 201, 'archive the second address');
  }
});

test('ops · logistics records that the customer refused the second delivery', async ({ page }) => {
  await signInAs(page, 'logistics');
  await open(page, `${OPERATIONS}/logistics/shipments/${get('secondDeliveryId')}`);
  await expect(visible(page, /Address change — Our Erode plant takes these forty; the line moved\. · to Walk C16 dock/)).toBeVisible();
  await button(page, 'The customer refused it').click();
  await field(page, 'Refused by').fill('R. Kumar, stores');
  await field(page, 'Why').fill('Their stores would not take a delivery meant for Erode.');
  await command(page, 'Record the refusal');
  await expect(page.getByText(/^.?refused at delivery — coming back — /).first()).toBeVisible();
  await expect(visible(page, 'Refused at delivery — Refused by R. Kumar, stores: Their stores would not take a delivery meant for Erode.')).toBeVisible();
  await expect(button(page, 'Record the POD')).toHaveCount(0);
  await expect(button(page, 'The customer refused it')).toHaveCount(0);
  await axe(page, 'delivery (refused)');
  // The refusal opens the return leg that brings the forty back, reachable from the refused delivery.
  const returnId = ((await shipment(get('secondDeliveryId')))['delivery'] as Body)['returnShipmentId'] as string;
  expect(returnId).toMatch(/^[0-9a-f-]{36}$/);
  await page.getByRole('link', { name: 'Open the return', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/logistics/shipments/${returnId}$`));
  await open(page, page.url());
});

test('customer · withdraws its report on the first delivery', async ({ page }) => {
  ok(
    await (await as('buyer')).post(`/deliveries/${get('firstDeliveryId')}/issues`, { kind: 'shortage', lotMarking: '', quantity: '2', description: 'Two pieces short in package 1.', evidenceDocumentVersionIds: [] }),
    201,
    'report a shortage',
  );
  await signInAs(page, 'buyer');
  await open(page, `${PORTAL}/orders/${get('orderId')}/deliveries/${get('firstDeliveryId')}`);
  await expect(visible(page, /Fewer pieces than the delivery note · 2/)).toBeVisible();
  await command(page, 'Withdraw');
  await expect(visible(page, 'Withdrawn by you')).toBeVisible();
  await expect(button(page, 'Withdraw')).toHaveCount(0);
  await axe(page, 'customer delivery (report withdrawn)');
});
