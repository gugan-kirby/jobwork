import { expect, test } from '@playwright/test';
import { expectAccessible } from '../support/a11y';
import { PORTAL } from '../support/api';
import { signIn } from '../support/session';
import { world } from '../support/world';

/** Doc 21 §9 supplier launch journeys: the RFQ and the purchase order. */
test.describe('supplier journeys', () => {
  test('opens an invited round and sees the requirement without the customer', async ({ page }) => {
    const { openRfqId } = world();
    await signIn(page, PORTAL, 'estimator@anand.test');
    await page.goto(`${PORTAL}/rfqs`);
    await expectAccessible(page, 'supplier RFQ list');
    await page.goto(`${PORTAL}/rfqs/${openRfqId}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectAccessible(page, 'supplier RFQ detail');
    await expect(page.locator('body')).not.toContainText(/Kovai/);
  });

  test('acknowledges a purchase order with the keyboard alone', async ({ page }) => {
    const { purchaseOrderId } = world();
    await signIn(page, PORTAL, 'estimator@anand.test');
    await page.goto(`${PORTAL}/supplier/orders/${purchaseOrderId}`);
    await expect(page.getByText('To acknowledge')).toBeVisible();
    await expectAccessible(page, 'supplier purchase order');
    await page.getByLabel('Note to JobWork (optional)').focus();
    await page.keyboard.type('Material booked.');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(page.getByText('Acknowledged').first()).toBeVisible();
    await expect(page.locator('body')).not.toContainText(/Kovai/);
  });
});
