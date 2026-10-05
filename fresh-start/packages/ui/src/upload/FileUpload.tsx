'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type {
  DocumentPurpose,
  InitiateUploadResponse,
  UploadSessionStatus,
} from '@jobwork/contracts';
// Values come from the zod-free entry so the upload widget does not ship every schema (F-FE.3).
import { acceptAttribute, UPLOAD_POLICY } from '@jobwork/contracts/constants';

/**
 * The doc 21 §6 file-upload contract: a purpose-scoped accept list, one visible state
 * per phase of doc 08 §7, recovery after a reload, and refusals that name the problem
 * code rather than dissolving into "something went wrong".
 *
 * The component never decides whether a file is acceptable — it mirrors what the API
 * will enforce so the obvious mistakes are caught before the bytes move, and reports
 * whatever the server says when they disagree.
 */

export type UploadPhase =
  | 'idle'
  | 'preparing'
  | 'uploading'
  | 'verifying'
  | 'scanning'
  | 'ready'
  | 'quarantined'
  | 'failed';

export interface UploadProblem {
  code: string;
  title: string;
  detail?: string;
}

export interface VersionState {
  documentId: string;
  documentVersionId: string;
  versionNo: number;
  status: 'processing' | 'available' | 'quarantined' | 'revoked';
  scanState: string;
}

export interface FileUploadApi {
  initiate(
    body: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<InitiateUploadResponse>;
  finalize(
    uploadSessionId: string,
    body: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<{ documentId: string; documentVersionId: string; versionNo: number }>;
  session(uploadSessionId: string): Promise<UploadSessionStatus>;
  /** Polled while the scan runs; returns the version's current states. */
  version(documentId: string, documentVersionId: string): Promise<VersionState | null>;
}

export interface FileUploadProps {
  purpose: DocumentPurpose;
  api: FileUploadApi;
  /** Existing document to add a version to; omitted starts a new document. */
  documentId?: string;
  onSettled?: (version: VersionState) => void;
  /** Storage key for resume state; one per mounted uploader. */
  resumeKey?: string;
  pollIntervalMs?: number;
}

interface ResumeRecord {
  uploadSessionId: string;
  idempotencyKey: string;
  filename: string;
  byteSize: number;
  sha256: string;
  purpose: DocumentPurpose;
  documentId?: string;
}

const PHASE_LABEL: Record<UploadPhase, string> = {
  idle: 'No file selected',
  preparing: 'Reading and fingerprinting the file',
  uploading: 'Uploading to secure storage',
  verifying: 'Verifying what arrived',
  scanning: 'Scanning for safety',
  ready: 'Ready',
  quarantined: 'Quarantined',
  failed: 'Upload refused',
};

const PHASE_TONE: Record<UploadPhase, 'neutral' | 'progress' | 'positive' | 'blocked'> = {
  idle: 'neutral',
  preparing: 'progress',
  uploading: 'progress',
  verifying: 'progress',
  scanning: 'progress',
  ready: 'positive',
  quarantined: 'blocked',
  failed: 'blocked',
};

/** What the person holding a refused file can actually do about it. */
const CORRECTIVE_ACTION: Record<string, string> = {
  UPLOAD_POLICY_REJECTED: 'Check the file type and size against the list above, then try again.',
  UPLOAD_VERIFICATION_FAILED:
    'The file that arrived did not match what was declared. Upload it again from the original source.',
  UPLOAD_SESSION_INVALID: 'The upload window closed. Select the file again to start a new one.',
  OBJECT_STORE_UNAVAILABLE: 'Secure storage is briefly unavailable. Try again in a minute.',
  VERSION_CONFLICT: 'Someone else added a version while you were uploading. Reload and retry.',
};

const QUARANTINE_ADVICE =
  'The safety scan refused this file, so it cannot be shared or downloaded. ' +
  'Export a clean copy from the original application — flatten or remove embedded ' +
  'scripts, macros, and nested archives — and upload that instead. The original is ' +
  'retained for investigation.';

async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** XHR, not fetch: the upload progress event is the only honest progress signal. */
function putWithProgress(
  grant: InitiateUploadResponse['grant'],
  file: File,
  onProgress: (fraction: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(grant.method, grant.url);
    for (const [name, value] of Object.entries(grant.headers)) {
      // The browser sets content-length itself and forbids setting it here; every
      // other signed header must go out exactly as the grant specifies.
      if (name.toLowerCase() === 'content-length') continue;
      xhr.setRequestHeader(name, value);
    }
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    });
    xhr.addEventListener('load', () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`storage refused the upload (${xhr.status})`)),
    );
    xhr.addEventListener('error', () => reject(new Error('network error during upload')));
    xhr.send(file);
  });
}

export function FileUpload({
  purpose,
  api,
  documentId,
  onSettled,
  resumeKey = 'jobwork.upload.resume',
  pollIntervalMs = 1500,
}: FileUploadProps): React.JSX.Element {
  const [phase, setPhase] = useState<UploadPhase>('idle');
  const [progress, setProgress] = useState(0);
  const [problem, setProblem] = useState<UploadProblem | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const [version, setVersion] = useState<VersionState | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Generated, not derived from the purpose: a page can carry several uploaders of the
  // same purpose (one per evidence item), and a shared id would point every label at
  // the first input — the file dialog would open for the wrong row.
  const inputId = useId();
  const policy = UPLOAD_POLICY[purpose];

  function remember(record: ResumeRecord | null): void {
    try {
      if (record) localStorage.setItem(resumeKey, JSON.stringify(record));
      else localStorage.removeItem(resumeKey);
    } catch {
      // Private browsing or blocked storage: resume is a convenience, not a promise.
    }
  }

  function readResume(): ResumeRecord | null {
    try {
      const raw = localStorage.getItem(resumeKey);
      return raw ? (JSON.parse(raw) as ResumeRecord) : null;
    } catch {
      return null;
    }
  }

  function fail(err: unknown): void {
    const problemLike = (err as { problem?: UploadProblem }).problem;
    setProblem(
      problemLike ?? {
        code: 'UPLOAD_FAILED',
        title: err instanceof Error ? err.message : 'Upload failed',
      },
    );
    setPhase('failed');
  }

  /** Polls the manifest until the scan settles the version one way or the other. */
  async function awaitVerdict(docId: string, versionId: string): Promise<void> {
    setPhase('scanning');
    for (;;) {
      const state = await api.version(docId, versionId);
      if (state && state.status !== 'processing') {
        setVersion(state);
        setPhase(state.status === 'available' ? 'ready' : 'quarantined');
        remember(null);
        onSettled?.(state);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  // A reload loses the file handle and the signed grant, never the session: a
  // finalized upload picks its scan back up, and an unfinished one is offered again.
  useEffect(() => {
    const record = readResume();
    if (!record) return;
    let cancelled = false;
    void (async () => {
      try {
        const session = await api.session(record.uploadSessionId);
        if (cancelled) return;
        setFilename(record.filename);
        if (session.status === 'finalized' && session.documentId && session.documentVersionId) {
          await awaitVerdict(session.documentId, session.documentVersionId);
          return;
        }
        if (session.status === 'initiated' && new Date(session.expiresAt) > new Date()) {
          setPhase('idle');
          setProblem({
            code: 'UPLOAD_INCOMPLETE',
            title: `“${record.filename}” was not finished`,
            detail: 'Select the same file again to continue where it stopped.',
          });
          return;
        }
        remember(null);
      } catch {
        remember(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Mount-only by intent: this recovers the *previous* page's state, so re-running
    // it when props change would restart a recovery that is already under way.
  }, []);

  async function upload(file: File): Promise<void> {
    setProblem(null);
    setVersion(null);
    setFilename(file.name);
    setProgress(0);

    // Mirror the server's policy so an impossible file is refused before it moves.
    const extension = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : '';
    if (!policy.extensions.includes(extension)) {
      setProblem({
        code: 'UPLOAD_POLICY_REJECTED',
        title: `A ${policy.label.toLowerCase()} must be one of: ${policy.extensions.join(', ')}`,
      });
      setPhase('failed');
      return;
    }
    if (file.size > policy.maxBytes) {
      setProblem({
        code: 'UPLOAD_POLICY_REJECTED',
        title: `That file is ${formatBytes(file.size)}; the limit is ${formatBytes(policy.maxBytes)}`,
      });
      setPhase('failed');
      return;
    }

    try {
      setPhase('preparing');
      const sha256 = await sha256Hex(file);

      // One key for the whole attempt: re-initiating after a reload returns the same
      // session with a fresh grant rather than orphaning the first one.
      const previous = readResume();
      const idempotencyKey =
        previous && previous.sha256 === sha256 && previous.filename === file.name
          ? previous.idempotencyKey
          : crypto.randomUUID();

      const started = await api.initiate(
        {
          purpose,
          filename: file.name,
          declaredMediaType: file.type || 'application/octet-stream',
          byteSize: file.size,
          sha256,
          ...(documentId ? { documentId } : {}),
        },
        idempotencyKey,
      );
      remember({
        uploadSessionId: started.uploadSessionId,
        idempotencyKey,
        filename: file.name,
        byteSize: file.size,
        sha256,
        purpose,
        ...(documentId ? { documentId } : {}),
      });

      setPhase('uploading');
      await putWithProgress(started.grant, file, setProgress);

      setPhase('verifying');
      const finalized = await api.finalize(
        started.uploadSessionId,
        { byteSize: file.size, sha256 },
        `${idempotencyKey}:finalize`,
      );

      await awaitVerdict(finalized.documentId, finalized.documentVersionId);
    } catch (err) {
      fail(err);
    }
  }

  const tone = PHASE_TONE[phase];
  const busy = phase === 'preparing' || phase === 'uploading' || phase === 'verifying' || phase === 'scanning';

  return (
    <section
      style={{
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
        padding: 'var(--space-4)',
        background: 'var(--color-surface)',
        minWidth: 0,
      }}
    >
      {/* Wraps and shrinks at phone width: the native file control is otherwise wider than a 390 px card. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', gap: 'var(--space-1) var(--space-3)' }}>
        <label style={{ font: 'var(--text-body-strong)' }} htmlFor={inputId}>
          {policy.label}
        </label>
        <span style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
          {policy.extensions.join(', ')} · up to {formatBytes(policy.maxBytes)}
        </span>
      </div>

      <input
        id={inputId}
        ref={inputRef}
        type="file"
        accept={acceptAttribute(purpose)}
        disabled={busy}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file);
        }}
        style={{ display: 'block', maxWidth: '100%', marginTop: 'var(--space-3)', font: 'var(--text-body)' }}
      />

      <p
        aria-live="polite"
        style={{
          marginTop: 'var(--space-3)',
          marginBottom: 0,
          font: 'var(--text-caption)',
          color: `var(--status-${tone}-fg)`,
        }}
      >
        <span
          style={{
            display: 'inline-block',
            padding: '2px var(--space-2)',
            borderRadius: 'var(--radius-sm)',
            background: `var(--status-${tone}-bg)`,
            border: `1px solid var(--status-${tone}-border)`,
            font: 'var(--text-caption)',
          }}
        >
          {PHASE_LABEL[phase]}
        </span>{' '}
        {filename ? <span style={{ color: 'var(--color-text-muted)' }}>{filename}</span> : null}
        {phase === 'uploading' ? (
          <span style={{ color: 'var(--color-text-muted)' }}> · {Math.round(progress * 100)}%</span>
        ) : null}
      </p>

      {phase === 'uploading' ? (
        <progress
          value={progress}
          max={1}
          style={{ width: '100%', marginTop: 'var(--space-2)' }}
          aria-label="Upload progress"
        />
      ) : null}

      {phase === 'quarantined' ? (
        <p
          role="alert"
          style={{
            marginTop: 'var(--space-3)',
            padding: 'var(--space-3)',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--status-blocked-bg)',
            border: '1px solid var(--status-blocked-border)',
            color: 'var(--status-blocked-fg)',
            font: 'var(--text-caption)',
          }}
        >
          <strong>This file was quarantined.</strong> {QUARANTINE_ADVICE}
          {version ? (
            <span style={{ display: 'block', marginTop: 'var(--space-2)', font: 'var(--text-mono)' }}>
              scan result: {version.scanState}
            </span>
          ) : null}
        </p>
      ) : null}

      {problem ? (
        <p
          role="alert"
          style={{
            marginTop: 'var(--space-3)',
            padding: 'var(--space-3)',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--status-blocked-bg)',
            border: '1px solid var(--status-blocked-border)',
            color: 'var(--status-blocked-fg)',
            font: 'var(--text-caption)',
          }}
        >
          <strong>{problem.title}</strong>
          {problem.detail ? <span style={{ display: 'block' }}>{problem.detail}</span> : null}
          {/* One instruction, never two: the generic line is a fallback for codes
              that arrive without guidance of their own. */}
          {CORRECTIVE_ACTION[problem.code] ?? (problem.detail ? null : (
            'Try again, or contact support with the code below.'
          )) ? (
            <span style={{ display: 'block', marginTop: 'var(--space-2)' }}>
              {CORRECTIVE_ACTION[problem.code] ??
                'Try again, or contact support with the code below.'}
            </span>
          ) : null}
          <span style={{ display: 'block', font: 'var(--text-mono)', marginTop: 'var(--space-1)' }}>
            {problem.code}
          </span>
        </p>
      ) : null}
    </section>
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
