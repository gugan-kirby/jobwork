'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import type { DeliveryException, DeliveryExceptionResolution, PodRemarks, Shipment, SiteSnapshot } from '@jobwork/contracts';
import { Button, Callout, Card, CommandButton, DescriptionList, FileUpload, GateMatrix, Inline, Select, Stack, StatusChip, TextInput, type VersionState } from '@jobwork/ui';
import { api } from '../../../../lib/api';
import { createUploadApi } from '../../../../lib/upload-api';
import { EXCEPTION, EXCEPTION_RESOLUTION, EXCEPTION_RESOLUTIONS, GUARD_OWNER, when } from '../../labels';

const address = (s: SiteSnapshot | null): string => (s ? `${s.label}, ${s.addressLine1}, ${s.city} ${s.postalCode}` : '—');

/** Opens one of the customer's documents, rendered by the API, in a new tab. */
async function openDocument(path: string): Promise<void> {
  const { html } = await api<{ html: string; contentHash: string }>(path);
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  window.open(url, '_blank', 'noopener');
}

/**
 * Leg 2 before it leaves (IN-17 F-17.5; doc 10 §12; doc 03 §4): the eight guards, an override
 * asked of a red guard's owner, a confirmation the customer gave by phone, submit and release.
 */
export function DispatchGatePanel({ s, onChange }: { s: Shipment; onChange: (s: Shipment) => void }): React.JSX.Element {
  const [asking, setAsking] = useState<string | null>(null);
  const [justification, setJustification] = useState('');
  const [note, setNote] = useState('');
  const d = s.delivery!;
  const post = async (path: string, body: Record<string, unknown>): Promise<void> => onChange(await api<Shipment>(`/customer-dispatches/${s.shipmentId}${path}`, { method: 'POST', body, idempotencyKey: crypto.randomUUID() }));
  const green = s.guards.every((g) => g.pass);
  return (
    <Card title="Dispatch gate" description="doc 10 §12. Every guard green, or overridden by its owner for exactly the reasons shown. Release checks them again and moves the stock out.">
      <Stack gap={3}>
        <GateMatrix gates={s.guards} label={`Dispatch guards for ${s.number}`} />
        {s.guards
          .filter((g) => g.overridable && (!g.pass || g.override))
          .map((g) => (
            <Stack key={g.key} gap={1}>
              <p style={{ font: 'var(--text-caption)' }}>
                <strong>{g.label}</strong>:{' '}
                {g.override?.covers
                  ? `overridden by ${GUARD_OWNER[g.key]} for the reasons shown`
                  : g.override?.status === 'requested'
                    ? `override asked of ${GUARD_OWNER[g.key]}, waiting`
                    : g.override?.status === 'approved'
                      ? `an approved override no longer covers it: the reasons changed`
                      : g.override?.status === 'rejected' || g.override?.status === 'returned'
                        ? `${GUARD_OWNER[g.key]} did not approve the override`
                        : `only ${GUARD_OWNER[g.key]} may override it`}
              </p>
              {!g.pass && g.override?.status !== 'requested' ? (
                asking === g.key ? (
                  <Stack gap={1}>
                    <TextInput label={`Why ${GUARD_OWNER[g.key]} should let it leave`} value={justification} onChange={(e) => setJustification(e.target.value)} />
                    <CommandButton
                      size="sm"
                      receiptLabel="Asked"
                      disabled={justification.trim().length < 10}
                      disabledReason="Say why, in a sentence"
                      onCommand={async () => {
                        await post('/overrides', { guardKey: g.key, justification: justification.trim() });
                        setAsking(null);
                        setJustification('');
                      }}
                    >
                      Ask {GUARD_OWNER[g.key]} to override
                    </CommandButton>
                  </Stack>
                ) : (
                  <Button size="sm" variant="secondary" onClick={() => setAsking(g.key)}>
                    Ask {GUARD_OWNER[g.key]} to override
                  </Button>
                )
              ) : null}
            </Stack>
          ))}
        {d.addressConfirmation?.current ? null : (
          <Stack gap={1}>
            <TextInput label="The customer confirmed the address by phone or mail: how" value={note} onChange={(e) => setNote(e.target.value)} />
            <CommandButton size="sm" receiptLabel="Recorded" disabled={note.trim().length < 3} disabledReason="Say who confirmed it and how" onCommand={() => post('/address-confirmations', { expectedVersion: s.aggregateVersion, note: note.trim() })}>
              Record the confirmation
            </CommandButton>
          </Stack>
        )}
        <Inline gap={2}>
          <Link href={`/logistics/dispatch/new?shipmentId=${s.shipmentId}`}>Edit packages and documents</Link>
          {s.status === 'planned' ? (
            <CommandButton receiptLabel="Submitted" disabled={!green} disabledReason="A guard is red" onCommand={() => post('/submit', { expectedVersion: s.aggregateVersion })}>
              Submit for release
            </CommandButton>
          ) : (
            <CommandButton receiptLabel="Released" disabled={!green} disabledReason="A guard is red" onCommand={() => post('/release', { expectedVersion: s.aggregateVersion })}>
              Release to the customer
            </CommandButton>
          )}
        </Inline>
      </Stack>
    </Card>
  );
}

/** What the customer will be given, rendered from its own view of the delivery. */
export function DeliveryDocumentsPanel({ s }: { s: Shipment }): React.JSX.Element {
  const d = s.delivery!;
  return (
    <Card title="Customer documents" description="Rendered from the customer’s own view of this delivery: JobWork’s lot markings, never a workshop.">
      <Inline gap={2}>
        <Button size="sm" variant="secondary" onClick={() => void openDocument(`/customer-dispatches/${s.shipmentId}/label`)}>
          Labels
        </Button>
        <Button size="sm" variant="secondary" onClick={() => void openDocument(`/customer-dispatches/${s.shipmentId}/delivery-note`)}>
          Delivery note
        </Button>
        {!['planned', 'ready_for_release'].includes(s.status) ? (
          <Button size="sm" variant="secondary" onClick={() => void openDocument(`/customer-dispatches/${s.shipmentId}/conformity`)}>
            Certificate of conformance
          </Button>
        ) : null}
        {d.pod ? (
          <Button size="sm" variant="secondary" onClick={() => void openDocument(`/customer-dispatches/${s.shipmentId}/pod`)}>
            Proof of delivery
          </Button>
        ) : null}
      </Inline>
    </Card>
  );
}

/** The handover (FR-902): it opens the customer's window and accepts nothing (BR-LOG-05). */
export function PodPanel({ s, onChange }: { s: Shipment; onChange: (s: Shipment) => void }): React.JSX.Element {
  const [form, setForm] = useState({ receivedByName: '', receivedAt: '', packagesReceived: String(s.packages.length), remarks: 'clean' as PodRemarks, remarksNote: '', source: 'driver' as 'driver' | 'carrier' | 'jobwork_staff' });
  const [photos, setPhotos] = useState<string[]>([]);
  const [uploadKey, setUploadKey] = useState(0);
  const uploadApi = useMemo(() => createUploadApi(), []);
  return (
    <Card title="Proof of delivery" description="Who took the goods, when and in what state. The customer then accepts, or reports within the window.">
      <Stack gap={2}>
        <TextInput label="Received by" value={form.receivedByName} onChange={(e) => setForm({ ...form, receivedByName: e.target.value })} />
        <TextInput label="When" type="datetime-local" value={form.receivedAt} onChange={(e) => setForm({ ...form, receivedAt: e.target.value })} />
        <TextInput label="Packages received" inputMode="numeric" value={form.packagesReceived} onChange={(e) => setForm({ ...form, packagesReceived: e.target.value })} />
        <Select label="Remarks" value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value as PodRemarks })} options={[{ value: 'clean', label: 'Received without remarks' }, { value: 'with_remarks', label: 'Received with remarks' }]} />
        {form.remarks === 'with_remarks' ? <TextInput label="What the remarks say" value={form.remarksNote} onChange={(e) => setForm({ ...form, remarksNote: e.target.value })} /> : null}
        <Select label="From" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value as typeof form.source })} options={[{ value: 'driver', label: 'The driver’s signed copy' }, { value: 'carrier', label: 'The carrier’s POD' }, { value: 'jobwork_staff', label: 'JobWork staff at the handover' }]} />
        <FileUpload
          key={uploadKey}
          purpose="image"
          api={uploadApi}
          resumeKey={`jobwork-pod-${s.shipmentId}`}
          onSettled={(v: VersionState) => {
            if (v.status === 'available') {
              setPhotos((list) => [...list, v.documentVersionId]);
              setUploadKey((k) => k + 1);
            }
          }}
        />
        {photos.length > 0 ? <p style={{ font: 'var(--text-caption)' }}>{photos.length} file{photos.length === 1 ? '' : 's'} attached</p> : null}
        <CommandButton
          receiptLabel="Recorded"
          disabled={form.receivedByName.trim().length < 2 || !form.receivedAt || (form.remarks === 'with_remarks' && form.remarksNote.trim().length < 3)}
          disabledReason="Say who received it, when, and any remarks"
          onCommand={async () =>
            onChange(
              await api<Shipment>(`/shipments/${s.shipmentId}/pod`, {
                method: 'POST',
                body: { expectedVersion: s.aggregateVersion, receivedByName: form.receivedByName.trim(), receivedAt: new Date(`${form.receivedAt}:00+05:30`).toISOString(), packagesReceived: Number(form.packagesReceived), remarks: form.remarks, remarksNote: form.remarksNote.trim(), documentVersionIds: photos, source: form.source },
                idempotencyKey: crypto.randomUUID(),
              }),
            )
          }
        >
          Record the POD
        </CommandButton>
      </Stack>
    </Card>
  );
}

/** Doc 19 §8: refused at the door. The leg ends; a return leg brings the goods back. */
export function RefusalPanel({ s, onChange }: { s: Shipment; onChange: (s: Shipment) => void }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [refusedBy, setRefusedBy] = useState('');
  const [reason, setReason] = useState('');
  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        The customer refused it
      </Button>
    );
  }
  return (
    <Card title="Refused at delivery" description="The carrier brings it back on a return leg of its own; receive that leg to put the stock back.">
      <Stack gap={2}>
        <TextInput label="Refused by" value={refusedBy} onChange={(e) => setRefusedBy(e.target.value)} />
        <TextInput label="Why" value={reason} onChange={(e) => setReason(e.target.value)} />
        <CommandButton
          receiptLabel="Recorded"
          disabled={refusedBy.trim().length < 2 || reason.trim().length < 3}
          disabledReason="Say who refused it and why"
          onCommand={async () => onChange(await api<Shipment>(`/shipments/${s.shipmentId}/refusal`, { method: 'POST', body: { expectedVersion: s.aggregateVersion, refusedBy: refusedBy.trim(), reason: reason.trim() }, idempotencyKey: crypto.randomUUID() }))}
        >
          Record the refusal
        </CommandButton>
      </Stack>
    </Card>
  );
}

function ResolveException({ x, onChange }: { x: DeliveryException; onChange: (s: Shipment) => void }): React.JSX.Element {
  const [resolution, setResolution] = useState<DeliveryExceptionResolution | ''>('');
  const [note, setNote] = useState('');
  const [caseReference, setCaseReference] = useState('');
  const [carrierChargeNote, setCarrierChargeNote] = useState('');
  const options = x.warrantyClaim ? (['handed_to_case'] as DeliveryExceptionResolution[]) : EXCEPTION_RESOLUTIONS[x.kind];
  return (
    <Stack gap={1}>
      <Select label="Resolution" placeholder="Choose" value={resolution} options={options.map((r) => ({ value: r, label: EXCEPTION_RESOLUTION[r] }))} onChange={(e) => setResolution(e.target.value as DeliveryExceptionResolution)} />
      <TextInput label="Note" value={note} onChange={(e) => setNote(e.target.value)} />
      {resolution === 'handed_to_case' ? <TextInput label="Case reference" value={caseReference} onChange={(e) => setCaseReference(e.target.value)} /> : null}
      {resolution === 'redirected' ? <TextInput label="Carrier’s charge (optional)" value={carrierChargeNote} onChange={(e) => setCarrierChargeNote(e.target.value)} /> : null}
      <CommandButton
        size="sm"
        receiptLabel="Resolved"
        disabled={!resolution || note.trim().length < 3 || (resolution === 'handed_to_case' && !caseReference.trim())}
        disabledReason="Choose a resolution and say why"
        onCommand={async () =>
          onChange(await api<Shipment>(`/delivery-exceptions/${x.exceptionId}/resolve`, { method: 'POST', body: { resolution, note: note.trim(), caseReference: caseReference.trim(), carrierChargeNote: carrierChargeNote.trim() }, idempotencyKey: crypto.randomUUID() }))
        }
      >
        Resolve {x.number}
      </CommandButton>
    </Stack>
  );
}

/** Leg 2 after it left: the handover, the customer's decision, and every exception on the way. */
export function DeliveryFactsPanel({ s, onChange }: { s: Shipment; onChange: (s: Shipment) => void }): React.JSX.Element {
  const d = s.delivery!;
  return (
    <Stack gap={4}>
      {d.pod || d.acceptance || d.acceptanceDueAt ? (
        <Card title="Handover and acceptance">
          <DescriptionList
            columns={2}
            items={[
              { label: 'Received by', value: d.pod ? `${d.pod.receivedByName} · ${when(d.pod.receivedAt)}` : '—' },
              { label: 'Handed over at', value: d.pod ? address(d.pod.deliveredTo) : '—' },
              { label: 'Remarks', value: d.pod ? (d.pod.remarks === 'clean' ? 'None' : d.pod.remarksNote) : '—' },
              { label: 'Customer’s window', value: d.acceptanceDueAt ? `to ${when(d.acceptanceDueAt)}` : '—' },
              { label: 'Accepted', value: d.acceptance ? `${d.acceptance.basis === 'deemed' ? 'Taken as accepted' : 'By the customer'} · ${when(d.acceptance.acceptedAt)}` : 'Not yet' },
              { label: 'Return leg', value: d.returnShipmentId ? <Link href={`/logistics/shipments/${d.returnShipmentId}`}>Open the return</Link> : '—' },
            ]}
          />
        </Card>
      ) : null}
      {d.exceptions.length > 0 ? (
        <Card title="Delivery exceptions" description="A report inside the window holds the delivery until it is withdrawn, found, declined or handed to a case; a case keeps the hold until it is decided.">
          <Stack gap={3}>
            {d.exceptions.map((x, i) => (
              <Stack key={x.exceptionId} gap={1} style={i > 0 ? { borderTop: 'var(--hairline) solid var(--color-border)', paddingTop: 'var(--space-3)' } : undefined}>
                <p>
                  <span className="mono">{x.number}</span> · <strong>{EXCEPTION[x.kind]}</strong>
                  {x.warrantyClaim ? <> · <StatusChip tone="attention">warranty claim</StatusChip></> : null}
                  {x.lotMarking ? ` · ${x.lotMarking}` : ''}
                  {Number(x.quantity) > 0 ? ` · ${x.quantity}` : ''} — {x.description}
                  {x.requestedAddress ? ` · to ${address(x.requestedAddress)}` : ''}
                  {x.evidenceCount > 0 ? ` · ${x.evidenceCount} photo${x.evidenceCount === 1 ? '' : 's'}` : ''}
                </p>
                {x.status === 'open' ? (
                  <ResolveException x={x} onChange={onChange} />
                ) : (
                  <p style={{ font: 'var(--text-caption)' }}>
                    {x.resolution ? EXCEPTION_RESOLUTION[x.resolution] : ''} · {x.resolutionNote}
                    {x.caseReference ? ` · ${x.caseReference}` : ''}
                    {x.carrierChargeNote ? ` · ${x.carrierChargeNote}` : ''} · {x.resolvedAt ? when(x.resolvedAt) : ''}
                  </p>
                )}
              </Stack>
            ))}
          </Stack>
        </Card>
      ) : null}
      {s.status === 'delivered_to_destination' && !d.pod ? <Callout tone="attention" title="The carrier says it is delivered">That is not a proof of delivery: get the signed copy or the carrier’s POD and record it.</Callout> : null}
    </Stack>
  );
}
