import type { Page } from '@playwright/test';
import { world } from '../support/world';
import { axe, expect, noSideways, OPERATIONS, open, PORTAL, recall, signInAs, test, type Who } from './support/walk';

/**
 * FW.11 Route sweep and access matrix: every screen of the three portals, as its owning
 * role, at 1280 and 390 wide, on the records the storyline made. Each must render its
 * heading with no error, no 5xx and no console error (the guard), no sideways scroll and no
 * serious axe finding. Then every shell link resolves, refusals are refusals, and no page
 * names the party it shields.
 */
test.describe.configure({ mode: 'serial' });

const id = (key: string): string => recall<string>(key).split('/').pop()!;

type Screen = string | { path: string; allowAlert?: boolean; shield?: RegExp };

async function sweep(page: Page, who: Who, base: string, screens: Screen[]): Promise<void> {
  if (who !== ('public' as Who)) await signInAs(page, who);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width > 500 ? 800 : 844 });
    for (const s of screens) {
      const { path, allowAlert, shield } = typeof s === 'string' ? { path: s, allowAlert: false, shield: undefined } : s;
      await open(page, `${base}${path}`, { allowAlert: Boolean(allowAlert) });
      if (shield) await expect(page.locator('body'), `${path} names a shielded party`).not.toContainText(shield);
      if (width === 1280) await axe(page, `${who} ${path}`);
      else await noSideways(page, `${path} at 390`);
    }
  }
}

// ADR-0007: a customer may see the supplier's name, never its cost or JobWork's own records.
const INTERNAL = /\bPO-\d{4}-\d{4}\b|\bLOT-[A-Z0-9]+|landed cost|supplier cost/i;
const CUSTOMER = /Kovai/;

test('public · every public screen', async ({ page }) => {
  await sweep(page, 'public' as Who, PORTAL, ['/welcome', '/start', '/explore', '/about', '/terms', '/help', '/offline', '/login', '/register', { path: '/verify-email', allowAlert: true }, { path: '/accept-invitation', allowAlert: true }]);
});

test('customer · every customer screen', async ({ page }) => {
  const c = (path: string): Screen => ({ path, shield: INTERNAL });
  await sweep(page, 'buyer', PORTAL, [
    c('/'),
    c('/enquiries'),
    c('/enquiries/new'),
    c(`/enquiries/${id('enquiryId')}`),
    '/quotations',
    `/quotations/${id('quoteStandard')}`,
    { path: `/quotations/${id('quoteStandard')}/accept`, allowAlert: true },
    c('/orders'),
    `/orders/${id('orderId')}`,
    c(`/orders/${id('lgOrderId')}`),
    c(`/orders/${id('lgOrderId')}/deliveries/${id('outboundShipmentId')}`),
    c(`/orders/${id('orderId')}/documents`),
    c('/invoices'),
    c(`/invoices/${id('stInvoiceId')}`),
    c('/payments'),
    c('/support'),
    c(`/support/${id('caseId')}`),
    c('/documents'),
    c('/team'),
    c('/notifications'),
    c('/profile'),
    c('/profile/edit'),
    c('/account/addresses'),
    c('/account/security'),
  ]);
});

test('supplier · every supplier screen', async ({ page }) => {
  const s = (path: string): Screen => ({ path, shield: CUSTOMER });
  await sweep(page, 'supplierA', PORTAL, [
    s('/supplier'),
    s('/rfqs'),
    s(`/rfqs/${id('rfqId')}`),
    s('/capabilities'),
    s('/supplier/company'),
    s('/supplier/compliance'),
    s('/supplier/team'),
    s('/supplier/orders'),
    s(`/supplier/orders/${id('purchaseOrderId')}`),
    s(`/supplier/orders/${id('lgPurchaseOrderId')}`),
    s('/supplier/quality'),
    s(`/supplier/inspections/${id('faiId')}`),
    s(`/supplier/ncrs/${id('ncrId')}`),
    s('/supplier/shipments'),
    s(`/supplier/shipments/new?purchaseOrderId=${id('lgPurchaseOrderId')}`),
    s(`/supplier/shipments/${id('inboundShipmentId')}`),
    s('/supplier/bills'),
    s('/documents'),
    s('/notifications'),
    s('/profile'),
    s('/account/security'),
  ]);
});

test('ops · admin screens', async ({ page }) => {
  await sweep(page, 'admin', OPERATIONS, ['/', '/organizations', '/organizations/new', `/organizations/${id('newCustomerOrgUrl')}`, '/audit', '/ops-health', '/suppliers', '/suppliers/new', '/suppliers/applications', '/notifications', '/account/security']);
});

test('ops · sourcing screens', async ({ page }) => {
  await sweep(page, 'sourcing', OPERATIONS, [
    '/queues',
    '/approvals',
    '/intake',
    `/intake/${id('enquiryId')}`,
    '/rfqs',
    `/rfqs/${id('rfqId')}`,
    '/sales-orders',
    `/sales-orders/${id('orderId')}`,
    '/suppliers/verification',
    `/suppliers/${id('newSupplierProfileUrl')}`,
    '/leakage-reviews',
    '/changes',
  ]);
});

test('ops · sales and finance screens', async ({ page }) => {
  await sweep(page, 'sales', OPERATIONS, ['/quotes', `/quotes/${id('quoteStandard')}`, `/awards/${id('awardId')}`, '/finance/margin']);
  await sweep(page, 'finance', OPERATIONS, ['/finance', '/finance/bills', '/finance/margin', '/approvals', `/sales-orders/${id('stOrderId')}`]);
});

test('ops · engineering and quality screens', async ({ page }) => {
  await sweep(page, 'engineering', OPERATIONS, [`/sales-orders/${id('orderId')}/production`, `/changes/${id('changeId')}`, '/production']);
  await sweep(page, 'quality', OPERATIONS, [
    '/quality',
    `/quality/inspections/${id('faiId')}`,
    '/quality/instruments',
    '/quality/ncrs',
    `/quality/ncrs/${id('ncrId')}`,
    `/quality/plans/${id('qaPlanId')}`,
    `/quality/releases/${id('qaWorkPackageId')}`,
    '/production',
  ]);
});

test('ops · logistics and support screens', async ({ page }) => {
  await sweep(page, 'logistics', OPERATIONS, [
    '/logistics',
    `/logistics/dispatch/new?salesOrderId=${id('lgOrderId')}`,
    `/logistics/shipments/${id('inboundShipmentId')}`,
    `/logistics/shipments/${id('outboundShipmentId')}`,
    `/logistics/work-packages/${id('lgWorkPackageId')}`,
  ]);
  await sweep(page, 'support', OPERATIONS, ['/support', `/support/${id('caseId')}`, '/leakage-reviews']);
});

/** Every link in the shell's primary navigation opens a screen (groups open first). */
async function everyNavLink(page: Page, base: string): Promise<void> {
  const nav = page.getByRole('navigation', { name: 'Primary' }).first();
  // The portal shows no audience's links until /auth/me has answered (shell.tsx), so on a
  // slow runner the shell is still empty right after goto: wait for the signed-in
  // navigation instead of reading whatever is there first.
  await expect.poll(() => page.locator('nav a[href^="/"]').count(), { message: 'the shell has links' }).toBeGreaterThan(3);
  const groups = nav.locator('button[aria-expanded]');
  for (let i = 0; i < (await groups.count()); i++) {
    const group = groups.nth(i);
    await group.click();
    await expect(group).toHaveAttribute('aria-expanded', 'true');
    // Each group's links are in the viewport once open (D9: none may run off-screen).
    for (const link of await page.locator(`#${await group.getAttribute('aria-controls')} a`).all()) await expect(link).toBeInViewport();
    await page.keyboard.press('Escape');
  }
  const hrefs = new Set<string>();
  for (const link of await page.locator('nav a[href^="/"]').all()) hrefs.add((await link.getAttribute('href'))!);
  expect(hrefs.size, 'the shell has links').toBeGreaterThan(3);
  for (const href of hrefs) await open(page, `${base}${href}`, { allowAlert: true });
}

test('ops · every navigation link and group resolves', async ({ page }) => {
  await signInAs(page, 'admin');
  await page.goto(`${OPERATIONS}/`);
  await everyNavLink(page, OPERATIONS);
});

test('customer · every navigation link resolves', async ({ page }) => {
  await signInAs(page, 'buyer');
  await page.goto(`${PORTAL}/`);
  await everyNavLink(page, PORTAL);
});

test('supplier · every navigation link resolves', async ({ page }) => {
  await signInAs(page, 'supplierA');
  await page.goto(`${PORTAL}/supplier`);
  await everyNavLink(page, PORTAL);
});

/** A refusal: the screen renders (heading, no 5xx) and says no, and shows none of the record. */
async function refused(page: Page, url: string, mustNotShow: RegExp): Promise<void> {
  await open(page, url, { allowAlert: true });
  await expect(page.locator('body')).not.toContainText(mustNotShow);
}

test('customer · is refused the supplier screens', async ({ page }) => {
  await signInAs(page, 'buyer');
  for (const path of [`/rfqs/${id('rfqId')}`, `/supplier/orders/${id('purchaseOrderId')}`, `/supplier/inspections/${id('faiId')}`, `/supplier/ncrs/${id('ncrId')}`, '/supplier/bills']) {
    await refused(page, `${PORTAL}${path}`, /Anand|PO-\d{4}-\d{4}|Price each/);
  }
});

test('supplier · is refused the customer screens and another supplier’s', async ({ page }) => {
  await signInAs(page, 'supplierB');
  for (const path of [`/orders/${id('orderId')}`, `/quotations/${id('quoteStandard')}`, `/invoices/${id('stInvoiceId')}`, `/supplier/orders/${id('purchaseOrderId')}`, `/supplier/shipments/${id('inboundShipmentId')}`]) {
    await refused(page, `${PORTAL}${path}`, /Kovai|LOT-L1|₹\s?[1-9]/);
  }
});

test('public · signed-out visitors are sent to sign in', async ({ page }) => {
  await page.goto(`${PORTAL}/`);
  await expect(page).toHaveURL(/\/welcome$/);
  for (const path of ['/orders', '/supplier/orders', '/invoices']) {
    await open(page, `${PORTAL}${path}`, { allowAlert: true });
    await expect(page.locator('body')).not.toContainText(/SO-\d{4}|PO-\d{4}|INV-\d{4}/);
  }
  for (const path of ['/approvals', '/finance', '/sales-orders']) {
    await page.goto(`${OPERATIONS}${path}`);
    // W15: sent to sign in, never shown an empty list as if nothing were waiting.
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.locator('body')).not.toContainText(/SO-\d{4}|INV-\d{4}|Award on/);
  }
});

test('ops · a JobWork role without authority is refused, never served a 500', async ({ page }) => {
  await signInAs(page, 'quality');
  for (const path of ['/finance', '/finance/bills', `/quotes/${id('quoteStandard')}`, '/organizations', '/audit']) {
    await refused(page, `${OPERATIONS}${path}`, /₹\s?[1-9][\d,]*\.\d\d.*margin/i);
  }
  await signInAs(page, 'support');
  await refused(page, `${OPERATIONS}/awards/${id('awardId')}`, /₹48\.50/);
  void world;
});
