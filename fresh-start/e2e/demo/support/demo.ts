import { test as base, expect, type Locator, type Page } from '@playwright/test';
import { PASSWORD, PORTAL } from '../../support/api';

/**
 * The customer demo: the customer portal on a phone, paced for a person to follow. Every tap
 * shows a ring where the finger lands, typing is letter by letter, and each step carries a
 * caption (`say`) that `scripts/demo-video.mjs` burns in above the phone. JobWork's and the
 * suppliers' work happens through the API between scenes, off camera.
 */

export const PHONE = { width: 390, height: 844 };

/** A ring where each tap lands, so a viewer sees what was pressed. */
const TAP_RING = `
  addEventListener('pointerdown', (e) => {
    const r = document.createElement('div');
    r.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;background:rgba(37,99,235,.28);border:3px solid rgba(37,99,235,.85);transition:transform .6s ease-out,opacity .6s ease-out;left:' + e.clientX + 'px;top:' + e.clientY + 'px';
    document.documentElement.appendChild(r);
    requestAnimationFrame(() => { r.style.transform = 'scale(1.6)'; r.style.opacity = '0'; });
    setTimeout(() => r.remove(), 700);
  }, true);
`;

export interface Director {
  /** The caption from now until the next one. */
  say(text: string): void;
}

/** The scene being filmed, so a tap can set the caption for the screen it opens. */
let active: Director | undefined;

export const test = base.extend<{ director: Director }>({
  director: async ({ page }, use, testInfo) => {
    await page.context().addInitScript(TAP_RING);
    const started = Date.now();
    const captions: Array<{ at: number; text: string }> = [];
    active = { say: (text) => captions.push({ at: (Date.now() - started) / 1000, text }) };
    await use(active);
    active = undefined;
    await testInfo.attach('captions', { body: JSON.stringify(captions), contentType: 'application/json' });
  },
});
export { expect };

export const pause = (page: Page, ms = 1200): Promise<void> => page.waitForTimeout(ms);

async function into(page: Page, target: Locator): Promise<void> {
  await expect(target).toBeVisible();
  await target.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  await pause(page, 700);
}

/** Brings the control into view, lets the eye find it, taps it; `then` captions what it opens. */
export async function tap(page: Page, target: Locator, then?: string): Promise<void> {
  await into(page, target);
  await target.click();
  if (then) active?.say(then);
  await pause(page, 900);
}

/** Taps a field and types into it a letter at a time. */
export async function type(page: Page, target: Locator, text: string, delay = 55): Promise<void> {
  await into(page, target);
  await target.click();
  await target.fill('');
  await target.pressSequentially(text, { delay });
  await pause(page, 500);
}

/** Picks the first option whose text matches. */
export async function pick(page: Page, select: Locator, option: RegExp): Promise<void> {
  await into(page, select);
  await expect(select.locator('option').filter({ hasText: option }).first()).toBeAttached();
  const label = (await select.locator('option').allInnerTexts()).find((t) => option.test(t))!;
  await select.selectOption({ label });
  await pause(page, 800);
}

/** Taps a command button and waits for it to finish; `then` captions its outcome. */
export async function run(page: Page, target: Locator, then?: string): Promise<void> {
  await into(page, target);
  await expect(target).toBeEnabled();
  await target.click();
  if (then) active?.say(then);
  await expect(page.locator('[role="status"]').filter({ hasText: /^Working$/ })).toHaveCount(0, { timeout: 30_000 });
  await pause(page, 1500);
}

/** Scrolls slowly to the end of the page and back, so the whole screen is seen. */
export async function read(page: Page, step = 320, dwell = 1100): Promise<void> {
  await pause(page, 1200);
  for (let i = 0; i < 12; i++) {
    const moved = await page.evaluate((dy) => {
      const before = scrollY;
      scrollTo({ top: before + dy, behavior: 'smooth' });
      return document.documentElement.scrollHeight - innerHeight - before > 4;
    }, step);
    if (!moved) break;
    await pause(page, dwell);
  }
  await page.evaluate(() => scrollTo({ top: 0, behavior: 'smooth' }));
  await pause(page, 1000);
}

export const button = (page: Page, name: string | RegExp): Locator =>
  page.getByRole('button', { name, exact: typeof name === 'string' }).filter({ visible: true }).first();
export const link = (page: Page, name: string | RegExp): Locator =>
  page.getByRole('link', { name, exact: typeof name === 'string' }).filter({ visible: true }).first();
export const field = (page: Page, label: string | RegExp): Locator => page.getByLabel(label, { exact: false }).filter({ visible: true }).first();

/** Signs in through the portal's login screen; `then` captions the first screen after it. */
export async function signIn(page: Page, director: Director, email: string, who: string, then?: string): Promise<void> {
  director.say(`${who} signs in to the JobWork app`);
  await page.goto(`${PORTAL}/login`);
  await pause(page, 1500);
  await type(page, field(page, 'Email'), email, 45);
  await type(page, field(page, 'Password'), PASSWORD, 30);
  await tap(page, button(page, 'Login'), then);
  await expect(page).not.toHaveURL(/\/login/);
  await pause(page, 800);
}

export { PORTAL };
