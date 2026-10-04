'use client';

import { useEffect, useState } from 'react';
import type { Enquiry, MeResponse, ReviseRequirementItem } from '@jobwork/contracts';
import { Callout, CommandButton, ErrorState, ReasonField, Select, Stack, TextArea, TextInput } from '@jobwork/ui';
import { api, ApiError } from '../../../lib/api';

interface Revised {
  revision: { revisionNo: number };
  supersededRounds: Array<{ rfqId: string; reference: string | null; roundNo: number }>;
}

const INSPECTION_LEVELS = [
  { value: 'standard', label: 'Standard checks' },
  { value: 'dimensional_report', label: 'Dimensional report' },
  { value: 'first_article', label: 'First-article inspection' },
  { value: 'third_party', label: 'Third-party inspection' },
];

/**
 * Revise requirement (F-12.5; doc 19 §10 scenario 5). Engineering changes what suppliers
 * are pricing after bids have arrived: a new revision is frozen with the reason, every
 * round still live on the old one closes as superseded and its suppliers are told, and
 * their bids stay exactly as submitted. Shown only to engineering, and only while the
 * enquiry is being sourced; the server refuses the rest (an award pending or approved).
 */
export function RevisePanel({ enquiry, onRevised }: { enquiry: Enquiry; onRevised: () => Promise<void> }): React.JSX.Element | null {
  const [engineer, setEngineer] = useState(false);
  const [itemId, setItemId] = useState(enquiry.items[0]?.enquiryItemId ?? '');
  const item = enquiry.items.find((i) => i.enquiryItemId === itemId) ?? enquiry.items[0];
  const [fields, setFields] = useState({ materialGrade: '', toleranceClass: '', inspectionLevel: '', quantity: '', qualityNote: '' });
  const [reason, setReason] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<Revised | null>(null);

  useEffect(() => {
    api<MeResponse>('/auth/me')
      .then((me) => setEngineer(me.roles.includes('jobwork_engineering')))
      .catch(() => setEngineer(false));
  }, []);

  useEffect(() => {
    if (!item) return;
    setFields({
      materialGrade: item.materialGrade ?? '',
      toleranceClass: item.toleranceClass ?? '',
      inspectionLevel: item.inspectionLevel,
      quantity: String(item.quantityBreakpoints[0]?.quantity ?? ''),
      qualityNote: item.qualityNote,
    });
  }, [item]);

  if (!engineer || !item) return null;

  // Only what changed is sent: the server refuses a revision that changes nothing.
  const change: ReviseRequirementItem = { enquiryItemId: item.enquiryItemId };
  if (fields.materialGrade !== (item.materialGrade ?? '')) change.materialGrade = fields.materialGrade;
  if (fields.toleranceClass !== (item.toleranceClass ?? '')) change.toleranceClass = fields.toleranceClass;
  if (fields.inspectionLevel !== item.inspectionLevel) change.inspectionLevel = fields.inspectionLevel as ReviseRequirementItem['inspectionLevel'];
  if (fields.qualityNote !== item.qualityNote) change.qualityNote = fields.qualityNote;
  const first = item.quantityBreakpoints[0];
  if (first && fields.quantity !== String(first.quantity) && Number(fields.quantity) > 0) {
    change.quantityBreakpoints = [{ ...first, quantity: Number(fields.quantity) }, ...item.quantityBreakpoints.slice(1)];
  }
  const changed = Object.keys(change).length > 1;
  const ready = changed && reason.trim().length >= 3;

  async function revise(): Promise<void> {
    setError(null);
    try {
      const result = await api<Revised>(`/intake/${enquiry.enquiryId}/revise`, {
        method: 'POST',
        body: { expectedVersion: enquiry.aggregateVersion, reason: reason.trim(), items: [change] },
        idempotencyKey: `revise-${enquiry.enquiryId}-${enquiry.aggregateVersion}`,
      });
      setDone(result);
      setReason('');
      await onRevised();
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      setError(err);
      throw err;
    }
  }

  return (
    <div>
      <h3 style={{ font: 'var(--text-body-strong)', marginBottom: 'var(--space-2)' }}>Revise requirement</h3>
      <Stack gap={3}>
        <p style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
          For a change after suppliers have started pricing. Rounds still open on revision {enquiry.currentRevisionNo} close as superseded and their
          suppliers are told; their bids are kept as submitted and cannot be awarded. After an award, use engineering change control.
        </p>
        {done ? (
          <Callout tone="positive" title={`Revision ${done.revision.revisionNo} is in force`}>
            {done.supersededRounds.length === 0
              ? 'No round was live on the old revision.'
              : `Superseded: ${done.supersededRounds.map((r) => r.reference ?? `round ${r.roundNo}`).join(', ')}. Open a new round from RFQs to quote the revised part.`}
          </Callout>
        ) : null}
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} /> : null}
        {enquiry.items.length > 1 ? (
          <Select
            label="Item"
            value={item.enquiryItemId}
            options={enquiry.items.map((i) => ({ value: i.enquiryItemId, label: `${i.lineNo}. ${i.partName}` }))}
            onChange={(event) => setItemId(event.target.value)}
          />
        ) : null}
        <TextInput label="Material grade" value={fields.materialGrade} onChange={(event) => setFields({ ...fields, materialGrade: event.target.value })} />
        <TextInput label="Tolerance class" value={fields.toleranceClass} onChange={(event) => setFields({ ...fields, toleranceClass: event.target.value })} />
        <TextInput
          label={`Quantity (${first?.unit ?? 'piece'})`}
          inputMode="numeric"
          value={fields.quantity}
          onChange={(event) => setFields({ ...fields, quantity: event.target.value.replace(/[^0-9]/g, '') })}
        />
        <Select label="Inspection" value={fields.inspectionLevel} options={INSPECTION_LEVELS} onChange={(event) => setFields({ ...fields, inspectionLevel: event.target.value })} />
        <TextArea label="Quality note" rows={2} value={fields.qualityNote} onChange={(event) => setFields({ ...fields, qualityNote: event.target.value })} />
        <ReasonField label="Why the requirement changed (kept with the revision)" audience="internal" value={reason} onChange={setReason} />
        <div>
          <CommandButton
            receiptLabel="Revised"
            disabled={!ready}
            disabledReason={changed ? 'Say why the requirement changed' : 'Change at least one field'}
            onCommand={revise}
          >
            Freeze revision {(enquiry.currentRevisionNo ?? 0) + 1}
          </CommandButton>
        </div>
      </Stack>
    </div>
  );
}
