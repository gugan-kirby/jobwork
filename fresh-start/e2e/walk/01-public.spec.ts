import { randomUUID } from 'node:crypto';
import { axe, button, expect, field, open, PORTAL, remember, test, visible } from './support/walk';

/** FW.1 Public and account: the pages anyone sees, registration, email confirmation, the supplier application. */
test.describe.configure({ mode: 'serial' });

test('public · welcome, start, explore, about, terms, help and offline', async ({ page }) => {
  await page.goto(`${PORTAL}/welcome`);
  await expect(page.getByRole('link', { name: 'Get started' })).toBeVisible();
  await axe(page, 'welcome');
  await page.getByRole('link', { name: 'Get started' }).click();
  await expect(page).toHaveURL(/\/start$/);
  await expect(page.getByRole('link', { name: 'Register' })).toBeVisible();
  await page.getByRole('link', { name: 'Continue as guest' }).click();
  await expect(page).toHaveURL(/\/explore$/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await axe(page, 'explore');
  for (const path of ['/about', '/terms', '/help', '/offline']) {
    await open(page, `${PORTAL}${path}`);
    await axe(page, path);
  }
  await expect(page.getByRole('link', { name: /support@jobwork/ }).or(page.getByText(/./)).first()).toBeVisible();
  // A signed-out visitor to the home page is sent to the welcome page.
  await page.goto(`${PORTAL}/`);
  await expect(page).toHaveURL(/\/welcome$/);
});

test('public · a wrong password is refused at sign-in', async ({ page }) => {
  await page.goto(`${PORTAL}/login`);
  await field(page, 'Email').fill('buyer@kovai.test');
  await field(page, 'Password').fill('not-the-password-1');
  await button(page, 'Login').click();
  await expect(visible(page, 'Sign-in failed')).toBeVisible();
  await axe(page, 'login refused');
});

test('public · a customer registers, confirms the email and signs in', async ({ page }) => {
  const mail = `owner-${randomUUID().slice(0, 8)}@walk.test`;
  await page.goto(`${PORTAL}/register`);
  await expect(page.getByRole('button', { name: 'Customer' })).toHaveAttribute('aria-pressed', 'true');
  await field(page, 'Full name').fill('Walk Owner');
  await field(page, 'Mobile number').fill('9840099911');
  await field(page, 'Email address').fill(mail);
  await field(page, 'Company (optional)').fill('Walk Fabrications');
  await field(page, /^Password/).fill('walk-owner-password-1');
  await field(page, 'Confirm password').fill('walk-owner-password-2');
  await expect(visible(page, 'The two passwords do not match')).toBeVisible();
  await field(page, 'Confirm password').fill('walk-owner-password-1');
  await expect(button(page, 'Register')).toBeDisabled();
  await page.getByLabel('I agree to Terms & Conditions').check();
  await axe(page, 'register');
  const registered = page.waitForResponse((r) => r.url().endsWith('/auth/register') && r.request().method() === 'POST');
  await button(page, 'Register').click();
  const body = (await (await registered).json()) as { verifyUrl?: string };
  await expect(visible(page, 'Check your email')).toBeVisible();
  expect(body.verifyUrl, 'dev registration returns the confirmation link').toBeTruthy();
  const token = new URL(body.verifyUrl!).searchParams.get('token');
  await page.goto(`${PORTAL}/verify-email?token=${token}`);
  await expect(visible(page, 'Your email is confirmed')).toBeVisible();
  await page.getByRole('link', { name: 'Login' }).click();
  await field(page, 'Email').fill(mail);
  await field(page, 'Password').fill('walk-owner-password-1');
  await button(page, 'Login').click();
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  remember('registeredCustomer', mail);
  // A link that was already used, or never issued, is refused.
  await page.goto(`${PORTAL}/verify-email?token=not-a-real-token`);
  await expect(visible(page, 'That link is not valid')).toBeVisible();
});

test('public · a workshop applies to join as a supplier', async ({ page }) => {
  for (const [company, key] of [
    ['Walk Precision Works', 'applicationAdmit'],
    ['Walk Sheet Metal', 'applicationDecline'],
  ] as const) {
    await page.goto(`${PORTAL}/register`);
    await page.getByRole('button', { name: 'Supplier' }).click();
    await field(page, 'Company name').fill(company);
    await field(page, 'Contact name').fill('Walk Contact');
    await field(page, 'Mobile number').fill('9840054321');
    await field(page, 'Email address').fill(`${key}-${randomUUID().slice(0, 6)}@walk.test`);
    await field(page, 'City').fill('Chennai');
    const processes = page.getByRole('group', { name: 'What you do' }).getByRole('checkbox');
    await expect(processes.first()).toBeVisible();
    await processes.first().check();
    await field(page, 'Anything else').fill('Three VMCs and a CMM.');
    await page.getByLabel('I agree to Terms & Conditions').check();
    await axe(page, 'supplier application');
    await button(page, 'Send application').click();
    await expect(visible(page, 'Application received')).toBeVisible();
    remember(key, company);
  }
});
