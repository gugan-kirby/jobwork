import { as, inProduction, orderedDeal, upload } from './support/flows';
import { ok } from '../support/api';
import { axe, button, choose, command, daysFromNow, expand, expect, field, OPERATIONS, open, PORTAL, recall, remember, signInAs, test, visible, showOrderDetails } from './support/walk';

/** FW.8 Engineering changes: customer request → triage → question → classify → interim stop → impact → approvals → release → supplier → verify → close; a withdrawn change. */
test.describe.configure({ mode: 'serial' });

test('customer · requests a change on its order', async ({ page }) => {
  const deal = await orderedDeal('Walk change housing');
  await inProduction(deal);
  remember('chOrderId', deal.orderId);
  remember('chPurchaseOrderId', deal.purchaseOrderId);
  await signInAs(page, 'buyer');
  await open(page, `${PORTAL}/orders/${deal.orderId}`);
  await showOrderDetails(page);
  const box = await expand(page, 'Request a change');
  await box.getByLabel('What should change', { exact: false }).fill('Laser-mark the part number');
  await box.getByLabel('Why, and which drawing or part', { exact: false }).fill('Our assembly line needs traceability on every housing.');
  await box.getByRole('checkbox', { name: 'Urgent' }).check();
  await command(page, 'Request change');
  await expect(visible(page, 'Laser-mark the part number')).toBeVisible();
  await axe(page, 'order (change requested)');
});

test('ops · engineering triages, stops the affected work and asks the customer a question', async ({ page }) => {
  const changes = ok(await (await as('engineering')).get(`/changes?salesOrderId=${recall('chOrderId')}`), 200, 'changes');
  const list = (Array.isArray(changes) ? changes : (changes['changes'] as unknown[])) as Array<Record<string, unknown>>;
  remember('changeId', list[0]!['changeRequestId']);
  await signInAs(page, 'engineering');
  await open(page, `${OPERATIONS}/changes`);
  await axe(page, 'changes');
  await open(page, `${OPERATIONS}/changes/${recall('changeId')}`);
  await command(page, 'Start triage');
  await page.getByRole('checkbox', { name: /PO-\d{4}-\d{4}/ }).first().check();
  await choose(page.getByLabel('Decision', { exact: true }), /Stop affected work/);
  await field(page, 'Until (date)').fill(daysFromNow(10));
  await field(page, 'Reason (the supplier sees the decision, not this text)').fill('Marking changes the finishing step.');
  await command(page, 'Issue interim decision');
  await field(page, 'Question for the proposer').fill('Should the mark be on the flange face or the body?');
  await command(page, 'Ask for more information');
  await axe(page, 'change (clarification asked)');
});

test('customer · answers the change question', async ({ page }) => {
  await signInAs(page, 'buyer');
  await open(page, `${PORTAL}/orders/${recall('chOrderId')}`);
  await showOrderDetails(page);
  await field(page, 'Your answer').fill('On the flange face, 3 mm characters.');
  await command(page, 'Send answer');
});

test('ops · engineering classifies the change and lifts the stop', async ({ page }) => {
  await signInAs(page, 'engineering');
  await open(page, `${OPERATIONS}/changes/${recall('changeId')}`);
  await expect(visible(page, 'On the flange face, 3 mm characters.')).toBeVisible();
  await choose(page.getByLabel('Classify as', { exact: false }), /Scope or configuration change/);
  await field(page, 'What suppliers are told (no customer names)').fill('Add laser marking of the part number on the flange face.');
  await command(page, 'Classify');
  await command(page, 'Lift');
  await axe(page, 'change (impact analysis)');
});

test('supplier · A sends its cost and lead-time estimate', async ({ page }) => {
  await signInAs(page, 'supplierA');
  await open(page, `${PORTAL}/supplier/orders/${recall('chPurchaseOrderId')}`);
  const box = await expand(page, 'Send your cost and lead-time estimate');
  await box.getByLabel('Cost change', { exact: false }).fill('1200');
  await box.getByLabel('Lead time change (days)', { exact: false }).fill('2');
  await box.getByLabel('Work in progress and anything JobWork should know', { exact: false }).fill('Ten parts machined, none marked yet.');
  await command(page, 'Send estimate', box);
  await expect(page.locator('body')).not.toContainText(/Kovai/);
});

test('ops · engineering assembles the new baseline and completes the impact', async ({ page }) => {
  await upload('engineering', 'drawing_2d');
  await signInAs(page, 'engineering');
  await open(page, `${OPERATIONS}/sales-orders/${recall('chOrderId')}/production`);
  for (const row of await page.locator('li, tr, div').filter({ has: page.getByRole('checkbox', { name: 'Include' }) }).filter({ hasText: /drawing/ }).all()) {
    const include = row.getByRole('checkbox', { name: 'Include' });
    if ((await include.count()) === 1 && (await include.isEnabled())) await include.check();
  }
  await command(page, /^(Assemble|Update) draft baseline$/);
  await open(page, `${OPERATIONS}/changes/${recall('changeId')}`);
  for (const area of await page.getByRole('checkbox', { name: / applies$/ }).all()) await area.check();
  for (const answer of await page.locator('textarea').filter({ visible: true }).all()) if (!(await answer.inputValue())) await answer.fill('Assessed: laser marking adds one operation, no other effect.');
  await field(page, 'Customer price change (₹, tax included; negative is a credit)').fill('1500');
  await field(page, 'Delivery date change (days)').fill('2');
  await page.getByLabel(/: supplier cost change \(₹\)$/).first().fill('1200');
  await page.getByLabel(/: lead time change \(days\)$/).first().fill('2');
  await choose(page.getByLabel('Baseline this change will release', { exact: false }), /BL-/);
  await command(page, 'Save impact version');
  await command(page, 'Complete impact and request approval');
  await expect(page.getByRole('link', { name: /open approvals/ })).toBeVisible();
  await axe(page, 'change (approval)');
});

test('ops · sales approves the change', async ({ page }) => {
  await signInAs(page, 'sales');
  await open(page, `${OPERATIONS}/approvals`);
  const row = page.locator('tr').filter({ has: page.locator(`a[href*="${recall('changeId')}"]`) }).first();
  await row.getByRole('button', { name: 'Decide…' }).click();
  await command(page, 'Approve');
});

test('customer · the approver approves the change and its effect', async ({ page }) => {
  await signInAs(page, 'approver');
  await open(page, `${PORTAL}/orders/${recall('chOrderId')}`);
  await showOrderDetails(page);
  await page.getByRole('checkbox', { name: /I understand this/ }).check();
  await command(page, 'Approve change');
  await expect(page.locator('body')).not.toContainText(/Anand/);
});

test('ops · engineering releases the new baseline', async ({ page }) => {
  await signInAs(page, 'engineering');
  await open(page, `${OPERATIONS}/changes/${recall('changeId')}`);
  await command(page, 'Release the new baseline');
});

test('supplier · A acknowledges the new drawing pack and the amendment', async ({ page }) => {
  await signInAs(page, 'supplierA');
  await open(page, `${PORTAL}/supplier/orders/${recall('chPurchaseOrderId')}`);
  await command(page, 'Acknowledge the new drawing pack and amendment');
  await axe(page, 'supplier PO (change acknowledged)');
});

test('ops · engineering verifies and closes the change; a second change is withdrawn', async ({ page }) => {
  await signInAs(page, 'engineering');
  await open(page, `${OPERATIONS}/changes/${recall('changeId')}`);
  await field(page, 'How the change was verified').fill('First marked housing checked against the marking drawing.');
  await command(page, 'Verify');
  await command(page, 'Close the change');
  await expect(visible(page, /closed/i)).toBeVisible();
  await axe(page, 'change (closed)');

  await open(page, `${OPERATIONS}/sales-orders/${recall('chOrderId')}/production`);
  const propose = await expand(page, 'Propose a change');
  await propose.getByLabel('What changes', { exact: false }).fill('Chamfer the outer edge');
  await propose.getByLabel('Why', { exact: true }).fill('Handling damage at assembly.');
  await command(page, 'Propose change', propose);
  const all = ok(await (await as('engineering')).get(`/changes?salesOrderId=${recall('chOrderId')}`), 200, 'changes');
  const second = ((Array.isArray(all) ? all : all['changes']) as Array<Record<string, unknown>>).find((c) => c['changeRequestId'] !== recall('changeId'))!;
  await open(page, `${OPERATIONS}/changes/${second['changeRequestId']}`);
  const withdraw = await expand(page, 'Withdraw this change');
  await withdraw.getByLabel('Why it is withdrawn', { exact: false }).fill('Customer will chamfer in-house instead.');
  await command(page, 'Withdraw', withdraw);
  await expect(visible(page, /withdrawn/i)).toBeVisible();
  void button;
});
