import { expect, type Page, test } from '@playwright/test';
import { expectAccessible } from '../support/a11y';
import { OPERATIONS, PORTAL } from '../support/api';
import { signIn } from '../support/session';
import { world } from '../support/world';

/**
 * TP.5 (IN-18 F-18.4): every settlement and support screen loads at desktop and phone widths, with
 * its heading, no horizontal scroll, and no serious or critical axe violation (doc 21 §9).
 */
const WIDTHS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'phone', width: 390, height: 844 },
];

async function expectScreen(page: Page, url: string, screen: string): Promise<void> {
  await page.goto(url);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const overflow = await page.locator('html').evaluate((html) => html.scrollWidth - html.clientWidth);
  expect(overflow, `${screen} scrolls sideways`).toBeLessThanOrEqual(0);
  // Every primary navigation link that is shown sits inside the viewport (D9).
  const viewport = page.viewportSize()!.width;
  for (const link of await page.getByRole('navigation', { name: 'Primary' }).getByRole('link').filter({ visible: true }).all()) {
    const box = (await link.boundingBox())!;
    expect(box.x + box.width, `${screen}: "${await link.innerText()}" runs off-screen`).toBeLessThanOrEqual(viewport);
  }
  await expectAccessible(page, screen);
}

for (const size of WIDTHS) {
  test.describe(`settlement and support screens (${size.name})`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    test('finance reads the bills and the margin', async ({ page }) => {
      const { secrets } = world();
      await signIn(page, OPERATIONS, 'finance@jobwork.test', secrets['finance@jobwork.test']);
      await expectScreen(page, `${OPERATIONS}/finance/bills`, 'finance bills');
      await expect(page.getByText('AE/E2E-1').filter({ visible: true }).first()).toBeVisible();
      await expectScreen(page, `${OPERATIONS}/finance/margin`, 'margin');
    });

    test('support works the case center and a case', async ({ page }) => {
      const { caseId, secrets } = world();
      await signIn(page, OPERATIONS, 'support@jobwork.test', secrets['support@jobwork.test']);
      await expectScreen(page, `${OPERATIONS}/support`, 'case center');
      await expect(page.getByText('Thread worn on two covers').filter({ visible: true }).first()).toBeVisible();
      await expectScreen(page, `${OPERATIONS}/support/${caseId}`, 'case');
    });

    test('the supplier reads its bills', async ({ page }) => {
      await signIn(page, PORTAL, 'estimator@anand.test');
      await expectScreen(page, `${PORTAL}/supplier/bills`, 'supplier bills');
      await expect(page.getByText('AE/E2E-1').filter({ visible: true }).first()).toBeVisible();
    });

    test('the customer follows its case', async ({ page }) => {
      const { caseId } = world();
      await signIn(page, PORTAL, 'buyer@kovai.test');
      await expectScreen(page, `${PORTAL}/support`, 'customer cases');
      await expect(page.getByText('Thread worn on two covers').filter({ visible: true }).first()).toBeVisible();
      await expectScreen(page, `${PORTAL}/support/${caseId}`, 'customer case');
    });
  });
}
