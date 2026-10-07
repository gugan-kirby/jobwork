'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { CustomerDelivery, DeliveryIssueKind, OrganizationSite, SiteSnapshot } from '@jobwork/contracts';
import {
  ActionNeededCard,
  Button,
  Callout,
  Card,
  CommandButton,
  DescriptionList,
  ErrorState,
  FileUpload,
  Inline,
  LoadingState,
  Page,
  Select,
  Stack,
  StatusChip,
  TextArea,
  TextInput,
  type VersionState,
} from '@jobwork/ui';
import { api, ApiError } from '../../../../../lib/api';
import { createUploadApi } from '../../../../../lib/upload-api';
import { DELIVERY_TONE } from '../../deliveries-panel';

const day = (iso: string): string => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
const moment = (iso: string): string => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
const address = (s: SiteSnapshot | null): string => (s ? [s.label, s.addressLine1, s.addressLine2, `${s.city}, ${s.state} ${s.postalCode}`].filter((x) => x.trim()).join(', ') : '—');

const ISSUE: Record<DeliveryIssueKind, string> = {
  not_received: 'Nothing arrived',
  shortage: 'Fewer pieces than the delivery note',
  damage: 'Damaged',
  wrong_item: 'Not the part ordered',
  quality_defect: 'A defect',
  documents: 'The documents are wrong or missing',
};
const EXCEPTION_LABEL: Record<string, string> = { address_change: 'Address change', refused: 'Refused at delivery', ...ISSUE };
const RESOLUTION: Record<string, string> = {
  found_delivered: 'Found delivered',
  customer_withdrew: 'Withdrawn by you',
  handed_to_case: 'Being handled under a case',
  redirected: 'Redirected by the carrier',
  declined: 'Declined by JobWork',
  returned_to_stock: 'Back with JobWork',
};

/** Opens a document JobWork rendered for you, in a new tab. */
async function openDocument(path: string): Promise<void> {
  const { html } = await api<{ html: string; contentHash: string }>(path);
  window.open(URL.createObjectURL(new Blob([html], { type: 'text/html' })), '_blank', 'noopener');
}

/**
 * One delivery, the customer's side (IN-17 F-17.5; UC-09; FR-905; doc 19 §8): confirm where it goes,
 * follow it, and once it is handed over, accept it or report what is wrong with your own photos,
 * inside the window. A defect found later is still yours to report, as a warranty claim.
 */
export default function DeliveryPage(): React.JSX.Element {
  const { orderId, shipmentId } = useParams<{ orderId: string; shipmentId: string }>();
  const [d, setD] = useState<CustomerDelivery | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [sites, setSites] = useState<OrganizationSite[]>([]);
  const [report, setReport] = useState<{ open: boolean; kind: DeliveryIssueKind | ''; lotMarking: string; quantity: string; description: string }>({ open: false, kind: '', lotMarking: '', quantity: '', description: '' });
  const [photos, setPhotos] = useState<string[]>([]);
  const [uploadKey, setUploadKey] = useState(0);
  const [change, setChange] = useState<{ open: boolean; siteId: string; reason: string }>({ open: false, siteId: '', reason: '' });
  const [note, setNote] = useState('');
  const uploadApi = useMemo(() => createUploadApi(), []);

  const load = useCallback(async () => {
    try {
      setD(await api<CustomerDelivery>(`/deliveries/${shipmentId}`));
      setError(null);
    } catch (err) {
      if (err instanceof ApiError) setError(err);
    }
  }, [shipmentId]);

  useEffect(() => {
    void load();
    api<{ sites: OrganizationSite[] }>('/organizations/me/sites')
      .then((r) => setSites(r.sites))
      .catch(() => setSites([]));
  }, [load]);

  if (!d) {
    return (
      <Page title="Delivery" back={{ href: `/orders/${orderId}`, label: 'Back to the order' }}>
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} /> : <Card><LoadingState label="Loading the delivery" /></Card>}
      </Page>
    );
  }

  const post = async (path: string, body: Record<string, unknown>): Promise<void> => setD(await api<CustomerDelivery>(path, { method: 'POST', body, idempotencyKey: crypto.randomUUID() }));
  const kinds: DeliveryIssueKind[] = d.actions.reportNotReceived ? ['not_received'] : d.actions.reportIssue ? ['shortage', 'damage', 'wrong_item', 'quality_defect', 'documents'] : d.actions.reportDefect ? ['quality_defect'] : [];
  const markings = [...new Set(d.packages.flatMap((p) => p.items.map((i) => i.lotMarking)))];
  const elsewhere = sites.filter((x) => x.status === 'active' && x.label !== d.destination?.label);

  return (
    <Page
      title={`Delivery ${d.number}`}
      back={{ href: `/orders/${orderId}`, label: `Back to ${d.orderNumber}` }}
      meta={<StatusChip tone={DELIVERY_TONE[d.status]}>{d.statusLabel}</StatusChip>}
    >
      <Stack gap={4}>
        {d.addressConfirmation.needed ? (
          <ActionNeededCard
            title="Confirm the delivery address"
            detail={`It goes to ${address(d.destination)}, for ${d.destination?.contactName || 'your stores'} (${d.destination?.contactPhone || 'no phone'}). If that is wrong, correct it in your addresses first, then confirm.`}
            owner="You"
            action={
              <CommandButton size="sm" receiptLabel="Confirmed" onCommand={() => post(`/deliveries/${d.shipmentId}/confirm-address`, { expectedVersion: d.aggregateVersion })}>
                Confirm
              </CommandButton>
            }
          />
        ) : null}

        {d.actions.accept ? (
          <Card title="Confirm the delivery" description={d.acceptanceDueAt ? `By ${day(d.acceptanceDueAt)}. After that it is taken as accepted.` : undefined}>
            <Stack gap={2}>
              <Callout tone="neutral" title="What accepting means">{d.warrantyStatement}</Callout>
              <TextInput label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
              <Inline gap={2}>
                <CommandButton receiptLabel="Accepted" onCommand={() => post(`/deliveries/${d.shipmentId}/accept`, { expectedVersion: d.aggregateVersion, note: note.trim() })}>
                  Accept the delivery
                </CommandButton>
                <Button variant="secondary" onClick={() => setReport({ ...report, open: true })}>
                  Report a problem
                </Button>
              </Inline>
            </Stack>
          </Card>
        ) : null}

        {kinds.length > 0 && (report.open || !d.actions.accept) ? (
          <Card title={d.actions.reportDefect && !d.actions.reportIssue ? 'Report a defect (warranty)' : 'Report a problem'} description="With photos of what you see. JobWork answers on this delivery.">
            <Stack gap={2}>
              {!report.open ? (
                <Button variant="secondary" onClick={() => setReport({ ...report, open: true })}>
                  {d.actions.reportNotReceived ? 'Nothing arrived' : 'Report a problem'}
                </Button>
              ) : (
                <>
                  <Select label="What is wrong" placeholder="Choose" value={report.kind} options={kinds.map((k) => ({ value: k, label: ISSUE[k] }))} onChange={(e) => setReport({ ...report, kind: e.target.value as DeliveryIssueKind })} />
                  {report.kind && report.kind !== 'not_received' && report.kind !== 'documents' ? (
                    <>
                      <Select label="Lot (as on the delivery note)" placeholder="Whole delivery" value={report.lotMarking} options={markings.map((m) => ({ value: m, label: m }))} onChange={(e) => setReport({ ...report, lotMarking: e.target.value })} />
                      <TextInput label="How many pieces" inputMode="decimal" value={report.quantity} onChange={(e) => setReport({ ...report, quantity: e.target.value })} />
                    </>
                  ) : null}
                  <TextArea label="What you found" value={report.description} onChange={(e) => setReport({ ...report, description: e.target.value })} />
                  <FileUpload
                    key={uploadKey}
                    purpose="image"
                    api={uploadApi}
                    resumeKey={`delivery-issue-${d.shipmentId}`}
                    onSettled={(v: VersionState) => {
                      if (v.status === 'available') {
                        setPhotos((list) => [...list, v.documentVersionId]);
                        setUploadKey((k) => k + 1);
                      }
                    }}
                  />
                  {photos.length > 0 ? <p style={{ font: 'var(--text-caption)' }}>{photos.length} photo{photos.length === 1 ? '' : 's'} attached</p> : null}
                  <CommandButton
                    receiptLabel="Reported"
                    disabled={!report.kind || report.description.trim().length < 3}
                    disabledReason="Choose what is wrong and describe it"
                    onCommand={async () => {
                      await post(`/deliveries/${d.shipmentId}/issues`, { kind: report.kind, lotMarking: report.lotMarking, quantity: report.quantity.trim() || '0', description: report.description.trim(), evidenceDocumentVersionIds: photos });
                      setReport({ open: false, kind: '', lotMarking: '', quantity: '', description: '' });
                      setPhotos([]);
                    }}
                  >
                    Send the report
                  </CommandButton>
                </>
              )}
            </Stack>
          </Card>
        ) : null}

        {d.actions.requestAddressChange && elsewhere.length > 0 ? (
          <Card title="Deliver somewhere else" description="It has left JobWork. The carrier may be able to redirect it; JobWork arranges it and tells you what it costs.">
            {!change.open ? (
              <Button variant="secondary" onClick={() => setChange({ ...change, open: true })}>
                Ask for another address
              </Button>
            ) : (
              <Stack gap={2}>
                <Select label="Deliver to" placeholder="Choose" value={change.siteId} options={elsewhere.map((x) => ({ value: x.siteId, label: `${x.label}, ${x.city}` }))} onChange={(e) => setChange({ ...change, siteId: e.target.value })} />
                <TextInput label="Why" value={change.reason} onChange={(e) => setChange({ ...change, reason: e.target.value })} />
                <CommandButton receiptLabel="Asked" disabled={!change.siteId || change.reason.trim().length < 3} disabledReason="Choose the address and say why" onCommand={() => post(`/deliveries/${d.shipmentId}/address-change`, { siteId: change.siteId, reason: change.reason.trim() })}>
                  Ask JobWork
                </CommandButton>
              </Stack>
            )}
          </Card>
        ) : null}

        {d.exceptions.length > 0 ? (
          <Card title="Reports and changes">
            <Stack gap={2}>
              {d.exceptions.map((x) => (
                <Inline key={x.exceptionId} gap={2} justify="space-between">
                  <span>
                    <span className="mono">{x.number}</span> · {EXCEPTION_LABEL[x.kind] ?? x.kind}
                    {x.warrantyClaim ? ' (warranty claim)' : ''}
                    {x.lotMarking ? ` · ${x.lotMarking}` : ''}
                    {Number(x.quantity) > 0 ? ` · ${x.quantity}` : ''}
                    {x.requestedAddress ? ` · to ${x.requestedAddress.label}` : ''}
                    <span style={{ display: 'block', font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
                      {x.status === 'open' ? 'Open' : `${x.resolution ? RESOLUTION[x.resolution] : 'Resolved'}${x.caseReference ? ` · ${x.caseReference}` : ''}`}
                    </span>
                  </span>
                  {x.status === 'open' && x.raisedByParty === 'customer' && x.kind !== 'address_change' ? (
                    <CommandButton size="sm" variant="secondary" receiptLabel="Withdrawn" onCommand={() => post(`/delivery-exceptions/${x.exceptionId}/withdraw`, { note: '' })}>
                      Withdraw
                    </CommandButton>
                  ) : null}
                </Inline>
              ))}
            </Stack>
          </Card>
        ) : null}

        <Card title="Where it is">
          <DescriptionList
            columns={1}
            items={[
              { label: 'Deliver to', value: address(d.destination) },
              { label: 'Receiving contact', value: d.destination ? `${d.destination.contactName || '—'} · ${d.destination.contactPhone || '—'}` : '—' },
              { label: 'Carrier', value: d.carrier.name ? `${d.carrier.name} · ${d.carrier.trackingReference}` : 'Not yet handed to a carrier' },
              { label: 'Dispatched', value: d.dispatchedAt ? moment(d.dispatchedAt) : '—' },
              ...(d.pod
                ? [
                    { label: 'Handed over', value: `${moment(d.pod.receivedAt)} to ${d.pod.receivedByName}, at ${address(d.pod.deliveredTo)}` },
                    { label: 'Remarks', value: d.pod.remarks === 'clean' ? 'None' : d.pod.remarksNote },
                  ]
                : []),
              ...(d.acceptance ? [{ label: 'Accepted', value: `${d.acceptance.basis === 'deemed' ? 'Taken as accepted' : 'By you'} on ${day(d.acceptance.acceptedAt)}` }] : []),
            ]}
          />
          {d.tracking.length > 0 ? (
            <ul style={{ marginTop: 'var(--space-2)' }}>
              {d.tracking.map((t, i) => (
                <li key={i} style={{ font: 'var(--text-caption)' }}>
                  {moment(t.occurredAt)} · {t.status.replace(/_/g, ' ')}
                </li>
              ))}
            </ul>
          ) : null}
        </Card>

        <Card title="What is in it">
          <Stack gap={2}>
            {d.packages.map((p) => (
              <div key={p.packageNo}>
                <strong>Package {p.packageNo}</strong>
                {p.items.map((i) => (
                  <p key={i.lotMarking} style={{ font: 'var(--text-caption)' }}>
                    {i.description} · lot <span className="mono">{i.lotMarking}</span> · {i.quantity} {i.unit === 'piece' ? 'Nos' : i.unit}
                    {i.serials.length > 0 ? ` · ${i.serials.join(', ')}` : ''}
                  </p>
                ))}
              </div>
            ))}
          </Stack>
        </Card>

        <Card title="Documents">
          <Inline gap={2}>
            <Button size="sm" variant="secondary" onClick={() => void openDocument(`/deliveries/${d.shipmentId}/delivery-note`)}>
              Delivery note
            </Button>
            {d.status !== 'preparing' ? (
              <Button size="sm" variant="secondary" onClick={() => void openDocument(`/deliveries/${d.shipmentId}/conformity`)}>
                Certificate of conformance
              </Button>
            ) : null}
            {d.pod ? (
              <Button size="sm" variant="secondary" onClick={() => void openDocument(`/deliveries/${d.shipmentId}/pod`)}>
                Proof of delivery
              </Button>
            ) : null}
            <Link href={`/orders/${orderId}/documents`}>All documents of the order</Link>
          </Inline>
        </Card>
      </Stack>
    </Page>
  );
}
