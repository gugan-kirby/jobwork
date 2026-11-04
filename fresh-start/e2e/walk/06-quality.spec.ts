import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { ok, type Body } from '../support/api';
import { as, inProduction, inspected, calibratedGauge, orderedDeal, released } from './support/flows';
import { axe, expand, button, choose, command, daysFromNow, expect, field, FIXTURES, OPERATIONS, open, PORTAL, recall, remember, signInAs, test, visible, showOrderDetails } from './support/walk';

/** FW.6 Quality: instruments, plan an inspection, the supplier's results grid, review, NCR, rework, corrective action, deviation, release. */
test.describe.configure({ mode: 'serial' });

/** Fills a supplier inspection grid: every piece, every characteristic, `bore` for the bore. */
async function fillGrid(page: Page, bore: string): Promise<void> {
  for (const serial of await page.getByLabel(/^Serial of piece \d+$/).all()) await serial.fill(`S-${Math.random().toString(36).slice(2, 6)}`);
  for (const tool of await page.getByLabel(/^Instrument for /).all()) await tool.selectOption({ index: 1 });
  for (const cell of await page.locator('select[aria-label*=", piece "]').all()) await cell.selectOption({ index: 1 });
  for (const cell of await page.locator('input[aria-label*=", piece "]').all()) {
    const name = (await cell.getAttribute('aria-label'))!;
    await cell.fill(name.startsWith('Bore') ? bore : name.startsWith('Surface') ? '1.6' : name.includes('length') ? '80.00' : '1');
  }
}

async function inspectionsOf(workPackageId: string): Promise<Body[]> {
  return ok(await (await as('quality')).get(`/inspections?workPackageId=${workPackageId}`), 200, 'inspections') as unknown as Body[];
}

test('ops · quality registers and calibrates an instrument and plans the first-article inspection', async ({ page }) => {
  const deal = await orderedDeal('Walk QA cover');
  const { workPackageId, planId } = await inProduction(deal);
  remember('qaOrderId', deal.orderId);
  remember('qaPurchaseOrderId', deal.purchaseOrderId);
  remember('qaWorkPackageId', workPackageId);
  remember('qaPlanId', planId);

  await signInAs(page, 'quality');
  await open(page, `${OPERATIONS}/quality/instruments`);
  await field(page, 'Asset tag').fill(`JW-CAL-${Date.now() % 10000}`);
  await field(page, 'What it is').fill('Reference bore gauge');
  await choose(page.getByLabel('Reads in', { exact: false }).first(), /mm|milli/i);
  await command(page, 'Register instrument');
  await choose(page.getByLabel('Calibrate', { exact: true }), /JW-CAL/);
  await field(page, 'Calibrated on').fill(daysFromNow(-5));
  await field(page, 'Next due').fill(daysFromNow(360));
  await page.getByLabel('Certificate', { exact: false }).first().setInputFiles(join(FIXTURES, 'drawing.pdf'));
  await expect(button(page, 'Record calibration')).toBeEnabled({ timeout: 60_000 });
  await command(page, 'Record calibration');
  await axe(page, 'instruments');

  await open(page, `${OPERATIONS}/quality/plans/${planId}`);
  await choose(page.getByLabel('Stage', { exact: true }), /First article|FAI/i);
  await command(page, 'Plan inspection');
  await axe(page, 'quality plan (approved)');
});

test('supplier · registers and calibrates its gauge', async ({ page }) => {
  await signInAs(page, 'supplierA');
  await open(page, `${PORTAL}/supplier/quality`);
  await expand(page, 'Register an instrument');
  await field(page, 'Asset tag').fill(`AE-BG-${Date.now() % 10000}`);
  await field(page, 'What it is').fill('Bore gauge 10-18 mm');
  await choose(page.getByLabel('Reads in', { exact: false }).first(), /mm|milli/i);
  await command(page, 'Register');
  const calibration = await expand(page, 'Record a calibration');
  await calibration.getByLabel('Calibrated on', { exact: false }).fill(daysFromNow(-3));
  await calibration.getByLabel('Next due', { exact: false }).fill(daysFromNow(300));
  await calibration.getByLabel('Certificate', { exact: false }).setInputFiles(join(FIXTURES, 'drawing.pdf'));
  await expect(button(calibration, 'Record calibration')).toBeEnabled({ timeout: 60_000 });
  await command(page, 'Record calibration', calibration);
  await axe(page, 'supplier quality');
});

test('supplier · records the first-article results, out of tolerance on the bore, and corrects a value', async ({ page }) => {
  const fai = (await inspectionsOf(recall('qaWorkPackageId'))).find((i) => i['stage'] === 'fai')!;
  remember('faiId', fai['inspectionId']);
  await signInAs(page, 'supplierA');
  await open(page, `${PORTAL}/supplier/inspections/${fai['inspectionId']}`);
  await command(page, 'Start inspection');
  await fillGrid(page, '12.050');
  await axe(page, 'supplier inspection grid');
  await command(page, 'Submit results');
  await expand(page, 'Correct');
  await page.getByLabel(/^Value in /).first().fill('1.5');
  await page.getByLabel('Why', { exact: true }).first().fill('Transcription error, gauge read 1.5');
  await command(page, 'Save correction');
  await expect(page.locator('body')).not.toContainText(/Kovai/);
});

test('ops · quality2 reviews, fails the inspection and opens an NCR', async ({ page }) => {
  await signInAs(page, 'quality2');
  await open(page, `${OPERATIONS}/quality`);
  await axe(page, 'inspections');
  await open(page, `${OPERATIONS}/quality/inspections/${recall('faiId')}`);
  await command(page, 'Start review');
  await field(page, 'Note to the supplier (needed to fail)').fill('Bore 12.05 is above the 12.02 limit.');
  await command(page, 'Fail');
  await expand(page, 'Open an NCR');
  for (const box of await page.getByRole('checkbox').filter({ visible: true }).all()) await box.check();
  await field(page, 'Title').fill('Bore oversize on first article');
  await field(page, 'What was found').fill('Bore measured 12.05 against 12.00 +0.02.');
  await field(page, 'Parts affected').fill('1');
  await field(page, 'Lots (comma separated)').fill('LOT-1');
  await command(page, 'Open NCR');
  await expect(page).toHaveURL(/\/quality\/ncrs\/[0-9a-f-]{36}$/);
  remember('ncrId', page.url().split('/').pop());
  await axe(page, 'NCR (open)');
});

test('ops · quality contains the NCR and approves rework', async ({ page }) => {
  await signInAs(page, 'quality');
  await open(page, `${OPERATIONS}/quality/ncrs`);
  await axe(page, 'NCRs');
  await open(page, `${OPERATIONS}/quality/ncrs/${recall('ncrId')}`);
  await expand(page, 'Record containment');
  await field(page, 'What was done').fill('Lot segregated, red-tagged.');
  await field(page, 'Where the parts are').fill('Supplier quarantine rack 3');
  await command(page, 'Record');
  await command(page, 'Contained — decide the disposition');
  await expand(page, 'Rework, remake or sort');
  await choose(page.getByLabel('Disposition', { exact: false }).first(), /rework/i);
  await field(page, 'Plan the supplier follows').fill('Re-bore to 12.01 and re-measure every piece.');
  await command(page, 'Approve');
  await axe(page, 'NCR (rework)');
});

test('supplier · records containment, the rework and its corrective action', async ({ page }) => {
  await signInAs(page, 'supplierA');
  await open(page, `${PORTAL}/supplier/ncrs/${recall('ncrId')}`);
  await field(page, 'What you did, and when').fill('Re-bored on 2 Nov, all pieces re-measured.');
  await command(page, 'Rework done');
  if (await page.getByLabel('The problem', { exact: false }).count()) {
    await field(page, 'The problem').fill('Bore oversize.');
    await field(page, 'Why it happened').fill('Worn boring bar insert.');
    await field(page, 'Why it was not caught').fill('In-process check every 10 pieces, not every piece.');
    await page.getByLabel('Action 1', { exact: false }).fill('Insert change every 50 bores');
    await page.getByLabel('Owner', { exact: false }).first().fill('Shop foreman');
    await page.getByLabel('By', { exact: true }).first().fill(daysFromNow(7));
    await command(page, 'Send corrective action');
  }
  await axe(page, 'supplier NCR');
});

test('ops · quality plans the reinspection', async ({ page }) => {
  await signInAs(page, 'quality');
  await open(page, `${OPERATIONS}/quality/ncrs/${recall('ncrId')}`);
  await command(page, 'Plan the reinspection');
  await expect(page.getByRole('link', { name: /Reinspection/ })).toBeVisible();
});

test('supplier · records the reinspection in tolerance', async ({ page }) => {
  const re = (await inspectionsOf(recall('qaWorkPackageId'))).find((i) => i['inspectionId'] !== recall('faiId') && ['planned', 'in_progress'].includes(i['status'] as string))!;
  remember('reinspectionId', re['inspectionId']);
  await signInAs(page, 'supplierA');
  await open(page, `${PORTAL}/supplier/inspections/${re['inspectionId']}`);
  await command(page, 'Start inspection');
  await fillGrid(page, '12.008');
  await command(page, 'Submit results');
});

test('ops · quality2 passes the reinspection', async ({ page }) => {
  await signInAs(page, 'quality2');
  await open(page, `${OPERATIONS}/quality/inspections/${recall('reinspectionId')}`);
  await command(page, 'Start review');
  await command(page, 'Pass');
});

test('ops · quality accepts and verifies the corrective action', async ({ page }) => {
  await signInAs(page, 'quality');
  await open(page, `${OPERATIONS}/quality/ncrs/${recall('ncrId')}`);
  await command(page, 'Accept');
  await field(page, 'Evidence it worked').fill('Fifty bores since the insert change, all in tolerance.');
  await command(page, 'Verify effective');
  // Whoever decided the disposition never closes it.
  await expect(button(page, 'Close NCR')).toBeDisabled();
});

test('ops · quality2 closes the NCR', async ({ page }) => {
  await signInAs(page, 'quality2');
  await open(page, `${OPERATIONS}/quality/ncrs/${recall('ncrId')}`);
  await field(page, 'Closure note').fill('Reworked parts pass reinspection; corrective action effective.');
  await command(page, 'Close NCR');
  await expect(visible(page, /closed/i)).toBeVisible();
  await axe(page, 'NCR (closed)');
});

test('ops · a second NCR is accepted under a deviation request', async ({ page }) => {
  const gauge = await calibratedGauge();
  const failed = await inspected(recall('qaWorkPackageId'), 'final', 'LOT-D', gauge, '12.030');
  await signInAs(page, 'quality');
  await open(page, `${OPERATIONS}/quality/inspections/${failed['inspectionId']}`);
  await expand(page, 'Open an NCR');
  for (const box of await page.getByRole('checkbox').filter({ visible: true }).all()) await box.check();
  await field(page, 'Title').fill('Bore 12.03 on lot D');
  await field(page, 'What was found').fill('Bore 0.01 over the limit; fit unaffected per assembly drawing.');
  await field(page, 'Parts affected').fill('5');
  await field(page, 'Lots (comma separated)').fill('LOT-D');
  await command(page, 'Open NCR');
  remember('deviationNcrId', page.url().split('/').pop());
  await expand(page, 'Record containment');
  await field(page, 'What was done').fill('Lot D held at the supplier.');
  await field(page, 'Where the parts are').fill('Supplier stores');
  await command(page, 'Record');
  await command(page, 'Contained — decide the disposition');
  await expand(page, 'Use as is under a deviation');
  for (const box of await page.getByRole('checkbox').filter({ visible: true }).all()) await box.check();
  await page.getByLabel(/^Parts/).first().fill('5');
  await page.getByLabel(/^Lots/).last().fill('LOT-D');
  await page.getByLabel('Until', { exact: false }).fill(daysFromNow(60));
  await field(page, 'Why the parts can be used').fill('Mating shaft has 0.05 clearance; 0.01 oversize does not affect fit.');
  await field(page, 'Risk').fill('Low');
  await field(page, 'Fit, function and safety').fill('No effect.');
  await field(page, 'Price effect').fill('None');
  await field(page, 'Warranty effect').fill('None');
  await field(page, 'Traceability').fill('Lot D marked DEV-1.');
  await field(page, 'Labelling').fill('Yellow deviation tag on each box.');
  await command(page, 'Request deviation');
  await axe(page, 'NCR (deviation requested)');
});

test('ops · quality2 approves the deviation for the customer', async ({ page }) => {
  await signInAs(page, 'quality2');
  await open(page, `${OPERATIONS}/approvals`);
  const row = page.locator('tr').filter({ hasText: /Deviation|deviation/ }).filter({ has: page.getByRole('button', { name: 'Decide…' }) }).first();
  await row.getByRole('button', { name: 'Decide…' }).click();
  await command(page, 'Approve');
});

test('customer · the approver accepts the parts as they are', async ({ page }) => {
  await signInAs(page, 'approver');
  await open(page, `${PORTAL}/orders/${recall('qaOrderId')}`);
  await showOrderDetails(page);
  await page.getByRole('checkbox', { name: /I accept \d+ parts/ }).check();
  await command(page, 'Accept as is');
  await expect(page.locator('body')).not.toContainText(/LOT-D/);
  await axe(page, 'order (deviation decided)');
});

test('ops · quality checks the release facts and authorizes release', async ({ page }) => {
  const deal = await orderedDeal('Walk release flange');
  const { workPackageId } = await inProduction(deal);
  await released(deal, workPackageId, [{ lot: 'LOT-R', quantity: '100' }], { release: false });
  await signInAs(page, 'quality');
  await open(page, `${OPERATIONS}/quality/releases/${workPackageId}`);
  await page.getByLabel(/^Parts/).fill('100');
  await field(page, 'Lots (comma separated)').fill('LOT-R');
  await command(page, 'Check');
  await command(page, 'Authorize release');
  await axe(page, 'quality release');
});
