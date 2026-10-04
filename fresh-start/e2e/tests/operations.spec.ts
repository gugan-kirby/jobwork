import { expect, test } from '@playwright/test';
import { expectAccessible } from '../support/a11y';
import { OPERATIONS } from '../support/api';
import { signIn } from '../support/session';
import { world } from '../support/world';

/** Doc 21 §9 operations launch journeys: intake, queues, approvals. */
test.describe('operations journeys', () => {
  test('engineering opens the intake queue and an enquiry waiting there', async ({ page }) => {
    const { intakeEnquiryId, intakeReference, secrets } = world();
    await signIn(page, OPERATIONS, 'engineering@jobwork.test', secrets['engineering@jobwork.test']);
    await page.goto(`${OPERATIONS}/intake`);
    await expect(page.getByRole('link', { name: intakeReference }).or(page.getByText(intakeReference)).first()).toBeVisible();
    await expectAccessible(page, 'intake queue');
    await page.goto(`${OPERATIONS}/intake/${intakeEnquiryId}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectAccessible(page, 'intake detail');
  });

  test('sourcing works its queues', async ({ page }) => {
    const { secrets } = world();
    await signIn(page, OPERATIONS, 'sourcing@jobwork.test', secrets['sourcing@jobwork.test']);
    await page.goto(`${OPERATIONS}/queues`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectAccessible(page, 'work queues');
    await page.goto(`${OPERATIONS}/rfqs`);
    await expectAccessible(page, 'RFQ control room');
  });

  test('sales decides a waiting award from the approvals screen', async ({ page }) => {
    const { secrets } = world();
    await signIn(page, OPERATIONS, 'sales@jobwork.test', secrets['sales@jobwork.test']);
    await page.goto(`${OPERATIONS}/approvals`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectAccessible(page, 'approvals');
    // Keyboard only: open the decision panel, read it, approve.
    const decide = page.getByRole('button', { name: 'Decide…' }).first();
    await decide.focus();
    await page.keyboard.press('Enter');
    const approve = page.getByRole('button', { name: 'Approve', exact: true });
    await expect(approve).toBeVisible();
    await expectAccessible(page, 'approval decision panel');
    await approve.focus();
    await page.keyboard.press('Enter');
    // The decided award leaves the waiting list, and the navigation badge drops with it
    // without navigating away.
    await expect(page.getByText('Nothing waiting')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Approvals', exact: true })).toBeVisible();
  });
});
