import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { test as base, expect, type Locator, type Page } from '@playwright/test';
import { ApiSession, OPERATIONS, ok, PASSWORD, PORTAL, totp } from '../../support/api';
import { world } from '../../support/world';

/**
 * FW.0: the full portal walk's shared harness. Every test is one actor on one portal, so the
 * recorded clips stitch into one video per portal (`scripts/stitch-videos.mjs`), and the
 * test title is the chapter caption burned into the video.
 */

export const STAFF_FILE = join(__dirname, '..', '..', '.state', 'walk-staff.json');
const STORY_FILE = join(__dirname, '..', '..', '.state', 'walk-story.json');

export type Who =
  | 'buyer'
  | 'approver'
  | 'supplierA'
  | 'supplierB'
  | 'engineering'
  | 'sourcing'
  | 'sourcing2'
  | 'sales'
  | 'sales2'
  | 'finance'
  | 'finance2'
  | 'quality'
  | 'quality2'
  | 'logistics'
  | 'support'
  | 'admin';

const EMAIL: Record<Who, string> = {
  buyer: 'buyer@kovai.test',
  approver: 'approver@kovai.test',
  supplierA: 'estimator@anand.test',
  supplierB: 'estimator@balaji.test',
  engineering: 'engineering@jobwork.test',
  sourcing: 'sourcing@jobwork.test',
  sourcing2: 'sourcing2@jobwork.test',
  sales: 'sales@jobwork.test',
  sales2: 'sales2@jobwork.test',
  finance: 'finance@jobwork.test',
  finance2: 'finance2@jobwork.test',
  quality: 'quality@jobwork.test',
  quality2: 'quality2@jobwork.test',
  logistics: 'logistics@jobwork.test',
  support: 'support@jobwork.test',
  admin: 'admin@jobwork.test',
};

export const email = (who: Who): string => EMAIL[who];
export const internal = (who: Who): boolean => EMAIL[who].endsWith('@jobwork.test');
export const portalOf = (who: Who): string => (internal(who) ? OPERATIONS : PORTAL);

export function secrets(): Record<string, string> {
  const staff = existsSync(STAFF_FILE) ? (JSON.parse(readFileSync(STAFF_FILE, 'utf8')) as Record<string, string>) : {};
  return { ...world().secrets, ...staff };
}

/** A value one chapter leaves for a later one (ids the storyline built). */
export function remember(key: string, value: unknown): void {
  const story = existsSync(STORY_FILE) ? (JSON.parse(readFileSync(STORY_FILE, 'utf8')) as Record<string, unknown>) : {};
  story[key] = value;
  writeFileSync(STORY_FILE, JSON.stringify(story, null, 2), { mode: 0o600 });
}

export function recall<T = string>(key: string): T {
  const story = existsSync(STORY_FILE) ? (JSON.parse(readFileSync(STORY_FILE, 'utf8')) as Record<string, unknown>) : {};
  if (!(key in story)) throw new Error(`the walk has no "${key}" yet: run the chapter that makes it first`);
  return story[key] as T;
}

/** An API session for setting up a chapter's preconditions; JobWork staff sign in with TOTP. */
export async function apiAs(who: Who): Promise<ApiSession> {
  const s = new ApiSession();
  const login = ok(await s.post('/auth/login', { email: EMAIL[who], password: PASSWORD }), 201, `sign in ${who}`);
  if (login['mfaRequired']) {
    const secret = secrets()[EMAIL[who]];
    if (!secret) throw new Error(`${who} has no TOTP secret in the walk state`);
    ok(await s.post('/auth/mfa', { code: totp(secret, EMAIL[who]) }), 201, `mfa ${who}`);
  }
  return s;
}

const IGNORED_CONSOLE = [
  // A refused API call is the product working (deny by default); the guard watches 5xx instead.
  /Failed to load resource: the server responded with a status of 4\d\d/,
  /the server responded with a status of 4\d\d/,
];

/**
 * Every walk test gets `guard`: uncaught page errors, console errors and API 5xx responses
 * fail the test at its end, with the list, so a broken screen cannot pass by looking right.
 */
/**
 * FW_MOBILE=1 records the customer's side of the walk on a phone (390 × 844, touch), for the
 * client cut `walk:videos` makes in that mode; JobWork staff and suppliers stay on desktop.
 */
const MOBILE = process.env.FW_MOBILE === '1';
const onPhone = (title: string): boolean => MOBILE && /^(customer|public) ·/.test(title);

export const test = base.extend<{ guard: string[] }>({
  viewport: async ({ viewport }, use, testInfo) => use(onPhone(testInfo.title) ? { width: 390, height: 844 } : viewport),
  isMobile: async ({ isMobile }, use, testInfo) => use(onPhone(testInfo.title) || isMobile),
  hasTouch: async ({ hasTouch }, use, testInfo) => use(onPhone(testInfo.title) || hasTouch),
  deviceScaleFactor: async ({ deviceScaleFactor }, use, testInfo) => use(onPhone(testInfo.title) ? 2 : deviceScaleFactor),
  guard: [
    async ({ page }, use, testInfo) => {
      const problems: string[] = [];
      page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
      page.on('console', (m) => {
        if (m.type() !== 'error') return;
        const text = m.text();
        if (IGNORED_CONSOLE.some((r) => r.test(text))) return;
        problems.push(`console error on ${page.url()}: ${text.slice(0, 300)}`);
      });
      page.on('response', (r) => {
        if (r.status() >= 500) problems.push(`HTTP ${r.status()} ${r.request().method()} ${r.url()}`);
      });
      await use(problems);
      if (testInfo.status === testInfo.expectedStatus) expect(problems, 'the walk saw errors on screen or from the API').toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };

/** Signs in through the login screen; JobWork staff answer the TOTP step. */
export async function signInAs(page: Page, who: Who): Promise<void> {
  const baseUrl = portalOf(who);
  await page.goto(`${baseUrl}/login`);
  await page.getByLabel('Email', { exact: false }).first().fill(EMAIL[who]);
  await page.getByLabel('Password', { exact: false }).first().fill(PASSWORD);
  await page.getByRole('button', { name: internal(who) ? 'Sign in' : 'Login', exact: true }).click();
  if (internal(who)) {
    const code = page.getByLabel('Authentication code', { exact: false });
    await expect(code).toBeVisible();
    await code.fill(totp(secrets()[EMAIL[who]]!, EMAIL[who]));
    await page.getByRole('button', { name: 'Verify', exact: true }).click();
  }
  await expect(page).not.toHaveURL(/\/login/);
}

export async function noSideways(page: Page, screen: string): Promise<void> {
  const overflow = await page.locator('html').evaluate((h) => h.scrollWidth - h.clientWidth);
  expect(overflow, `${screen} scrolls sideways`).toBeLessThanOrEqual(0);
}

export async function axe(page: Page, screen: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const blocking = results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.impact} ${v.id}: ${v.help} (${v.nodes[0]?.target.join(' ') ?? ''})`);
  expect(blocking, `${screen} has serious or critical accessibility violations`).toEqual([]);
}

/**
 * Opens a screen and checks it rendered: a heading, no error boundary, no failed-load alert,
 * no sideways scroll. `allowAlert` is for screens whose refusal is the expected outcome.
 */
export async function open(page: Page, url: string, opts: { allowAlert?: boolean; heading?: string | RegExp } = {}): Promise<void> {
  await page.goto(url);
  const h1 = page.getByRole('heading', { level: 1 }).first();
  await expect(h1).toBeVisible();
  if (opts.heading) await expect(h1).toContainText(opts.heading);
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
  await expect(page.getByText(/^(Something went wrong|That page does not exist|We could not show this page)$/)).toHaveCount(0);
  if (!opts.allowAlert) {
    const texts = await errorAlerts(page).allInnerTexts();
    expect(texts.filter((t) => t.trim() !== ''), `${url} shows an error`).toEqual([]);
  }
  await noSideways(page, url);
}

/** Visible alerts, without Next's route announcer (it reads the new page's title as an alert). */
export const errorAlerts = (page: Page): Locator => page.locator('[role="alert"]:not(#__next-route-announcer__)').filter({ visible: true });

export const button = (scope: Page | Locator, name: string | RegExp): Locator =>
  scope.getByRole('button', { name, exact: typeof name === 'string' }).filter({ visible: true }).first();
export const field = (scope: Page | Locator, label: string | RegExp): Locator =>
  scope.getByLabel(label, { exact: false }).filter({ visible: true }).first();
export const visible = (scope: Page | Locator, text: string | RegExp): Locator => scope.getByText(text).filter({ visible: true }).first();

/** Clicks a command and waits for it to settle without an error alert. */
export async function command(page: Page, name: string | RegExp, scope: Page | Locator = page): Promise<void> {
  const b = button(scope, name);
  await expect(b).toBeEnabled();
  // The load state is long reached, so wait for the command's own request and for the
  // button to stop working before reading alerts; otherwise a refusal is missed.
  const answered = page.waitForResponse((r) => r.request().method() !== 'GET' && r.url().includes('/api/v1/'), { timeout: 15_000 }).catch(() => null);
  await b.click();
  await answered;
  await expect(page.locator('[role="status"]').filter({ hasText: /^Working$/ })).toHaveCount(0, { timeout: 30_000 });
  await page.waitForTimeout(250);
  const alerts = (await errorAlerts(page).allInnerTexts()).filter((t) => t.trim() !== '');
  expect(alerts, `"${String(name)}" failed`).toEqual([]);
}

/** A card or section found by its heading text. */
export const section = (page: Page, heading: string | RegExp): Locator =>
  page.locator('section, article, [class*="card"]:not(.jw-card-head):not(.jw-card-body), fieldset, details').filter({ has: page.getByRole('heading', { name: heading }) }).last();

/** Order Tracking keeps deliveries, payments, changes and messages behind Order Details (VF-18). */
export async function showOrderDetails(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Order Details', exact: true }).click();
}

export const FIXTURES = join(__dirname, '..', 'fixtures');
export const daysFromNow = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
export { OPERATIONS, PORTAL };

/** Picks the first option of a select whose text matches. */
export async function choose(select: Locator, option: RegExp): Promise<string> {
  await expect(select.locator('option').filter({ hasText: option }).first()).toBeAttached();
  const label = (await select.locator('option').allInnerTexts()).find((t) => option.test(t))!;
  await select.selectOption({ label });
  return label;
}

/** Opens a <details> section by its summary text. */
export async function expand(page: Page, summary: string): Promise<Locator> {
  const details = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: summary }) }).filter({ visible: true }).first();
  if ((await details.getAttribute('open')) === null) await details.locator('summary').first().click();
  return details;
}

/** A `datetime-local` value in the browser's own zone, `offsetMs` from now (minute precision). */
export async function localStamp(page: Page, offsetMs = 0): Promise<string> {
  return page.evaluate((offset) => {
    const d = new Date(Date.now() + offset);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }, offsetMs);
}

/** Waits for the next minute and returns it: a stamp after anything already recorded, never in the future. */
export async function freshMinute(page: Page): Promise<string> {
  const ms = await page.evaluate(() => 60_000 - (Date.now() % 60_000) + 500);
  await page.waitForTimeout(ms);
  return localStamp(page);
}
