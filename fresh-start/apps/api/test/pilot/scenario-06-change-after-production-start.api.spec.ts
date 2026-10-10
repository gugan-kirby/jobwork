import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Body, ok, Pilot, type SourcedDeal } from './driver';

const AREAS = ['configuration', 'wip', 'process_tooling', 'quality', 'commercial', 'schedule', 'contract', 'logistics'] as const;

/**
 * Pilot scenario 6 (doc 19 §10; IN-13 F-13.4): production has started and evidence is
 * in when the customer asks for a laser-marked part number. Engineering stops the
 * affected work, weighs the change (20 anodised pieces cannot take the mark and are
 * scrapped), sales approves the money, the customer accepts the price and date, and a new
 * baseline supersedes the old one in the change's name. The supplier acknowledges it
 * before working to it; the old evidence keeps naming the baseline it was made under; and
 * the money adds up on both legs.
 */
describe('Pilot 6: engineering change after production start', () => {
  let p: Pilot;
  let deal: SourcedDeal;
  let prod: { baselineId: string; workPackageId: string; milestoneId: string; evidenceVersionId: string };
  let markingSpecId: string;
  let changeId: string;
  let candidateId: string;
  const customerPriceDelta = 23_600; // ₹236.00 tax included
  const supplierCostDelta = 12_000;
  const scrapCost = 30_000; // 20 pieces

  const view = async (): Promise<Body> => ok(await p.as.engineering.get(`/api/v1/changes/${changeId}`), 200, 'change');
  const version = async (): Promise<number> => (await view())['aggregateVersion'] as number;

  beforeAll(async () => {
    p = await Pilot.start('s06');
    const { enquiryId } = await p.approvedEnquiry();
    deal = await p.sourceToPurchaseOrder(enquiryId);
    prod = await p.intoProduction(deal);
    // The customer's marking specification: a new document of its own.
    markingSpecId = await p.cleanDrawing(p.orgs.customer);
  }, 240_000);

  afterAll(async () => {
    await p?.stop();
  });

  it('takes the customer’s request, and stops the affected work at once', async () => {
    const requested = ok(
      await p.as.buyer.post(`/api/v1/orders/${deal.orderId}/changes`, {
        title: 'Laser-mark the part number',
        reason: 'Kovai assembly line needs traceability on every bracket; marking spec attached.',
        urgency: 'urgent',
        contextDocumentVersionIds: [markingSpecId],
      }),
      201,
      'customer requests change',
    );
    changeId = requested['changeRequestId'] as string;
    expect(requested).toMatchObject({ status: 'proposed', decisionNeeded: false });

    ok(await p.as.engineering.post(`/api/v1/changes/${changeId}/triage`, { expectedVersion: await version() }), 201, 'triage');
    ok(
      await p.as.sourcing.post(`/api/v1/changes/${changeId}/interim-decisions`, {
        purchaseOrderIds: [deal.purchaseOrderId],
        decision: 'stop',
        reason: 'No more anodising until the marking step is placed',
        expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      }),
      201,
      'interim stop',
    );
    const gate = ((await p.productionView(deal.orderId))['workPackages'] as Body[])[0]!['gates'] as Body[];
    expect(JSON.stringify(gate.find((g) => g['key'] === 'technical'))).toContain('Interim stop');
    const ready = (((await p.supplierProduction('supplierA', deal.purchaseOrderId))['workPackage'] as Body)['milestones'] as Body[]).find((m) => m['status'] === 'ready');
    if (ready) expect((await p.as.supplierA.post(`/api/v1/supplier/milestones/${ready['milestoneId']}/start`, { expectedVersion: ready['aggregateVersion'] })).body['code']).toBe('INTERIM_STOP');

    const classified = ok(
      await p.as.engineering.post(`/api/v1/changes/${changeId}/classify`, {
        expectedVersion: await version(),
        classification: 'scope',
        supplierBrief: 'Add a laser-marked part number after anodising, per the attached marking drawing. Quote the step and any scrap.',
      }),
      201,
      'classify',
    );
    expect(classified['status']).toBe('impact_analysis');
    // The supplier gets JobWork's brief, not the customer's words or name.
    const brief = ok(await p.as.supplierA.get(`/api/v1/supplier/changes/${changeId}`), 200, 'supplier brief');
    expect(brief['impactInvited']).toBe(true);
    p.expectNothingOf(brief, ['Kovai', 'traceability', 'assembly line'], 'supplier change brief');
  });

  it('weighs every area, with 20 anodised pieces scrapped, and the marking spec in the candidate baseline', async () => {
    ok(
      await p.as.supplierA.post(`/api/v1/supplier/changes/${changeId}/impact`, {
        purchaseOrderId: deal.purchaseOrderId,
        costDeltaMinor: supplierCostDelta,
        leadTimeDeltaDays: 3,
        wip: [{ quantity: 20, disposition: 'scrap', costMinor: scrapCost, note: 'Anodised; the mark would break the coating' }],
        note: 'Marking after anodising adds a fixture',
      }),
      201,
      'supplier estimate',
    );
    // The customer's document is offered as a candidate because the change brings it in.
    const candidates = ok(await p.as.engineering.get(`/api/v1/sales-orders/${deal.orderId}/baseline-candidates`), 200, 'candidates')['candidates'] as Body[];
    expect(candidates.find((c) => c['documentVersionId'] === markingSpecId)).toMatchObject({ source: 'change', selectable: true });
    const assembled = ok(
      await p.as.engineering.post(`/api/v1/sales-orders/${deal.orderId}/baselines`, {
        items: [
          { documentVersionId: p.drawingVersionId, purpose: 'governing', governingPriority: 1 },
          { documentVersionId: markingSpecId, purpose: 'governing', governingPriority: 2 },
        ],
      }),
      201,
      'assemble candidate',
    );
    candidateId = (assembled['baselines'] as Body[]).find((b) => b['status'] === 'draft')!['baselineId'] as string;

    const completed = ok(
      await p.as.engineering.post(`/api/v1/changes/${changeId}/impact`, {
        expectedVersion: await version(),
        areas: Object.fromEntries(AREAS.map((a) => [a, a === 'contract' ? { applicable: false, reason: 'Warranty and terms unchanged' } : { applicable: true, answer: `${a}: laser mark after anodising, 20 pieces scrapped` }])),
        customerPriceDeltaMinor: customerPriceDelta,
        deliveryDateDeltaDays: 3,
        purchaseOrders: [{ purchaseOrderId: deal.purchaseOrderId, costDeltaMinor: supplierCostDelta, leadTimeDeltaDays: 3 }],
        wip: [{ purchaseOrderId: deal.purchaseOrderId, quantity: 20, disposition: 'scrap', costMinor: scrapCost, note: 'Anodised before the change' }],
        candidateBaselineId: candidateId,
      }),
      201,
      'impact',
    );
    expect(completed['impactComplete']).toBe(true);
    const sent = ok(await p.as.engineering.post(`/api/v1/changes/${changeId}/complete-impact`, { expectedVersion: await version() }), 201, 'complete impact');
    expect(sent).toMatchObject({ status: 'commercial_approval', customerApprovalRequired: true });
  });

  it('is approved inside JobWork, then by the customer on its price and date alone', async () => {
    ok(await p.decide('sales', (await view())['approvalRequestId'] as string), 201, 'sales approves');
    const customer = ok(await p.as.approver.get(`/api/v1/customer/changes/${changeId}`), 200, 'customer view');
    expect(customer).toMatchObject({ priceDeltaMinor: customerPriceDelta, deliveryDateDeltaDays: 3, decisionNeeded: true, canDecide: true });
    p.expectNothingOf(customer, [String(supplierCostDelta), String(scrapCost), 'scrap', 'Anand', 'fixture'], 'customer change view');
    ok(await p.as.approver.post(`/api/v1/customer/changes/${changeId}/decide`, { expectedVersion: customer['aggregateVersion'], decision: 'approved', acknowledgeEffect: true }), 201, 'customer approves');
  });

  it('releases the new baseline in the change’s name; no other path could', async () => {
    // A second baseline cannot be released directly, even with every approval in.
    const draft = ((await p.productionView(deal.orderId))['baselines'] as Body[]).find((b) => b['baselineId'] === candidateId)!;
    const direct = await p.as.engineering.post(`/api/v1/baselines/${candidateId}/release`, { expectedVersion: draft['aggregateVersion'] });
    expect(direct.body['code']).toBe('BASELINE_CHANGE_REQUIRED');

    const released = ok(await p.as.engineering.post(`/api/v1/changes/${changeId}/release`, { expectedVersion: await version() }), 201, 'release');
    expect(released).toMatchObject({ status: 'released', releasedBaselineId: candidateId });
    expect((released['interimDecisions'] as Body[]).every((d) => d['active'] === false)).toBe(true);
    const lineage = await p.one<{ supersedes_baseline_id: string; change_request_id: string }>(`SELECT supersedes_baseline_id, change_request_id FROM dms.baseline WHERE id = $1`, [candidateId]);
    expect(lineage).toEqual({ supersedes_baseline_id: prod.baselineId, change_request_id: changeId });
  });

  it('is implemented when the supplier acknowledges; old evidence keeps its baseline', async () => {
    const acked = ok(await p.as.supplierA.post(`/api/v1/supplier/changes/${changeId}/acknowledge`, { purchaseOrderId: deal.purchaseOrderId, note: 'Marking drawing received.' }), 201, 'supplier acknowledges');
    expect(acked['status']).toBe('implemented');
    expect((await p.one<{ baseline_id: string }>(`SELECT baseline_id FROM orders.milestone_evidence WHERE milestone_id = $1`, [prod.milestoneId])).baseline_id).toBe(prod.baselineId);
    const wp = ((await p.productionView(deal.orderId))['workPackages'] as Body[])[0]!;
    expect((wp['baselinesUsed'] as Body[]).map((b) => b['baselineId'])).toEqual([prod.baselineId, candidateId]);
    // The supplier now holds the marking drawing it must make the parts to, as JobWork's copy (F-FP.5).
    const copyId = (await p.one<{ copy_version_id: string }>(`SELECT copy_version_id FROM dms.supplier_copy WHERE source_version_id = $1`, [markingSpecId])).copy_version_id;
    const transmitted = (((await p.supplierProduction('supplierA', deal.purchaseOrderId))['transmittal'] as Body)['items'] as Body[]).map((i) => i['documentVersionId']);
    expect(transmitted).toContain(copyId);
    expect((await p.as.supplierA.get(`/api/v1/documents/versions/${copyId}/download`)).status).toBe(200);
    expect((await p.as.supplierA.get(`/api/v1/documents/versions/${markingSpecId}/download`)).status).toBe(404);

    ok(await p.as.engineering.post(`/api/v1/changes/${changeId}/verify`, { expectedVersion: await version(), note: 'First marked part checked against the marking drawing.' }), 201, 'verify');
    expect((ok(await p.as.engineering.post(`/api/v1/changes/${changeId}/close`, { expectedVersion: await version() }), 201, 'close'))['status']).toBe('closed');
  });

  it('adds up: the amendment is the installment and the invoice, the PO moves by the supplier delta, and the scrap journal balances', async () => {
    const amendment = await p.one<{ price_delta_minor: string; installment_id: string }>(`SELECT price_delta_minor, installment_id FROM orders.order_amendment WHERE change_request_id = $1`, [changeId]);
    expect(Number(amendment.price_delta_minor)).toBe(customerPriceDelta);
    const installment = await p.one<{ amount_minor: string }>(`SELECT amount_minor FROM finance.installment WHERE id = $1`, [amendment.installment_id]);
    expect(Number(installment.amount_minor)).toBe(customerPriceDelta);

    const so = ok(await p.as.finance.get(`/api/v1/sales-orders/${deal.orderId}`), 200, 'order');
    const changeInstallment = (so['installments'] as Body[]).find((i) => i['kind'] === 'change')!;
    const invoiced = ok(await p.as.finance.post(`/api/v1/sales-orders/${deal.orderId}/invoices`, { expectedVersion: so['aggregateVersion'], installmentId: changeInstallment['installmentId'] }), 201, 'invoice change');
    const invoice = (invoiced['invoices'] as Body[]).find((i) => i['kind'] === 'change')!;
    expect(invoice['totalMinor']).toBe(customerPriceDelta);
    expect((invoice['subtotalMinor'] as number) + (invoice['taxMinor'] as number)).toBe(customerPriceDelta);

    const poAmendment = await p.one<{ cost_delta_minor: string; acknowledged_at: Date | null }>(`SELECT cost_delta_minor, acknowledged_at FROM orders.purchase_order_amendment WHERE change_request_id = $1`, [changeId]);
    expect(Number(poAmendment.cost_delta_minor)).toBe(supplierCostDelta);
    expect(poAmendment.acknowledged_at).not.toBeNull();

    const lines = await p.rows<{ account_code: string; debit_minor: string; credit_minor: string; cost_object_id: string }>(
      `SELECT l.account_code, l.debit_minor, l.credit_minor, l.cost_object_id FROM finance.journal j JOIN finance.journal_line l ON l.journal_id = j.id WHERE j.source_id = $1`,
      [changeId],
    );
    const sum = (k: 'debit_minor' | 'credit_minor'): number => lines.reduce((n, l) => n + Number(l[k]), 0);
    expect([sum('debit_minor'), sum('credit_minor')]).toEqual([scrapCost, scrapCost]);
    expect(lines.every((l) => l.cost_object_id === deal.orderId)).toBe(true);
  });

  it('leaves a complete, ordered audit trail of who did what', async () => {
    expect(await p.auditActions(changeId)).toEqual([
      'change.change_proposed',
      'change.triage_started',
      'change.interim_decision_issued',
      'change.change_classified',
      'change.supplier_impact_submitted',
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
