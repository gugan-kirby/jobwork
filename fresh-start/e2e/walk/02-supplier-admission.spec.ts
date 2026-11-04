import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { axe, button, command, daysFromNow, expect, field, FIXTURES, OPERATIONS, open, PORTAL, recall, remember, section, signInAs, test, visible } from './support/walk';

/** FW.2 Supplier admission: application → admission → onboarding → evidence review → decision → availability. */
test.describe.configure({ mode: 'serial' });

const PASSWORD = 'walk-supplier-password-1';

async function signInSupplier(page: Page): Promise<void> {
  await page.goto(`${PORTAL}/login`);
  await field(page, 'Email').fill(recall('newSupplierEmail'));
  await field(page, 'Password').fill(PASSWORD);
  await button(page, 'Login').click();
  await expect(page).not.toHaveURL(/\/login/);
}

test('ops · applications are declined and admitted, the supplier is invited', async ({ page }) => {
  await signInAs(page, 'admin');
  await open(page, `${OPERATIONS}/suppliers/applications`);
  await axe(page, 'supplier applications');
  const declineRow = page.getByRole('row').filter({ hasText: recall('applicationDecline') });
  await declineRow.getByRole('button', { name: /Decline/ }).click();
  await field(page, 'Reason').fill('We have enough sheet-metal capacity in Ambattur for now.');
  await command(page, 'Decline application');
  await expect(page.getByRole('row').filter({ hasText: recall('applicationDecline') })).toHaveCount(0);

  await page.getByRole('row').filter({ hasText: recall('applicationAdmit') }).getByRole('link', { name: /Admit/ }).click();
  await expect(page).toHaveURL(/\/suppliers\/new\?application=/);
  await expect(field(page, 'Registered legal name')).toHaveValue(recall('applicationAdmit'));
  const invitee = `owner-${randomUUID().slice(0, 6)}@walkprecision.test`;
  await field(page, 'Registered legal name').fill('Walk Precision Works Private Limited');
  await field(page, 'Invite this email').fill(invitee);
  await field(page, 'Contact email').fill(invitee);
  await axe(page, 'admit supplier');
  const admitted = page.waitForResponse((r) => /\/api\/v1\/suppliers$/.test(r.url()) && r.request().method() === 'POST');
  await button(page, 'Admit supplier and invite').click();
  const body = (await (await admitted).json()) as Record<string, unknown>;
  const acceptUrl = JSON.stringify(body).match(/accept-invitation\?token=([^"&]+)/)?.[1];
  expect(acceptUrl, 'dev admission returns the invitation link').toBeTruthy();
  await page.getByRole('link', { name: /Open the supplier/ }).click();
  await expect(page).toHaveURL(/\/suppliers\/[0-9a-f-]{36}$/);
  remember('newSupplierEmail', invitee);
  remember('newSupplierToken', acceptUrl);
  remember('newSupplierProfileUrl', page.url());
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await axe(page, 'supplier 360');
});

test('supplier · accepts the invitation and completes its company profile', async ({ page }) => {
  await page.goto(`${PORTAL}/accept-invitation?token=${recall('newSupplierToken')}`);
  await field(page, 'Your name').fill('Walk Owner');
  await field(page, 'Choose a password').fill(PASSWORD);
  await axe(page, 'accept invitation');
  await button(page, 'Accept invitation').click();
  await page.getByRole('link', { name: 'Continue to sign in' }).click();
  await signInSupplier(page);
  await expect(page).toHaveURL(/\/supplier$/);
  await axe(page, 'supplier home (onboarding)');
  await expect(button(page, 'Send for review')).toBeDisabled();

  await open(page, `${PORTAL}/supplier/company`);
  await field(page, 'Trade name').fill('Walk Precision');
  await field(page, 'Website').fill('https://walkprecision.example');
  await field(page, 'What you make').fill('Precision turned and milled parts in aluminium and steel.');
  await page.getByLabel('Where you serve', { exact: false }).selectOption({ label: 'Chennai metro' });
  await field(page, 'Year established').fill('2009');
  await page.getByLabel('People on the shop floor', { exact: false }).selectOption({ index: 2 });
  await field(page, 'Primary contact name').fill('Walk Owner');
  await field(page, 'Primary contact phone').fill('+91 98400 54321');
  await command(page, 'Save company details');
  await field(page, 'Unit name').fill('Ambattur unit');
  await field(page, /^Address/).fill('Plot 7, SIDCO Industrial Estate, Ambattur');
  await field(page, 'City').fill('Chennai');
  await field(page, 'State').fill('Tamil Nadu');
  await field(page, 'PIN code').fill('600098');
  await command(page, 'Save works address');
  await axe(page, 'supplier company');
});

test('supplier · sends its compliance evidence and a certification', async ({ page }) => {
  await signInSupplier(page);
  await open(page, `${PORTAL}/supplier/compliance`);
  for (const [card, ref, value] of [
    ['GST registration', 'GSTIN', '33ABCDE1234F1Z5'],
    ['PAN', 'PAN', 'ABCDE1234F'],
    ['Bank account', 'Account number', '50100012345678'],
  ] as const) {
    const box = section(page, card);
    await box.getByLabel(ref, { exact: false }).fill(value);
    await box.getByLabel('Certificate', { exact: false }).setInputFiles(join(FIXTURES, 'drawing.pdf'));
    await expect(box.getByText('Ready')).toBeVisible({ timeout: 60_000 });
    await command(page, /Send for checking|Send again/, box);
  }
  const certs = section(page, 'Certifications');
  await certs.getByLabel('Certificate number', { exact: false }).fill('ISO-9001-WALK-1');
  await certs.getByLabel('Issued by', { exact: false }).fill('TUV India');
  await certs.getByLabel('Expires on', { exact: false }).fill(daysFromNow(400));
  await certs.getByLabel(/^Upload File — Certificate/).setInputFiles(join(FIXTURES, 'drawing.pdf'));
  await expect(certs.getByText('Ready')).toBeVisible({ timeout: 60_000 });
  await command(page, 'Send certification', certs);
  await axe(page, 'supplier compliance');
});

test('supplier · declares capabilities, a machine and capacity, then sends for review', async ({ page }) => {
  await signInSupplier(page);
  await open(page, `${PORTAL}/capabilities`);
  for (const option of [/CNC milling/i, /aluminium/i]) {
    const select = page.getByLabel('Capability', { exact: false }).first();
    const label = (await select.locator('option').allInnerTexts()).find((t) => option.test(t))!;
    await select.selectOption({ label });
    await field(page, 'Tolerance class').fill('IT7');
    await button(page, 'Publish version').click();
    await expect(visible(page, label.replace(/ \(.*\)$/, ''))).toBeVisible();
  }
  await field(page, 'Key').fill('vmc-1');
  await field(page, 'Label').fill('VMC 850');
  await field(page, 'X (mm)').fill('850');
  await field(page, 'Y (mm)').fill('500');
  await field(page, 'Z (mm)').fill('500');
  await button(page, 'Publish machine').click();
  await expect(visible(page, 'VMC 850')).toBeVisible();
  await page.getByLabel('From', { exact: true }).fill(daysFromNow(1));
  await page.getByLabel('To', { exact: true }).fill(daysFromNow(30));
  await field(page, 'Hours available').fill('160');
  await button(page, 'Declare window').click();
  await expect(visible(page, '160')).toBeVisible();
  await axe(page, 'capabilities');

  await open(page, `${PORTAL}/supplier`);
  await command(page, 'Send for review');
  await expect(visible(page, /submitted|under review|with JobWork/i)).toBeVisible();
});

test('ops · sourcing verifies the evidence', async ({ page }) => {
  await signInAs(page, 'sourcing');
  await open(page, `${OPERATIONS}/suppliers/verification`);
  await axe(page, 'evidence queue');
  for (let i = 0; i < 4; i++) {
    const item = page.locator('article, li, tr, section').filter({ hasText: 'Walk Precision' }).filter({ has: page.getByRole('button', { name: 'Verify' }) }).first();
    if ((await item.count()) === 0) break;
    const expiry = item.getByLabel('Expiry on the document', { exact: false });
    if (await expiry.count()) await expiry.fill(daysFromNow(365));
    await command(page, 'Verify', item);
  }
  await expect(page.locator('article, li, tr, section').filter({ hasText: 'Walk Precision' }).filter({ has: page.getByRole('button', { name: 'Verify' }) })).toHaveCount(0);
});

test('ops · a second reviewer admits the supplier, suspends and reinstates it', async ({ page }) => {
  await signInAs(page, 'sourcing2');
  await open(page, recall('newSupplierProfileUrl'));
  await field(page, 'Reason').fill('Evidence verified, capability matches the launch taxonomy.');
  await command(page, 'Approve and admit');
  await expect(visible(page, /^active/)).toBeVisible();
  await field(page, 'Reason').fill('Pausing matching while we audit the CMM calibration.');
  await command(page, 'Suspend from matching');
  await field(page, 'Reason').fill('CMM calibration certificate checked.');
  await command(page, 'Reinstate');
  await expect(visible(page, /^active/)).toBeVisible();
  await axe(page, 'supplier 360 (active)');
  await open(page, `${OPERATIONS}/suppliers`);
  await expect(page.getByRole('link', { name: /Walk Precision/ }).first()).toBeVisible();
  await axe(page, 'supplier directory');
});

test('supplier · pauses new work and starts again; home tiles count its work', async ({ page }) => {
  await signInSupplier(page);
  await open(page, `${PORTAL}/supplier`);
  await field(page, 'Why, and for how long?').fill('Annual maintenance shutdown');
  await field(page, 'Back on').fill(daysFromNow(10));
  await command(page, 'Pause new work');
  await command(page, 'Start taking work again');
  await expect(button(page, 'Pause new work')).toBeVisible();
  await axe(page, 'supplier home (active)');
});

test('supplier · an active supplier sees its bids and orders counted on home', async ({ page }) => {
  // W1: the home tiles count the supplier's own bids and purchase orders (they read 0 before).
  await signInAs(page, 'supplierA');
  await open(page, `${PORTAL}/supplier`);
  for (const tile of ['Bids sent', 'Purchase orders']) {
    await expect(page.getByRole('link', { name: new RegExp(tile, 'i') }).first()).toContainText(/^[1-9]\d*/);
  }
  await axe(page, 'supplier home with work');
});
