import { expect, type Page } from '@playwright/test';
import { PASSWORD, totp } from './api';

/**
 * Signs in with the keyboard only (doc 21 §9): Tab to each field, type, Enter to submit.
 * A pointer is never used, so the path is the one a keyboard user takes.
 */
export async function signIn(page: Page, base: string, email: string, totpSecret?: string): Promise<void> {
  await page.goto(`${base}/login`);
  await page.getByLabel('Email').focus();
  await page.keyboard.type(email);
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Password')).toBeFocused();
  await page.keyboard.type(PASSWORD);
  await page.keyboard.press('Enter');
  if (totpSecret) {
    const code = page.getByLabel('Authentication code');
    await expect(code).toBeVisible();
    await code.focus();
    await page.keyboard.type(totp(totpSecret, email));
    await page.keyboard.press('Enter');
  }
  await expect(page).not.toHaveURL(/\/login/);
}
