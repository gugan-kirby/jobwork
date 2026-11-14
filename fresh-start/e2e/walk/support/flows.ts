import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ApiSession, type Body, ok } from '../../support/api';
import { apiAs, daysFromNow, FIXTURES, type Who } from './walk';

/**
 * FW.0: the API builders a chapter uses to reach its starting state, so each chapter's
 * screens are driven from a known record and a chapter can be rerun on its own against the
 * same database. The browser then does the chapter's own steps.
 */

const sessions = new Map<Who, Promise<ApiSession>>();
/**
 * One API session per actor for the run, signed in again once the walk has ended it:
 * suspending a member (chapter 10) revokes every session that member holds.
 */
export const as = async (who: Who): Promise<ApiSession> => {
  const cached = sessions.get(who);
  if (cached && (await (await cached).get('/auth/me')).status === 200) return cached;
  const fresh = apiAs(who);
  sessions.set(who, fresh);
  return fresh;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Uploads a fixture the way the product does (initiate, PUT, finalize) and waits for the worker's scan. */
export async function upload(who: Who, purpose: 'drawing_2d' | 'certificate' | 'image', file = purpose === 'image' ? 'photo.png' : 'drawing.pdf'): Promise<{ documentId: string; documentVersionId: string }> {
  const s = await as(who);
  const bytes = readFileSync(join(FIXTURES, file));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const type = file.endsWith('.png') ? 'image/png' : 'application/pdf';
  const key = randomUUID();
  const started = ok(await s.post('/documents/uploads', { purpose, filename: `${purpose}-${key.slice(0, 6)}${file.slice(file.lastIndexOf('.'))}`, declaredMediaType: type, byteSize: bytes.length, sha256 }, { 'idempotency-key': key }), 201, 'initiate upload');
  const grant = started['grant'] as { method: string; url: string; headers: Record<string, string> };
  const headers = Object.fromEntries(Object.entries(grant.headers).filter(([k]) => k.toLowerCase() !== 'content-length'));
  const put = await fetch(grant.url, { method: grant.method, headers, body: bytes });
  if (!put.ok) throw new Error(`object store refused the upload: ${put.status} ${await put.text()}`);
  const done = ok(await s.post(`/documents/uploads/${started['uploadSessionId']}/finalize`, { byteSize: bytes.length, sha256 }, { 'idempotency-key': `${key}:finalize` }), 201, 'finalize upload');
  for (let i = 0; i < 60; i++) {
    const manifest = ok(await s.get(`/documents/${done['documentId']}/manifest`), 200, 'manifest');
    const v = (manifest['versions'] as Body[]).find((x) => x['documentVersionId'] === done['documentVersionId']);
    if (v?.['status'] === 'available') return { documentId: done['documentId'] as string, documentVersionId: done['documentVersionId'] as string };
    if (v?.['status'] === 'quarantined') throw new Error('the scan quarantined the walk fixture');
    await sleep(1000);
  }
  throw new Error('the scan never finished: is the worker running?');
}

export async function capability(code: string): Promise<string> {
  const taxonomy = ok(await (await as('buyer')).get('/suppliers/me/taxonomy'), 200, 'taxonomy')['capabilities'] as Body[];
  return taxonomy.find((c) => c['code'] === code)!['capabilityId'] as string;
}

export async function libraryDrawing(title = 'Bracket drawing'): Promise<string> {
  const documents = ok(await (await as('buyer')).get('/documents'), 200, 'documents')['documents'] as Body[];
  return documents.find((d) => d['title'] === title)!['currentVersionId'] as string;
}

export async function submittedEnquiry(title: string): Promise<string> {
  const buyer = await as('buyer');
  const draft = ok(
    await buyer.post('/enquiries/draft', {
      title,
      applicationNote: 'Mounts the drive motor on a pump skid.',
      requiredByDate: daysFromNow(60),
      items: [
        {
          lineNo: 1,
          partName: 'Bracket',
          description: 'Machined aluminium bracket',
          processCapabilityId: await capability('cnc_milling'),
          materialCapabilityId: await capability('material_aluminium'),
          materialGrade: '6061-T6',
          quantityBreakpoints: [{ quantity: 100, unit: 'piece', kind: 'production' }],
          toleranceClass: 'IT8',
          inspectionLevel: 'dimensional_report',
        },
      ],
      documents: [{ documentVersionId: await libraryDrawing(), role: 'governing', lineNo: 1 }],
    }),
    201,
    'draft',
  );
  const submitted = ok(await buyer.post(`/enquiries/${draft['enquiryId']}/submit`, { expectedVersion: draft['aggregateVersion'] }), 201, 'submit');
  return (submitted['enquiryId'] as string | undefined) ?? (draft['enquiryId'] as string);
}

async function intakeVersion(id: string): Promise<number> {
  return (ok(await (await as('engineering')).get(`/intake/${id}`), 200, 'intake')['enquiry'] as Body)['aggregateVersion'] as number;
}

export async function approvedEnquiry(title: string): Promise<string> {
  const enquiryId = await submittedEnquiry(title);
  const eng = await as('engineering');
  ok(await eng.post(`/intake/${enquiryId}/triage`, { expectedVersion: await intakeVersion(enquiryId) }), 201, 'triage');
  ok(await eng.post(`/intake/${enquiryId}/approve`, { expectedVersion: await intakeVersion(enquiryId) }), 201, 'approve');
  return enquiryId;
}

export async function rfqVersion(rfqId: string): Promise<number> {
  return (ok(await (await as('sourcing')).get(`/rfqs/${rfqId}`), 200, 'rfq')['rfq'] as Body)['aggregateVersion'] as number;
}

/** A released round with both suppliers invited; no bids yet. */
export async function openRound(enquiryId: string): Promise<{ rfqId: string; itemId: string }> {
  const sourcing = await as('sourcing');
  const rfqId = ok(await sourcing.post('/rfqs', { enquiryId, deadlineAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), lateBidPolicy: 'reject', instructions: 'Quote per piece at 100 off.' }), 201, 'rfq')['rfqId'] as string;
  const candidates = ok(await sourcing.get(`/rfqs/match?enquiryId=${enquiryId}`), 200, 'match')['candidates'] as Body[];
  for (const c of candidates.filter((x) => x['eligible'] && /Anand|Balaji/.test(String(x['displayName'])))) ok(await sourcing.post(`/rfqs/${rfqId}/invitations`, { supplierProfileId: c['supplierProfileId'] }), 201, 'invite');
  ok(await sourcing.post(`/rfqs/${rfqId}/release`, { expectedVersion: await rfqVersion(rfqId) }), 201, 'release');
  const itemId = ((ok(await (await as('supplierA')).get(`/supplier/rfqs/${rfqId}`), 200, 'supplier rfq')['items'] as Body[])[0]!['rfqItemId']) as string;
  return { rfqId, itemId };
}

export const bidBody = (itemId: string, price: number): Body => ({
  currency: 'INR',
  taxTreatment: 'gst_extra',
  lines: [{ rfqItemId: itemId, lineNo: 1, quantity: 100, unit: 'piece', unitPriceMinor: price, setupAmountMinor: 500000, note: '' }],
  nreAmountMinor: 0,
  freightAmountMinor: 250000,
  leadTimeDays: 21,
  validityUntil: daysFromNow(30),
  feasibility: 'feasible',
  assumptions: 'Material from our stock.',
  exclusions: 'Surface treatment not included.',
  paymentTerms: '30 days from invoice',
  note: '',
});

export interface Round {
  enquiryId: string;
  rfqId: string;
  itemId: string;
  bidA: string;
}

/** Bids from both suppliers, round closed for evaluation. */
export async function sourced(title: string): Promise<Round> {
  const enquiryId = await approvedEnquiry(title);
  const { rfqId, itemId } = await openRound(enquiryId);
  const bidA = ok(await (await as('supplierA')).post(`/supplier/rfqs/${rfqId}/bid/submit`, bidBody(itemId, 4850)), 201, 'bid A')['bidVersionId'] as string;
  ok(await (await as('supplierB')).post(`/supplier/rfqs/${rfqId}/bid/submit`, bidBody(itemId, 5250)), 201, 'bid B');
  ok(await (await as('sourcing')).post(`/rfqs/${rfqId}/close`, { expectedVersion: await rfqVersion(rfqId) }), 201, 'close');
  return { enquiryId, rfqId, itemId, bidA };
}

export async function proposeAward(round: Round): Promise<{ awardId: string; approvalRequestId: string }> {
  const sourcing = await as('sourcing');
  const evaluationId = ok(await sourcing.post(`/rfqs/${round.rfqId}/evaluations`, { scenario: { inspectionPackagingMinor: 0, financingRiskBp: 0, nreAllocation: 'value' } }), 201, 'evaluate')['evaluationId'];
  const award = ok(
    await sourcing.post('/awards', {
      rfqId: round.rfqId,
      evaluationId,
      items: [{ rfqItemId: round.itemId, targetQuantity: 100, lines: [{ bidVersionId: round.bidA, bidQuantity: 100, quantity: 100 }] }],
      rationale: 'Lowest normalized landed cost with the lead time the customer needs.',
    }),
    201,
    'award',
  );
  return { awardId: award['awardId'] as string, approvalRequestId: award['approvalRequestId'] as string };
}

export async function decide(who: Who, approvalRequestId: string): Promise<void> {
  ok(await (await as(who)).post(`/approvals/${approvalRequestId}/decide`, { decision: 'approved', reason: '' }), 201, `${who} approves`);
}

/** Award approved and an approved cost sheet version on it. */
export async function costed(round: Round): Promise<{ awardId: string; costSheetVersionId: string }> {
  const award = await proposeAward(round);
  await decide('sales', award.approvalRequestId);
  const sales = await as('sales');
  const sheet = ok(await sales.post(`/awards/${award.awardId}/cost-sheet`, { components: [{ code: 'freight_outbound', label: 'Freight to customer', amountMinor: 30000, basis: 'courier estimate' }], targetMarginBp: 1500, note: '' }), 201, 'cost sheet');
  const requested = ok(await sales.post(`/cost-sheets/${sheet['costSheetId']}/request-approval`, {}), 201, 'request cost sheet approval');
  await decide('finance', (requested['versions'] as Body[])[0]!['approvalRequestId'] as string);
  const approved = ok(await sales.get(`/cost-sheets/${sheet['costSheetId']}`), 200, 'cost sheet');
  return { awardId: award.awardId, costSheetVersionId: (approved['versions'] as Body[]).find((v) => v['status'] === 'approved')!['costSheetVersionId'] as string };
}

export async function quoteVersion(quoteId: string): Promise<number> {
  return ok(await (await as('sales')).get(`/quotes/${quoteId}`), 200, 'quote')['aggregateVersion'] as number;
}

export async function sentQuote(round: Round, optionLabel = 'standard', costSheetVersionId?: string): Promise<string> {
  const sheet = costSheetVersionId ?? (await costed(round)).costSheetVersionId;
  const sales = await as('sales');
  const quote = ok(
    await sales.post('/quotes', { costSheetVersionId: sheet, optionLabel, content: { deliveryLeadDays: 21, paymentTerms: '50% advance, balance before dispatch', validityUntil: daysFromNow(14), advanceBp: 5000, balanceTrigger: 'before_dispatch', taxRateBp: 1800, freightMinor: 0 } }),
    201,
    'quote',
  );
  const quoteId = quote['quoteId'] as string;
  const req = ok(await sales.post(`/quotes/${quoteId}/request-approval`, { expectedVersion: await quoteVersion(quoteId) }), 201, 'request quote approval');
  await decide('sales2', (req['versions'] as Body[])[0]!['approvalRequestId'] as string);
  ok(await sales.post(`/quotes/${quoteId}/send`, { expectedVersion: await quoteVersion(quoteId) }), 201, 'send quote');
  return quoteId;
}

export async function accepted(quoteId: string): Promise<string> {
  const approver = await as('approver');
  const seen = ok(await approver.get(`/quotations/${quoteId}`), 200, 'quotation');
  const res = ok(
    await approver.post(
      `/quotations/${quoteId}/accept`,
      { expectedVersion: seen['aggregateVersion'], quoteVersionNo: seen['versionNo'], contentHash: seen['contentHash'], termsHash: (seen['terms'] as Body)['hash'], acknowledgeTerms: true },
      { 'idempotency-key': `walk-accept-${quoteId}` },
    ),
    201,
    'accept',
  );
  return res['orderId'] as string;
}

/** Pays an invoice in full through the dev gateway's simulate endpoint (what `/pay` does). */
export async function pay(invoiceId: string): Promise<void> {
  const approver = await as('approver');
  const intent = ok(await approver.post(`/invoices/${invoiceId}/pay`), 201, 'start payment');
  ok(await approver.post(`/payments/intents/${intent['paymentIntentId']}/simulate`, { outcome: 'success' }), 201, 'simulate payment');
}

export async function salesOrder(orderId: string): Promise<Body> {
  return ok(await (await as('finance')).get(`/sales-orders/${orderId}`), 200, 'sales order');
}

export async function issuePurchaseOrders(orderId: string): Promise<string> {
  const sourcing = await as('sourcing');
  const so = ok(await sourcing.get(`/sales-orders/${orderId}`), 200, 'sales order');
  const pos = ok(await sourcing.post(`/sales-orders/${orderId}/purchase-orders`, { expectedVersion: so['aggregateVersion'] }), 201, 'issue POs')['purchaseOrders'] as Body[];
  return pos[0]!['purchaseOrderId'] as string;
}

export async function acknowledgePo(purchaseOrderId: string): Promise<void> {
  const a = await as('supplierA');
  const po = ok(await a.get(`/supplier/purchase-orders/${purchaseOrderId}`), 200, 'supplier PO');
  ok(await a.post(`/supplier/purchase-orders/${purchaseOrderId}/acknowledge`, { expectedVersion: po['aggregateVersion'], note: 'Material booked.' }), 201, 'acknowledge');
}

export interface Deal {
  round: Round;
  quoteId: string;
  orderId: string;
  purchaseOrderId: string;
}

/** Quote accepted, advance paid, purchase order issued (and acknowledged unless told not to). */
export async function orderedDeal(title: string, opts: { pay?: boolean; acknowledge?: boolean } = {}): Promise<Deal> {
  const round = await sourced(title);
  const quoteId = await sentQuote(round);
  const orderId = await accepted(quoteId);
  if (opts.pay !== false) await pay(((await salesOrder(orderId))['invoices'] as Body[])[0]!['invoiceId'] as string);
  const purchaseOrderId = await issuePurchaseOrders(orderId);
  if (opts.acknowledge !== false) await acknowledgePo(purchaseOrderId);
  return { round, quoteId, orderId, purchaseOrderId };
}

export async function productionView(orderId: string): Promise<Body> {
  return ok(await (await as('engineering')).get(`/sales-orders/${orderId}/production`), 200, 'production view');
}

export async function supplierProduction(purchaseOrderId: string): Promise<Body> {
  return ok(await (await as('supplierA')).get(`/supplier/purchase-orders/${purchaseOrderId}/production`), 200, 'supplier production');
}

export async function workPackage(deal: Deal): Promise<Body> {
  return ((await productionView(deal.orderId))['workPackages'] as Body[]).find((w) => w['purchaseOrderId'] === deal.purchaseOrderId)!;
}

/** Baseline released and transmitted, acknowledged by the supplier. */
export async function baselined(deal: Deal): Promise<string> {
  const eng = await as('engineering');
  const assembled = ok(await eng.post(`/sales-orders/${deal.orderId}/baselines`, { items: [{ documentVersionId: await libraryDrawing(), purpose: 'governing' }] }), 201, 'assemble baseline');
  const draft = (assembled['baselines'] as Body[]).find((b) => b['status'] === 'draft')!;
  ok(await eng.post(`/baselines/${draft['baselineId']}/release`, { expectedVersion: draft['aggregateVersion'] }), 201, 'release baseline');
  ok(await eng.post(`/sales-orders/${deal.orderId}/transmittals`, { baselineId: draft['baselineId'] }), 201, 'transmit');
  const transmittal = (await supplierProduction(deal.purchaseOrderId))['transmittal'] as Body;
  ok(await (await as('supplierA')).post(`/supplier/transmittals/${transmittal['transmittalId']}/acknowledge`, { expectedVersion: transmittal['aggregateVersion'], note: 'Drawing pack received.' }), 201, 'acknowledge transmittal');
  return draft['baselineId'] as string;
}

export async function qualityPlan(workPackageId: string): Promise<string> {
  const q = await as('quality');
  const draft = ok(await q.post('/quality-plans', { workPackageId, templateCode: 'cnc_machined_part' }), 201, 'quality plan');
  const drawing = [
    { kind: 'variable', drawingReference: '7', name: 'Bore diameter', criticality: 'critical', unit: 'mm', nominal: '12', lower: { value: '11.98', inclusive: true }, upper: { value: '12.02', inclusive: true }, stages: ['fai', 'final'], method: 'Bore gauge', instrumentKind: 'bore_gauge' },
  ];
  const saved = ok(await q.post(`/quality-plans/${draft['planId']}/draft`, { expectedVersion: draft['aggregateVersion'], stages: draft['stages'], characteristics: [...(draft['characteristics'] as Body[]), ...drawing] }), 201, 'save plan');
  ok(await q.post(`/quality-plans/${draft['planId']}/approve`, { expectedVersion: saved['aggregateVersion'] }), 201, 'approve plan');
  return draft['planId'] as string;
}

/** Baselined, work package planned with an approved quality plan, released to production. */
export async function inProduction(deal: Deal): Promise<{ workPackageId: string; planId: string }> {
  await baselined(deal);
  ok(await (await as('sourcing')).post(`/purchase-orders/${deal.purchaseOrderId}/work-package`, { plannedStart: daysFromNow(1), plannedFinish: daysFromNow(21) }), 201, 'plan work package');
  const planned = await workPackage(deal);
  const planId = await qualityPlan(planned['workPackageId'] as string);
  const wp = await workPackage(deal);
  ok(await (await as('sourcing')).post(`/work-packages/${wp['workPackageId']}/release`, { expectedVersion: wp['aggregateVersion'] }), 201, 'release work package');
  return { workPackageId: wp['workPackageId'] as string, planId };
}

export async function calibratedGauge(): Promise<string> {
  const a = await as('supplierA');
  const made = ok(await a.post('/supplier/instruments', { assetTag: `BG-${randomUUID().slice(0, 8)}`, kind: 'Bore gauge', unit: 'mm' }), 201, 'instrument');
  const cert = await upload('supplierA', 'certificate');
  ok(
    await a.post(`/supplier/instruments/${made['instrumentId']}/calibrations`, { performedAt: new Date(Date.now() - 10 * 86_400_000).toISOString(), dueAt: new Date(Date.now() + 300 * 86_400_000).toISOString(), outcome: 'pass', certificateDocumentVersionId: cert.documentVersionId }),
    201,
    'calibrate',
  );
  return made['instrumentId'] as string;
}

/** Supplier A's results for an inspection; every value in tolerance except the bore (`bore` mm). */
export async function inspected(workPackageId: string, stage: 'fai' | 'final', lot: string, gauge: string, bore = '12.006', review = true): Promise<Body> {
  const q = await as('quality');
  const a = await as('supplierA');
  let i = ok(await q.post('/inspections', { workPackageId, stage, lot }), 201, `plan ${stage}`);
  i = ok(await a.post(`/supplier/inspections/${i['inspectionId']}/start`, { expectedVersion: i['aggregateVersion'] }), 201, 'start inspection');
  const samples = Array.from({ length: i['sampleSize'] as number }, (_, k) => k + 1);
  const value = (name: string): Body =>
    name.startsWith('Visual')
      ? { measurement: { value: 'conforming', unit: null, declaredPrecision: null } }
      : name.startsWith('Surface')
        ? { measurement: { value: '1.6', unit: 'um', declaredPrecision: 1 }, instrumentId: gauge }
        : name === 'Bore diameter'
          ? { measurement: { value: bore, unit: 'mm', declaredPrecision: 3 }, instrumentId: gauge }
          : { measurement: { value: '80.00', unit: 'mm', declaredPrecision: 2 }, instrumentId: gauge };
  i = ok(
    await a.post(`/supplier/inspections/${i['inspectionId']}/results`, {
      expectedVersion: i['aggregateVersion'],
      inspectedAt: new Date().toISOString(),
      samples: samples.map((n) => ({ sampleNo: n, lot })),
      results: samples.flatMap((n) => (i['characteristics'] as Body[]).map((c) => ({ sampleNo: n, characteristicId: c['characteristicId'], ...value(c['name'] as string) }))),
    }),
    201,
    'submit results',
  );
  if (!review) return i;
  i = ok(await q.post(`/inspections/${i['inspectionId']}/review`, { expectedVersion: i['aggregateVersion'] }), 201, 'review');
  const pass = Number(bore) <= 12.02;
  return ok(await q.post(`/inspections/${i['inspectionId']}/decide`, { expectedVersion: i['aggregateVersion'], decision: pass ? 'passed' : 'failed', reason: pass ? '' : 'Bore oversize' }), 201, 'decide');
}

/** Milestones verified or waived, FAI and final inspections passed, the lots quality released. */
export async function released(deal: Deal, workPackageId: string, lots: Array<{ lot: string; quantity: string }>, opts: { release?: boolean } = {}): Promise<void> {
  const gauge = await calibratedGauge();
  for (const [n, { lot }] of lots.entries()) {
    if (n === 0) await inspected(workPackageId, 'fai', lot, gauge);
    await inspected(workPackageId, 'final', lot, gauge);
  }
  const q = await as('quality');
  for (;;) {
    const wp = await workPackage(deal);
    const m = (wp['milestones'] as Body[]).find((x) => x['status'] !== 'verified' && x['status'] !== 'waived');
    if (!m) break;
    if (m['status'] === 'evidence_submitted') ok(await q.post(`/milestones/${m['milestoneId']}/verify`, { expectedVersion: m['aggregateVersion'], decision: 'verified' }), 201, 'verify milestone');
    else ok(await q.post(`/milestones/${m['milestoneId']}/waive`, { expectedVersion: m['aggregateVersion'], reason: 'Covered by the final inspection on record.' }), 201, 'waive milestone');
  }
  if (opts.release === false) return;
  for (const { lot, quantity } of lots) ok(await q.post('/quality-releases', { workPackageId, quantity, lots: [lot], serials: [] }), 201, `release ${lot}`);
}

/** Supplier A's works address (its pickup origin), created once. */
export async function supplierSite(): Promise<string> {
  const a = await as('supplierA');
  const sites = ok(await a.get('/organizations/me/sites'), 200, 'sites')['sites'] as Body[] | undefined;
  if (sites?.[0]) return sites[0]['siteId'] as string;
  ok(
    await a.post('/suppliers/me/site', { label: 'Anand works', addressLine1: 'Plot 12, SIDCO Ambattur', addressLine2: '', city: 'Chennai', state: 'Tamil Nadu', postalCode: '600098' }),
    201,
    'works address',
  );
  const again = ok(await a.get('/organizations/me/sites'), 200, 'sites')['sites'] as Body[];
  return again[0]!['siteId'] as string;
}

/** A leg-1 shipment planned, submitted, released and picked up. */
export async function shippedToJobWork(deal: Deal, lots: Array<{ lot: string; quantity: string }>, pickup = true): Promise<Body> {
  const a = await as('supplierA');
  const packages = lots.map((l, n) => ({ packageNo: n + 1, weightG: 9000, items: [{ lotCode: l.lot, quantity: l.quantity }] }));
  let s = ok(await a.post('/supplier/shipments', { purchaseOrderId: deal.purchaseOrderId, originSiteId: await supplierSite(), packages, documents: { challanNumber: 'DC-201', eWaybillNumber: '1811 0000 0001' } }), 201, 'plan shipment');
  s = ok(await a.post(`/supplier/shipments/${s['shipmentId']}/submit`, { expectedVersion: s['aggregateVersion'] }), 201, 'submit shipment');
  s = ok(await (await as('logistics')).post(`/shipments/${s['shipmentId']}/release`, { expectedVersion: s['aggregateVersion'] }), 201, 'release shipment');
  if (!pickup) return s;
  return ok(await a.post(`/supplier/shipments/${s['shipmentId']}/pickup`, { expectedVersion: s['aggregateVersion'], carrierMode: 'carrier', carrierName: 'Safe Carriers', trackingReference: `LR-${randomUUID().slice(0, 8)}` }), 201, 'pickup');
}

export async function receivedInFull(shipment: Body): Promise<Body> {
  const items = (shipment['packages'] as Body[]).flatMap((pk) => pk['items'] as Body[]);
  return ok(
    await (await as('logistics')).post(`/shipments/${shipment['shipmentId']}/receive`, {
      expectedVersion: shipment['aggregateVersion'],
      sealIntact: true,
      packages: (shipment['packages'] as Body[]).map((pk) => ({ packageNo: pk['packageNo'], condition: 'ok' })),
      lines: items.map((i) => ({ itemId: i['itemId'], countedQuantity: i['quantity'], acceptedQuantity: i['quantity'] })),
    }),
    201,
    'receive in full',
  );
}

/** The customer's delivery address, created once through its own address book. */
export async function customerSite(): Promise<string> {
  const b = await as('buyer');
  const sites = ok(await b.get('/organizations/me/sites'), 200, 'sites')['sites'] as Body[];
  if (sites[0]) return sites[0]['siteId'] as string;
  const made = ok(
    await b.post('/organizations/me/sites', { kind: 'delivery', label: 'Kovai Pumps plant', addressLine1: 'SIDCO Industrial Estate, Mudalipalayam', city: 'Tiruppur', state: 'Tamil Nadu', postalCode: '641606', contactName: 'R. Kumar', contactPhone: '+91 98400 12345' }),
    201,
    'customer site',
  );
  return made['siteId'] as string;
}

/** A deal produced, released lot by lot, shipped and received in full at JobWork. */
export async function atJobWork(title: string, lots = [{ lot: 'LOT-A', quantity: '60' }, { lot: 'LOT-B', quantity: '40' }]): Promise<{ deal: Deal; workPackageId: string }> {
  await customerSite();
  const deal = await orderedDeal(title);
  const { workPackageId } = await inProduction(deal);
  await released(deal, workPackageId, lots);
  await receivedInFull(await shippedToJobWork(deal, lots));
  return { deal, workPackageId };
}

export async function stockLots(orderId: string): Promise<Record<string, string>> {
  const context = ok(await (await as('logistics')).get(`/logistics/sales-orders/${orderId}/dispatch-context`), 200, 'dispatch context');
  return Object.fromEntries((context['lots'] as Body[]).map((l) => [l['lotCode'] as string, l['stockLotId'] as string]));
}

/** A leg-2 delivery planned, balance paid, address confirmed, released and picked up. */
export async function dispatched(orderId: string, lots: Array<[string, string]>): Promise<Body> {
  const packingCheck = { neutralCartons: true, supplierMarksRemoved: true, jobworkLabelsApplied: true, packagingNoteFollowed: true };
  const ids = await stockLots(orderId);
  const packages = lots.map(([code, quantity], n) => ({ packageNo: n + 1, weightG: 5000, items: [{ stockLotId: ids[code], quantity }] }));
  const logistics = await as('logistics');
  let s = ok(await logistics.post('/customer-dispatches', { salesOrderId: orderId, packages, packingCheck }), 201, 'plan dispatch');
  const balance = ((await salesOrder(orderId))['invoices'] as Body[]).find((i) => i['kind'] === 'balance')!;
  if (balance['status'] !== 'paid') await pay(balance['invoiceId'] as string);
  s = ok(await logistics.post(`/customer-dispatches/${s['shipmentId']}/replan`, { expectedVersion: s['aggregateVersion'], packages, documents: { invoiceNumber: balance['number'] }, packingCheck }), 201, 'replan dispatch');
  s = ok(await (await as('sales')).post(`/customer-dispatches/${s['shipmentId']}/address-confirmations`, { expectedVersion: s['aggregateVersion'], note: 'Confirmed by phone with stores' }), 201, 'confirm address');
  s = ok(await logistics.post(`/customer-dispatches/${s['shipmentId']}/submit`, { expectedVersion: s['aggregateVersion'] }), 201, 'submit dispatch');
  s = ok(await logistics.post(`/customer-dispatches/${s['shipmentId']}/release`, { expectedVersion: s['aggregateVersion'] }), 201, 'release dispatch');
  return ok(await logistics.post(`/shipments/${s['shipmentId']}/pickup`, { expectedVersion: s['aggregateVersion'], carrierMode: 'carrier', carrierName: 'Safexpress', trackingReference: `SX-${randomUUID().slice(0, 6)}` }), 201, 'pickup dispatch');
}

export async function proofOfDelivery(shipment: Body): Promise<Body> {
  return ok(
    await (await as('logistics')).post(`/shipments/${shipment['shipmentId']}/pod`, { expectedVersion: shipment['aggregateVersion'], receivedByName: 'R. Kumar', receivedAt: new Date().toISOString(), packagesReceived: (shipment['packages'] as Body[]).length, remarks: 'clean', source: 'driver' }),
    201,
    'proof of delivery',
  );
}
