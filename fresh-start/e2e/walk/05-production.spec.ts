import { join } from 'node:path';
import { axe, expand, button, command, daysFromNow, expect, field, FIXTURES, OPERATIONS, open, PORTAL, recall, remember, signInAs, test, visible } from './support/walk';

/** FW.5 Purchase order to production: PO issue and acknowledgment, baseline, transmittal, work package, quality plan, checkpoints. */
test.describe.configure({ mode: 'serial' });

test('ops · sourcing issues the purchase orders and messages the customer', async ({ page }) => {
  await signInAs(page, 'sourcing');
  await open(page, `${OPERATIONS}/sales-orders`);
  await axe(page, 'sales orders');
  await open(page, `${OPERATIONS}/sales-orders/${recall('orderId')}`);
  await command(page, 'Issue purchase orders');
  await expect(visible(page, /PO-\d{4}-\d{4}/)).toBeVisible();
  await page.getByLabel('Message', { exact: false }).first().fill('Your order is with our workshop; we will share the plan this week.');
  await command(page, 'Send');
  await axe(page, 'sales order (POs issued)');
});

test('supplier · A acknowledges the purchase order', async ({ page }) => {
  await signInAs(page, 'supplierA');
  await open(page, `${PORTAL}/supplier/orders`);
  await axe(page, 'supplier orders');
  await page.getByRole('link', { name: /PO-\d{4}-\d{4}/ }).first().click();
  await expect(page).toHaveURL(/\/supplier\/orders\/[0-9a-f-]{36}$/);
  remember('purchaseOrderId', page.url().split('/').pop());
  await expect(page.locator('body')).not.toContainText(/Kovai/);
  await field(page, 'Note to JobWork (optional)').fill('Material booked, start next Monday.');
  await command(page, 'Acknowledge purchase order');
  await expect(visible(page, 'Acknowledged')).toBeVisible();
  await axe(page, 'supplier PO (acknowledged)');
});

test('ops · engineering baselines the drawings, transmits and plans the work package', async ({ page }) => {
  await signInAs(page, 'engineering');
  await open(page, `${OPERATIONS}/sales-orders/${recall('orderId')}/production`);
  await axe(page, 'production (no baseline)');
  // W9: only this order's documents and JobWork's own unlinked files are offered.
  await expect(page.getByText(/Flange drawing \(supplier copy\)/)).toHaveCount(0);
  const row = page.locator('li, tr, div').filter({ hasText: 'Supplier copy checked' }).filter({ has: page.getByRole('checkbox', { name: 'Include' }) }).last();
  await row.getByRole('checkbox', { name: 'Include' }).check();
  await row.getByLabel('Purpose', { exact: false }).selectOption({ label: 'Governing' });
  await command(page, /^(Assemble|Update) draft baseline$/);
  await command(page, /^Release BL-/);
  await command(page, 'Transmit to suppliers');
  await field(page, 'Planned start').fill(daysFromNow(1));
  await field(page, 'Planned finish').fill(daysFromNow(21));
  await command(page, 'Plan with standard checkpoints');
  await expect(visible(page, /WP-\d{4}-\d{4}/)).toBeVisible();
  await axe(page, 'production (planned)');
});

test('ops · quality writes and approves the quality plan', async ({ page }) => {
  await signInAs(page, 'quality');
  await open(page, `${OPERATIONS}/sales-orders/${recall('orderId')}/production`);
  const write = button(page, /^Write quality plan/);
  // Writing the plan opens it; a plan written on an earlier run is opened from its link.
  if (await write.isVisible()) await write.click();
  else await page.getByRole('link', { name: /^Plan v\d+/ }).first().click();
  await expect(page).toHaveURL(/\/quality\/plans\/[0-9a-f-]{36}$/);
  remember('qualityPlanUrl', page.url());
  await axe(page, 'quality plan (draft)');
  // The template asks for at least one characteristic from the drawing, by balloon.
  await button(page, 'Add characteristic').click();
  await page.getByLabel('Balloon', { exact: false }).last().fill('7');
  await page.getByLabel('Characteristic', { exact: true }).last().fill('Bore diameter');
  await page.getByLabel('Criticality', { exact: false }).last().selectOption({ label: 'Critical' });
  await page.getByLabel('Lower limit', { exact: false }).last().fill('11.98');
  await page.getByLabel('Upper limit', { exact: false }).last().fill('12.02');
  await page.getByLabel('Method', { exact: false }).last().fill('Bore gauge');
  await command(page, 'Save draft');
  await command(page, 'Approve plan');
  await expect(button(page, 'Revise plan')).toBeVisible();
  await axe(page, 'quality plan (approved)');
});

test('supplier · A acknowledges the drawing pack', async ({ page }) => {
  await signInAs(page, 'supplierA');
  await open(page, `${PORTAL}/supplier/orders/${recall('purchaseOrderId')}`);
  await field(page, 'Note to JobWork (optional)').fill('Drawing pack received complete.');
  await command(page, 'Acknowledge drawing pack');
  await expect(button(page, 'Acknowledge drawing pack')).toHaveCount(0);
});

test('ops · sourcing releases the work package to production', async ({ page }) => {
  await signInAs(page, 'sourcing');
  await open(page, `${OPERATIONS}/sales-orders/${recall('orderId')}/production`);
  await command(page, 'Release to production');
  await expect(visible(page, /released|in production/i)).toBeVisible();
});

test('supplier · A starts a checkpoint, sends evidence and reports a delay', async ({ page }) => {
  await signInAs(page, 'supplierA');
  await open(page, `${PORTAL}/supplier/orders/${recall('purchaseOrderId')}`);
  await command(page, 'Start');
  const upload = page.getByLabel(/^Upload File — (Photo|Certificate)/).first();
  await upload.setInputFiles(join(FIXTURES, (await upload.getAttribute('accept'))?.includes('pdf') ? 'drawing.pdf' : 'photo.png'));
  await expect(button(page, 'Submit for verification')).toBeEnabled({ timeout: 60_000 });
  await command(page, 'Submit for verification');
  await expand(page, 'Report a delay');
  await field(page, 'New forecast date').fill(daysFromNow(25));
  await field(page, 'What happened').fill('Spindle bearing replacement on the VMC.');
  await command(page, 'Report delay');
  await axe(page, 'supplier PO (production)');
});

test('ops · quality verifies the evidence and waives a checkpoint', async ({ page }) => {
  await signInAs(page, 'quality');
  await open(page, `${OPERATIONS}/production`);
  await expect(page.getByRole('link').filter({ hasText: /./ }).first()).toBeVisible();
  await axe(page, 'verification queue');
  await open(page, `${OPERATIONS}/sales-orders/${recall('orderId')}/production`);
  await command(page, 'Verify');
  await field(page, 'Waiver reason').fill('Covered by the final inspection on record.');
  await command(page, 'Waive');
  await axe(page, 'production (verified)');
});
