#!/usr/bin/env node
// API actions for the provider-outage drill (IN-12 F-12.2); `provider-outage.sh` stops
// and restarts the dependencies around them and checks the database. Each action prints
// one machine-readable line, `key=value …`, and exits non-zero only on a broken
// expectation, never on the outage it is probing.
//
//   node infra/drills/outage.mjs message <enquiryId>
//   node infra/drills/outage.mjs upload
//   node infra/drills/outage.mjs read
//   node infra/drills/outage.mjs pay <invoiceId>
//   node infra/drills/outage.mjs callback <providerIntentId> <amountMinor>
//   node infra/drills/outage.mjs sweep
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Session, sha256 } from './client.mjs';

const BASE = process.env.DRILL_BASE ?? 'http://localhost:4000';
const [, , action, ...rest] = process.argv;
const out = (fields) => console.log(Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' '));

// One sign-in per drill run: the session is kept in a file between actions, so the drill
// probes outages rather than the sign-in rate limit.
const SESSION_FILE = process.env.DRILL_SESSION_FILE;

async function buyer() {
  const session = new Session(BASE);
  const saved = SESSION_FILE && existsSync(SESSION_FILE) ? readFileSync(SESSION_FILE, 'utf8') : '';
  if (saved) {
    session.jar = new Map(JSON.parse(saved));
    if ((await session.get('/auth/me')).status === 200) return session;
    session.jar = new Map();
  }
  await session.signIn(process.env.DRILL_BUYER_EMAIL ?? 'buyer@demo.local', process.env.DRILL_BUYER_PASSWORD ?? 'demo-portal-password-1', process.env.DRILL_BUYER_TOTP);
  if (SESSION_FILE) writeFileSync(SESSION_FILE, JSON.stringify([...session.jar]), { mode: 0o600 });
  return session;
}

async function service(path) {
  const { mintServiceToken, SCAN_WORKER_PRINCIPAL, SERVICE_TOKEN_HEADER } = await import('../../packages/service-auth/dist/index.js');
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method: 'POST',
    headers: { [SERVICE_TOKEN_HEADER]: mintServiceToken(process.env.SERVICE_TOKEN_SECRET ?? 'dev-service-token-secret', SCAN_WORKER_PRINCIPAL.name), origin: 'http://localhost:3000' },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

switch (action) {
  case 'message': {
    // A customer message: commits a message and an outbox event, whoever delivers it.
    const s = await buyer();
    const res = await s.post(`/conversations/enquiry/${rest[0]}/messages`, { audience: 'customer', body: `Outage drill ${new Date().toISOString()}: please confirm the delivery date.` });
    out({ status: res.status, messageId: res.body.messageId ?? res.body.message?.messageId ?? '' });
    if (res.status !== 201) process.exit(1);
    break;
  }
  case 'upload': {
    // The full upload path: initiate → PUT the bytes to the store → finalize.
    const s = await buyer();
    const bytes = Buffer.from(`%PDF-1.4\n% outage drill ${randomUUID()}\n%%EOF\n`);
    const init = await s.post('/documents/uploads', { purpose: 'drawing_2d', filename: 'drill.pdf', declaredMediaType: 'application/pdf', byteSize: bytes.length, sha256: sha256(bytes) });
    if (init.status !== 201) {
      out({ step: 'initiate', status: init.status, code: init.body.code ?? '' });
      break;
    }
    let put = 'ok';
    try {
      const res = await fetch(init.body.grant.url, { method: init.body.grant.method, headers: init.body.grant.headers, body: bytes });
      put = String(res.status);
    } catch (err) {
      put = `unreachable(${err.cause?.code ?? err.name})`;
    }
    const fin = await s.post(`/documents/uploads/${init.body.uploadSessionId}/finalize`, { byteSize: bytes.length, sha256: sha256(bytes), title: 'Outage drill' });
    out({ step: 'finalize', put, status: fin.status, code: fin.body.code ?? '', session: init.body.uploadSessionId });
    break;
  }
  case 'read': {
    // Sign-in and the customer's own screens: database truth, nothing else.
    const s = await buyer();
    const [enquiries, orders] = await Promise.all([s.get('/enquiries'), s.get('/orders')]);
    out({ signin: 'ok', enquiries: enquiries.status, orders: orders.status, ms: Math.max(enquiries.ms, orders.ms) });
    if (enquiries.status !== 200 || orders.status !== 200) process.exit(1);
    break;
  }
  case 'pay': {
    const s = await buyer();
    const res = await s.post(`/invoices/${rest[0]}/pay`, undefined, { 'idempotency-key': `drill-${randomUUID()}` });
    out({ status: res.status, intentId: res.body.paymentIntentId ?? '', amountMinor: res.body.amountMinor ?? '' });
    if (res.status !== 201) process.exit(1);
    break;
  }
  case 'callback': {
    // A provider callback signed as the dev gateway signs it, arriving now.
    const [intentId, amountMinor] = rest;
    const id = `evt_${randomUUID()}`;
    const body = JSON.stringify({ id, type: 'payment.captured', data: { intentId, transactionId: `txn_drill_${randomBytes(6).toString('hex')}`, amountMinor: Number(amountMinor), currency: 'INR', occurredAt: new Date().toISOString() } });
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await fetch(`${BASE}/api/v1/webhooks/payments/dev`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dev-signature': createHmac('sha256', process.env.PAYMENT_WEBHOOK_SECRET ?? 'dev-payment-webhook-secret').update(`${ts}.${body}`).digest('hex'), 'x-dev-timestamp': ts, 'x-dev-delivery-id': id },
      body,
    });
    const parsed = await res.json().catch(() => ({}));
    out({ status: res.status, outcome: parsed.outcome ?? '', transactionId: parsed.transactionId ?? '' });
    break;
  }
  case 'sweep': {
    const res = await service('/internal/payments/reconcile-sweep');
    out({ status: res.status, expired: res.body.expired ?? '' });
    break;
  }
  default:
    console.error(`unknown action ${action}`);
    process.exit(2);
}
