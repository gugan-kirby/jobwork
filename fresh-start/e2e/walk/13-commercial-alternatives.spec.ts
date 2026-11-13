import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { type Body, ok } from '../support/api';
import { accepted, approvedEnquiry, as, bidBody, decide, issuePurchaseOrders, openRound, proposeAward, salesOrder, sentQuote, sourced, submittedEnquiry } from './support/flows';
import { axe, button, command, expand, expect, field, OPERATIONS, open, PORTAL, recall, remember, section, signInAs, test, visible } from './support/walk';

/** FW.13 Commercial alternatives: declines, revisions, overrides, revoked and declined invitations, held messages, returned and rejected approvals, withdrawn and rejected quotations, release on credit. */
test.describe.configure({ mode: 'serial' });

const run = Date.now().toString(36).slice(-5);

async function intakeVersion(enquiryId: string): Promise<number> {
  return (ok(await (await as('engineering')).get(`/intake/${enquiryId}`), 200, 'intake')['enquiry'] as Body)['aggregateVersion'] as number;
}

async function rfqReference(rfqId: string): Promise<string> {
  return (ok(await (await as('sourcing')).get(`/rfqs/${rfqId}`), 200, 'rfq')['rfq'] as Body)['reference'] as string;
}

/** The approval row whose subject links to `id`, on whichever filter is showing. */
const approvalRow = (page: Page, id: string) => page.locator('tr').filter({ has: page.locator(`a[href*="${id}"]`) });

test('ops · engineering declines an enquiry JobWork cannot make', async ({ page }) => {
  const enquiryId = await submittedEnquiry(`Walk 13 thin-wall sleeve ${run}`);
  ok(await (await as('engineering')).post(`/intake/${enquiryId}/triage`, { expectedVersion: await intakeVersion(enquiryId) }), 201, 'triage');
  await signInAs(page, 'engineering');
  await open(page, `${OPERATIONS}/intake/${enquiryId}`);
  const reason = 'A 0.3 mm wall over 80 mm is below what our network can hold; a 1 mm wall we can quote.';
  await field(page, /^Reason/).fill(reason);
  await command(page, 'Decline enquiry');
  await expect(visible(page, `Declined: ${reason}`)).toBeVisible();
  await expect(visible(page, /\bclosed — /)).toBeVisible();
  await axe(page, 'intake detail (declined)');
});

test('ops · engineering freezes a revised requirement and the live round closes as superseded', async ({ page }) => {
  const enquiryId = await approvedEnquiry(`Walk 13 revised bracket ${run}`);
  const { rfqId } = await openRound(enquiryId);
  const reference = await rfqReference(rfqId);
  await signInAs(page, 'engineering');
  await open(page, `${OPERATIONS}/intake/${enquiryId}`);
  await field(page, 'Tolerance class').fill('IT7');
  await field(page, 'Why the requirement changed').fill('The customer tightened the bore after their fit trial.');
  await command(page, /^Freeze revision \d+$/);
  await expect(page.getByText(/^Revision \d+ is in force$/)).toBeVisible();
  await expect(visible(page, `Superseded: ${reference}.`)).toBeVisible();
  await axe(page, 'intake detail (revised)');
});

test('ops · sourcing releases a round to a supplier the filter excludes, recording why', async ({ page }) => {
  const enquiryId = await approvedEnquiry(`Walk 13 fixture plate ${run}`);
  // A supplier admitted this week: not yet matchable, so inviting it is an override.
  const name = `Walk 13 Fixture Works ${run}`;
  const email = `owner-${randomUUID().slice(0, 8)}@walk13.test`;
  ok(
    await (await as('admin')).post('/suppliers', { legalName: `${name} Private Limited`, displayName: name, regionClass: 'chennai_metro', primaryContactName: 'Walk Thirteen', primaryContactEmail: email, firstUserEmail: email, firstUserRoleKeys: ['org_admin'] }),
    201,
    'admit supplier',
  );
  await signInAs(page, 'sourcing');
  await open(page, `${OPERATIONS}/rfqs/new?enquiryId=${enquiryId}`);
  await page.getByRole('checkbox', { name: /Invite Anand Engineering/ }).check();
  await page.getByRole('checkbox', { name: `Invite ${name}` }).check();
  await expect(visible(page, 'An override needs a reason')).toBeVisible();
  await expect(button(page, 'Release to 2 suppliers')).toBeDisabled();
  const why = 'Only shop with a five-axis fixture for this plate; its evidence arrives this week.';
  await field(page, `Why invite ${name} anyway`).fill(why);
  await axe(page, 'new RFQ (override)');
  await command(page, 'Release to 2 suppliers');
  await expect(page).toHaveURL(/\/rfqs\/[0-9a-f-]{36}$/);
  const rfqId = page.url().split('/').pop()!;
  remember('c13OverrideRfq', rfqId);
  remember('c13OverrideSupplier', name);
  remember('c13OverrideReference', await rfqReference(rfqId));
  await expect(section(page, 'Invitations').getByRole('row').filter({ hasText: name })).toContainText(`override: ${why}`);
  await axe(page, 'RFQ (released with an override)');
});

test('ops · sourcing sends a flagged message anyway, has two held for review and revokes the excluded supplier', async ({ page }) => {
  const rfqId = recall('c13OverrideRfq');
  const name = recall('c13OverrideSupplier');
  await signInAs(page, 'sourcing');
  await open(page, `${OPERATIONS}/rfqs/${rfqId}`);
  // Naming an outside messaging app only warns: JobWork may send it as written.
  const warned = `Please keep drawing questions in this thread, not on WhatsApp (${run}).`;
  await field(page, 'Message').fill(warned);
  await button(page, 'Send').click();
  await expect(visible(page, 'Check this message before sending')).toBeVisible();
  await axe(page, 'message warning (send anyway)');
  await command(page, 'Send anyway');
  await expect(visible(page, warned)).toBeVisible();
  // A phone number to one supplier, and the customer's name to all of them, wait for a person.
  for (const [to, text] of [
    [/JobWork and Anand Engineering/, `Our stores desk is on 044 2625 4000; call before you dispatch (${run}).`],
    [/Every invited supplier/, `Kovai Pumps needs these anodised; quote the finish separately (${run}).`],
  ] as const) {
    await page.getByRole('radio', { name: to }).check();
    await field(page, 'Message').fill(text);
    await button(page, 'Send').click();
    await expect(visible(page, 'This message will be held for review')).toBeVisible();
    await command(page, 'Send for review');
    await expect(visible(page, /^Held for review\./)).toBeVisible();
  }
  const invitations = section(page, 'Invitations');
  const row = invitations.getByRole('row').filter({ hasText: name });
  await field(page, /^Note/).fill('Their evidence did not arrive in time; withdrawing the invitation.');
  await command(page, 'Revoke', row);
  await expect(row).toContainText('revoked');
  await expect(visible(page, `${name} removed from the round; their document access is gone.`)).toBeVisible();
  await axe(page, 'RFQ (invitation revoked)');
});

test('ops · support releases JobWork’s own number as written and rejects the message naming the customer', async ({ page }) => {
  const rfqId = recall('c13OverrideRfq');
  await signInAs(page, 'support');
  await open(page, `${OPERATIONS}/leakage-reviews`);
  const held = (reader: RegExp) => page.getByRole('row').filter({ has: page.locator(`a[href="/rfqs/${rfqId}"]`) }).filter({ hasText: reader });
  const decision = section(page, /^Held message about/);
  await held(/Anand Engineering \(supplier\)/).getByRole('button', { name: 'Review' }).click();
  await expect(decision).toContainText('044 2625 4000');
  await field(page, 'Why (kept with the decision)').fill('It is our own stores desk; suppliers may call it.');
  await command(page, 'Release as written');
  await expect(decision).toContainText('Released');
  await expect(held(/Anand Engineering \(supplier\)/)).toHaveCount(0);
  await axe(page, 'held message (released as written)');
  await held(/every invited supplier/).getByRole('button', { name: 'Review' }).click();
  await expect(decision).toContainText('Kovai Pumps');
  await field(page, 'Why (kept with the decision)').fill('Names the customer to every supplier; the question goes again without it.');
  await command(page, 'Reject');
  await expect(decision).toContainText('Rejected');
  await expect(held(/every invited supplier/)).toHaveCount(0);
  await axe(page, 'held message (rejected)');
});

test('supplier · B declines a round it has no capacity for', async ({ page }) => {
  const { rfqId, itemId } = await openRound(await approvedEnquiry(`Walk 13 busy month ${run}`));
  ok(await (await as('supplierA')).post(`/supplier/rfqs/${rfqId}/bid/submit`, bidBody(itemId, 4900)), 201, 'bid A');
  remember('c13BidRfq', rfqId);
  await signInAs(page, 'supplierB');
  await open(page, `${PORTAL}/rfqs/${rfqId}`);
  const notForUs = section(page, 'Not for you?');
  await notForUs.getByLabel('Why', { exact: true }).selectOption({ label: 'No capacity in the window' });
  await field(notForUs, 'Anything you want sourcing to know').fill('Both VMCs are booked until the end of the month.');
  await command(page, 'Decline this RFQ', notForUs);
  await expect(visible(page, 'Thanks for telling us — sourcing can move on straight away.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Not for you?' })).toHaveCount(0);
  await axe(page, 'supplier RFQ (declined)');
});

test('supplier · A finds the round it bid on under My Quotes', async ({ page }) => {
  const rfqId = recall('c13BidRfq');
  const reference = await rfqReference(rfqId);
  await signInAs(page, 'supplierA');
  await open(page, `${PORTAL}/supplier`);
  await expect(page.getByRole('link', { name: /Quotes Sent/ })).toHaveAttribute('href', '/rfqs/quotes');
  await open(page, `${PORTAL}/rfqs/quotes`, { heading: 'My Quotes' });
  const row = page.getByRole('row').filter({ has: page.getByRole('link', { name: reference, exact: true }) });
  await expect(row).toContainText('responded');
  await expect(row).toContainText(/days left/);
  // A round it was only invited to is not a quote.
  await expect(page.getByRole('link', { name: recall('c13OverrideReference'), exact: true })).toHaveCount(0);
  await axe(page, 'supplier my quotes');
  await row.getByRole('link', { name: reference }).click();
  await expect(page).toHaveURL(new RegExp(`/rfqs/${rfqId}$`));
  await expect(visible(page, 'your bid v1')).toBeVisible();
});

test('ops · sales rejects a proposed award, saying why', async ({ page }) => {
  const { awardId } = await proposeAward(await sourced(`Walk 13 rejected award ${run}`));
  await signInAs(page, 'sales');
  await open(page, `${OPERATIONS}/approvals`);
  await approvalRow(page, awardId).getByRole('button', { name: 'Decide…' }).click();
  // An award is approved or rejected; only drafts that can be edited come back for changes.
  await expect(button(page, 'Return for changes')).toHaveCount(0);
  await field(page, 'Reason').fill('Lead time misses the customer date; re-run with the wider panel.');
  await command(page, 'Reject');
  await expect(approvalRow(page, awardId)).toHaveCount(0);
  await page.getByLabel('Show', { exact: false }).selectOption({ label: 'Rejected' });
  await expect(approvalRow(page, awardId)).toContainText('rejected by');
  await axe(page, 'approvals (rejected)');
});

test('ops · finance returns a cost sheet for changes', async ({ page }) => {
  const award = await proposeAward(await sourced(`Walk 13 returned cost sheet ${run}`));
  await decide('sales', award.approvalRequestId);
  const sales = await as('sales');
  const sheet = ok(await sales.post(`/awards/${award.awardId}/cost-sheet`, { components: [{ code: 'freight_outbound', label: 'Freight to customer', amountMinor: 30000, basis: 'courier estimate' }], targetMarginBp: 1500, note: '' }), 201, 'cost sheet');
  ok(await sales.post(`/cost-sheets/${sheet['costSheetId']}/request-approval`, {}), 201, 'request cost sheet approval');
  await signInAs(page, 'finance');
  await open(page, `${OPERATIONS}/approvals`);
  await approvalRow(page, award.awardId).getByRole('button', { name: 'Decide…' }).click();
  await expect(button(page, 'Return for changes')).toBeDisabled();
  await field(page, 'Reason').fill('Add the inspection fixture as a component before this goes out.');
  await command(page, 'Return for changes');
  await expect(approvalRow(page, award.awardId)).toHaveCount(0);
  await page.getByLabel('Show', { exact: false }).selectOption({ label: 'Returned' });
  await expect(approvalRow(page, award.awardId)).toContainText('returned by');
  await axe(page, 'approvals (returned)');
});

test('ops · sales withdraws a quotation it sent', async ({ page }) => {
  const quoteId = await sentQuote(await sourced(`Walk 13 withdrawn quote ${run}`));
  await signInAs(page, 'sales');
  await open(page, `${OPERATIONS}/quotes/${quoteId}`);
  await button(page, 'Withdraw…').click();
  await expect(button(page, 'Withdraw')).toBeDisabled();
  await field(page, /^Why/).fill('The supplier lost the machine slot; we requote next week.');
  await command(page, 'Withdraw');
  await expect(visible(page, /\bwithdrawn — /)).toBeVisible();
  await expect(button(page, 'Withdraw…')).toHaveCount(0);
  await axe(page, 'quote (withdrawn)');
});

test('customer · the requester may ask for a revision; accepting and rejecting wait for the approver', async ({ page }) => {
  const quoteId = await sentQuote(await sourced(`Walk 13 requester quote ${run}`));
  await signInAs(page, 'buyer');
  await open(page, `${PORTAL}/quotations/${quoteId}`);
  await expect(page.getByRole('link', { name: 'Accept Quote' })).toHaveCount(0);
  await expect(button(page, 'Accept Quote')).toBeDisabled();
  await expand(page, 'Price & Terms');
  await expect(button(page, 'Reject')).toBeDisabled();
  await expect(button(page, 'Request a revision')).toBeEnabled();
  await axe(page, 'customer quotation (requester)');
});

test('customer · the approver rejects a quotation, saying why', async ({ page }) => {
  const quoteId = await sentQuote(await sourced(`Walk 13 rejected quote ${run}`));
  await signInAs(page, 'approver');
  await open(page, `${PORTAL}/quotations/${quoteId}`);
  await expand(page, 'Price & Terms');
  await button(page, 'Reject').click();
  const reason = 'Above our budget for this part this quarter.';
  await field(page, 'Why are you rejecting it?').fill(reason);
  await command(page, 'Reject quotation');
  await expect(visible(page, `Your reason: ${reason}`)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Accept Quote' })).toHaveCount(0);
  await axe(page, 'customer quotation (rejected)');
});

test('ops · finance releases an order commercially once the credit hold lifts', async ({ page }) => {
  const quoteId = await sentQuote(await sourced(`Walk 13 credit release ${run}`));
  // Accepted while a hold stands, the order waits; lifting the hold leaves the release to finance.
  const kovai = ok(await (await as('approver')).get('/auth/me'), 200, 'me')['organizationId'] as string;
  const finance = await as('finance');
  const placed = ok(await finance.post(`/finance/credit/${kovai}/holds`, { reason: `Walk 13 statement query ${run}` }), 201, 'place hold')['credit'] as Body;
  const holdId = (placed['activeHolds'] as Body[]).find((h) => String(h['reason']).includes(run))!['holdId'] as string;
  let orderId = '';
  try {
    orderId = await accepted(quoteId);
  } finally {
    ok(await finance.post(`/finance/credit/${kovai}/holds/${holdId}/release`, { reason: 'Statement query answered.' }), 201, 'release hold');
  }
  remember('c13OrderId', orderId);
  await signInAs(page, 'finance');
  await open(page, `${OPERATIONS}/sales-orders/${orderId}`);
  await expect(visible(page, /\bpending commercial release — /)).toBeVisible();
  await axe(page, 'sales order (waiting for commercial release)');
  await command(page, 'Release commercially');
  await expect(page.getByText(/^Released \d{4}-\d{2}-\d{2}$/)).toBeVisible();
  await expect(visible(page, /\bpending technical release — /)).toBeVisible();
  await expect(button(page, 'Release commercially')).toHaveCount(0);
  await axe(page, 'sales order (released commercially)');
});

test('ops · sourcing writes to the supplier in the purchase order conversation', async ({ page }) => {
  const orderId = recall('c13OrderId');
  if (((await salesOrder(orderId))['purchaseOrders'] as Body[]).length === 0) await issuePurchaseOrders(orderId);
  await signInAs(page, 'sourcing');
  await open(page, `${OPERATIONS}/sales-orders/${orderId}`);
  const thread = section(page, /^Conversation with Anand Engineering \(PO-/);
  const text = `Please send the material certificate with the first lot (${run}).`;
  await field(thread, 'Message').fill(text);
  await command(page, 'Send', thread);
  await expect(visible(thread, text)).toBeVisible();
  await axe(page, 'sales order (supplier conversation)');
});
