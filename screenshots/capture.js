const puppeteer = require('puppeteer-core');
const { execSync } = require('node:child_process');
const { mkdirSync } = require('node:fs');
const { join } = require('node:path');

const OUT = process.argv[2] ?? '/Users/gugan/Downloads/JobWorkV2/screenshots';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORTAL = 'http://localhost:3000';
const OPS = 'http://localhost:3001';

const DESKTOP = { width: 1280, height: 900 };
const WIDE = { width: 1400, height: 1000 };
const MOBILE = { width: 320, height: 900 };

function totp() {
  const secret = execSync(
    `psql jobwork_dev -t -A -c "SELECT mfa_totp_secret FROM iam.user_account WHERE email='admin@jobwork.local'"`,
  ).toString().trim();
  return execSync(
    `cd /Users/gugan/Downloads/JobWorkV2/fresh-start/apps/api && node -e "` +
    `const O=require('otpauth');` +
    `const t=new O.TOTP({issuer:'JobWork',label:'a',algorithm:'SHA1',digits:6,period:30,secret:O.Secret.fromBase32('${secret}')});` +
    `console.log(t.generate())"`,
  ).toString().trim();
}

/** Logs in through the API the page is proxying to, so the session cookie is first-party. */
async function login(page, origin, email, password, code) {
  await page.goto(`${origin}/login`, { waitUntil: 'networkidle2' });
  const status = await page.evaluate(async (creds) => {
    const r = await fetch('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(creds),
      credentials: 'same-origin',
    });
    return { status: r.status, body: await r.json() };
  }, { email, password });
  if (status.body?.mfaRequired) {
    await page.evaluate(async (c) => {
      const csrf = document.cookie.match(/jw_csrf=([^;]+)/)?.[1] ?? '';
      await fetch('/api/v1/auth/mfa', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify({ code: c }),
        credentials: 'same-origin',
      });
    }, code);
  }
}

async function shot(page, origin, path, file, viewport, prepare) {
  await page.setViewport(viewport);
  await page.goto(`${origin}${path}`, { waitUntil: 'networkidle2' });
  if (prepare) await prepare(page);
  await new Promise((r) => setTimeout(r, 400));
  const out = join(OUT, file);
  await page.screenshot({ path: out, fullPage: true });
  console.log('  ' + out);
}

(async () => {
  mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({ headless: 'new', executablePath: CHROME });

  // ---------------------------------------------------------------- portal
  console.log('portal (customer, buyer@demo.local)');
  const portal = await browser.newPage();
  await shot(portal, PORTAL, '/login', '01-portal-login.png', DESKTOP);
  await login(portal, PORTAL, 'buyer@demo.local', 'demo-portal-password-1');

  await shot(portal, PORTAL, '/', '02-portal-home.png', DESKTOP);
  await shot(portal, PORTAL, '/enquiries', '03-portal-enquiry-list.png', DESKTOP);
  await shot(portal, PORTAL, '/documents', '04-portal-documents.png', DESKTOP);
  await shot(portal, PORTAL, '/account/security', '05-portal-account-security.png', DESKTOP);

  // The wizard, including a deliberately failed submit so the error summary,
  // the stepper's error states and the inline field errors are all captured.
  await shot(portal, PORTAL, '/enquiries/new', '06-wizard-step1.png', DESKTOP);
  await shot(portal, PORTAL, '/enquiries/new', '07-wizard-errors-after-submit.png', DESKTOP, async (page) => {
    const steps = await page.$$('nav[aria-label="Enquiry steps"] li button');
    await steps[6].click();
    await new Promise((r) => setTimeout(r, 300));
    const buttons = await page.$$('button');
    for (const b of buttons) {
      const text = await b.evaluate((el) => el.textContent.trim());
      if (text === 'Submit enquiry') { await b.click(); break; }
    }
    await new Promise((r) => setTimeout(r, 1500));
    await page.evaluate(() => window.scrollTo(0, 0));
  });

  // ---------------------------------------------------------------- mobile
  console.log('portal at 320px (doc 21 §9 reflow)');
  await shot(portal, PORTAL, '/enquiries', '08-mobile-enquiry-list-320.png', MOBILE);
  await shot(portal, PORTAL, '/enquiries/new', '09-mobile-wizard-320.png', MOBILE);
  await shot(portal, PORTAL, '/enquiries/new', '10-mobile-nav-open-320.png', MOBILE, async (page) => {
    await page.click('button.jw-nav-toggle');
    await new Promise((r) => setTimeout(r, 300));
  });

  // ---------------------------------------------------------------- operations
  // A separate browser context: cookies ignore ports, so one profile cannot hold a
  // portal session and an operations session at the same time on localhost.
  console.log('operations (internal, admin@jobwork.local)');
  const context = await browser.createBrowserContext();
  const ops = await context.newPage();
  await shot(ops, OPS, '/login', '11-ops-login.png', DESKTOP);
  await login(ops, OPS, 'admin@jobwork.local', 'admin-dev-password-1', totp());

  await shot(ops, OPS, '/', '12-ops-home.png', DESKTOP);
  await shot(ops, OPS, '/intake', '13-ops-intake-queue.png', WIDE);

  const enquiryId = execSync(
    `psql jobwork_dev -t -A -c "SELECT id FROM sourcing.enquiry WHERE reference IS NOT NULL ORDER BY submitted_at LIMIT 1"`,
  ).toString().trim();
  await shot(ops, OPS, `/intake/${enquiryId}`, '14-ops-intake-workspace.png', WIDE);
  await shot(ops, OPS, '/suppliers/verification', '15-ops-supplier-verification.png', WIDE);
  await shot(ops, OPS, '/audit', '16-ops-audit-explorer.png', WIDE);
  await shot(ops, OPS, `/intake/${enquiryId}`, '17-mobile-ops-workspace-320.png', MOBILE);
  await shot(ops, OPS, '/intake', '18-mobile-ops-queue-320.png', MOBILE);

  await browser.close();
  console.log('\ndone');
})().catch((err) => { console.error(err); process.exit(1); });
