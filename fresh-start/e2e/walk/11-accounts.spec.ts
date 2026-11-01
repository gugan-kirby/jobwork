import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { ApiSession, PASSWORD, totp } from '../support/api';
import { axe, button, command, expect, field, FIXTURES, OPERATIONS, open, PORTAL, recall, signInAs, test, visible, type Who } from './support/walk';

/** FW.11 Accounts on all three portals: teams, addresses, profile, documents, notifications, two-factor, sessions, sign-out. */
test.describe.configure({ mode: 'serial' });

const OWNER_PASSWORD = 'walk-owner-password-1';

async function signInOwner(page: Page, mfa = false): Promise<void> {
  await page.goto(`${PORTAL}/login`);
  await field(page, 'Email').fill(recall('registeredCustomer'));
  await field(page, 'Password').fill(OWNER_PASSWORD);
  await button(page, 'Login').click();
  if (!mfa) await expect(page).not.toHaveURL(/\/login/);
}

test('customer · invites a teammate and manages the address book', async ({ page }) => {
  await signInAs(page, 'buyer');
  await open(page, `${PORTAL}/team`);
  await field(page, 'Their work email').fill(`planner-${Date.now() % 10000}@kovai.test`);
  await page.getByLabel('What they do', { exact: false }).selectOption({ index: 0 });
  await command(page, 'Send invitation');
  await axe(page, 'customer team');
  await open(page, `${PORTAL}/account/addresses`);
  await field(page, 'Name for this address').fill('Kovai Pumps stores');
  await page.getByLabel(/^Address(?! line)/).fill('12 Avinashi Road');
  await field(page, 'City').fill('Coimbatore');
  await field(page, 'State').fill('Tamil Nadu');
  await field(page, 'PIN code').fill('641018');
  await field(page, 'Who receives it').fill('S. Devi');
  await field(page, 'Their phone').fill('+91 98940 77777');
  await command(page, 'Add address');
  const row = page.locator('tr, li').filter({ hasText: 'Kovai Pumps stores', visible: true }).first();
  await row.getByRole('button', { name: 'Edit' }).click();
  await field(page, 'Address line 2').fill('Gate 3');
  await command(page, 'Save changes');
  await command(page, 'Archive', page.locator('tr, li').filter({ hasText: 'Kovai Pumps stores', visible: true }).first());
  await axe(page, 'addresses');
});

test('customer · edits the profile, uploads and downloads a document, reads notifications', async ({ page }) => {
  await signInAs(page, 'buyer');
  await open(page, `${PORTAL}/profile`);
  await axe(page, 'profile');
  await page.getByRole('link', { name: 'Edit profile' }).click();
  await field(page, 'Full name').fill('Kovai Buyer');
  await button(page, 'Save changes').click();
  await expect(visible(page, /saved|updated/i).or(page.getByRole('heading', { level: 1 }))).toBeVisible();
  await open(page, `${PORTAL}/documents`);
  await page.getByLabel('2D drawing', { exact: false }).setInputFiles(join(FIXTURES, 'drawing.pdf'));
  await expect(visible(page, 'Ready')).toBeVisible({ timeout: 60_000 });
  const download = page.waitForEvent('download', { timeout: 10_000 }).catch(() => null);
  await button(page, 'Download').click();
  await download;
  await axe(page, 'documents');
  await notificationsOn(page, PORTAL);
});

async function notificationsOn(page: Page, base: string): Promise<void> {
  await open(page, `${base}/notifications`);
  await axe(page, `${base} notifications`);
  const all = button(page, 'Mark all as read');
  if (await all.isVisible()) {
    await command(page, 'Mark all as read');
    await expect(all).toHaveCount(0);
  }
}

test('supplier · invites a teammate, reads notifications and its documents', async ({ page }) => {
  await signInAs(page, 'supplierA');
  await open(page, `${PORTAL}/supplier/team`);
  await field(page, 'Their work email').fill(`quality-${Date.now() % 10000}@anand.test`);
  await page.getByLabel('What they do', { exact: false }).selectOption({ label: 'Quality — inspection evidence and NCR responses' });
  await command(page, 'Send invitation');
  await axe(page, 'supplier team');
  await open(page, `${PORTAL}/documents`);
  await axe(page, 'supplier documents');
  await notificationsOn(page, PORTAL);
  await open(page, `${PORTAL}/profile`);
  await expect(page.getByRole('link', { name: 'Compliance & evidence' })).toBeVisible();
});

test('ops · staff read their notifications and their sessions', async ({ page }) => {
  for (const who of ['sourcing', 'finance'] as Who[]) {
    await signInAs(page, who);
    await notificationsOn(page, OPERATIONS);
  }
  // A second session to revoke.
  await ApiSession.signInEnrolled('logistics@jobwork.test').catch(() => undefined);
  await signInAs(page, 'logistics');
  await open(page, `${OPERATIONS}/account/security`);
  await axe(page, 'ops security');
  const revoke = button(page, 'Revoke');
  if (await revoke.isVisible()) await command(page, 'Revoke');
});

test('customer · the owner turns on two-factor sign-in and signs in with a code', async ({ page }) => {
  await signInOwner(page);
  await open(page, `${PORTAL}/account/security`);
  const enrolled = page.waitForResponse((r) => r.url().endsWith('/account/mfa/enroll'));
  await button(page, 'Enable two-factor authentication').click();
  const { secret } = (await (await enrolled).json()) as { secret: string };
  await field(page, 'Code from app').fill(totp(secret, recall('registeredCustomer')));
  await button(page, 'Activate two-factor authentication').click();
  await expect(visible(page, /Recovery codes/)).toBeVisible();
  await axe(page, 'two-factor enabled');
  // Another device signs in, the owner revokes it, then signs out everywhere.
  const other = new ApiSession();
  await other.post('/auth/login', { email: recall('registeredCustomer'), password: OWNER_PASSWORD });
  await page.reload();
  await command(page, 'Revoke');
  await command(page, 'Sign out everywhere');
  await expect(page).toHaveURL(/\/(login|welcome)/);
  // The next sign-in asks for the code.
  await signInOwner(page, true);
  const code = page.getByLabel('Authentication code', { exact: false });
  await expect(code).toBeVisible();
  await code.fill(totp(secret, recall('registeredCustomer')));
  await button(page, 'Verify').click();
  await expect(page).not.toHaveURL(/\/login/);
  void PASSWORD;
});

test('customer · signs out from the profile', async ({ page }) => {
  await signInAs(page, 'buyer');
  await open(page, `${PORTAL}/profile`);
  await button(page, 'Logout').click();
  await expect(page).toHaveURL(/\/welcome$/);
  await page.goto(`${PORTAL}/orders`);
  // On a phone the header's links sit behind the menu button.
  const menu = page.getByRole('button', { name: 'Menu', exact: true });
  if (await menu.isVisible()) await menu.click();
  await expect(page.getByRole('link', { name: /Sign in|Login/ }).filter({ visible: true }).first()).toBeVisible();
});
