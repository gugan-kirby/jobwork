#!/usr/bin/env node
// Critical-journey synthetic test (doc 12 §9 step 7) for a restored or recovering stack.
// Read-only: it signs in as a customer and as JobWork sourcing, opens the screens each
// relies on, and downloads one document to prove the database and the object store
// agree. Prints `document <versionId> <sha256>` for the caller to compare with the row.
//
//   DRILL_BASE=http://localhost:4100 \
//   DRILL_BUYER_TOTP=… DRILL_SOURCING_TOTP=… node infra/drills/journey.mjs
import { reporter, Session, sha256 } from './client.mjs';

const BASE = process.env.DRILL_BASE ?? 'http://localhost:4000';
const r = reporter('journey');

const health = await fetch(`${BASE}/api/v1/health`).then((res) => res.json());
r.check('API answers and reaches its database', health.status === 'ok' && health.db === 'ok', `db=${health.db}`);

const buyer = await new Session(BASE).signIn(process.env.DRILL_BUYER_EMAIL ?? 'buyer@demo.local', process.env.DRILL_BUYER_PASSWORD ?? 'demo-portal-password-1', process.env.DRILL_BUYER_TOTP);
const enquiries = await buyer.get('/enquiries');
r.check('customer lists enquiries', enquiries.status === 200 && Array.isArray(enquiries.body.enquiries), `${enquiries.body.enquiries?.length ?? 0} found, ${enquiries.ms} ms`);
const orders = await buyer.get('/orders');
r.check('customer lists orders', orders.status === 200, `${orders.ms} ms`);
const quotes = await buyer.get('/quotations');
r.check('customer lists quotations', quotes.status === 200, `${quotes.ms} ms`);

const sourcing = await new Session(BASE).signIn(process.env.DRILL_SOURCING_EMAIL ?? 'sourcing@jobwork.local', process.env.DRILL_SOURCING_PASSWORD ?? 'sourcing-dev-password-1', process.env.DRILL_SOURCING_TOTP);
const rfqs = await sourcing.get('/rfqs');
r.check('sourcing lists RFQ rounds', rfqs.status === 200, `${rfqs.ms} ms`);
const queue = await sourcing.get('/intake/queue');
r.check('sourcing opens the intake queue', queue.status === 200, `${queue.ms} ms`);

// One document the customer owns, end to end: row → grant → bytes → digest.
const docs = await buyer.get('/documents');
const candidate = (docs.body.documents ?? []).find((d) => d.currentVersionScanState === 'clean' && d.currentVersionId);
if (!candidate) {
  r.check('customer has a clean document to download', false, 'none found');
} else {
  const grant = await buyer.get(`/documents/versions/${candidate.currentVersionId}/download`);
  r.check('download grant issued', grant.status === 200 && typeof grant.body.url === 'string', `${grant.status}`);
  if (grant.status === 200) {
    const bytes = Buffer.from(await (await fetch(grant.body.url)).arrayBuffer());
    console.log(`document ${candidate.currentVersionId} ${sha256(bytes)}`);
    r.check('bytes downloaded through the grant', bytes.length > 0, `${bytes.length} bytes`);
  }
}
r.exit();
