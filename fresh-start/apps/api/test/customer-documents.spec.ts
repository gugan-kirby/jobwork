import type { CustomerDelivery } from '@jobwork/contracts';
import { describe, expect, it } from 'vitest';
import { renderDeliveryNote, renderProofOfDelivery, renderShippingLabels } from '../src/modules/logistics/presentation/customer-documents';

/**
 * IN-17 F-17.2 (`R-08`): the customer's logistics documents are rendered from the customer's own
 * projection and JobWork's name and city, and nothing else. Snapshots pin what a customer reads; the
 * API suite (`customer-dispatch.api.spec.ts`) checks that no supplier fact reaches the projection.
 */
const delivery: CustomerDelivery = {
  shipmentId: '6f1c2a90-0000-4000-8000-000000000001',
  number: 'SH-2026-0002',
  orderId: '6f1c2a90-0000-4000-8000-000000000002',
  orderNumber: 'SO-2026-0001',
  status: 'ready_to_leave',
  statusLabel: 'Packed, leaving soon',
  destination: {
    label: 'Kovai Pumps plant',
    addressLine1: 'SIDCO Industrial Estate, Mudalipalayam',
    addressLine2: '',
    city: 'Tiruppur',
    state: 'Tamil Nadu',
    postalCode: '641606',
    countryCode: 'IN',
    contactName: 'R. Kumar',
    contactPhone: '+91 98400 12345',
  },
  addressConfirmation: { needed: false, confirmedAt: '2026-10-05T09:00:00.000Z', byJobWork: false },
  carrier: { name: '', trackingReference: '' },
  dispatchedAt: null,
  packages: [
    { packageNo: 1, weightG: 9000, items: [{ lotMarking: 'JW-6F1C2A90', serials: [], quantity: '60', unit: 'piece', description: 'Pump bracket' }] },
    { packageNo: 2, weightG: null, items: [{ lotMarking: 'JW-0B44D1E7', serials: ['S-001', 'S-002'], quantity: '2', unit: 'piece', description: 'Pump bracket <spare>' }] },
  ],
  totalQuantity: '62',
  documents: { invoiceNumber: 'INV-2026-0002', eWaybillNumber: '1811 0000 0042' },
  tracking: [],
  pod: null,
  acceptance: null,
  acceptanceDueAt: null,
  exceptions: [],
  warrantyStatement: 'Accepting does not waive JobWork’s warranty.',
  actions: { confirmAddress: false, accept: false, reportIssue: false, reportNotReceived: false, reportDefect: false, requestAddressChange: false },
  createdAt: '2026-10-05T08:00:00.000Z',
  aggregateVersion: 6,
};
const from = { name: 'JobWork' as const, city: 'Chennai' };
const WARRANTY = 'Accepting does not waive JobWork’s warranty.';

describe('customer logistics documents (F-17.2)', () => {
  it('renders one label per package, to the customer from JobWork', () => {
    const { html, contentHash } = renderShippingLabels(delivery, from);
    expect(html.match(/class="label"/g)).toHaveLength(2);
    expect(html).toContain('From: JobWork, Chennai');
    expect(html).toContain('Carrier: to be assigned');
    expect(contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(html).toMatchSnapshot();
  });

  it('renders the delivery note with the documents, the lot markings and the warranty statement', () => {
    const { html } = renderDeliveryNote(delivery, from, WARRANTY);
    expect(html).toContain('Tax invoice INV-2026-0002 · E-way bill 1811 0000 0042');
    expect(html).toContain('Pump bracket &lt;spare&gt;');
    expect(html).toContain(WARRANTY);
    expect(html).toMatchSnapshot();
  });

  it('renders the proof of delivery as the handover only, naming where it was handed over (F-17.3)', () => {
    const delivered: CustomerDelivery = {
      ...delivery,
      status: 'awaiting_your_confirmation',
      carrier: { name: 'Safexpress', trackingReference: 'SX-55120' },
      pod: { receivedByName: 'R. Kumar', receivedAt: '2026-10-07T06:30:00.000Z', deliveredTo: { ...delivery.destination!, label: 'Kovai Pumps Hosur unit', city: 'Hosur' }, packagesReceived: 2, remarks: 'with_remarks', remarksNote: 'Carton 1 corner crushed' },
      acceptanceDueAt: '2026-10-14T18:29:59.999Z',
    };
    const { html } = renderProofOfDelivery(delivered, from);
    expect(html).toContain('Handed over to <strong>R. Kumar</strong>');
    expect(html).toContain('Kovai Pumps Hosur unit');
    expect(html).toContain('Received with remarks: Carton 1 corner crushed');
    expect(html).toContain('open until 2026-10-14');
    expect(html).toMatchSnapshot();
  });

  it('is deterministic: the same delivery gives the same hash, a changed one another', () => {
    expect(renderDeliveryNote(delivery, from, WARRANTY).contentHash).toBe(renderDeliveryNote(structuredClone(delivery), from, WARRANTY).contentHash);
    expect(renderDeliveryNote({ ...delivery, totalQuantity: '61' }, from, WARRANTY).contentHash).not.toBe(renderDeliveryNote(delivery, from, WARRANTY).contentHash);
  });
});
