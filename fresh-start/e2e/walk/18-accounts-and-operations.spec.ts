import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { Client } from 'pg';
import { ApiSession, ok, totp, type Body } from '../support/api';
import { as, capability } from './support/flows';
import { axe, button, command, daysFromNow, expect, field, FIXTURES, noSideways, OPERATIONS, open, PORTAL, recall, remember, signInAs, test, visible } from './support/walk';

/** FW.18 Accounts and operations: a new staff member's two-factor, notifications read on both portals, sessions revoked and ended, a staff sign-out on the portal, dead letters replayed and dismissed, the mail. */
test.describe.configure({ mode: 'serial' });

const STAFF_PASSWORD = 'walk-c18-staff-password-1';
const OWNER_PASSWORD = 'walk-c18-owner-password-1';
const tag = (): string => randomUUID().slice(0, 6);

/** The walk's own database, as the walk config derives it. */
function walkDatabase(): string {
  const url = new URL(process.env.DATABASE_URL ?? 'postgres://localhost:5432/jobwork_dev');
  url.pathname = '/jobwork_e2e';
  return url.toString();
}

/** A password sign-in over the API, answering the code step when the account has one. */
async function apiSignIn(email: string, password: string, secret: string | null, headers: Record<string, string> = {}): Promise<ApiSession> {
  const s = new ApiSession();
  const login = ok(await s.post('/auth/login', { email, password }, headers), 201, `sign in ${email}`);
  if (login['mfaRequired']) ok(await s.post('/auth/mfa', { code: totp(secret!, email) }, headers), 201, `mfa ${email}`);
  return s;
}

const staff = (): { email: string; secret: string | null } => ({ email: recall('c18StaffEmail'), secret: recall<string | null>('c18StaffSecret') });

/** This chapter's own staff member signs in through the console's (or the portal's) sign-in screen. */
async function signInStaff(page: Page, base = OPERATIONS): Promise<void> {
  const { email, secret } = staff();
  await page.goto(`${base}/login`);
  await field(page, 'Email').fill(email);
  await field(page, 'Password').fill(STAFF_PASSWORD);
  await button(page, base === OPERATIONS ? 'Sign in' : 'Login').click();
  if (secret) {
    const code = field(page, 'Authentication code');
    await expect(code).toBeVisible();
    await code.fill(totp(secret, email));
    await button(page, 'Verify').click();
  }
  await expect(page).not.toHaveURL(/\/login/);
}

/** The drawing the chapter's own customer uploads, scanned clean (initiate, PUT, finalize). */
async function ownDrawing(s: ApiSession): Promise<string> {
  const bytes = readFileSync(join(FIXTURES, 'drawing.pdf'));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const key = randomUUID();
  const started = ok(await s.post('/documents/uploads', { purpose: 'drawing_2d', filename: `c18-${key.slice(0, 6)}.pdf`, declaredMediaType: 'application/pdf', byteSize: bytes.length, sha256 }, { 'idempotency-key': key }), 201, 'initiate upload');
  const grant = started['grant'] as { method: string; url: string; headers: Record<string, string> };
  const put = await fetch(grant.url, { method: grant.method, headers: Object.fromEntries(Object.entries(grant.headers).filter(([k]) => k.toLowerCase() !== 'content-length')), body: bytes });
  expect(put.ok, 'the object store takes the upload').toBe(true);
  const done = ok(await s.post(`/documents/uploads/${started['uploadSessionId']}/finalize`, { byteSize: bytes.length, sha256 }, { 'idempotency-key': `${key}:finalize` }), 201, 'finalize upload');
  await expect
    .poll(async () => ((ok(await s.get(`/documents/${done['documentId']}/manifest`), 200, 'manifest')['versions'] as Body[]).find((v) => v['documentVersionId'] === done['documentVersionId']) ?? {})['status'], { timeout: 60_000, message: 'the scan clears the drawing' })
    .toBe('available');
  return done['documentVersionId'] as string;
}

/** The chapter's own customer submits an enquiry; JobWork triages it and asks a question (a notification on each side). */
async function enquiryWithQuestion(s: ApiSession, drawing: string, title: string): Promise<string> {
  const draft = ok(
    await s.post('/enquiries/draft', {
      title,
      applicationNote: 'Holds the pump motor on its skid.',
      requiredByDate: daysFromNow(60),
      items: [
        {
          lineNo: 1,
          partName: 'Bracket',
          description: 'Machined aluminium bracket',
          processCapabilityId: await capability('cnc_milling'),
          materialCapabilityId: await capability('material_aluminium'),
          materialGrade: '6061-T6',
          quantityBreakpoints: [{ quantity: 50, unit: 'piece', kind: 'production' }],
          toleranceClass: 'IT8',
          inspectionLevel: 'dimensional_report',
        },
      ],
      documents: [{ documentVersionId: drawing, role: 'governing', lineNo: 1 }],
    }),
    201,
    'draft enquiry',
  );
  const id = draft['enquiryId'] as string;
  ok(await s.post(`/enquiries/${id}/submit`, { expectedVersion: draft['aggregateVersion'] }), 201, 'submit enquiry');
  const eng = await as('engineering');
  const version = async (): Promise<number> => (ok(await eng.get(`/intake/${id}`), 200, 'intake')['enquiry'] as Body)['aggregateVersion'] as number;
  ok(await eng.post(`/intake/${id}/triage`, { expectedVersion: await version() }), 201, 'triage');
  ok(await eng.post(`/intake/${id}/clarifications`, { expectedVersion: await version(), questions: [{ topic: 'other', question: 'Which surface finish do you need?' }] }), 201, 'ask a question');
  return id;
}

/** Waits until the reader's feed holds an unread notification for every link. */
async function unreadFor(s: ApiSession, links: string[]): Promise<void> {
  await expect
    .poll(async () => {
      const feed = ok(await s.get('/notifications'), 200, 'notifications')['notifications'] as Body[];
      return links.every((l) => feed.some((n) => n['link'] === l && n['readAt'] === null));
    }, { timeout: 30_000, message: 'the worker delivers the notifications' })
    .toBe(true);
}

/** Opens one unread notification from the feed, then marks the rest read. */
async function readNotifications(page: Page, base: string, opened: string, other: string, screen: string): Promise<void> {
  await open(page, `${base}/notifications`);
  const first = page.locator(`a[href="${opened}"]`);
  await expect(first).toContainText('Unread:');
  await expect(page.locator(`a[href="${other}"]`)).toContainText('Unread:');
  await axe(page, `${screen} notifications (unread)`);
  const read = page.waitForResponse((r) => /\/notifications\/[0-9a-f-]{36}\/read$/.test(r.url()) && r.request().method() === 'POST');
  await first.click();
  expect((await read).ok(), 'opening a notification marks it read').toBe(true);
  await expect(page).toHaveURL(new RegExp(`${opened}$`));
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await open(page, `${base}/notifications`);
  await expect(page.locator(`a[href="${opened}"]`)).not.toContainText('Unread:');
  await expect(page.locator(`a[href="${other}"]`)).toContainText('Unread:');
  await command(page, 'Mark all as read');
  await expect(button(page, 'Mark all as read')).toHaveCount(0);
  await expect(page.locator(`a[href="${other}"]`)).not.toContainText('Unread:');
  await expect(page.locator('.jw-notification-unread')).toHaveCount(0);
  await axe(page, `${screen} notifications (all read)`);
}

test('ops · a new staff member turns on two-factor authentication', async ({ page }) => {
  const admin = await as('admin');
  const email = `c18-engineer-${tag()}@jobwork.test`;
  const internal = ok(await admin.get('/auth/me'), 200, 'admin')['organizationId'] as string;
  const invited = ok(await admin.post(`/organizations/${internal}/invitations`, { email, roleKeys: ['jobwork_engineering'] }), 201, 'invite staff');
  const token = new URL(invited['acceptUrl'] as string).searchParams.get('token');
  ok(await new ApiSession().post('/invitations/accept', { token, displayName: 'C18 Engineer', password: STAFF_PASSWORD }), 201, 'accept invitation');
  remember('c18StaffEmail', email);
  remember('c18StaffSecret', null);

  await signInStaff(page);
  await open(page, `${OPERATIONS}/account/security`);
  await axe(page, 'ops security (no second factor)');
  const enrolled = page.waitForResponse((r) => r.url().endsWith('/account/mfa/enroll') && r.request().method() === 'POST');
  await button(page, 'Enable two-factor authentication').click();
  const { secret } = (await (await enrolled).json()) as { secret: string };
  await field(page, 'Code from app').fill(totp(secret, email));
  await axe(page, 'ops security (enrolling)');
  const activated = page.waitForResponse((r) => r.url().endsWith('/account/mfa/activate') && r.request().method() === 'POST');
  await button(page, 'Activate two-factor authentication').click();
  expect((await activated).ok(), 'the code activates two-factor').toBe(true);
  remember('c18StaffSecret', secret);
  await expect(visible(page, 'Recovery codes — shown only now')).toBeVisible();
  await expect(page.getByText(/Enabled/).first()).toBeVisible();
  await expect(button(page, 'Enable two-factor authentication')).toHaveCount(0);
  await axe(page, 'ops security (two-factor on)');
});

test('ops · the staff member opens a notification and marks the rest read', async ({ page }) => {
  const owner = `c18-owner-${tag()}@walk.test`;
  const registered = ok(await new ApiSession().post('/auth/register', { fullName: 'C18 Owner', email: owner, password: OWNER_PASSWORD, organizationName: `C18 Fabrication ${tag()}`, acceptTerms: true }), 201, 'register');
  ok(await new ApiSession().post('/auth/verify-email', { token: new URL(registered['verifyUrl'] as string).searchParams.get('token') }), 201, 'verify email');
  const customer = await apiSignIn(owner, OWNER_PASSWORD, null);
  const drawing = await ownDrawing(customer);
  const enquiries = [await enquiryWithQuestion(customer, drawing, `C18 bracket ${tag()}`), await enquiryWithQuestion(customer, drawing, `C18 cover ${tag()}`)];
  remember('c18Owner', owner);
  remember('c18Enquiries', enquiries);

  const { email, secret } = staff();
  await unreadFor(await apiSignIn(email, STAFF_PASSWORD, secret), enquiries.map((e) => `/intake/${e}`));
  await signInStaff(page);
  await readNotifications(page, OPERATIONS, `/intake/${enquiries[0]}`, `/intake/${enquiries[1]}`, 'ops');
});

test('customer · opens a notification and marks the rest read', async ({ page }) => {
  const owner = recall('c18Owner');
  const enquiries = recall<string[]>('c18Enquiries');
  await unreadFor(await apiSignIn(owner, OWNER_PASSWORD, null), enquiries.map((e) => `/enquiries/${e}`));
  await page.goto(`${PORTAL}/login`);
  await field(page, 'Email').fill(owner);
  await field(page, 'Password').fill(OWNER_PASSWORD);
  await button(page, 'Login').click();
  await expect(page).not.toHaveURL(/\/login/);
  await readNotifications(page, PORTAL, `/enquiries/${enquiries[0]}`, `/enquiries/${enquiries[1]}`, 'customer');
});

test('ops · the staff member revokes a session on another device', async ({ page }) => {
  const { email, secret } = staff();
  const device = `c18-walk-tablet-${tag()}`;
  const other = await apiSignIn(email, STAFF_PASSWORD, secret, { 'user-agent': device });
  expect((await other.get('/auth/me')).status).toBe(200);
  await signInStaff(page);
  await open(page, `${OPERATIONS}/account/security`);
  const row = page.getByRole('row').filter({ hasText: device });
  await expect(row).toBeVisible();
  await axe(page, 'ops security (another device)');
  await command(page, 'Revoke', row);
  await expect(page.getByRole('row').filter({ hasText: device })).toHaveCount(0);
  expect((await other.get('/auth/me')).status, 'the revoked device is signed out').toBe(401);
  await expect(page.getByRole('row').filter({ hasText: 'This device' })).toBeVisible();
});

test('customer · a JobWork staff member on the customer portal is told so and signs out', async ({ page }) => {
  await signInStaff(page, PORTAL);
  await expect(page.getByRole('heading', { level: 1, name: 'You are signed in as JobWork staff' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Orders' })).toHaveCount(0);
  await axe(page, 'portal (JobWork staff session)');
  const out = page.waitForResponse((r) => r.url().endsWith('/auth/logout') && r.request().method() === 'POST');
  await button(page, 'Sign out').click();
  expect((await out).ok(), 'sign-out is accepted').toBe(true);
  await expect(page).toHaveURL(/\/login$/);
  await page.goto(`${PORTAL}/`);
  await expect(page).toHaveURL(/\/welcome$/);
});

test('ops · the staff member signs out everywhere', async ({ page }) => {
  const { email, secret } = staff();
  const other = await apiSignIn(email, STAFF_PASSWORD, secret, { 'user-agent': `c18-walk-laptop-${tag()}` });
  await signInStaff(page);
  await open(page, `${OPERATIONS}/account/security`);
  await command(page, 'Sign out everywhere');
  await expect(page).toHaveURL(/\/login$/);
  expect((await other.get('/auth/me')).status, 'every other session ended too').toBe(401);
  await axe(page, 'ops sign-in (signed out everywhere)');
  await page.goto(`${OPERATIONS}/account/security`);
  await expect(page).toHaveURL(/\/login$/);
});

test('ops · admin replays one event given up on, dismisses another and reads the mail', async ({ page }) => {
  const mark = tag();
  const letters = [
    { type: 'orders.supplier_rated.v1', error: `c18 walk ${mark}: replay me`, verb: 'Replay orders.supplier_rated.v1', after: 'delivered' },
    { type: 'commercial.quote_withdrawn.v1', error: `c18 walk ${mark}: dismiss me`, verb: 'Dismiss — no longer wanted', after: 'dismissed' },
  ];
  // The one row the walk writes directly: a dead letter cannot be made through the API.
  const db = new Client({ connectionString: walkDatabase() });
  await db.connect();
  try {
    const ids: string[] = [];
    for (const l of letters) {
      const res = await db.query<{ id: string }>(
        `INSERT INTO platform.outbox_event (event_type, aggregate_type, aggregate_id, correlation_id, status, attempts, last_error)
         VALUES ($1, 'walk_fixture', $2, $3, 'dead', 8, $4) RETURNING id`,
        [l.type, randomUUID(), `c18-walk-${mark}`, l.error],
      );
      ids.push(res.rows[0]!.id);
    }

    await signInAs(page, 'admin');
    await open(page, `${OPERATIONS}/ops-health`);
    const deadLetters = page.locator('section.jw-card').filter({ has: page.getByRole('heading', { name: 'Events given up on', exact: true }) });
    for (const l of letters) await expect(deadLetters.getByRole('row').filter({ hasText: l.error })).toBeVisible();
    await axe(page, 'platform health (dead letters)');
    for (const [n, l] of letters.entries()) {
      await deadLetters.getByRole('row').filter({ hasText: l.error }).getByRole('button', { name: 'Resolve' }).click();
      await expect(visible(deadLetters, `${l.type}, given up on`)).toBeVisible();
      await expect(button(deadLetters, l.verb)).toBeDisabled();
      await field(deadLetters, 'Why (kept with the decision)').fill(n === 0 ? 'Handler fixed; the rating event can run again.' : 'The quotation was withdrawn long ago; nothing to send.');
      if (n === 0) await axe(page, 'platform health (resolving a dead letter)');
      await command(page, l.verb, deadLetters);
      await expect(page.getByRole('row').filter({ hasText: l.error })).toHaveCount(0);
    }
    await expect
      .poll(async () => (await db.query<{ status: string }>('SELECT status FROM platform.outbox_event WHERE id = ANY($1) ORDER BY array_position($1, id)', [ids])).rows.map((r) => r.status), { timeout: 30_000, message: 'the replay is delivered, the dismissal stays dismissed' })
      .toEqual(letters.map((l) => l.after));
  } finally {
    await db.end();
  }

  await page.getByRole('link', { name: 'Read the mail' }).click();
  await expect(page).toHaveURL(/\/mail$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Mail' })).toBeVisible();
  await expect(visible(page, 'This environment sends no email. Everything it would have sent is kept here, newest first.')).toBeVisible();
  // The walk's worker sends through SMTP, so the box may be empty; a kept message names its addressee.
  await expect(visible(page, 'No mail yet').or(page.getByText(/^To .+ · /).first())).toBeVisible();
  await axe(page, 'mail');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { level: 1, name: 'Mail' })).toBeVisible();
  await noSideways(page, 'mail at 390');
});
