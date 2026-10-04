import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Body, ok, Pilot, type SourcedDeal } from './pilot/driver';

const AREAS = ['configuration', 'wip', 'process_tooling', 'quality', 'commercial', 'schedule', 'contract', 'logistics'];
const answered = (skip: string[] = []): Record<string, Body> =>
  Object.fromEntries(AREAS.filter((a) => !skip.includes(a)).map((a) => [a, a === 'logistics' ? { applicable: false, reason: 'Same packaging and route' } : { applicable: true, answer: `${a} assessed against revision B` }]));

/**
 * Engineering change control (IN-13 F-13.2; doc 06 §9; doc 09 §§7–8; FR-604–605): a
 * customer's new drawing revision after production started opens a change; JobWork
 * stops the work, weighs eight impact areas, approves, the customer accepts the price and
 * date, a new baseline supersedes the old in the change's name, and the supplier
 * acknowledges before it works to it.
 */
describe('Engineering change control (F-13.2)', () => {
  let p: Pilot;
  let deal: SourcedDeal;
  let prod: { baselineId: string; workPackageId: string; milestoneId: string; evidenceVersionId: string };
  let drawingDocumentId: string;
  let revisionB: { documentVersionId: string; versionNo: number };
  let changeId: string;
  let candidateId: string;

  const version = async (): Promise<number> => (ok(await p.as.engineering.get(`/api/v1/changes/${changeId}`), 200, 'change'))['aggregateVersion'] as number;
  const change = async (): Promise<Body> => ok(await p.as.engineering.get(`/api/v1/changes/${changeId}`), 200, 'change');

  beforeAll(async () => {
    p = await Pilot.start('change');
    const { enquiryId } = await p.approvedEnquiry();
    deal = await p.sourceToPurchaseOrder(enquiryId);
    prod = await p.intoProduction(deal);
    drawingDocumentId = (await p.one<{ document_id: string }>(`SELECT document_id FROM dms.document_version WHERE id = $1`, [p.drawingVersionId])).document_id;
  }, 240_000);

  afterAll(async () => {
    await p?.stop();
  });

  it('opens a change on its own when a baselined drawing gets a new revision (BR-ENG-05)', async () => {
    revisionB = await p.uploadRevision(p.as.buyer, drawingDocumentId, 'bracket-rev-b.pdf');
    expect(revisionB.versionNo).toBe(2);
    const changes = ok(await p.as.engineering.get(`/api/v1/changes?salesOrderId=${deal.orderId}`), 200, 'changes') as unknown as Body[];
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ origin: 'document_revision', status: 'proposed', contextDocumentVersionIds: [revisionB.documentVersionId] });
    changeId = changes[0]!['changeRequestId'] as string;
    // Nothing moved: the released baseline still governs and production carries on as before.
    expect(((await p.productionView(deal.orderId))['baselines'] as Body[]).find((b) => b['status'] === 'released')!['baselineId']).toBe(prod.baselineId);
  });

  it('triages, asks the customer, and stops the affected work for a bounded time', async () => {
    ok(await p.as.engineering.post(`/api/v1/changes/${changeId}/triage`, { expectedVersion: await version() }), 201, 'triage');
    ok(await p.as.engineering.post(`/api/v1/changes/${changeId}/request-info`, { expectedVersion: await version(), question: 'Does revision B change the bore or only the note?' }), 201, 'request info');
    const asked = ok(await p.as.buyer.get(`/api/v1/customer/changes/${changeId}`), 200, 'customer view');
    expect(asked['infoRequest']).toContain('bore');
    ok(await p.as.buyer.post(`/api/v1/customer/changes/${changeId}/provide-info`, { expectedVersion: asked['aggregateVersion'], answer: 'The bore moves from IT8 to IT7 for the new bearing.' }), 201, 'provide info');

    // An expiry is required and bounded.
    expect((await p.as.sourcing.post(`/api/v1/changes/${changeId}/interim-decisions`, { purchaseOrderIds: [deal.purchaseOrderId], decision: 'stop', reason: 'Hold the bore', expiresAt: new Date(Date.now() + 40 * 86_400_000).toISOString() })).status).toBe(400);
    ok(await p.as.sourcing.post(`/api/v1/changes/${changeId}/interim-decisions`, { purchaseOrderIds: [deal.purchaseOrderId], decision: 'stop', reason: 'Hold the bore until revision B is decided', expiresAt: new Date(Date.now() + 5 * 86_400_000).toISOString() }), 201, 'interim stop');

    // The stop reaches the supplier and holds new work.
    const supplierView = ok(await p.as.supplierA.get(`/api/v1/supplier/changes/${changeId}`), 200, 'supplier change');
    expect((supplierView['purchaseOrders'] as Body[])[0]!['interimDecisions']).toEqual([expect.objectContaining({ decision: 'stop', active: true })]);
    p.expectNothingOf(supplierView, ['Kovai', 'bearing', 'IT7'], 'supplier change view');
    const wp = ((await p.supplierProduction('supplierA', deal.purchaseOrderId))['workPackage'] as Body)['milestones'] as Body[];
    const next = wp.find((m) => m['status'] === 'ready');
    if (next) {
      const refused = await p.as.supplierA.post(`/api/v1/supplier/milestones/${next['milestoneId']}/start`, { expectedVersion: next['aggregateVersion'] });
      expect(refused.body['code']).toBe('INTERIM_STOP');
    }
    const gate = ((await p.productionView(deal.orderId))['workPackages'] as Body[])[0]!['gates'] as Body[];
    expect(JSON.stringify(gate.find((g) => g['key'] === 'technical'))).toContain('Interim stop');
    await p.dispatchNotifications();
    expect((await p.notices('supplierA')).map((n) => n.template_key)).toContain('supplier.change_interim_decision');

    const classified = ok(
      await p.as.engineering.post(`/api/v1/changes/${changeId}/classify`, { expectedVersion: await version(), classification: 'scope', supplierBrief: 'Bore tolerance tightens to IT7 on revision B; quote rework and any scrap.' }),
      201,
      'classify',
    );
    expect(classified['status']).toBe('impact_analysis');
  });

  it('weighs every impact area before approval, with the supplier’s estimate on file', async () => {
    ok(await p.as.supplierA.post(`/api/v1/supplier/changes/${changeId}/impact`, { purchaseOrderId: deal.purchaseOrderId, costDeltaMinor: 30000, leadTimeDeltaDays: 4, wip: [{ quantity: 20, disposition: 'scrap', costMinor: 40000, note: 'Bores already cut' }], note: 'Re-fixture needed' }), 201, 'supplier impact');
    const assembled = ok(await p.as.engineering.post(`/api/v1/sales-orders/${deal.orderId}/baselines`, { items: [{ documentVersionId: revisionB.documentVersionId, purpose: 'governing' }] }), 201, 'assemble candidate');
    candidateId = (assembled['baselines'] as Body[]).find((b) => b['status'] === 'draft')!['baselineId'] as string;

    const partial = { expectedVersion: await version(), areas: answered(['logistics']), customerPriceDeltaMinor: 50000, deliveryDateDeltaDays: 7, purchaseOrders: [{ purchaseOrderId: deal.purchaseOrderId, costDeltaMinor: 30000, leadTimeDeltaDays: 4 }], wip: [{ purchaseOrderId: deal.purchaseOrderId, quantity: 20, disposition: 'scrap', costMinor: 40000, note: 'Bores already cut' }], candidateBaselineId: candidateId };
    ok(await p.as.engineering.post(`/api/v1/changes/${changeId}/impact`, partial), 201, 'partial impact');
    const incomplete = await p.as.engineering.post(`/api/v1/changes/${changeId}/complete-impact`, { expectedVersion: await version() });
    expect(incomplete.status).toBe(422);
    expect(incomplete.body['code']).toBe('IMPACT_INCOMPLETE');
    expect(incomplete.body['detail']).toContain('logistics');

    ok(await p.as.engineering.post(`/api/v1/changes/${changeId}/impact`, { ...partial, expectedVersion: await version(), areas: answered() }), 201, 'full impact');
    const completed = ok(await p.as.engineering.post(`/api/v1/changes/${changeId}/complete-impact`, { expectedVersion: await version() }), 201, 'complete impact');
    expect(completed).toMatchObject({ status: 'commercial_approval', customerApprovalRequired: true, impactComplete: true });
    expect((completed['impact'] as Body)['versionNo']).toBe(2);
    expect((completed['supplierImpacts'] as Body[])[0]).toMatchObject({ costDeltaMinor: 30000, leadTimeDeltaDays: 4 });
  });

  it('routes a change that moves money to sales, and only then asks the customer', async () => {
    const approvalId = (await change())['approvalRequestId'] as string;
    // Engineering completed the impact and cannot approve it; money moves, so sales decides.
    expect((await p.decide('engineering', approvalId)).status).toBeGreaterThanOrEqual(403);
    const early = await p.as.engineering.post(`/api/v1/changes/${changeId}/release`, { expectedVersion: await version() });
    expect(early.status).toBe(409);
    ok(await p.decide('sales', approvalId), 201, 'sales approves');
    expect((await change())['status']).toBe('approved');

    // Release waits for the customer.
    const pending = await p.as.engineering.post(`/api/v1/changes/${changeId}/release`, { expectedVersion: await version() });
    expect(pending.body['code']).toBe('CUSTOMER_DECISION_PENDING');
    await p.dispatchNotifications();
    expect((await p.notices('approver')).map((n) => n.template_key)).toContain('customer.change_decision_needed');

    // The customer sees price and date, never the supplier's cost or the scrap.
    const view = ok(await p.as.approver.get(`/api/v1/customer/changes/${changeId}`), 200, 'customer change');
    expect(view).toMatchObject({ priceDeltaMinor: 50000, deliveryDateDeltaDays: 7, decisionNeeded: true, canDecide: true });
    p.expectNothingOf(view, ['30000', '40000', 'scrap', 'Anand', 'Re-fixture'], 'customer change view');
    // The requester may not decide for the company.
    expect((await p.as.buyer.post(`/api/v1/customer/changes/${changeId}/decide`, { expectedVersion: view['aggregateVersion'], decision: 'approved', acknowledgeEffect: true })).status).toBe(403);
    const decided = ok(await p.as.approver.post(`/api/v1/customer/changes/${changeId}/decide`, { expectedVersion: view['aggregateVersion'], decision: 'approved', acknowledgeEffect: true }), 201, 'customer approves');
    expect(decided['decision']).toMatchObject({ decision: 'approved' });
  });

  it('releases the new baseline in the change’s name, with amendments, journal and revoked stale access', async () => {
    const released = ok(await p.as.engineering.post(`/api/v1/changes/${changeId}/release`, { expectedVersion: await version() }), 201, 'release');
    expect(released).toMatchObject({ status: 'released', releasedBaselineId: candidateId });
    const baselines = await p.rows<{ id: string; status: string; supersedes_baseline_id: string | null; change_request_id: string | null }>(
      `SELECT id, status, supersedes_baseline_id, change_request_id FROM dms.baseline WHERE sales_order_id = $1 ORDER BY created_at`,
      [deal.orderId],
    );
    expect(baselines).toEqual([
      { id: prod.baselineId, status: 'superseded', supersedes_baseline_id: null, change_request_id: null },
      { id: candidateId, status: 'released', supersedes_baseline_id: prod.baselineId, change_request_id: changeId },
    ]);
    // Amendments on both legs, exact.
    expect(released['amendments']).toEqual([expect.objectContaining({ purchaseOrderId: deal.purchaseOrderId, costDeltaMinor: 30000, leadTimeDeltaDays: 4, acknowledgedAt: null })]);
    const amendment = await p.one<{ price_delta_minor: string; delivery_date_delta_days: number; installment_id: string }>(`SELECT price_delta_minor, delivery_date_delta_days, installment_id FROM orders.order_amendment WHERE change_request_id = $1`, [changeId]);
    expect([Number(amendment.price_delta_minor), amendment.delivery_date_delta_days]).toEqual([50000, 7]);
    const installment = await p.one<{ kind: string; amount_minor: string }>(`SELECT kind, amount_minor FROM finance.installment WHERE id = $1`, [amendment.installment_id]);
    expect([installment.kind, Number(installment.amount_minor)]).toEqual(['change', 50000]);
    // Scrap is journalled against the order, balanced.
    const journal = await p.rows<{ account_code: string; debit_minor: string; credit_minor: string; cost_object_id: string }>(
      `SELECT l.account_code, l.debit_minor, l.credit_minor, l.cost_object_id FROM finance.journal j JOIN finance.journal_line l ON l.journal_id = j.id WHERE j.source_id = $1 ORDER BY l.account_code`,
      [changeId],
    );
    expect(journal.map((l) => [l.account_code, Number(l.debit_minor), Number(l.credit_minor), l.cost_object_id])).toEqual([
      ['change_cost', 40000, 0, deal.orderId],
      ['supplier_accrual', 0, 40000, deal.orderId],
    ]);
    // The supplier can no longer download revision A; its old evidence still names the old baseline.
    expect((await p.as.supplierA.get(`/api/v1/documents/versions/${p.drawingVersionId}/download`)).status).toBe(404);
    const evidence = await p.one<{ baseline_id: string }>(`SELECT baseline_id FROM orders.milestone_evidence WHERE milestone_id = $1`, [prod.milestoneId]);
    expect(evidence.baseline_id).toBe(prod.baselineId);
    // The stop is lifted by the release, but nothing more is made until revision B is acknowledged.
    expect((released['interimDecisions'] as Body[]).every((d) => d['active'] === false)).toBe(true);
    const ms = ((await p.supplierProduction('supplierA', deal.purchaseOrderId))['workPackage'] as Body)['milestones'] as Body[];
    const ready = ms.find((m) => m['status'] === 'ready');
    if (ready) expect((await p.as.supplierA.post(`/api/v1/supplier/milestones/${ready['milestoneId']}/start`, { expectedVersion: ready['aggregateVersion'] })).body['code']).toBe('TRANSMITTAL_NOT_ACKNOWLEDGED');
    // Old evidence was not touched; the original baseline's release is untouched too.
    expect((await p.one<{ status: string }>(`SELECT status FROM dms.baseline WHERE id = $1`, [prod.baselineId])).status).toBe('superseded');
  });

  it('is implemented when the supplier acknowledges, and the work package shows both baselines', async () => {
    const acked = ok(await p.as.supplierA.post(`/api/v1/supplier/changes/${changeId}/acknowledge`, { purchaseOrderId: deal.purchaseOrderId, note: 'Revision B received; re-fixturing.' }), 201, 'supplier acknowledges');
    expect(acked['status']).toBe('implemented');
    const wp = ((await p.productionView(deal.orderId))['workPackages'] as Body[])[0]!;
    expect((wp['baselinesUsed'] as Body[]).map((b) => b['baselineId'])).toEqual([prod.baselineId, candidateId]);
    // Finance invoices the change installment like any other.
    const so = ok(await p.as.finance.get(`/api/v1/sales-orders/${deal.orderId}`), 200, 'order');
    const changeInstallment = (so['installments'] as Body[]).find((i) => i['kind'] === 'change')!;
    const invoiced = ok(await p.as.finance.post(`/api/v1/sales-orders/${deal.orderId}/invoices`, { expectedVersion: so['aggregateVersion'], installmentId: changeInstallment['installmentId'] }), 201, 'invoice change');
    expect((invoiced['invoices'] as Body[]).find((i) => i['kind'] === 'change')).toMatchObject({ totalMinor: 50000 });

    ok(await p.as.engineering.post(`/api/v1/changes/${changeId}/verify`, { expectedVersion: await version(), note: 'First-off part from revision B measured IT7 at the bore.' }), 201, 'verify');
    const closed = ok(await p.as.engineering.post(`/api/v1/changes/${changeId}/close`, { expectedVersion: await version() }), 201, 'close');
    expect(closed['status']).toBe('closed');
  });

  it('audits every step of the change with its actor, in order', async () => {
    expect(await p.auditActions(changeId)).toEqual([
      'change.change_proposed',
      'change.triage_started',
      'change.info_requested',
      'change.info_provided',
      'change.interim_decision_issued',
      'change.change_classified',
      'change.supplier_impact_submitted',
      'change.impact_recorded',
      'change.impact_recorded',
      'change.impact_completed',
      'commercial.approval_decided',
      'change.customer_decided',
      'change.change_released',
      'change.supplier_acknowledged',
      'change.change_verified',
      'change.change_closed',
    ]);
  });
});
