import { expect, type Locator, test } from '@playwright/test';
import { join } from 'node:path';
import { expectAccessible } from '../support/a11y';
import { PORTAL } from '../support/api';
import { signIn } from '../support/session';

/** Picks the first option whose visible text matches, as a person reading the list would. */
async function choose(select: Locator, text: RegExp): Promise<void> {
  const options = await select.locator('option').allTextContents();
  const label = options.find((o) => text.test(o));
  if (!label) throw new Error(`no option matching ${text} in [${options.join(', ')}]`);
  await select.selectOption({ label });
}

/** Doc 21 §9 customer launch journey: the enquiry wizard, from blank to submitted. */
test('raises an enquiry through the wizard, every stage accessible', async ({ page }) => {
  await signIn(page, PORTAL, 'buyer@kovai.test');
  await page.goto(`${PORTAL}/enquiries/new`);

  // Details
  await page.getByLabel('Part / job name').fill('Impeller housing');
  await choose(page.getByLabel('Category', { exact: true }), /machin|mill/i);
  await choose(page.getByLabel('Sub category'), /mill/i);
  await choose(page.getByLabel('Material', { exact: true }), /alumin/i);
  await page.getByRole('spinbutton', { name: /^Quantity/ }).fill('250');
  // The saved locations arrive after the form does.
  await expect(page.getByRole('option', { name: / — / }).first()).toBeAttached();
  await choose(page.getByLabel('Delivery Location'), / — /);
  await expectAccessible(page, 'enquiry wizard: details');
  await page.getByRole('button', { name: 'Next' }).click();

  // Requirements
  await page.getByLabel(/Upload File/).setInputFiles(join(__dirname, '..', 'walk', 'fixtures', 'drawing.pdf'));
  await expect(page.getByText('Scanned clean and attached to this enquiry.')).toBeVisible({ timeout: 60_000 });
  await choose(page.getByLabel('Tolerance'), /0\.1 mm/);
  await expectAccessible(page, 'enquiry wizard: requirements');
  await page.getByRole('button', { name: 'Next' }).click();

  // Review and submit
  await expect(page.getByRole('button', { name: 'Submit Enquiry' })).toBeVisible();
  await expectAccessible(page, 'enquiry wizard: review');
  await page.getByRole('button', { name: 'Submit Enquiry' }).click();
  await expect(page.getByText(/ENQ-\d{4}-\d{4}/).first()).toBeVisible();
});
