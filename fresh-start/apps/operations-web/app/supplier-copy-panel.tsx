'use client';

import { useCallback, useEffect, useState } from 'react';
import type { SupplierCopy } from '@jobwork/contracts';
import { CommandButton, FileUpload, Inline, Stack, StatusChip, TextInput, type VersionState } from '@jobwork/ui';
import { api } from '../lib/api';
import { createUploadApi } from '../lib/upload-api';

/**
 * F-FP.5 (`FR-305`): a supplier only ever receives JobWork's copy of a customer's file. One member
 * uploads the cleaned file (title block, notes and photos without the customer's name, people or
 * numbers); a second member checks it and confirms. Shown beside every customer file that may travel
 * to a supplier: a round's documents and a baseline's.
 */
export function SupplierCopyPanel({ versionId }: { versionId: string }) {
  const [copy, setCopy] = useState<SupplierCopy | null | undefined>(undefined);
  const [uploaded, setUploaded] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [uploadApi] = useState(() => createUploadApi());

  const load = useCallback(async () => {
    setCopy((await api<{ copy: SupplierCopy | null }>(`/documents/versions/${versionId}/supplier-copy`)).copy);
  }, [versionId]);
  useEffect(() => {
    void load();
  }, [load]);

  if (copy === undefined) return null;
  if (copy?.confirmed) {
    return (
      <StatusChip tone="positive" silent>
        Supplier copy checked
      </StatusChip>
    );
  }
  if (copy) {
    return (
      <Stack gap={2}>
        <StatusChip tone="attention">Supplier copy waiting for a second check</StatusChip>
        <Inline gap={2}>
          <TextInput label="What you checked" value={note} onChange={(e) => setNote(e.target.value)} />
          <CommandButton
            receiptLabel="Confirmed"
            disabled={note.trim().length < 3}
            disabledReason="Say what you checked: no customer name, people, phone or address on any sheet"
            onCommand={async () => {
              await api(`/documents/versions/${versionId}/supplier-copy/confirm`, { method: 'POST', body: { note }, idempotencyKey: crypto.randomUUID() });
              await load();
            }}
          >
            Confirm it is clean
          </CommandButton>
        </Inline>
      </Stack>
    );
  }
  return (
    <Stack gap={2}>
      <StatusChip tone="attention">No supplier copy: suppliers cannot receive this file yet</StatusChip>
      <FileUpload
        purpose="drawing_2d"
        api={uploadApi}
        resumeKey={`jobwork-supplier-copy-${versionId}`}
        onSettled={(v: VersionState) => {
          if (v.status === 'available') setUploaded(v.documentVersionId);
        }}
      />
      <div>
        <CommandButton
          receiptLabel="Prepared"
          disabled={!uploaded}
          disabledReason="Upload the cleaned file first"
          onCommand={async () => {
            await api(`/documents/versions/${versionId}/supplier-copy`, { method: 'POST', body: { copyVersionId: uploaded, note: 'Customer identity removed' }, idempotencyKey: crypto.randomUUID() });
            await load();
          }}
        >
          Use as the supplier copy
        </CommandButton>
      </div>
    </Stack>
  );
}
