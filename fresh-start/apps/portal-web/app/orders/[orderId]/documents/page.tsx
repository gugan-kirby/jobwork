'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import type { CustomerOrderDocument } from '@jobwork/contracts';
import { Button, Card, ErrorState, Inline, LoadingState, Page, Stack } from '@jobwork/ui';
import { api, ApiError } from '../../../../lib/api';

const KIND: Record<CustomerOrderDocument['kind'], string> = {
  quotation: 'Quotation',
  invoice: 'Invoice',
  delivery_note: 'Delivery note',
  proof_of_delivery: 'Proof of delivery',
  conformity_certificate: 'Certificate of conformance',
};
const day = (iso: string): string => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));

/**
 * The order's documents for your own record (IN-17 F-17.5; doc 14 §4 "documents"): the quotation you
 * accepted, JobWork's invoices, and for each delivery its delivery note, certificate of conformance
 * and proof of delivery. Each is issued once and carries the hash of its own content.
 */
export default function OrderDocumentsPage(): React.JSX.Element {
  const orderId = useParams<{ orderId: string }>().orderId;
  const [docs, setDocs] = useState<CustomerOrderDocument[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [hashes, setHashes] = useState<Record<string, string>>({});

  useEffect(() => {
    api<CustomerOrderDocument[]>(`/orders/${orderId}/documents`)
      .then(setDocs)
      .catch((err) => {
        if (err instanceof ApiError) setError(err);
      });
  }, [orderId]);

  const open = async (d: CustomerOrderDocument): Promise<void> => {
    const { html, contentHash } = await api<{ html: string; contentHash: string }>(d.path);
    setHashes((h) => ({ ...h, [d.path]: contentHash }));
    window.open(URL.createObjectURL(new Blob([html], { type: 'text/html' })), '_blank', 'noopener');
  };

  return (
    <Page title="Order documents" back={{ href: `/orders/${orderId}`, label: 'Back to the order' }}>
      {error ? (
        <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} />
      ) : !docs ? (
        <Card>
          <LoadingState label="Loading the documents" />
        </Card>
      ) : (
        <Card>
          <Stack gap={3}>
            {docs.map((d) => (
              <Inline key={d.path} gap={3} justify="space-between">
                <span>
                  <strong>{KIND[d.kind]}</strong> <span className="mono">{d.reference}</span>
                  <span style={{ display: 'block', font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
                    {d.date ? day(d.date) : ''}
                    {hashes[d.path] ? ` · hash ${hashes[d.path]!.slice(0, 12)}…` : ''}
                  </span>
                </span>
                <Button size="sm" variant="secondary" onClick={() => void open(d)}>
                  Open
                </Button>
              </Inline>
            ))}
          </Stack>
        </Card>
      )}
    </Page>
  );
}
