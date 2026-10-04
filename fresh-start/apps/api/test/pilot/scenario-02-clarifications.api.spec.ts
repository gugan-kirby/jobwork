import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Body, ok, Pilot } from './driver';

/**
 * Pilot scenario 2 (doc 19 §10): an incomplete enquiry needs two clarifications before it
 * can be sourced. The customer is asked twice, answers twice; nothing they submitted is
 * rewritten; the answers become part of the requirement of record, and the round quotes
 * the clarified part.
 */
describe('Pilot 2: incomplete enquiry, two clarifications', () => {
  let p: Pilot;
  let enquiryId: string;
  let reference: string;
  let intakeHash: string;
  let staleVersion: number;
  let rfqId: string;

  async function ask(topic: string, question: string): Promise<Body> {
    return ok(
      await p.as.engineering.post(`/api/v1/intake/${enquiryId}/clarifications`, { expectedVersion: await p.enquiryVersion(enquiryId), questions: [{ topic, question, lineNo: 1 }] }),
      201,
      `ask ${topic}`,
    );
  }

  async function answer(text: string): Promise<Body> {
    const view = ok(await p.as.buyer.get(`/api/v1/enquiries/${enquiryId}`), 200, 'customer reads enquiry');
    const open = (view['clarifications'] as Body[]).filter((c) => c['status'] === 'open');
    expect(open).toHaveLength(1);
    return ok(await p.as.buyer.post(`/api/v1/enquiries/${enquiryId}/clarifications`, { answers: [{ clarificationId: open[0]!['clarificationId'], answer: text }] }), 201, 'customer answers');
  }

  beforeAll(async () => {
    p = await Pilot.start('s02');
    // No material grade and no tolerance: enough to submit, not enough to quote.
    ({ enquiryId, reference } = await p.submitEnquiry({}, { materialGrade: undefined, toleranceClass: undefined }));
    intakeHash = (await p.one<{ content_hash: string }>(`SELECT content_hash FROM sourcing.requirement WHERE enquiry_id = $1 AND revision_no = 1`, [enquiryId])).content_hash;
    await p.triage(enquiryId);
  }, 180_000);

  afterAll(async () => {
    await p?.stop();
  });

  it('asks the customer the first question, and holds approval while it is open', async () => {
    const asked = await ask('material', 'Which aluminium grade does the bracket need?');
    expect(asked['status']).toBe('clarification_required');
    const view = await p.as.buyer.get(`/api/v1/enquiries/${enquiryId}`);
    expect((view.body['enquiry'] as Body)['status']).toBe('information_needed');
    // Approving now would source a part nobody has fully described.
    const early = await p.as.engineering.post(`/api/v1/intake/${enquiryId}/approve`, { expectedVersion: await p.enquiryVersion(enquiryId) });
    expect(early.status).toBe(409);

    const answered = await answer('6061-T6, the same grade as our other Kovai pump brackets.');
    expect(answered['status']).toBe('under_review');
  });

  it('asks the second question in a new round and takes the second answer', async () => {
    const asked = await ask('tolerance', 'What tolerance does the motor bore need?');
    expect(asked['status']).toBe('clarification_required');
    staleVersion = await p.enquiryVersion(enquiryId);
    const answered = await answer('IT7 on the bore; IT8 everywhere else.');
    expect(answered['status']).toBe('under_review');
  });

  it('recovers from approving a stale version: refused, reloaded, approved', async () => {
    const stale = await p.as.engineering.post(`/api/v1/intake/${enquiryId}/approve`, { expectedVersion: staleVersion });
    expect(stale.status).toBe(409);
    expect(stale.body['code']).toBe('VERSION_CONFLICT');
    const approved = await p.approveForSourcing(enquiryId);
    expect(approved['status']).toBe('approved_for_sourcing');
  });

  it('keeps what was submitted byte for byte, and freezes every answer into the approved revision', async () => {
    const chain = await p.rows<{ revision_no: number; kind: string; content_hash: string; snapshot: { clarifications?: Array<{ topic: string; answer: string }> } }>(
      `SELECT revision_no, kind, content_hash, snapshot FROM sourcing.requirement WHERE enquiry_id = $1 ORDER BY revision_no`,
      [enquiryId],
    );
    expect(chain.map((r) => r.kind)).toEqual(['intake', 'reviewed', 'reviewed', 'reviewed']);
    expect(chain[0]!.content_hash).toBe(intakeHash);
    expect(chain[3]!.snapshot.clarifications?.map((c) => c.topic)).toEqual(['material', 'tolerance']);
  });

  it('carries the answers into the structured requirement the suppliers quote', async () => {
    const enquiry = (await p.intake(enquiryId))['enquiry'] as Body;
    const itemId = (enquiry['items'] as Body[])[0]!['enquiryItemId'];
    ok(
      await p.as.engineering.post(`/api/v1/intake/${enquiryId}/revise`, {
        expectedVersion: enquiry['aggregateVersion'],
        reason: 'Transcribe the customer’s answers on grade and bore tolerance',
        items: [{ enquiryItemId: itemId, materialGrade: '6061-T6', toleranceClass: 'IT7' }],
      }),
      201,
      'transcribe answers',
    );
    ({ rfqId } = await p.openRound(enquiryId));
    const rfq = await p.as.supplierA.get(`/api/v1/supplier/rfqs/${rfqId}`);
    const line = (rfq.body['items'] as Body[])[0]!;
    expect(JSON.stringify(line)).toContain('6061-T6');
    expect(JSON.stringify(line)).toContain('IT7');
    // The customer's own words, with their name in them, stay on the customer's side.
    p.expectNothingOf(rfq.body, ['Kovai', reference, 'our other'], 'supplier RFQ');
  });

  it('audits every question, answer and decision on the enquiry, in order', async () => {
    expect(await p.auditActions(enquiryId)).toEqual([
      'sourcing.enquiry_draft_saved',
      'sourcing.enquiry_submitted',
      'sourcing.triage_started',
      'sourcing.clarification_requested',
      'sourcing.clarification_answered',
      'sourcing.clarification_requested',
      'sourcing.clarification_answered',
      'sourcing.enquiry_approved_for_sourcing',
      'sourcing.requirement_revised',
    ]);
  });

  it('tells the customer each time it is their turn, and nobody else', async () => {
    await p.dispatchNotifications();
    const asked = (await p.notices('buyer')).filter((n) => n.template_key === 'customer.clarification_requested');
    expect(asked).toHaveLength(2);
    p.expectNothingOf(asked, ['engineering@', 'Anand', 'Balaji'], 'customer clarification notices');
    expect((await p.notices('supplierA')).map((n) => n.template_key)).toEqual(['supplier.rfq_invitation']);
  });
});
