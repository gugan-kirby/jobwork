import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { ApiSession, type Body, ok } from '../support/api';
import { as } from './support/flows';
import { axe, button, command, expect, field, FIXTURES, OPERATIONS, open, PORTAL, recall, remember, section, signInAs, test, visible } from './support/walk';

/** FW.14 Supplier network alternatives: a resent and a rejected application, a returned and a rejected file, returned evidence, a withdrawn capability, offboarding, leaving, a restored account. */
test.describe.configure({ mode: 'serial' });

const run = Date.now().toString(36).slice(-5);
const PASSWORD = 'walk-14-supplier-password';

/** A supplier this chapter admits, so every destructive step lands on its own organization. */
interface Fresh {
  name: string;
  email: string;
  profileId: string;
  token: string;
}

async function admitted(label: string): Promise<Fresh> {
  const name = `Walk 14 ${label} ${run}`;
  const email = `owner-${randomUUID().slice(0, 8)}@walk14.test`;
  const res = ok(
    await (await as('admin')).post('/suppliers', { legalName: `${name} Private Limited`, displayName: name, regionClass: 'chennai_metro', primaryContactName: 'Walk Fourteen', primaryContactEmail: email, firstUserEmail: email, firstUserRoleKeys: ['org_admin'] }),
    201,
    `admit ${name}`,
  );
  const token = String(res['acceptUrl']).match(/token=([^&"]+)/)?.[1];
  if (!token) throw new Error('dev admission returns no invitation link');
  return { name, email, profileId: res['supplierProfileId'] as string, token: decodeURIComponent(token) };
}

async function signedIn(email: string): Promise<ApiSession> {
  const s = new ApiSession();
  ok(await s.post('/auth/login', { email, password: PASSWORD }), 201, `sign in ${email}`);
  return s;
}

/** The owner accepts the invitation and signs in. */
async function joined(f: Fresh): Promise<ApiSession> {
  ok(await new ApiSession().post('/invitations/accept', { token: f.token, password: PASSWORD, displayName: 'Walk Fourteen' }), 201, 'accept invitation');
  return signedIn(f.email);
}

/** Uploads the fixture as the supplier's own certificate and waits for the scan. */
async function evidence(s: ApiSession): Promise<string> {
  const bytes = readFileSync(join(FIXTURES, 'drawing.pdf'));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const key = randomUUID();
  const started = ok(await s.post('/documents/uploads', { purpose: 'certificate', filename: `evidence-${key.slice(0, 6)}.pdf`, declaredMediaType: 'application/pdf', byteSize: bytes.length, sha256 }, { 'idempotency-key': key }), 201, 'initiate upload');
  const grant = started['grant'] as { method: string; url: string; headers: Record<string, string> };
  const put = await fetch(grant.url, { method: grant.method, headers: Object.fromEntries(Object.entries(grant.headers).filter(([k]) => k.toLowerCase() !== 'content-length')), body: bytes });
  if (!put.ok) throw new Error(`object store refused the upload: ${put.status}`);
  const done = ok(await s.post(`/documents/uploads/${started['uploadSessionId']}/finalize`, { byteSize: bytes.length, sha256 }, { 'idempotency-key': `${key}:finalize` }), 201, 'finalize upload');
  for (let i = 0; i < 60; i++) {
    const versions = ok(await s.get(`/documents/${done['documentId']}/manifest`), 200, 'manifest')['versions'] as Body[];
    if (versions.find((v) => v['documentVersionId'] === done['documentVersionId'])?.['status'] === 'available') return done['documentVersionId'] as string;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('the scan never finished: is the worker running?');
}

async function profileVersion(s: ApiSession): Promise<number> {
  return (ok(await s.get('/suppliers/me'), 200, 'supplier self view')['profile'] as Body)['aggregateVersion'] as number;
}

/** Company, works address, two capabilities and the three mandatory pieces of evidence, then sent for review. */
async function submitted(f: Fresh): Promise<ApiSession> {
  const s = await joined(f);
  ok(
    await s.post('/suppliers/me/profile', {
      expectedVersion: await profileVersion(s),
      tradeName: f.name,
      website: '',
      summary: 'Turned and milled aluminium parts.',
      regionClass: 'chennai_metro',
      yearEstablished: 2012,
      employeeBand: '11-50',
      primaryContactName: 'Walk Fourteen',
      primaryContactEmail: f.email,
      primaryContactPhone: '+91 98400 11111',
    }),
    201,
    'company details',
  );
  ok(await s.post('/suppliers/me/site', { label: 'Works', addressLine1: 'Plot 9, SIDCO Industrial Estate', addressLine2: '', city: 'Chennai', state: 'Tamil Nadu', postalCode: '600098' }), 201, 'works address');
  for (const code of ['cnc_milling', 'material_aluminium']) ok(await s.post('/suppliers/me/capabilities', { capabilityCode: code, attributes: {} }), 201, `capability ${code}`);
  for (const kind of ['gst', 'pan', 'bank_account']) ok(await s.post('/suppliers/me/verification', { kind, evidenceDocumentVersionId: await evidence(s) }), 201, `evidence ${kind}`);
  ok(await s.post('/suppliers/me/submit', { expectedVersion: await profileVersion(s) }), 201, 'send for review');
  return s;
}

/** Sourcing verifies the evidence and a second reviewer admits the supplier. */
async function active(f: Fresh): Promise<void> {
  const sourcing = await as('sourcing');
  const queue = ok(await sourcing.get('/suppliers/verification/queue'), 200, 'evidence queue')['items'] as Body[];
  for (const item of queue.filter((i) => i['supplierProfileId'] === f.profileId)) {
    ok(await sourcing.post(`/suppliers/verification/${item['verificationItemId']}/review`, { decision: 'verify', expiresAt: new Date(Date.now() + 365 * 86_400_000).toISOString() }), 201, 'verify evidence');
  }
  const reviewer = await as('sourcing2');
  const detail = ok(await reviewer.get(`/suppliers/${f.profileId}`), 200, 'supplier');
  ok(await reviewer.post(`/suppliers/${f.profileId}/approve`, { expectedVersion: (detail['profile'] as Body)['aggregateVersion'], reason: 'Evidence verified.' }), 201, 'approve');
}

async function signInFresh(page: Page, email: string): Promise<void> {
  await page.goto(`${PORTAL}/login`);
  await field(page, 'Email').fill(email);
  await field(page, 'Password').fill(PASSWORD);
  await button(page, 'Login').click();
  await expect(page).not.toHaveURL(/\/login/);
}

test('ops · admin resends a supplier’s invitation, then rejects the application it never completed', async ({ page }) => {
  const s = await admitted('Sheet Works');
  await signInAs(page, 'admin');
  await open(page, `${OPERATIONS}/suppliers/${s.profileId}`);
  await command(page, 'Resend', section(page, 'Invitations outstanding').getByRole('row').filter({ hasText: s.email }));
  await expect(visible(page, `A fresh invitation is on its way to ${s.email}.`)).toBeVisible();
  await axe(page, 'supplier 360 (invitation resent)');
  await field(page, /^Reason/).fill('Nobody at the company took the invitation up in three weeks; closing the file.');
  await command(page, 'Reject this application');
  await expect(visible(page, /\brejected — /)).toBeVisible();
  await expect(visible(page, /^Last decision: Nobody at the company took the invitation up/)).toBeVisible();
  await expect(button(page, 'Reject this application')).toHaveCount(0);
  await axe(page, 'supplier 360 (application rejected)');
});

test('ops · sourcing returns a submitted supplier file for changes', async ({ page }) => {
  const s = await admitted('Turned Parts');
  await submitted(s);
  remember('c14Returned', s);
  await signInAs(page, 'sourcing');
  await open(page, `${OPERATIONS}/suppliers/${s.profileId}`);
  await expect(visible(page, 'This file is waiting on a decision')).toBeVisible();
  await axe(page, 'supplier 360 (submitted)');
  await field(page, /^Reason/).fill('Your bank evidence names a different account holder; send the cancelled cheque.');
  await command(page, 'Return for changes');
  await expect(visible(page, /\bonboarding — /)).toBeVisible();
  await expect(visible(page, /^Last decision: Your bank evidence names a different account holder/)).toBeVisible();
  await expect(button(page, 'Approve and admit')).toHaveCount(0);
  await axe(page, 'supplier 360 (returned)');
});

test('ops · sourcing returns a piece of evidence, then rejects the resubmitted file', async ({ page }) => {
  const s = recall<Fresh>('c14Returned');
  const owner = await signedIn(s.email);
  ok(await owner.post('/suppliers/me/submit', { expectedVersion: await profileVersion(owner) }), 201, 'send for review again');
  await signInAs(page, 'sourcing');
  await open(page, `${OPERATIONS}/suppliers/verification`);
  const gst = page.locator('section.jw-card').filter({ has: page.getByRole('link', { name: s.name, exact: true }) }).filter({ hasText: 'gst · version' });
  await expect(gst).toHaveCount(1);
  await expect(button(gst, 'Return for evidence')).toBeDisabled();
  await field(gst, 'Reason').fill('The GST certificate is cut off at the bottom; upload the full page.');
  await command(page, 'Return for evidence', gst);
  await expect(visible(page, `${s.name}: gst returned for evidence.`)).toBeVisible();
  await expect(gst).toHaveCount(0);
  await axe(page, 'evidence queue (returned)');
  await open(page, `${OPERATIONS}/suppliers/${s.profileId}`);
  await expect(section(page, 'Evidence').getByRole('row').filter({ hasText: /^gst/ })).toContainText('returned for evidence');
  await field(page, /^Reason/).fill('The GST registration could not be verified; we cannot admit the company as it stands.');
  await command(page, 'Reject');
  await expect(visible(page, /\brejected — /)).toBeVisible();
  await expect(visible(page, /^Last decision: The GST registration could not be verified/)).toBeVisible();
  await axe(page, 'supplier 360 (file rejected)');
});

test('supplier · an admitted supplier uploads a document and stops offering a capability', async ({ page }) => {
  const s = await admitted('Precision Mills');
  await submitted(s);
  await active(s);
  remember('c14Active', s);
  await signInFresh(page, s.email);
  await open(page, `${PORTAL}/documents`);
  await page.getByLabel('What are you uploading?', { exact: false }).selectOption({ label: 'certificate' });
  await page.getByLabel(/^Upload File — Certificate/).setInputFiles(join(FIXTURES, 'drawing.pdf'));
  await expect(visible(page, 'Upload complete and scanned clean.')).toBeVisible({ timeout: 60_000 });
  const card = section(page, /^drawing$/);
  await expect(card).toContainText('certificate · confidential');
  await expect(card.getByRole('row').filter({ hasText: 'drawing.pdf' })).toContainText('Ready');
  await expect(button(card, 'Download')).toBeEnabled();
  await axe(page, 'supplier documents (uploaded)');

  await open(page, `${PORTAL}/capabilities`);
  const milling = page.locator('li').filter({ hasText: /CNC milling/i }).filter({ has: page.getByRole('button', { name: 'Stop offering' }) });
  await expect(milling).toHaveCount(1);
  await command(page, 'Stop offering', milling);
  await expect(visible(page, /withdrawn\. JobWork stops matching you for it; past versions stay\.$/)).toBeVisible();
  await expect(milling).toHaveCount(0);
  await axe(page, 'capabilities (one withdrawn)');
});

test('ops · sourcing offboards a supplier from the network', async ({ page }) => {
  const s = recall<Fresh>('c14Active');
  await signInAs(page, 'sourcing');
  await open(page, `${OPERATIONS}/suppliers/${s.profileId}`);
  await expect(visible(page, /\bactive — /)).toBeVisible();
  await field(page, /^Reason/).fill('Late on three orders running; leaving the network by agreement.');
  await command(page, 'Offboard from the network');
  await expect(visible(page, `${s.name} has left the network.`)).toBeVisible();
  await expect(visible(page, /\bexited — /)).toBeVisible();
  await expect(button(page, 'Offboard from the network')).toHaveCount(0);
  await axe(page, 'supplier 360 (offboarded)');
});

test('supplier · a supplier that changed its mind leaves the network', async ({ page }) => {
  const s = await admitted('Second Thoughts');
  await joined(s);
  await signInFresh(page, s.email);
  await open(page, `${PORTAL}/supplier`);
  await button(page, 'I want to leave').click();
  await expect(button(page, 'Leave the network')).toBeDisabled();
  await field(page, /to confirm$/).fill(s.name);
  await field(page, 'Anything you want us to know?').fill('We are staying with our own customers for now.');
  await axe(page, 'supplier home (leaving)');
  await command(page, 'Leave the network');
  await expect(visible(page, 'Left the network')).toBeVisible();
  await expect(visible(page, 'This account is no longer part of the supplier network.')).toBeVisible();
  await expect(button(page, 'I want to leave')).toHaveCount(0);
  await axe(page, 'supplier home (left the network)');
});

test('ops · admin restores a suspended account in a customer organization', async ({ page }) => {
  const admin = await as('admin');
  const name = `Walk 14 Castings ${run}`;
  const email = `buyer-${randomUUID().slice(0, 8)}@walk14.test`;
  const org = ok(await admin.post('/admin/organizations', { type: 'customer', legalName: `${name} Private Limited`, displayName: name, firstUserEmail: email, firstUserRoleKeys: ['org_admin'] }), 201, 'customer organization');
  const token = decodeURIComponent(String(org['acceptUrl']).match(/token=([^&"]+)/)![1]!);
  ok(await new ApiSession().post('/invitations/accept', { token, password: PASSWORD, displayName: 'Walk Fourteen Buyer' }), 201, 'accept invitation');
  const members = ok(await admin.get(`/admin/organizations/${org['organizationId']}`), 200, 'organization')['members'] as Body[];
  const userId = members.find((m) => m['email'] === email)!['userId'] as string;
  // The console suspends memberships only; a whole account is suspended through the API.
  ok(await admin.post(`/admin/users/${userId}/suspend`, { reason: 'Password seen in a shared spreadsheet.' }), 201, 'suspend account');
  await signInAs(page, 'admin');
  await open(page, `${OPERATIONS}/organizations/${org['organizationId']}`);
  const row = section(page, 'People').getByRole('row').filter({ hasText: email });
  await expect(row).toContainText('suspended');
  await axe(page, 'organization (account suspended)');
  await field(page, 'Reason for suspending or reinstating').fill('Password reset and the spreadsheet deleted.');
  await command(page, 'Restore account', row);
  await expect(visible(page, `${email}'s account is active again.`)).toBeVisible();
  await expect(row).not.toContainText('suspended');
  await expect(button(row, 'Restore account')).toHaveCount(0);
  await axe(page, 'organization (account restored)');
});
