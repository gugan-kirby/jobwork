import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Body, ok, Pilot } from './pilot/driver';

/**
 * F-FP: the fixed-price path. The customer names the price it hopes to pay (FR-308); JobWork offers
 * the supplier a price it sets (FR-408) and sets the customer's price itself (FR-409). The supplier
 * never sees the customer, its target, or the customer's price.
 */
describe('fixed-price path (F-FP)', () => {
  let p: Pilot;

  beforeAll(async () => {
    p = await Pilot.start('fixedprice');
  }, 120_000);

  afterAll(async () => {
    await p?.stop();
  });

  describe('F-FP.1 the customer’s target price', () => {
    let enquiryId: string;

    it('keeps the target with the item, in the frozen revision, and shows it to JobWork', async () => {
      expect((await p.as.buyer.post('/api/v1/enquiries/draft', p.draftBody({}, { targetUnitPriceMinor: -1 }))).status).toBe(400);
      expect((await p.as.buyer.post('/api/v1/enquiries/draft', p.draftBody({}, { targetUnitPriceMinor: 12.5 }))).status).toBe(400);

      const draft = ok(await p.as.buyer.post('/api/v1/enquiries/draft', p.draftBody({}, { targetUnitPriceMinor: 13_000 })), 201, 'draft');
      expect(((draft['items'] as Body[])[0]!)['targetUnitPriceMinor']).toBe(13_000);
      expect(draft['currency']).toBe('INR');
      const seen = ok(await p.as.buyer.get(`/api/v1/enquiries/${draft['enquiryId']}`), 200, 'customer reads draft');
      expect((((seen['draft'] as Body)['items'] as Body[])[0]!)['targetUnitPriceMinor']).toBe(13_000);

      ok(await p.as.buyer.post(`/api/v1/enquiries/${draft['enquiryId']}/submit`, { expectedVersion: draft['aggregateVersion'] }), 201, 'submit');
      enquiryId = draft['enquiryId'] as string;
      const intake = (await p.intake(enquiryId))['enquiry'] as Body;
      expect(intake).toMatchObject({ currency: 'INR', items: [expect.objectContaining({ targetUnitPriceMinor: 13_000 })] });
      const revision = await p.one<{ snapshot: Body }>(`SELECT snapshot FROM sourcing.requirement WHERE enquiry_id = $1 ORDER BY revision_no DESC LIMIT 1`, [enquiryId]);
      expect(((revision.snapshot['items'] as Body[])[0]!)['targetUnitPriceMinor']).toBe(13_000);
    });

    it('leaves an enquiry without a target hashed exactly as before', async () => {
      const { enquiryId: plain } = await p.submitEnquiry();
      const revision = await p.one<{ snapshot: Body }>(`SELECT snapshot FROM sourcing.requirement WHERE enquiry_id = $1`, [plain]);
      expect(Object.keys((revision.snapshot['items'] as Body[])[0]!)).not.toContain('targetUnitPriceMinor');
    });

    it('never sends the target to a supplier', async () => {
      await p.triage(enquiryId);
      await p.approveForSourcing(enquiryId);
      const { rfqId } = await p.openRound(enquiryId);
      const view = ok(await p.as.supplierA.get(`/api/v1/supplier/rfqs/${rfqId}`), 200, 'supplier round');
      p.expectNothingOf(view, ['13000', '130.00', 'targetUnitPrice', 'Kovai'], 'supplier RFQ view');
    });
  });
});
