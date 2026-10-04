'use client';

import type { DocumentVersionSummary } from '@jobwork/contracts';
import type { Tone } from '../tokens';
import { Button } from '../primitives/Button';
import { CopyableId } from '../data/CopyableId';
import { StatusChip } from '../status/StatusChip';
import { formatBytes } from '../upload/FileUpload';

/**
 * The doc 21 §6 / doc 14 §10 manifest row: logical name, engineering revision, system
 * version, hash in mono, and the scan and audience states. Version and revision are
 * deliberately shown as two separate numbers because they are two different things —
 * the system version is ours, the revision label is the customer's.
 *
 * The row states facts about one immutable version. Actions live outside it, and the
 * download control is only offered when the version is actually releasable, so the UI
 * never invites a click the API will refuse (`BR-ENG-08`).
 */

const STATUS_TONE: Record<DocumentVersionSummary['status'], Tone> = {
  processing: 'progress',
  available: 'positive',
  quarantined: 'blocked',
  revoked: 'neutral',
};

const STATUS_LABEL: Record<DocumentVersionSummary['status'], string> = {
  processing: 'Scanning',
  available: 'Ready',
  quarantined: 'Quarantined',
  revoked: 'Withdrawn',
};

const AUDIENCE_LABEL: Record<string, string> = {
  internal: 'JobWork',
  organization: 'Released to a party',
  auditor: 'Auditor',
};

export interface ManifestRowProps {
  version: DocumentVersionSummary;
  onDownload?: ((version: DocumentVersionSummary) => void) | undefined;
  downloading?: boolean | undefined;
  /**
   * Doc 21 §6 requires the governing flag on this row. When a CAD file and a drawing
   * both describe one part, which of them is authoritative is a declared fact, and the
   * manifest is where a reader looks for it (doc 19 §3).
   */
  governing?: boolean | undefined;
}

export function ManifestRow({
  version,
  onDownload,
  downloading,
  governing,
}: ManifestRowProps): React.JSX.Element {
  const releasable = version.status === 'available';
  return (
    <tr>
      <td style={cell}>
        <span style={{ font: 'var(--text-body-strong)' }}>{version.originalFilename}</span>
        {governing ? (
          <>
            {' '}
            <StatusChip tone="progress" silent>
              Governing
            </StatusChip>
          </>
        ) : null}
        <span style={{ display: 'block', font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
          {formatBytes(version.byteSize)} · {new Date(version.createdAt).toLocaleString()}
        </span>
      </td>
      <td style={cell}>{version.engineeringRevision ?? '—'}</td>
      <td style={cell}>v{version.versionNo}</td>
      <td style={{ ...cell, color: 'var(--color-text-muted)' }}>
        <CopyableId value={version.sha256} label="SHA-256" />
      </td>
      <td style={cell}>
        <StatusChip tone={STATUS_TONE[version.status]}>{STATUS_LABEL[version.status]}</StatusChip>
        <span style={{ display: 'block', font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
          scan: {version.scanState}
        </span>
      </td>
      <td style={cell}>
        {version.audiences.length === 0 ? (
          <span style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
            Not released
          </span>
        ) : (
          <span style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap' }}>
            {version.audiences.map((audience) => (
              <StatusChip key={audience} tone="special" silent>
                {AUDIENCE_LABEL[audience] ?? audience}
              </StatusChip>
            ))}
          </span>
        )}
      </td>
      <td style={{ ...cell, textAlign: 'right' }}>
        {releasable && onDownload ? (
          <Button
            variant="secondary"
            size="sm"
            busy={Boolean(downloading)}
            onClick={() => onDownload(version)}
          >
            {downloading ? 'Preparing…' : 'Download'}
          </Button>
        ) : (
          <span style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
            {version.status === 'quarantined' ? 'Blocked by scan' : '—'}
          </span>
        )}
      </td>
    </tr>
  );
}

export function ManifestHeader(): React.JSX.Element {
  return (
    <tr>
      {['File', 'Revision', 'Version', 'SHA-256', 'State', 'Audience', ''].map((heading) => (
        <th
          key={heading}
          scope="col"
          style={{
            ...cell,
            textAlign: heading === '' ? 'right' : 'left',
            font: 'var(--text-caption)',
            color: 'var(--color-text-muted)',
            borderBottom: '1px solid var(--color-border)',
          }}
        >
          {heading}
        </th>
      ))}
    </tr>
  );
}

const cell: React.CSSProperties = {
  padding: 'var(--table-cell-pad)',
  borderBottom: '1px solid var(--color-border)',
  verticalAlign: 'top',
  font: 'var(--text-body)',
};
