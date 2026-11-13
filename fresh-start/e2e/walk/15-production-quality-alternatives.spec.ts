import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { ok, type Body } from '../support/api';
import { as, baselined, calibratedGauge, inspected, orderedDeal, qualityPlan, supplierProduction, upload, workPackage, type Deal } from './support/flows';
import { axe, button, choose, command, daysFromNow, expand, expect, field, FIXTURES, OPERATIONS, open, PORTAL, recall, remember, signInAs, test, visible } from './support/walk';

/** FW.15 Production and quality, the other branches: replan, returned evidence, plan revision, calibration dispositions, a reviewer's correction, invalidation, a withdrawn deviation, a rejected lot, a returned corrective action. */
test.describe.configure({ mode: 'serial' });

/** This run's ids: kept in memory first (the story file is shared by chapters running side by side), and in the story for `-g` reruns. */
const run: Record<string, unknown> = {};
const keep = (key: string, value: unknown): void => {
  run[key] = value;
  remember(`c15${key}`, value);
};
const get = <T = string>(key: string): T => (key in run ? (run[key] as T) : recall<T>(`c15${key}`));

const supplierInspection = async (id: string): Promise<Body> => ok(await (await as('supplierA')).get(`/supplier/inspections/${id}`), 200, 'supplier inspection');
const ncr = async (id: string): Promise<Body> => ok(await (await as('quality')).get(`/ncrs/${id}`), 200, 'NCR');

/** A status chip by its label: the chip reads "<mark><label> — <tone>". */
const chip = (scope: Page | Locator, label: string): Locator => scope.getByText(new RegExp(`^.?${label} — `)).filter({ visible: true }).first();

/** One cell of the review grid: the characteristic's row, sample `n` (the first cell holds the limits). */
const cell = (page: Page, characteristic: RegExp, n: number): Locator =>
  page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: characteristic }) }).getByRole('cell').nth(n);

test('ops · engineering replans the work package before its release', async ({ page }) => {
  const stamp = Date.now().toString(36);
  const deal = await orderedDeal(`Walk C15 replan ${stamp}`);
  await baselined(deal);
  ok(await (await as('sourcing')).post(`/purchase-orders/${deal.purchaseOrderId}/work-package`, { plannedStart: daysFromNow(1), plannedFinish: daysFromNow(21) }), 201, 'plan work package');
  keep('stamp', stamp);
  keep('deal', deal);

  await signInAs(page, 'engineering');
  await open(page, `${OPERATIONS}/sales-orders/${deal.orderId}/production`);
  await expect(visible(page, `plan ${daysFromNow(21)}`)).toBeVisible();
  await field(page, 'Planned start').fill(daysFromNow(3));
  await field(page, 'Planned finish').fill(daysFromNow(30));
  await command(page, 'Replan');
  // The standard checkpoints are laid out again over the new span; the last one lands on the finish.
  await expect(visible(page, `plan ${daysFromNow(30)}`)).toBeVisible();
  await expect(page.getByText(`plan ${daysFromNow(21)}`)).toHaveCount(0);
  await axe(page, 'production (replanned)');
});

test('ops · quality returns a checkpoint’s evidence to the supplier', async ({ page }) => {
  const deal = get<Deal>('deal');
  const planned = await workPackage(deal);
  keep('planId', await qualityPlan(planned['workPackageId'] as string));
  const wp = await workPackage(deal);
  ok(await (await as('sourcing')).post(`/work-packages/${wp['workPackageId']}/release`, { expectedVersion: wp['aggregateVersion'] }), 201, 'release work package');
  keep('workPackageId', wp['workPackageId']);
  // Supplier A starts the first checkpoint and sends a photo of it.
  const a = await as('supplierA');
  const first = (((await supplierProduction(deal.purchaseOrderId))['workPackage'] as Body)['milestones'] as Body[]).find((m) => m['status'] === 'ready')!;
  const started = ok(await a.post(`/supplier/milestones/${first['milestoneId']}/start`, { expectedVersion: first['aggregateVersion'] }), 201, 'start checkpoint');
  const now = ((started['workPackage'] as Body)['milestones'] as Body[]).find((m) => m['milestoneId'] === first['milestoneId'])!;
  const photo = await upload('supplierA', 'image');
  ok(await a.post(`/supplier/milestones/${first['milestoneId']}/evidence`, { expectedVersion: now['aggregateVersion'], items: [{ documentVersionId: photo.documentVersionId, note: 'Bar stock on the rack' }] }), 201, 'submit evidence');

  await signInAs(page, 'quality');
  await open(page, `${OPERATIONS}/sales-orders/${deal.orderId}/production`);
  await expect(chip(page, 'evidence submitted')).toBeVisible();
  await field(page, 'Note (required to reject)').fill('The photo shows the rack, not the heat number on the bar.');
  await command(page, 'Reject evidence');
  await expect(chip(page, 'rejected evidence')).toBeVisible();
  await expect(visible(page, 'Decision note: The photo shows the rack, not the heat number on the bar.')).toBeVisible();
  await axe(page, 'production (evidence returned)');
});

test('ops · quality revises the approved plan into a new draft', async ({ page }) => {
  const planId = get('planId');
  await signInAs(page, 'quality');
  await open(page, `${OPERATIONS}/quality/plans/${planId}`, { heading: /Quality plan v1/ });
  await command(page, 'Revise plan');
  await expect(page).toHaveURL(/\/quality\/plans\/[0-9a-f-]{36}$/);
  await expect(page).not.toHaveURL(new RegExp(planId));
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Quality plan v2');
  await expect(chip(page, 'draft')).toBeVisible();
  await expect(button(page, 'Save draft')).toBeVisible();
  await axe(page, 'quality plan (revision draft)');
});

test('supplier · A records a final inspection with an uncalibrated gauge and attaches its certificate', async ({ page }) => {
  const gauge = `C15-UNCAL-${get('stamp')}`;
  ok(await (await as('supplierA')).post('/supplier/instruments', { assetTag: gauge, kind: 'Bore gauge', unit: 'mm' }), 201, 'uncalibrated gauge');
  const planned = ok(await (await as('quality')).post('/inspections', { workPackageId: get('workPackageId'), stage: 'final', lot: 'LOT-C15U' }), 201, 'plan final inspection');
  keep('inspectionId', planned['inspectionId']);

  await signInAs(page, 'supplierA');
  await open(page, `${PORTAL}/supplier/inspections/${planned['inspectionId']}`);
  await command(page, 'Start inspection');
  for (const serial of await page.getByLabel(/^Serial of piece \d+$/).all()) await serial.fill(`S-${Math.random().toString(36).slice(2, 6)}`);
  for (const tool of await page.getByLabel(/^Instrument for /).all()) await choose(tool, new RegExp(gauge));
  for (const select of await page.locator('select[aria-label*=", piece "]').all()) await select.selectOption({ index: 1 });
  for (const input of await page.locator('input[aria-label*=", piece "]').all()) await input.fill('12.006');
  await expect(visible(page, 'An instrument is out of calibration')).toBeVisible();
  await page.getByLabel(/^Upload File/).setInputFiles(join(FIXTURES, 'drawing.pdf'));
  await expect(visible(page, /^Ready$/)).toBeVisible({ timeout: 60_000 });
  await command(page, 'Submit results');
  await expect(chip(page, 'with JobWork quality')).toBeVisible();
  await expect(visible(page, 'drawing.pdf')).toBeVisible();
  expect((await supplierInspection(planned['inspectionId'] as string))['attachments'] as Body[]).toHaveLength(1);
  await axe(page, 'supplier inspection (results with certificate)');
});

test('ops · quality2 accepts one uncalibrated reading, sends one back and corrects a value', async ({ page }) => {
  await signInAs(page, 'quality2');
  await open(page, `${OPERATIONS}/quality/inspections/${get('inspectionId')}`);
  await expect(visible(page, 'drawing.pdf')).toBeVisible();
  await command(page, 'Start review');

  const first = cell(page, /Bore diameter/, 1);
  await field(first, 'Why').fill('Gauge checked against the setting ring that morning.');
  await command(page, 'Accept', first);
  await expect(first.getByText('not calibrated — accepted')).toBeVisible();

  const second = cell(page, /Bore diameter/, 2);
  await field(second, 'Why').fill('Re-measure with a calibrated bore gauge.');
  await command(page, 'Reinspect', second);
  await expect(second.getByText('not calibrated — reinspect')).toBeVisible();
  await expect(visible(page, /Bore diameter on sample 2 was measured with C15-UNCAL-\w+ without a valid calibration, and was sent for reinspection\./)).toBeVisible();

  const fifth = cell(page, /Bore diameter/, 5);
  await fifth.locator('summary').filter({ hasText: /^Correct$/ }).click();
  const fix = fifth.locator('details').filter({ has: page.locator('summary').filter({ hasText: /^Correct$/ }) });
  await field(fix, 'Value in mm').fill('12.008');
  await field(fix, 'Why').fill('Transposed digits on the sheet; the gauge read 12.008.');
  await command(page, 'Save correction', fix);
  await expect(page.getByRole('heading', { name: 'Corrections on record' })).toBeVisible();
  await expect(visible(page, /12\.006 mm \(pass\) → 12\.008 mm — Transposed digits/)).toBeVisible();
  await axe(page, 'inspection review (dispositions and correction)');
});

test('supplier · A records its containment on a new NCR and answers the corrective action', async ({ page }) => {
  const failed = await inspected(get('workPackageId'), 'final', 'LOT-C15N', await calibratedGauge(), '12.050');
  const results = (failed['results'] as Body[]).filter((r) => r['outcome'] === 'fail' && r['supersededByResultId'] === null);
  const opened = ok(
    await (await as('quality')).post('/ncrs', {
      inspectionId: failed['inspectionId'],
      resultIds: results.map((r) => r['resultId']),
      title: `Walk C15 bore oversize ${get('stamp')}`,
      description: 'Bore 12.05 against 12.00 +0.02 on every sampled piece.',
      severity: 'major',
      affectedQuantity: '5',
      lots: ['LOT-C15N'],
      serials: [],
    }),
    201,
    'open NCR',
  );
  keep('ncrId', opened['ncrId']);

  await signInAs(page, 'supplierA');
  await open(page, `${PORTAL}/supplier/ncrs/${opened['ncrId']}`);
  await expect(chip(page, 'contain the parts')).toBeVisible();
  await field(page, 'What you did').fill('Lot N segregated and red-tagged on 12 Nov.');
  await field(page, 'Where the parts are').fill('Quarantine cage B');
  await command(page, 'Record containment');
  await expect(visible(page, /You: Lot N segregated and red-tagged on 12 Nov\. · Quarantine cage B/)).toBeVisible();
  await expect(chip(page, 'contained')).toBeVisible();
  await field(page, 'The problem').fill('Bore oversize by 0.03 mm on lot N.');
  await field(page, 'Why it happened').fill('Boring bar deflection after a tool holder change.');
  await field(page, 'Why it was not caught').fill('First-off check skipped after the holder change.');
  await page.getByLabel('Action 1', { exact: false }).fill('First-off check after every holder change');
  await page.getByLabel('Owner', { exact: false }).first().fill('Shop foreman');
  await page.getByLabel('By', { exact: true }).first().fill(daysFromNow(10));
  await command(page, 'Send corrective action');
  await expect(page.getByText('responded', { exact: true })).toBeVisible();
  await axe(page, 'supplier NCR (contained, answered)');
});

test('ops · quality withdraws a deviation, rejects the lot and returns the corrective action', async ({ page }) => {
  const id = get('ncrId');
  const q = await as('quality');
  ok(await q.post(`/ncrs/${id}/to-disposition`, { expectedVersion: (await ncr(id))['aggregateVersion'] }), 201, 'to disposition');
  const n = await ncr(id);
  const deviation = ok(
    await q.post(`/ncrs/${id}/deviations`, {
      expectedVersion: n['aggregateVersion'],
      characteristicIds: [...new Set((n['defects'] as Body[]).map((d) => d['characteristicId']))],
      quantity: '5',
      lots: ['LOT-C15N'],
      serials: [],
      expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      rationale: 'Mating shaft clearance absorbs 0.03 mm.',
      riskAssessment: 'Low',
      fitFunctionSafety: 'No effect on fit.',
    }),
    201,
    'request deviation',
  );
  await signInAs(page, 'quality');
  await open(page, `${OPERATIONS}/quality/ncrs/${id}`);
  await expect(chip(page, 'deviation pending')).toBeVisible();
  await expect(chip(page, 'pending internal')).toBeVisible();
  const withdraw = await expand(page, 'Withdraw');
  await field(withdraw, 'Why').fill('The customer’s assembly drawing tightened the shaft fit.');
  await command(page, 'Withdraw deviation', withdraw);
  await expect(chip(page, 'withdrawn')).toBeVisible();
  await expect(chip(page, 'disposition pending')).toBeVisible();
  // Withdrawn before anyone decided: its approval request goes with it, nothing is left waiting.
  const waiting = ok(await q.get('/approvals?status=pending'), 200, 'waiting approvals')['approvals'] as Body[];
  expect(waiting.map((a) => a['approvalRequestId'])).not.toContain(deviation['approvalRequestId']);

  // The corrective action names a cause but no proof: send it back with what is missing, while the NCR still waits for a disposition.
  await field(page, 'What is missing').fill('Show the first-off record sheet that proves the new check runs.');
  await command(page, 'Return');
  await expect(chip(page, 'requested')).toBeVisible();
  await expect(button(page, 'Return')).toHaveCount(0);

  const reject = await expand(page, 'Return or scrap');
  await choose(reject.getByLabel('Disposition', { exact: true }), /Return/);
  await field(reject, 'Why').fill('Oversize bores cannot be recovered; return the lot to the supplier.');
  await command(page, 'Reject lot', reject);
  await expect(chip(page, 'rejected')).toBeVisible();
  await expect(visible(page, /^2\. return$/)).toBeVisible();
  await axe(page, 'NCR (rejected, corrective action returned)');
});

test('supplier · A reads what JobWork asked for on the corrective action', async ({ page }) => {
  await signInAs(page, 'supplierA');
  await open(page, `${PORTAL}/supplier/ncrs/${get('ncrId')}`);
  await expect(chip(page, 'rejected')).toBeVisible();
  await expect(visible(page, 'JobWork asked for more')).toBeVisible();
  await expect(visible(page, 'Show the first-off record sheet that proves the new check runs.')).toBeVisible();
  await expect(button(page, 'Send corrective action')).toBeVisible();
  await axe(page, 'supplier NCR (corrective action returned)');
});

test('ops · quality invalidates the inspection measured with the uncalibrated gauge', async ({ page }) => {
  await signInAs(page, 'quality');
  await open(page, `${OPERATIONS}/quality/inspections/${get('inspectionId')}`);
  const box = await expand(page, 'Invalidate this inspection');
  await field(box, 'Why it no longer counts').fill('Measured with a gauge that has no calibration on record.');
  await command(page, 'Invalidate', box);
  await expect(visible(page, 'Invalidated: Measured with a gauge that has no calibration on record.')).toBeVisible();
  await expect(chip(page, 'invalidated')).toBeVisible();
  await expect(button(page, 'Invalidate')).toHaveCount(0);
  await axe(page, 'inspection (invalidated)');
});
