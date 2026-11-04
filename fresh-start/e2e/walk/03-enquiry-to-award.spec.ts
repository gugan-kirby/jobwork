import { join } from 'node:path';
import { ok } from '../support/api';
import { as, submittedEnquiry } from './support/flows';
import { axe, button, choose, command, daysFromNow, expect, field, FIXTURES, OPERATIONS, open, PORTAL, recall, remember, section, signInAs, test, visible } from './support/walk';

/** FW.3 Enquiry to award: wizard, drafts, intake and questions, supplier copy, RFQ, bids, threads, evaluation, award. */
test.describe.configure({ mode: 'serial' });

test('customer · creates an enquiry through the three-step wizard', async ({ page }) => {
  await signInAs(page, 'buyer');
  await open(page, `${PORTAL}/`);
  await axe(page, 'customer home');
  await page.getByRole('link', { name: 'New Enquiry' }).first().click();
  await expect(page).toHaveURL(/\/enquiries\/new/);
  await field(page, 'Part / job name').fill('Walk impeller housing');
  await choose(page.getByLabel('Category', { exact: false }).first(), /machin/i);
  await choose(page.getByLabel('Sub category', { exact: false }).first(), /milling/i);
  await choose(page.getByLabel('Material', { exact: true }).first(), /alumin/i);
  await field(page, 'Quantity').fill('100');
  await choose(page.getByLabel('Delivery Location', { exact: false }), /Add new location/);
  await field(page, 'Name for this address').fill('Kovai Pumps assembly');
  await field(page, /^Address/).fill('SIDCO Industrial Estate, Mudalipalayam');
  await field(page, 'City').fill('Tiruppur');
  await field(page, 'State').fill('Tamil Nadu');
  await field(page, 'PIN code').fill('641606');
  await field(page, 'Who receives it').fill('R. Kumar');
  await field(page, 'Their phone').fill('+91 98400 12345');
  await command(page, 'Save address');
  await expect(page.getByRole('status').filter({ hasText: /Draft saved/ })).toBeAttached();
  await axe(page, 'wizard step 1');
  await button(page, 'Next').click();

  // Next waits for the drawing (VF-17).
  await button(page, 'Next').click();
  await expect(visible(page, /Upload a drawing/)).toBeVisible();
  await page.getByLabel('Upload File', { exact: false }).setInputFiles(join(FIXTURES, 'drawing.pdf'));
  await expect(visible(page, 'Scanned clean and attached to this enquiry.')).toBeVisible({ timeout: 60_000 });
  await field(page, 'Specifications / comments').fill('Break all sharp edges. Bore concentric to 0.02.');
  await choose(page.getByLabel('Surface Finish', { exact: false }), /Anodized/);
  await choose(page.getByLabel('Tolerance', { exact: false }), /0\.1 mm/);
  await axe(page, 'wizard step 2');
  await button(page, 'Next').click();

  await expect(page.getByRole('heading', { level: 1 })).toContainText('Review Enquiry');
  await axe(page, 'wizard review');
  await command(page, 'Submit Enquiry');
  await expect(page).toHaveURL(/\/enquiries\/[0-9a-f-]{36}$/);
  const reference = (await page.getByText(/ENQ-\d{4}-\d{4}/).first().innerText()).match(/ENQ-\d{4}-\d{4}/)![0];
  remember('enquiryId', page.url().split('/').pop());
  remember('enquiryReference', reference);
  await axe(page, 'enquiry detail');
  await open(page, `${PORTAL}/enquiries`);
  await expect(page.getByText(reference).first()).toBeVisible();
  await axe(page, 'enquiry list');
});

test('customer · resumes and discards a draft, withdraws and repeats an enquiry', async ({ page }) => {
  const run = Date.now().toString(36).slice(-4);
  const spacer = `Walk spacer ${run}`;
  const bushing = `Walk draft bushing ${run}`;
  const withdrawId = await submittedEnquiry(spacer);
  await signInAs(page, 'buyer');
  await page.goto(`${PORTAL}/enquiries/new`);
  await field(page, 'Part / job name').fill(bushing);
  await expect(page.getByRole('status').filter({ hasText: /Draft saved/ })).toBeAttached();
  await open(page, `${PORTAL}/enquiries`);
  await page.getByRole('radio', { name: /Drafts/ }).click();
  await page.getByRole('link', { name: new RegExp(bushing) }).first().click();
  await expect(field(page, 'Part / job name')).toHaveValue(bushing);
  const draftId = new URL(page.url()).searchParams.get('draft');
  await open(page, `${PORTAL}/enquiries/${draftId}`);
  await expect(page.getByRole('link', { name: 'Continue editing' })).toBeVisible();
  await command(page, 'Discard draft');

  await open(page, `${PORTAL}/enquiries/${withdrawId}`);
  await field(page, 'Why are you withdrawing it?').fill('The customer cancelled the pump project.');
  await command(page, 'Withdraw enquiry');
  // Withdrawing returns to the list, where withdrawn enquiries are hidden until asked for.
  await expect(page).toHaveURL(/\/enquiries$/);
  await expect(page.getByText(spacer)).toHaveCount(0);
  await button(page, 'Show withdrawn').click();
  await expect(page.getByText(spacer).first()).toBeVisible();
  await field(page, 'Search').fill(run);
  await page.getByRole('link', { name: new RegExp(spacer) }).first().click();
  await expect(page).toHaveURL(new RegExp(`/enquiries/${withdrawId}$`));
  await command(page, 'Order this again');
  await expect(page).toHaveURL(/\/enquiries\/new\?draft=/);
  await expect(field(page, 'Part / job name')).toHaveValue(new RegExp(spacer));
});

test('ops · engineering triages the enquiry and asks the customer a question', async ({ page }) => {
  await signInAs(page, 'engineering');
  await open(page, `${OPERATIONS}/intake`);
  await page.getByRole('link', { name: recall('enquiryReference') }).click();
  await expect(page).toHaveURL(/\/intake\/[0-9a-f-]{36}$/);
  await axe(page, 'intake detail (submitted)');
  await command(page, 'Start triage');
  await choose(page.getByLabel('Topic 1', { exact: false }), /./);
  await field(page, 'Question 1').fill('Is the 0.02 concentricity to the bore or to the spigot?');
  await command(page, 'Send questions');
  await expect(visible(page, /0\.02 concentricity/)).toBeVisible();
  await axe(page, 'intake detail (questions sent)');
});

test('customer · answers the question and messages JobWork', async ({ page }) => {
  await signInAs(page, 'buyer');
  await open(page, `${PORTAL}/enquiries/${recall('enquiryId')}`);
  await field(page, 'Your answer').fill('To the bore, datum A on the drawing.');
  await command(page, /Send answers?/);
  await field(page, 'Message').fill('We can share a sample part if it helps.');
  await command(page, 'Send');
  await expect(visible(page, 'We can share a sample part if it helps.')).toBeVisible();
  await axe(page, 'enquiry with answered question');
});

test('ops · engineering approves for sourcing and prepares the supplier copy', async ({ page }) => {
  await signInAs(page, 'engineering');
  await open(page, `${OPERATIONS}/intake/${(await intakeId())}`);
  await expect(visible(page, 'To the bore, datum A on the drawing.')).toBeVisible();
  await expect(visible(page, 'We can share a sample part if it helps.')).toBeVisible();
  await field(page, 'Message').fill('Thank you, the bore datum is clear.');
  await command(page, 'Send');
  await expect(visible(page, 'No supplier copy: suppliers cannot receive this file yet')).toBeVisible();
  await page.getByLabel('2D drawing', { exact: false }).first().setInputFiles(join(FIXTURES, 'drawing.pdf'));
  await expect(button(page, 'Use as the supplier copy')).toBeEnabled({ timeout: 60_000 });
  await command(page, 'Use as the supplier copy');
  await expect(visible(page, 'Supplier copy waiting for a second check')).toBeVisible();
  await command(page, 'Approve for sourcing');
  await expect(page.getByRole('link', { name: 'Start a sourcing round' })).toBeVisible();
  await axe(page, 'intake detail (approved)');
});

/** The prices of the supplier's live bid, as JobWork received them. */
async function sentPrices(who: 'supplierA' | 'supplierB'): Promise<{ unitPriceMinor: number; setupAmountMinor: number }> {
  const rfq = ok(await (await as(who)).get(`/supplier/rfqs/${recall('rfqId')}`), 200, 'supplier rfq');
  const versions = ((rfq['bid'] as Record<string, unknown>)['versions'] as Array<Record<string, unknown>>).filter((v) => v['status'] === 'submitted');
  const line = (versions[0]!['lines'] as Array<Record<string, number>>)[0]!;
  return { unitPriceMinor: line['unitPriceMinor']!, setupAmountMinor: line['setupAmountMinor']! };
}

async function intakeId(): Promise<string> {
  return recall('enquiryId');
}

test('ops · a second person confirms the supplier copy; sourcing releases the round', async ({ page }) => {
  await signInAs(page, 'sourcing');
  await open(page, `${OPERATIONS}/intake/${await intakeId()}`);
  await field(page, 'What you checked').fill('Title block and customer name removed; dimensions unchanged.');
  await command(page, 'Confirm it is clean');
  await expect(visible(page, 'Supplier copy checked')).toBeVisible();
  await page.getByRole('link', { name: 'Start a sourcing round' }).click();
  await expect(page).toHaveURL(/\/rfqs\/new\?enquiryId=/);
  for (const name of ['Anand Engineering', 'Balaji Precision']) await page.getByRole('checkbox', { name: new RegExp(`Invite ${name}`) }).check();
  await field(page, 'Bids close on').fill(daysFromNow(7));
  await field(page, 'Instructions to suppliers').fill('Quote per piece at 100 off, anodised finish excluded.');
  await axe(page, 'new RFQ');
  await command(page, /Release to 2 suppliers?/);
  await expect(page).toHaveURL(/\/rfqs\/[0-9a-f-]{36}$/);
  remember('rfqId', page.url().split('/').pop());
  await axe(page, 'RFQ (open)');
  await open(page, `${OPERATIONS}/rfqs`);
  await axe(page, 'RFQ control room');
});

test('supplier · A acknowledges, saves a draft, asks a question and bids', async ({ page }) => {
  await signInAs(page, 'supplierA');
  await open(page, `${PORTAL}/rfqs`);
  await axe(page, 'supplier RFQs');
  await open(page, `${PORTAL}/rfqs/${recall('rfqId')}`);
  await expect(page.locator('body')).not.toContainText(/Kovai/);
  await command(page, 'Yes, we are looking');
  await field(page, 'Price each').fill('48.50');
  await field(page, 'One-off setup').fill('5000');
  await field(page, 'Freight').fill('2500');
  await field(page, 'Assumptions').fill('Material from our stock.');
  await command(page, 'Save draft');
  await field(page, 'Message').fill('Is anodising in our scope or yours?');
  await command(page, 'Send');
  await expect(visible(page, 'Is anodising in our scope or yours?')).toBeVisible();
  await command(page, 'Submit bid');
  await expect(button(page, 'Submit a revised bid')).toBeVisible();
  // W7: what was on screen is what was sent.
  await expect(field(page, 'Price each')).toHaveValue('48.50');
  expect(await sentPrices('supplierA')).toEqual({ unitPriceMinor: 4850, setupAmountMinor: 500000 });
  await axe(page, 'supplier RFQ (bid sent)');
});

test('supplier · B bids, then revises its bid with a reason', async ({ page }) => {
  await signInAs(page, 'supplierB');
  await open(page, `${PORTAL}/rfqs/${recall('rfqId')}`);
  await field(page, 'Price each').fill('54.00');
  await field(page, 'One-off setup').fill('4000');
  await command(page, 'Submit bid');
  await field(page, 'Price each').fill('52.50');
  await field(page, 'What changed, and why?').fill('Found a cheaper aluminium source this week.');
  await command(page, 'Submit a revised bid');
  await expect(visible(page, /v2|version 2/i)).toBeVisible();
  // W7: the revision keeps the setup it was not asked to change.
  expect(await sentPrices('supplierB')).toEqual({ unitPriceMinor: 5250, setupAmountMinor: 400000 });
});

test('ops · sourcing answers every supplier, closes, compares and proposes the award', async ({ page }) => {
  await signInAs(page, 'sourcing');
  await open(page, `${OPERATIONS}/rfqs/${recall('rfqId')}`);
  await expect(visible(page, 'Is anodising in our scope or yours?')).toBeVisible();
  await button(page, /Answer for every supplier/).click();
  await field(page, 'Published text').fill('Anodising is excluded; quote machined parts only.');
  await command(page, 'Publish to every invited supplier');
  await field(page, 'Note').fill('Both invited suppliers have bid; closing early.');
  await command(page, 'Close for evaluation');
  await command(page, 'Run comparison');
  const anand = page.getByLabel(/Anand Engineering \(v\d+\)/).first();
  await anand.fill('100');
  await field(page, 'Rationale').fill('Lowest normalized landed cost with the lead time the customer needs.');
  await axe(page, 'RFQ evaluation');
  await command(page, 'Propose award');
  await expect(page).toHaveURL(/\/awards\/[0-9a-f-]{36}$/);
  remember('awardId', page.url().split('/').pop());
  await axe(page, 'award (proposed)');
  await open(page, `${OPERATIONS}/rfqs/${recall('rfqId')}`);
  await page.getByRole('link', { name: /\d+ bids?/ }).first().click();
  await expect(page).toHaveURL(/\/evaluations\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await axe(page, 'evaluation');
});

test('supplier · B sees the published answer', async ({ page }) => {
  await signInAs(page, 'supplierB');
  await open(page, `${PORTAL}/rfqs/${recall('rfqId')}`);
  await expect(visible(page, 'Anodising is excluded; quote machined parts only.')).toBeVisible();
  // A supplier never sees another supplier's question or name.
  await expect(page.locator('body')).not.toContainText(/Anand/);
  const b = await as('supplierB');
  ok(await b.get(`/supplier/rfqs/${recall('rfqId')}`), 200, 'supplier B reads its round');
  void section;
});
