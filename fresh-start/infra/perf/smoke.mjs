#!/usr/bin/env node
// Performance smoke (F-11.5; doc 12 §1; doc 13 §10). Not a load test — that is IN-12
// (`phase1-load.js`). It signs in a customer and a JobWork sourcing user, drives the
// screens they open most at a paced rate, and checks the doc 12 §1 objectives that a
// running API can show: normal API p95 under 500 ms, supplier search p95 under 1.5 s.
// Dependency-free so the nightly job needs nothing but Node.
//
//   node infra/perf/smoke.mjs --base http://localhost:4000 --duration 30 --concurrency 4 --rps 8
//
// Accounts come from `pnpm seed` (override with SMOKE_* variables). An MFA-enrolled
// sourcing account needs SMOKE_SOURCING_TOTP_SECRET. Pacing keeps the run inside the
// API's per-person read budget, so it measures latency, not rate limiting; a 429 is
// counted separately and fails the run, because it means the pacing is wrong.

import { createHmac } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith('--') ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), []),
);
const BASE = (args.base ?? process.env.SMOKE_BASE_URL ?? 'http://localhost:4000').replace(/\/$/, '');
const DURATION_S = Number(args.duration ?? process.env.SMOKE_DURATION_S ?? 30);
const CONCURRENCY = Number(args.concurrency ?? process.env.SMOKE_CONCURRENCY ?? 4);
const RPS = Number(args.rps ?? process.env.SMOKE_RPS ?? 8);
const OBJECTIVES = { normal: 0.5, search: 1.5 };

const ACCOUNTS = {
  customer: { email: process.env.SMOKE_BUYER_EMAIL ?? 'buyer@demo.local', password: process.env.SMOKE_BUYER_PASSWORD ?? 'demo-portal-password-1' },
  sourcing: {
    email: process.env.SMOKE_SOURCING_EMAIL ?? 'sourcing@jobwork.local',
    password: process.env.SMOKE_SOURCING_PASSWORD ?? 'sourcing-dev-password-1',
    totpSecret: process.env.SMOKE_SOURCING_TOTP_SECRET,
  },
};

// RFC 6238 TOTP (SHA-1, 6 digits, 30 s), as the API's authenticator enrolment issues.
function totp(base32) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of base32.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const mac = createHmac('sha1', key).update(counter).digest();
  const offset = mac[mac.length - 1] & 0xf;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

async function call(session, method, path, body) {
  const headers = { 'x-forwarded-for': '198.18.0.1' };
  if (session.cookie) headers.cookie = session.cookie;
  if (session.csrf && method !== 'GET') headers['x-csrf-token'] = session.csrf;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const started = performance.now();
  const res = await fetch(`${BASE}/api/v1${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  const seconds = (performance.now() - started) / 1000;
  for (const raw of res.headers.getSetCookie()) {
    const [pair] = raw.split(';');
    const [name, value] = pair.split('=');
    session.jar.set(name.trim(), value);
  }
  session.cookie = [...session.jar.entries()].filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('; ');
  session.csrf = session.jar.get('jw_csrf');
  return { status: res.status, body: text ? JSON.parse(text) : {}, seconds };
}

async function signIn({ email, password, totpSecret }) {
  const session = { jar: new Map(), cookie: '', csrf: undefined };
  const login = await call(session, 'POST', '/auth/login', { email, password });
  if (login.status !== 201) throw new Error(`sign-in failed for ${email}: ${login.status} ${login.body.code ?? ''}`);
  if (login.body.mfaRequired) {
    if (!totpSecret) throw new Error(`${email} needs SMOKE_SOURCING_TOTP_SECRET`);
    const mfa = await call(session, 'POST', '/auth/mfa', { code: totp(totpSecret) });
    if (mfa.status !== 201) throw new Error(`MFA failed for ${email}: ${mfa.status}`);
  }
  return session;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

async function main() {
  const customer = await signIn(ACCOUNTS.customer);
  const sourcing = await signIn(ACCOUNTS.sourcing);
  const anonymous = { jar: new Map(), cookie: '' };

  const journeys = [
    { name: 'health', kind: 'normal', session: anonymous, path: '/health' },
    { name: 'public categories', kind: 'normal', session: anonymous, path: '/public/categories' },
    { name: 'customer: who am I', kind: 'normal', session: customer, path: '/auth/me' },
    { name: 'customer: home summary', kind: 'normal', session: customer, path: '/portal/summary' },
    { name: 'customer: enquiries', kind: 'normal', session: customer, path: '/enquiries' },
    { name: 'customer: quotations', kind: 'normal', session: customer, path: '/quotations' },
    { name: 'customer: orders', kind: 'normal', session: customer, path: '/orders' },
    { name: 'customer: notifications', kind: 'normal', session: customer, path: '/notifications' },
    { name: 'ops: command center', kind: 'normal', session: sourcing, path: '/operations/summary' },
    { name: 'ops: work queues', kind: 'normal', session: sourcing, path: '/queues' },
    { name: 'ops: intake queue', kind: 'normal', session: sourcing, path: '/intake/queue' },
    { name: 'ops: RFQs', kind: 'normal', session: sourcing, path: '/rfqs' },
    { name: 'ops: suppliers', kind: 'normal', session: sourcing, path: '/suppliers' },
  ];
  // Supplier search needs an enquiry to match against; the seed may have none.
  const intake = await call(sourcing, 'GET', '/intake/queue');
  const enquiryId = (intake.body.items ?? intake.body.enquiries ?? [])[0]?.enquiryId;
  if (enquiryId) journeys.push({ name: 'ops: supplier search', kind: 'search', session: sourcing, path: `/rfqs/match?enquiryId=${enquiryId}` });

  const samples = new Map(journeys.map((j) => [j.name, { kind: j.kind, seconds: [], errors: 0, limited: 0 }]));
  const deadline = Date.now() + DURATION_S * 1000;
  const interval = 1000 / RPS;
  let next = Date.now();
  let index = 0;
  const take = async () => {
    // A shared schedule: the whole run makes RPS requests a second, whatever the concurrency.
    const at = next;
    next += interval;
    const wait = at - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    return journeys[index++ % journeys.length];
  };
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (Date.now() < deadline) {
        const journey = await take();
        if (Date.now() >= deadline) break;
        const s = samples.get(journey.name);
        try {
          const res = await call(journey.session, 'GET', journey.path);
          if (res.status === 429) s.limited += 1;
          else if (res.status >= 400) s.errors += 1;
          else s.seconds.push(res.seconds);
        } catch {
          s.errors += 1;
        }
      }
    }),
  );

  const rows = [...samples.entries()].map(([name, s]) => {
    const sorted = [...s.seconds].sort((a, b) => a - b);
    return { name, kind: s.kind, n: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99), errors: s.errors, limited: s.limited };
  });
  const pooled = (kind) => {
    const all = [...samples.values()].filter((s) => s.kind === kind).flatMap((s) => s.seconds).sort((a, b) => a - b);
    return { n: all.length, p50: percentile(all, 50), p95: percentile(all, 95), p99: percentile(all, 99) };
  };
  const normal = pooled('normal');
  const search = pooled('search');
  const total = rows.reduce((t, r) => t + r.n + r.errors + r.limited, 0);
  const errors = rows.reduce((t, r) => t + r.errors, 0);
  const limited = rows.reduce((t, r) => t + r.limited, 0);
  const verdicts = {
    normalApiP95: normal.p95 !== null && normal.p95 < OBJECTIVES.normal,
    supplierSearchP95: search.n === 0 ? 'not measured (no enquiry to match)' : search.p95 < OBJECTIVES.search,
    errorRateUnder1Percent: errors / Math.max(total, 1) < 0.01,
    noRateLimiting: limited === 0,
  };

  const ms = (v) => (v === null ? '—' : `${Math.round(v * 1000)} ms`);
  console.log(`\nJobWork perf smoke — ${BASE}, ${DURATION_S}s at ${RPS} req/s, ${CONCURRENCY} workers, ${total} requests\n`);
  console.log(['journey'.padEnd(28), 'n'.padStart(5), 'p50'.padStart(8), 'p95'.padStart(8), 'p99'.padStart(8), 'err'.padStart(5), '429'.padStart(5)].join(' '));
  for (const r of rows) console.log([r.name.padEnd(28), String(r.n).padStart(5), ms(r.p50).padStart(8), ms(r.p95).padStart(8), ms(r.p99).padStart(8), String(r.errors).padStart(5), String(r.limited).padStart(5)].join(' '));
  console.log(`\nnormal API p95 ${ms(normal.p95)} (objective < 500 ms) · supplier search p95 ${ms(search.p95)} (objective < 1500 ms) · errors ${errors} · rate limited ${limited}`);
  console.log(JSON.stringify(verdicts));

  const out = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'var', 'perf');
  mkdirSync(out, { recursive: true });
  const file = join(out, `smoke-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify({ base: BASE, durationSeconds: DURATION_S, rps: RPS, concurrency: CONCURRENCY, normal, search, rows, verdicts }, null, 2));
  console.log(`report: ${file}`);
  if (Object.values(verdicts).some((v) => v === false)) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(2);
});
