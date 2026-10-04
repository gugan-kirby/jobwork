import { expect, test } from '@playwright/test';
import { expectAccessible } from '../support/a11y';
import { PORTAL } from '../support/api';
import { signIn } from '../support/session';
import { world } from '../support/world';

/** Doc 21 §9 customer launch journeys: sign-in, quotation decision and acceptance, order tracking. */
test.describe('customer journeys', () => {
  test('signs in with the keyboard and lands on an accessible home', async ({ page }) => {
    await signIn(page, PORTAL, 'buyer@kovai.test');
    await expectAccessible(page, 'customer home');
  });

  test('decides on a quotation and accepts it with the keyboard alone', async ({ page }) => {
    const { openQuoteId } = world();
    await signIn(page, PORTAL, 'approver@kovai.test');
    await page.goto(`${PORTAL}/quotations`);
    await expectAccessible(page, 'quotations list');
    await page.goto(`${PORTAL}/quotations/${openQuoteId}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectAccessible(page, 'quotation detail');
    // Nothing of the buy side reaches the customer.
    await expect(page.locator('body')).not.toContainText(/Anand|Balaji/);

    await page.goto(`${PORTAL}/quotations/${openQuoteId}/accept`);
    await expectAccessible(page, 'acceptance');
    const consent = page.getByLabel(/I have read the quotation and the terms/);
    await consent.focus();
    await page.keyboard.press('Space');
    await expect(consent).toBeChecked();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: /accept/i })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByText(/Accepted|order/i).first()).toBeVisible();
  });

  test('follows an order', async ({ page }) => {
    const { orderId } = world();
    await signIn(page, PORTAL, 'approver@kovai.test');
    await page.goto(`${PORTAL}/orders/${orderId}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectAccessible(page, 'order tracking');
    await expect(page.locator('body')).not.toContainText(/Anand|Balaji|PO-/);
  });
});
