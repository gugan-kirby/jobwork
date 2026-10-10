import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { test as setup } from '@playwright/test';
import { ApiSession, type Body, ok } from '../support/api';
import { STATE_FILE, type World } from '../support/world';

const daysFromNow = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

/**
 * Builds the records the journeys act on, entirely over HTTP against the prepared
 * database: an enquiry waiting for intake, a quotation waiting for the customer, an order
 * whose purchase order waits for the supplier, and an award waiting for approval.
 */
setup('build the journey world', async () => {
  setup.setTimeout(180_000);
  const buyer = await ApiSession.signIn('buyer@kovai.test');
  const approver = await ApiSession.signIn('approver@kovai.test');
  const supplierA = await ApiSession.signIn('estimator@anand.test');
  const supplierB = await ApiSession.signIn('estimator@balaji.test');
  const secrets: Record<string, string> = {};
  const staff: Record<string, ApiSession> = {};
  for (const who of ['engineering', 'sourcing', 'sales', 'sales2', 'finance', 'support']) {
    const email = `${who}@jobwork.test`;
    const { session, secret } = await ApiSession.signInEnrolled(email);
    staff[who] = session;
    secrets[email] = secret;
  }

  const taxonomy = ok(await buyer.get('/suppliers/me/taxonomy'), 200, 'taxonomy')['capabilities'] as Body[];
  const capability = (code: string): string => taxonomy.find((c) => c['code'] === code)!['capabilityId'] as string;
  const documents = ok(await buyer.get('/documents'), 200, 'documents')['documents'] as Body[];
  const drawing = documents.find((d) => d['title'] === 'Bracket drawing')!['currentVersionId'] as string;

  async function submittedEnquiry(title: string): Promise<string> {
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
            processCapabilityId: capability('cnc_milling'),
            materialCapabilityId: capability('material_aluminium'),
            materialGrade: '6061-T6',
            quantityBreakpoints: [{ quantity: 100, unit: 'piece', kind: 'production' }],
            toleranceClass: 'IT8',
            inspectionLevel: 'dimensional_report',
          },
        ],
        documents: [{ documentVersionId: drawing, role: 'governing', lineNo: 1 }],
      }),
      201,
      'draft',
    );
    const submitted = ok(await buyer.post(`/enquiries/${draft['enquiryId']}/submit`, { expectedVersion: draft['aggregateVersion'] }), 201, 'submit');
    return (submitted['enquiryId'] as string | undefined) ?? (draft['enquiryId'] as string);
  }

  async function intakeVersion(id: string): Promise<number> {
    return (ok(await staff['engineering']!.get(`/intake/${id}`), 200, 'intake')['enquiry'] as Body)['aggregateVersion'] as number;
  }

  async function sourced(title: string): Promise<{ enquiryId: string; rfqId: string; itemId: string; bidA: string }> {
    const enquiryId = await submittedEnquiry(title);
    ok(await staff['engineering']!.post(`/intake/${enquiryId}/triage`, { expectedVersion: await intakeVersion(enquiryId) }), 201, 'triage');
    ok(await staff['engineering']!.post(`/intake/${enquiryId}/approve`, { expectedVersion: await intakeVersion(enquiryId) }), 201, 'approve');
    const sourcing = staff['sourcing']!;
    const rfqId = ok(await sourcing.post('/rfqs', { enquiryId, deadlineAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), lateBidPolicy: 'reject', instructions: 'Quote per piece at 100 off.' }), 201, 'rfq')['rfqId'] as string;
    const candidates = ok(await sourcing.get(`/rfqs/match?enquiryId=${enquiryId}`), 200, 'match')['candidates'] as Body[];
    for (const c of candidates.filter((x) => x['eligible'])) ok(await sourcing.post(`/rfqs/${rfqId}/invitations`, { supplierProfileId: c['supplierProfileId'] }), 201, 'invite');
    const version = async (): Promise<number> => (ok(await sourcing.get(`/rfqs/${rfqId}`), 200, 'rfq')['rfq'] as Body)['aggregateVersion'] as number;
    ok(await sourcing.post(`/rfqs/${rfqId}/release`, { expectedVersion: await version() }), 201, 'release');
    const itemId = ((ok(await supplierA.get(`/supplier/rfqs/${rfqId}`), 200, 'supplier rfq')['items'] as Body[])[0]!['rfqItemId']) as string;
    const bid = (price: number): Body => ({
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
    const bidA = ok(await supplierA.post(`/supplier/rfqs/${rfqId}/bid/submit`, bid(4850)), 201, 'bid A')['bidVersionId'] as string;
    ok(await supplierB.post(`/supplier/rfqs/${rfqId}/bid/submit`, bid(5250)), 201, 'bid B');
    ok(await sourcing.post(`/rfqs/${rfqId}/close`, { expectedVersion: await version() }), 201, 'close');
    return { enquiryId, rfqId, itemId, bidA };
  }

  async function proposeAward(round: { rfqId: string; itemId: string; bidA: string }): Promise<Body> {
    const evaluationId = ok(await staff['sourcing']!.post(`/rfqs/${round.rfqId}/evaluations`, { scenario: { inspectionPackagingMinor: 0, financingRiskBp: 0, nreAllocation: 'value' } }), 201, 'evaluate')['evaluationId'];
    return ok(
      await staff['sourcing']!.post('/awards', {
        rfqId: round.rfqId,
        evaluationId,
        items: [{ rfqItemId: round.itemId, targetQuantity: 100, lines: [{ bidVersionId: round.bidA, bidQuantity: 100, quantity: 100 }] }],
        rationale: 'Lowest normalized landed cost with the lead time the customer needs.',
      }),
      201,
      'award',
    );
  }

  async function sentQuote(round: { rfqId: string; itemId: string; bidA: string }): Promise<string> {
    const award = await proposeAward(round);
    ok(await staff['sales']!.post(`/approvals/${award['approvalRequestId']}/decide`, { decision: 'approved', reason: '' }), 201, 'approve award');
    const sales = staff['sales']!;
    const sheet = ok(await sales.post(`/awards/${award['awardId']}/cost-sheet`, { components: [{ code: 'freight_outbound', label: 'Freight to customer', amountMinor: 30000, basis: 'courier estimate' }], targetMarginBp: 1500, note: '' }), 201, 'cost sheet');
    const requested = ok(await sales.post(`/cost-sheets/${sheet['costSheetId']}/request-approval`, {}), 201, 'request cost sheet approval');
    ok(await staff['finance']!.post(`/approvals/${(requested['versions'] as Body[])[0]!['approvalRequestId']}/decide`, { decision: 'approved', reason: '' }), 201, 'approve cost sheet');
    const approvedSheet = ok(await sales.get(`/cost-sheets/${sheet['costSheetId']}`), 200, 'cost sheet');
    const costSheetVersionId = (approvedSheet['versions'] as Body[]).find((v) => v['status'] === 'approved')!['costSheetVersionId'];
    const quote = ok(await sales.post('/quotes', { costSheetVersionId, optionLabel: 'standard', content: { deliveryLeadDays: 21, paymentTerms: '50% advance, balance before dispatch', validityUntil: daysFromNow(14), advanceBp: 5000, balanceTrigger: 'before_dispatch', taxRateBp: 1800, freightMinor: 0 } }), 201, 'quote');
    const quoteId = quote['quoteId'] as string;
    const qv = async (): Promise<number> => ok(await sales.get(`/quotes/${quoteId}`), 200, 'quote')['aggregateVersion'] as number;
    const req = ok(await sales.post(`/quotes/${quoteId}/request-approval`, { expectedVersion: await qv() }), 201, 'request quote approval');
    ok(await staff['sales2']!.post(`/approvals/${(req['versions'] as Body[])[0]!['approvalRequestId']}/decide`, { decision: 'approved', reason: '' }), 201, 'approve quote');
    ok(await sales.post(`/quotes/${quoteId}/send`, { expectedVersion: await qv() }), 201, 'send quote');
    return quoteId;
  }

  // An enquiry waiting at intake.
  const intakeEnquiryId = await submittedEnquiry('Coupling flange');
  const intakeReference = (ok(await buyer.get(`/enquiries/${intakeEnquiryId}`), 200, 'enquiry')['enquiry'] as Body)['reference'] as string;

  // Deal A: a quotation waiting for the customer.
  const dealA = await sourced('Pump mounting bracket');
  const openQuoteId = await sentQuote(dealA);

  /** Accepted by the customer's approver, ordered, POs issued; returns the order and supplier A's PO. */
  async function ordered(quoteId: string): Promise<{ orderId: string; purchaseOrderId: string }> {
    const seen = ok(await approver.get(`/quotations/${quoteId}`), 200, 'quotation');
    const accepted = ok(
      await approver.post(
        `/quotations/${quoteId}/accept`,
        { expectedVersion: seen['aggregateVersion'], quoteVersionNo: seen['versionNo'], contentHash: seen['contentHash'], termsHash: (seen['terms'] as Body)['hash'], acknowledgeTerms: true },
        { 'idempotency-key': `e2e-accept-${quoteId}` },
      ),
      201,
      'accept',
    );
    const id = accepted['orderId'] as string;
    const so = ok(await staff['sourcing']!.get(`/sales-orders/${id}`), 200, 'sales order');
    const pos = ok(await staff['sourcing']!.post(`/sales-orders/${id}/purchase-orders`, { expectedVersion: so['aggregateVersion'] }), 201, 'issue POs')['purchaseOrders'] as Body[];
    return { orderId: id, purchaseOrderId: pos[0]!['purchaseOrderId'] as string };
  }

  // Deal B: accepted, ordered, PO issued to supplier A.
  const dealB = await sourced('Motor base plate');
  const { orderId, purchaseOrderId } = await ordered(await sentQuote(dealB));

  // Deal D (IN-18): supplier A acknowledged and billed its PO; the customer opened a case on the order.
  const dealD = await ordered(await sentQuote(await sourced('Pump end cover')));
  const po = ok(await supplierA.get(`/supplier/purchase-orders/${dealD.purchaseOrderId}`), 200, 'supplier PO');
  ok(await supplierA.post(`/supplier/purchase-orders/${dealD.purchaseOrderId}/acknowledge`, { expectedVersion: po['aggregateVersion'], note: 'Material booked.' }), 201, 'acknowledge');
  const billId = ok(
    await supplierA.post('/supplier/bills', { purchaseOrderId: dealD.purchaseOrderId, supplierReference: 'AE/E2E-1', billDate: daysFromNow(0), quantity: '100', taxableMinor: 100 * 4850, taxMinor: 0 }),
    201,
    'bill',
  )['billId'] as string;
  const caseId = ok(await buyer.post('/support/cases', { salesOrderId: dealD.orderId, kind: 'warranty', title: 'Thread worn on two covers', description: 'Two threads stripped at assembly' }), 201, 'case')['caseId'] as string;

  // An award waiting for approval.
  const dealC = await sourced('Gearbox cover');
  const pending = await proposeAward(dealC);

  const state: World = {
    intakeEnquiryId,
    intakeReference,
    openQuoteId,
    openRfqId: dealA.rfqId,
    orderId,
    purchaseOrderId,
    billId,
    caseId,
    pendingApprovalId: pending['approvalRequestId'] as string,
    secrets,
  };
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
});
