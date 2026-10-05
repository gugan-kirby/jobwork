import { describe, expect, it } from 'vitest';
import { applyOverrides, customerLotMarking, legTwoGuards, lotKey, reasonsHash, type LegTwoFacts } from '../src/modules/logistics/domain/dispatch-gate';

/**
 * IN-17 F-17.2: the leg-2 dispatch gate as pure arithmetic over facts (doc 10 §12; BR-LOG-03). Each
 * guard turns red on its own fact and on nothing else; overrides cover exactly the reasons their
 * owner approved, and only the four guards owned by someone other than logistics.
 */
const LOT = '6f1c2a90-0000-4000-8000-000000000001';
const WP = 'wp-1';

function green(): LegTwoFacts {
  return {
    order: { number: 'SO-2026-0001', ordered: '100', partialDelivery: 'allowed', packagingNote: '' },
    items: [{ packageNo: 1, stockLotId: LOT, marking: customerLotMarking(LOT), lotCode: 'LOT-A', quantity: '60', workPackageId: WP }],
    packageNos: [1],
    lots: new Map([[LOT, { ofOrder: true, inStock: '60', openReceipt: null }]]),
    dispatchedBefore: '0',
    quality: new Map([[WP, { releases: [{ lots: ['LOT-A'], quantity: '60' }], openNcrs: [] }]]),
    dispatchedOfLot: new Map([[lotKey(WP, 'LOT-A'), '0']]),
    payment: { currency: 'INR', holds: [], unpaid: [], credit: null },
    holds: { stops: [], openChanges: [] },
    identity: { packingCheck: { neutralCartons: true, supplierMarksRemoved: true, jobworkLabelsApplied: true, packagingNoteFollowed: true }, findings: [] },
    address: { problem: null, contactMissing: false, confirmation: 'current' },
    documents: { invoiceNumber: 'INV-2026-0002', invoice: { status: 'paid' }, eWaybillNumber: '181100000001', consignmentValueMinor: 6_000_000 },
  };
}

const red = (f: LegTwoFacts): string[] => legTwoGuards(f).filter((g) => !g.pass).map((g) => g.key);

describe('leg-2 dispatch gate (F-17.2)', () => {
  it('is green on authoritative facts, and marks the four overridable guards', () => {
    const guards = legTwoGuards(green());
    expect(guards.map((g) => g.key)).toEqual(['stock', 'quality', 'payment', 'commitment', 'holds', 'identity', 'address', 'documents']);
    expect(guards.every((g) => g.pass)).toBe(true);
    expect(guards.filter((g) => g.overridable).map((g) => g.key)).toEqual(['quality', 'payment', 'commitment', 'holds']);
  });

  it('marks a lot with JobWork’s own code, the same for the same lot', () => {
    expect(customerLotMarking(LOT)).toBe('JW-6F1C2A90');
    expect(customerLotMarking(LOT)).not.toContain('LOT-A');
  });

  const cases: Array<[string, (f: LegTwoFacts) => void, string, RegExp]> = [
    ['more than stock holds', (f) => f.lots.set(LOT, { ofOrder: true, inStock: '50', openReceipt: null }), 'stock', /60 to ship, 50 in JobWork stock/],
    ['another order’s lot', (f) => f.lots.set(LOT, { ofOrder: false, inStock: '60', openReceipt: null }), 'stock', /not this order’s stock/],
    ['a receipt still held', (f) => f.lots.set(LOT, { ofOrder: true, inStock: '60', openReceipt: 'SH-2026-0001' }), 'stock', /SH-2026-0001 still has an open discrepancy/],
    ['an empty package', (f) => f.packageNos.push(2), 'stock', /Package 2 is empty/],
    ['over-delivery', (f) => (f.dispatchedBefore = '50'), 'stock', /110 would be delivered against 100 ordered/],
    ['a lot quality never released', (f) => f.quality.set(WP, { releases: [{ lots: ['LOT-B'], quantity: '60' }], openNcrs: [] }), 'quality', /LOT-A\) is not quality released/],
    ['an NCR on the lot', (f) => f.quality.set(WP, { releases: [{ lots: ['LOT-A'], quantity: '60' }], openNcrs: [{ number: 'NCR-2026-0003', lots: ['LOT-A'] }] }), 'quality', /NCR-2026-0003 holds LOT-A/],
    ['more than released, counting earlier deliveries', (f) => f.dispatchedOfLot.set(lotKey(WP, 'LOT-A'), '10'), 'quality', /70 would be dispatched against 60 quality released/],
    ['a credit hold', (f) => (f.payment.holds = ['Cheque bounced']), 'payment', /Credit hold: Cheque bounced/],
    ['an unpaid balance and no credit', (f) => (f.payment.unpaid = [{ label: 'Balance (60 %)', invoiceNumber: 'INV-2026-0002', openMinor: 3_600_000 }]), 'payment', /INV-2026-0002\): ₹36,000.00 open.*no approved credit/s],
    ['credit exceeded', (f) => ((f.payment.unpaid = [{ label: 'Balance', invoiceNumber: null, openMinor: 100 }]), (f.payment.credit = { usable: true, limitMinor: 1000, exposureMinor: 5000 })), 'payment', /Balance is not invoiced yet.*would be exceeded/s],
    ['a partial delivery the customer did not allow', (f) => (f.order.partialDelivery = 'not_allowed'), 'commitment', /one complete delivery: this ships 60 of the 100 outstanding/],
    ['an interim stop', (f) => (f.holds.stops = [{ purchaseOrderNumber: 'PO-2026-0001', changeNumber: 'CR-2026-0001' }]), 'holds', /stopped under CR-2026-0001/],
    ['an open change', (f) => (f.holds.openChanges = [{ number: 'CR-2026-0002', status: 'impact_analysis' }]), 'holds', /CR-2026-0002 is open on this order \(impact analysis\)/],
    ['an unticked packing check', (f) => (f.identity.packingCheck.supplierMarksRemoved = false), 'identity', /workshop tags, stickers and paperwork removed/],
    ['a supplier’s name on a serial', (f) => (f.identity.findings = [{ field: 'a serial', text: 'Anand' }]), 'identity', /“Anand” in a serial names another party/],
    ['an address that is not the customer’s', (f) => (f.address.problem = 'The delivery address must be one of the customer’s active addresses.'), 'address', /customer’s active addresses/],
    ['no receiving contact', (f) => (f.address.contactMissing = true), 'address', /receiving contact/],
    ['no confirmation', (f) => (f.address.confirmation = 'none'), 'address', /not confirmed the delivery address/],
    ['a stale confirmation', (f) => (f.address.confirmation = 'stale'), 'address', /changed after it was confirmed/],
    ['another order’s invoice', (f) => (f.documents.invoice = null), 'documents', /INV-2026-0002 is not an invoice of SO-2026-0001/],
    ['a void invoice', (f) => (f.documents.invoice = { status: 'void' }), 'documents', /is void/],
    ['a malformed e-way bill', (f) => (f.documents.eWaybillNumber = '1811-XX'), 'documents', /not a 12-digit e-way bill number/],
    ['no e-way bill above ₹50,000', (f) => (f.documents.eWaybillNumber = ''), 'documents', /worth ₹60,000.00: give the e-way bill number/],
  ];

  it.each(cases)('turns one guard red on %s', (_name, mutate, key, reason) => {
    const f = green();
    mutate(f);
    const guards = legTwoGuards(f);
    expect(red(f)).toEqual([key]);
    expect(guards.find((g) => g.key === key)!.reasons.join(' ')).toMatch(reason);
  });

  it('needs no e-way bill at or below ₹50,000 and accepts one written with spaces', () => {
    const below = green();
    below.documents = { ...below.documents, eWaybillNumber: '', consignmentValueMinor: 5_000_000 };
    expect(red(below)).toEqual([]);
    const spaced = green();
    spaced.documents.eWaybillNumber = '1811 0000 0001';
    expect(red(spaced)).toEqual([]);
  });

  it('lets approved credit cover what is open', () => {
    const f = green();
    f.payment.unpaid = [{ label: 'Balance', invoiceNumber: 'INV-2026-0002', openMinor: 3_600_000 }];
    f.payment.credit = { usable: true, limitMinor: 10_000_000, exposureMinor: 3_600_000 };
    expect(red(f)).toEqual([]);
  });

  it('covers a red guard only with an approved override for exactly its reasons', () => {
    const f = green();
    f.payment.unpaid = [{ label: 'Balance', invoiceNumber: 'INV-2026-0002', openMinor: 3_600_000 }];
    const payment = legTwoGuards(f).find((g) => g.key === 'payment')!;
    const override = (status: 'requested' | 'approved' | 'rejected', reasons: string[], at = 1) => ({ overrideId: `o-${at}`, guardKey: 'payment', status, approvalRequestId: `a-${at}`, reasonsHash: reasonsHash(reasons), requestedAt: new Date(at) });

    expect(applyOverrides(legTwoGuards(f), [override('requested', payment.reasons)]).find((g) => g.key === 'payment')).toMatchObject({ pass: false, override: { status: 'requested', covers: false } });
    expect(applyOverrides(legTwoGuards(f), [override('approved', payment.reasons)]).find((g) => g.key === 'payment')).toMatchObject({ pass: true, override: { status: 'approved', covers: true } });
    // A later rejection, or a new reason the owner never saw, leaves the guard red.
    expect(applyOverrides(legTwoGuards(f), [override('approved', payment.reasons, 1), override('rejected', payment.reasons, 2)]).find((g) => g.key === 'payment')!.pass).toBe(false);
    f.payment.holds = ['Cheque bounced'];
    expect(applyOverrides(legTwoGuards(f), [override('approved', payment.reasons)]).find((g) => g.key === 'payment')).toMatchObject({ pass: false, override: { covers: false } });
  });

  it('never lets an override turn a logistics guard green', () => {
    const f = green();
    f.address.confirmation = 'none';
    const address = legTwoGuards(f).find((g) => g.key === 'address')!;
    const forged = { overrideId: 'o', guardKey: 'address', status: 'approved' as const, approvalRequestId: 'a', reasonsHash: reasonsHash(address.reasons), requestedAt: new Date() };
    expect(applyOverrides(legTwoGuards(f), [forged]).find((g) => g.key === 'address')).toMatchObject({ pass: false, override: null });
  });
});
