import { join } from 'node:path';
import { ok, type Body } from '../support/api';
import { as, atJobWork, customerSite, dispatched, inProduction, orderedDeal, pay, proofOfDelivery, released, salesOrder, supplierSite } from './support/flows';
import { axe, button, choose, freshMinute, localStamp, command, daysFromNow, expand, expect, field, FIXTURES, OPERATIONS, open, PORTAL, recall, remember, signInAs, test, visible, showOrderDetails } from './support/walk';

/** FW.7 Logistics, both legs: supplier shipment → release → pickup → receiving; customer material; dispatch → POD → acceptance; a delivery problem. */
test.describe.configure({ mode: 'serial' });

test('supplier · plans a shipment of released lots and submits it', async ({ page }) => {
  await customerSite();
  await supplierSite();
  const deal = await orderedDeal('Walk logistics bracket');
  const { workPackageId } = await inProduction(deal);
  await released(deal, workPackageId, [{ lot: 'LOT-L1', quantity: '100' }]);
  remember('lgOrderId', deal.orderId);
  remember('lgPurchaseOrderId', deal.purchaseOrderId);
  remember('lgWorkPackageId', workPackageId);

  await signInAs(page, 'supplierA');
  await open(page, `${PORTAL}/supplier/shipments`);
  await axe(page, 'supplier shipments');
  await open(page, `${PORTAL}/supplier/orders/${deal.purchaseOrderId}`);
  await page.getByRole('link', { name: 'Plan a shipment' }).click();
  await expect(page).toHaveURL(/\/supplier\/shipments\/new\?purchaseOrderId=/);
  await choose(page.getByLabel('Pickup address', { exact: false }), /Anand works/);
  await field(page, 'Delivery challan no.').fill('DC-WALK-1');
  await field(page, 'E-way bill no.').fill('1811 0000 0042');
  await field(page, 'Length mm').fill('600');
  await field(page, 'Width mm').fill('400');
  await field(page, 'Height mm').fill('300');
  await field(page, 'Weight kg').fill('18');
  await choose(page.getByLabel('Lot', { exact: true }).first(), /LOT-L1/);
  await field(page, 'Pieces').fill('100');
  await axe(page, 'shipment editor');
  await command(page, 'Save the plan');
  await expect(page).toHaveURL(/\/supplier\/shipments\/[0-9a-f-]{36}$/);
  remember('inboundShipmentId', page.url().split('/').pop());
  await command(page, 'Submit for release');
  await axe(page, 'supplier shipment (submitted)');
});

test('ops · logistics releases the shipment for pickup', async ({ page }) => {
  await signInAs(page, 'logistics');
  await open(page, `${OPERATIONS}/logistics`);
  await axe(page, 'logistics board');
  await open(page, `${OPERATIONS}/logistics/shipments/${recall('inboundShipmentId')}`);
  await command(page, 'Release for pickup');
  await axe(page, 'shipment (released)');
});

test('supplier · hands the shipment to the transporter', async ({ page }) => {
  await signInAs(page, 'supplierA');
  await open(page, `${PORTAL}/supplier/shipments/${recall('inboundShipmentId')}`);
  await choose(page.getByLabel('How it travels', { exact: false }), /Transporter/);
  await field(page, 'Carrier').fill('Safe Carriers');
  await field(page, 'Tracking or LR number').fill('LR-WALK-1001');
  await command(page, 'Picked up');
  await expect(page.locator('body')).not.toContainText(/Kovai/);
});

test('ops · logistics records a carrier update and receives the shipment', async ({ page }) => {
  await signInAs(page, 'logistics');
  await open(page, `${OPERATIONS}/logistics/shipments/${recall('inboundShipmentId')}`);
  await choose(page.getByLabel('Status', { exact: true }), /transit/i);
  await field(page, 'As the carrier put it').fill('Departed Ambattur hub');
  await page.getByLabel('When', { exact: true }).first().fill(await localStamp(page, -60_000));
  await command(page, 'Record update');
  await page.getByRole('checkbox', { name: /Seal intact/ }).check();
  await page.getByRole('checkbox', { name: /Challan or invoice in the box matches/ }).check();
  await choose(page.getByLabel(/^Package 1/), /Sound/);
  await page.getByLabel('Counted', { exact: false }).first().fill('100');
  await page.getByLabel('Accepted', { exact: false }).first().fill('100');
  await page.getByLabel('Photo', { exact: false }).first().setInputFiles(join(FIXTURES, 'photo.png'));
  await expect(button(page, 'Record receipt')).toBeEnabled({ timeout: 60_000 });
  await axe(page, 'receiving');
  await command(page, 'Record receipt');
  await expect(visible(page, /received/i)).toBeVisible();
  await open(page, `${OPERATIONS}/logistics/work-packages/${recall('lgWorkPackageId')}`);
  await axe(page, 'work package logistics');
});

test('ops · logistics receives customer material and issues it to the supplier', async ({ page }) => {
  await signInAs(page, 'logistics');
  await open(page, `${OPERATIONS}/sales-orders/${recall('lgOrderId')}`);
  await field(page, 'Customer’s challan no.').fill('KP-CH-77');
  await choose(page.getByLabel('Brought by', { exact: false }), /Customer vehicle/);
  await field(page, 'Carrier').fill('Customer van');
  await field(page, 'Lot or heat no.').fill(`HT-${Date.now() % 100000}`);
  await page.getByLabel(/^Quantity/).first().fill('25');
  await field(page, 'What it is').fill('6061 bar stock, 40 mm');
  await command(page, 'Record and receive it');
  // Recording opens the material's inbound shipment; issuing happens on the order.
  await expect(page).toHaveURL(/\/logistics\/shipments\/[0-9a-f-]{36}$/);
  await axe(page, 'customer material shipment');
  await page.getByRole('checkbox', { name: /Seal intact/ }).check();
  await page.getByRole('checkbox', { name: /Challan or invoice in the box matches/ }).check();
  await choose(page.getByLabel(/^Package 1/), /Sound/);
  await page.getByLabel('Counted', { exact: false }).first().fill('25');
  await page.getByLabel('Accepted', { exact: false }).first().fill('25');
  await command(page, 'Record receipt');
  await open(page, `${OPERATIONS}/sales-orders/${recall('lgOrderId')}`);
  await choose(page.getByLabel('Purchase order', { exact: true }), /PO-/);
  await choose(page.getByLabel('Lot', { exact: true }), /HT-/);
  await page.getByLabel(/^Quantity/).last().fill('10');
  await field(page, 'JobWork challan no.').fill('JW-CH-9');
  await command(page, 'Issue material');
  await axe(page, 'sales order (material)');
  const issued = (ok(await (await as('supplierA')).get('/supplier/shipments'), 200, 'supplier shipments') as unknown as Body[]).find((x) => x['leg'] === 'jobwork_to_supplier' && x['status'] === 'released')!;
  remember('issueShipmentId', issued['shipmentId']);
  await open(page, `${OPERATIONS}/logistics/shipments/${issued['shipmentId']}`);
  await choose(page.getByLabel('How it travels', { exact: false }), /own vehicle|Transporter/i);
  const carrier = page.getByLabel('Carrier', { exact: false });
  if (await carrier.count()) await carrier.first().fill('JobWork van');
  const tracking = page.getByLabel(/^(Tracking or LR number|Vehicle number)/);
  if (await tracking.count()) await tracking.first().fill('TN-01-AB-1234');
  await command(page, 'Picked up');
});

test('supplier · confirms the material arrived', async ({ page }) => {
  await signInAs(page, 'supplierA');
  await open(page, `${PORTAL}/supplier/shipments`);
  await open(page, `${PORTAL}/supplier/shipments/${recall('issueShipmentId')}`);
  await expect(page.locator('body')).not.toContainText(/Kovai/);
  await command(page, 'Material received');
});

test('ops · logistics plans the delivery to the customer, confirms the address, releases it', async ({ page }) => {
  const order = await salesOrder(recall('lgOrderId'));
  const balance = (order['invoices'] as Body[]).find((i) => i['kind'] === 'balance');
  if (balance && balance['status'] !== 'paid') await pay(balance['invoiceId'] as string);
  await signInAs(page, 'logistics');
  await open(page, `${OPERATIONS}/logistics`);
  await page.getByRole('link', { name: 'Plan a delivery' }).first().click();
  await open(page, `${OPERATIONS}/logistics/dispatch/new?salesOrderId=${recall('lgOrderId')}`);
  await page.getByLabel('Pieces', { exact: false }).first().fill('100');
  await choose(page.getByLabel('Deliver to', { exact: false }), /./);
  await choose(page.getByLabel('Tax invoice that travels with it', { exact: false }), /INV-/);
  for (const check of ['Packed in neutral or JobWork cartons', 'Workshop tags, stickers and paperwork removed', 'JobWork labels applied', 'The customer’s packaging instructions followed']) {
    await page.getByRole('checkbox', { name: check }).check();
  }
  await axe(page, 'dispatch planning');
  await command(page, /^Plan the delivery of \d+ pieces$/);
  await expect(page).toHaveURL(/\/logistics\/shipments\/[0-9a-f-]{36}$/);
  remember('outboundShipmentId', page.url().split('/').pop());
  await field(page, 'The customer confirmed the address by phone or mail: how').fill('Confirmed by phone with R. Kumar, stores.');
  await command(page, 'Record the confirmation');
  await command(page, 'Submit for release');
  await command(page, 'Release to the customer');
  await choose(page.getByLabel('How it travels', { exact: false }), /Transporter|Courier/);
  await field(page, 'Carrier').fill('Safexpress');
  await field(page, 'Tracking or LR number').fill('SX-WALK-55');
  await command(page, 'Picked up');
  for (const doc of ['Labels', 'Delivery note', 'Certificate of conformance']) {
    const popup = page.waitForEvent('popup', { timeout: 10_000 }).catch(() => null);
    await button(page, doc).click();
    const tab = await popup;
    if (tab) {
      await expect(tab.locator('body')).not.toContainText(/Anand/);
      await tab.close();
    }
  }
  await axe(page, 'customer delivery (on the way)');
});

test('ops · logistics records the proof of delivery', async ({ page }) => {
  await signInAs(page, 'logistics');
  await open(page, `${OPERATIONS}/logistics/shipments/${recall('outboundShipmentId')}`);
  await field(page, 'Received by').fill('R. Kumar');
  const handover = await freshMinute(page);
  for (const when of await page.getByLabel('When', { exact: true }).filter({ visible: true }).all()) await when.fill(handover);
  await field(page, 'Packages received').fill('1');
  await page.getByLabel('Photo', { exact: false }).last().setInputFiles(join(FIXTURES, 'photo.png'));
  await expect(button(page, 'Record the POD')).toBeEnabled({ timeout: 60_000 });
  await command(page, 'Record the POD');
});

test('customer · accepts the delivery and reads its documents', async ({ page }) => {
  await signInAs(page, 'approver');
  await open(page, `${PORTAL}/orders/${recall('lgOrderId')}`);
  await showOrderDetails(page);
  await page.getByRole('link', { name: /SD-|DL-|SH-/ }).first().click();
  await expect(page).toHaveURL(/\/deliveries\/[0-9a-f-]{36}$/);
  await expect(page.locator('body')).not.toContainText(/LOT-L1/);
  await field(page, 'Note (optional)').fill('All 100 received in good order.');
  await command(page, 'Accept the delivery');
  for (const doc of ['Delivery note', 'Certificate of conformance', 'Proof of delivery']) {
    const popup = page.waitForEvent('popup', { timeout: 10_000 }).catch(() => null);
    await button(page, doc).click();
    const tab = await popup;
    if (tab) {
      await expect(tab.locator('body')).not.toContainText(/Anand/);
      await tab.close();
    }
  }
  await axe(page, 'customer delivery (accepted)');
  await open(page, `${PORTAL}/orders/${recall('lgOrderId')}/documents`);
  await axe(page, 'order documents');
});

test('customer · reports a damaged delivery', async ({ page }) => {
  const { deal } = await atJobWork('Walk damaged delivery', [{ lot: 'LOT-X', quantity: '100' }]);
  const shipment = await proofOfDelivery(await dispatched(deal.orderId, [['LOT-X', '100']]));
  remember('problemShipmentId', shipment['shipmentId']);
  await signInAs(page, 'approver');
  await open(page, `${PORTAL}/orders/${deal.orderId}/deliveries/${shipment['shipmentId']}`);
  await button(page, 'Report a problem').click();
  await choose(page.getByLabel('What is wrong', { exact: false }), /damage/i);
  await page.getByLabel('Lot (as on the delivery note)', { exact: false }).selectOption({ index: 1 });
  await field(page, 'How many pieces').fill('4');
  await field(page, 'What you found').fill('Four housings dented in one carton.');
  await page.getByLabel('Photo', { exact: false }).setInputFiles(join(FIXTURES, 'photo.png'));
  await expect(button(page, 'Send the report')).toBeEnabled({ timeout: 60_000 });
  await command(page, 'Send the report');
  await axe(page, 'customer delivery (problem reported)');
});

test('ops · logistics resolves the delivery exception', async ({ page }) => {
  await signInAs(page, 'logistics');
  await open(page, `${OPERATIONS}/logistics/shipments/${recall('problemShipmentId')}`);
  const panel = page.locator('div').filter({ has: page.getByRole('button', { name: /^Resolve DX-/ }) }).filter({ has: page.getByLabel('Resolution', { exact: true }) }).last();
  await panel.getByLabel('Resolution', { exact: true }).selectOption({ index: 1 });
  await panel.getByLabel('Note', { exact: true }).fill('Carrier claim raised; replacements to follow.');
  const ref = panel.getByLabel('Case reference', { exact: false });
  if (await ref.count()) await ref.fill('CASE-WALK-1');
  await command(page, /^Resolve /);
  void expand;
  void ok;
  void as;
  void daysFromNow;
});
