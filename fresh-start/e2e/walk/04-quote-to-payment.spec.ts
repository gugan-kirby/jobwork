import type { Page } from '@playwright/test';
import { world } from '../support/world';
import { axe, button, choose, command, daysFromNow, expect, field, OPERATIONS, open, PORTAL, recall, remember, signInAs, test, visible } from './support/walk';

/** FW.4 Approvals, cost sheet, quotations, revision, acceptance, payment, finance controls. */
test.describe.configure({ mode: 'serial' });

/** Decides the waiting approval whose subject link points at `href` (or whose row mentions the text). */
async function approve(page: Page, href: string | RegExp, reason = ''): Promise<void> {
  await open(page, `${OPERATIONS}/approvals`);
  const subject = typeof href === 'string' ? page.locator(`a[href*="${href}"]`) : page.getByText(href);
  const row = page.locator('tr').filter({ has: subject }).filter({ has: page.getByRole('button', { name: 'Decide…' }) }).first();
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Decide…' }).click();
  if (reason) await field(page, 'Reason').fill(reason);
  await command(page, 'Approve');
}

test('ops · sales approves the award and prepares the cost sheet', async ({ page }) => {
  await signInAs(page, 'sales');
  await open(page, `${OPERATIONS}/approvals`);
  await axe(page, 'approvals');
  await page.getByLabel('Show', { exact: false }).selectOption({ label: 'All' });
  await page.getByLabel('Show', { exact: false }).selectOption({ label: 'Waiting' });
  await approve(page, recall('awardId'));
  await open(page, `${OPERATIONS}/awards/${recall('awardId')}`);
  await expect(page.getByRole('cell', { name: '₹48.50' }).first()).toBeVisible();
  await expect(async () => {
    await page.reload();
    await expect(button(page, 'Add a component')).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 20_000 });
  await button(page, 'Add a component').click();
  await choose(page.getByLabel('Component', { exact: false }).last(), /Freight/i);
  await field(page, 'Amount (₹)').fill('300');
  await page.getByLabel('Basis', { exact: false }).last().fill('Courier estimate to Tiruppur');
  await field(page, 'Target margin on sell (%)').fill('15');
  await field(page, 'Note').fill('Standard margin for a repeat customer.');
  await command(page, 'Save cost sheet');
  await command(page, 'Request approval');
  await axe(page, 'award with cost sheet');
});

test('ops · finance approves the cost sheet', async ({ page }) => {
  await signInAs(page, 'finance');
  await approve(page, recall('awardId'));
  await page.getByLabel('Show', { exact: false }).selectOption({ label: 'Approved' });
  await expect(page.locator(`a[href*="${recall('awardId')}"]`).first()).toBeVisible();
});

test('ops · sales drafts the standard and fast quotations and asks for approval', async ({ page }) => {
  await signInAs(page, 'sales');
  for (const option of ['Standard', 'Fast'] as const) {
    await open(page, `${OPERATIONS}/awards/${recall('awardId')}`);
    await page.getByLabel('Option', { exact: false }).selectOption({ label: option });
    await field(page, 'Delivery (days)').fill(option === 'Fast' ? '14' : '21');
    await field(page, 'Valid until').fill(daysFromNow(14));
    await field(page, 'Payment terms').fill('50% advance, balance before dispatch');
    await field(page, 'Scope').fill('Machined impeller housings to drawing, inspected, packed.');
    await command(page, `Draft ${option.toLowerCase()} quotation`);
    await expect(page).toHaveURL(/\/quotes\/[0-9a-f-]{36}$/);
    remember(`quote${option}`, page.url().split('/').pop());
    await button(page, 'Preview document').click();
    await expect(page.frameLocator('iframe[title="Quotation document"]').locator('body')).toContainText(/Quotation|QT-/);
    await button(page, 'Close').click();
    await command(page, 'Request approval');
    await axe(page, `quote ${option} (internal approval)`);
  }
  await open(page, `${OPERATIONS}/quotes`);
  await page.getByLabel('Show', { exact: false }).selectOption({ label: 'Awaiting approval' });
  await expect(page.locator(`a[href*="${recall('quoteFast')}"]`).first()).toBeVisible();
  await axe(page, 'quotes');
});

test('ops · sales2 approves both quotations', async ({ page }) => {
  await signInAs(page, 'sales2');
  await approve(page, recall('quoteStandard'));
  await approve(page, recall('quoteFast'));
});

test('ops · sales sends both quotations to the customer', async ({ page }) => {
  await signInAs(page, 'sales');
  for (const key of ['quoteStandard', 'quoteFast']) {
    await open(page, `${OPERATIONS}/quotes/${recall(key)}`);
    await command(page, 'Send to customer');
    await expect(visible(page, /sent|with the customer/i)).toBeVisible();
  }
  await expect(page.getByRole('link', { name: /Sourcing round, award and cost sheet/ })).toBeVisible();
});

test('customer · reads both options, downloads one and asks for a revision of the other', async ({ page }) => {
  await signInAs(page, 'buyer');
  await open(page, `${PORTAL}/quotations`);
  await axe(page, 'customer quotations');
  await open(page, `${PORTAL}/quotations/${recall('quoteStandard')}`);
  await expect(page.locator('body')).not.toContainText(/Anand|Balaji/);
  const download = page.waitForEvent('download').catch(() => null);
  const popup = page.waitForEvent('popup').catch(() => null);
  await button(page, 'Download Quote').click();
  expect((await Promise.race([download, popup, page.waitForTimeout(5000).then(() => 'none')])) ?? 'none').not.toBe('none');
  await axe(page, 'customer quotation');
  await open(page, `${PORTAL}/quotations/${recall('quoteFast')}`);
  await button(page, 'Request a revision').click();
  await field(page, 'What should change?').fill('Can you hold 14 days if we take 200 pieces?');
  await command(page, 'Send revision request');
  await expect(visible(page, /revis/i)).toBeVisible();
});

test('ops · sales replaces the fast quotation with version 2', async ({ page }) => {
  await signInAs(page, 'sales');
  await open(page, `${OPERATIONS}/quotes/${recall('quoteFast')}`);
  await button(page, 'Replace with a new version…').click();
  await field(page, 'Qty').fill('200');
  await field(page, 'Why this revision').fill('Quantity raised to 200 at the customer request.');
  await command(page, 'Create version 2');
  await expect(visible(page, /v2|Version 2/)).toBeVisible();
  await axe(page, 'quote version 2');
});

test('customer · the approver accepts the standard quotation and places the order', async ({ page }) => {
  await signInAs(page, 'approver');
  await open(page, `${PORTAL}/quotations/${recall('quoteStandard')}`);
  await page.getByRole('link', { name: 'Accept Quote' }).click();
  await expect(page).toHaveURL(/\/accept$/);
  await expect(button(page, 'Accept and place order')).toBeDisabled();
  await page.getByRole('checkbox', { name: /I have read the quotation/ }).check();
  await axe(page, 'accept quotation');
  await command(page, 'Accept and place order');
  await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}\?accepted=1$/);
  await expect(visible(page, 'Order placed')).toBeVisible();
  remember('orderId', new URL(page.url()).pathname.split('/').pop());
  await axe(page, 'order placed');
});

test('customer · pays the advance through the gateway', async ({ page }) => {
  await signInAs(page, 'approver');
  await open(page, `${PORTAL}/orders/${recall('orderId')}`);
  await button(page, /^Pay ₹/).click();
  await expect(page).toHaveURL(/\/pay\/[0-9a-f-]{36}$/);
  await axe(page, 'payment page');
  await command(page, /^Pay ₹/);
  await expect(visible(page, 'Payment received')).toBeVisible();
  await page.getByRole('link', { name: 'See the invoice' }).click();
  await expect(page).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/);
  await expect(visible(page, /Paid/)).toBeVisible();
  await axe(page, 'invoice (paid)');
  await open(page, `${PORTAL}/invoices`);
  await page.getByRole('radio', { name: /Paid/ }).click();
  await axe(page, 'invoices');
  await open(page, `${PORTAL}/payments`);
  await expect(page.getByText(/₹/).first()).toBeVisible();
  await axe(page, 'payments');
});

test('customer · a declined payment is reported and can be retried', async ({ page }) => {
  await signInAs(page, 'approver');
  await open(page, `${PORTAL}/orders/${world().orderId}`);
  await button(page, /^Pay ₹/).click();
  await expect(page).toHaveURL(/\/pay\//);
  await button(page, 'Simulate a declined payment').click();
  await expect(visible(page, 'The payment did not go through')).toBeVisible();
  await page.getByRole('link', { name: 'Try again from the invoice' }).click();
  await expect(page).toHaveURL(/\/invoices\//);
  await expect(button(page, /^Pay ₹/)).toBeEnabled();
});

test('ops · finance records a bank credit, proposes an allocation and manages credit', async ({ page }) => {
  await signInAs(page, 'finance');
  await open(page, `${OPERATIONS}/finance`);
  await axe(page, 'finance');
  await field(page, 'Bank reference').fill(`UTR-WALK-${Date.now() % 100000}`);
  await field(page, 'Amount (₹)').fill('1000');
  await field(page, 'Credited on').fill(daysFromNow(0));
  await command(page, 'Record');
  await button(page, 'Allocate…').click();
  await choose(page.getByLabel('Invoice', { exact: false }), /INV-/);
  await page.getByLabel('Amount (₹)', { exact: false }).first().fill('1000');
  await command(page, 'Propose');

  await open(page, `${OPERATIONS}/sales-orders/${world().orderId}`);
  await field(page, 'Credit limit (₹)').fill('500000');
  await field(page, 'Terms (days)').fill('30');
  await command(page, 'Approve credit terms');
  await field(page, 'Hold reason').fill('Two invoices overdue beyond terms.');
  await command(page, 'Place credit hold');
  await command(page, 'Release hold');
  await axe(page, 'sales order (finance)');
  await open(page, `${OPERATIONS}/finance/margin`);
  await axe(page, 'margin per order');
});

test('ops · finance2 approves the allocation', async ({ page }) => {
  await signInAs(page, 'finance2');
  await approve(page, /allocation|INV-/i);
});
