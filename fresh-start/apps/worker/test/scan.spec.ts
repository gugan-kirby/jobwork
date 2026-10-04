import { createHash } from 'node:crypto';
import type { BeginScanResponse, RecordScanResultRequest } from '@jobwork/contracts';
import { createLogger } from '@jobwork/observability';
import { ObjectStoreError } from '@jobwork/object-store';
import { fileCorpus } from '@jobwork/test-kit';
import { describe, expect, it } from 'vitest';
import { InternalApiError } from '../src/internal-api';
import { fileFinalizedHandler, type ScanHandlerOptions } from '../src/outbox/handlers/file-finalized';
import type { OutboxEventRow } from '../src/outbox/types';
import { SignatureScanner } from '../src/scan/scanner';
import type { ScanOutcome, Scanner } from '../src/scan/scanner';

const log = createLogger({ service: 'worker-test', level: 'silent' });
const scanner = new SignatureScanner();

function event(overrides: Partial<OutboxEventRow> = {}): OutboxEventRow {
  return {
    id: '01920000-0000-7000-8000-000000000001',
    eventType: 'dms.file_finalized',
    occurredAt: new Date(),
    aggregateType: 'file_object',
    aggregateId: 'file-1',
    aggregateVersion: null,
    organizationId: 'org-1',
    actor: { type: 'user', id: 'user-1' },
    correlationId: 'corr-1',
    data: { fileObjectId: 'file-1', extension: 'pdf' },
    attempts: 1,
    ...overrides,
  };
}

/** Records what the handler told the API, so fail-closed can be asserted directly. */
class ApiSpy {
  recorded: RecordScanResultRequest[] = [];
  beginCalls = 0;

  constructor(private readonly claim: Partial<BeginScanResponse> = {}) {}

  async beginScan(): Promise<BeginScanResponse> {
    this.beginCalls += 1;
    return {
      fileObjectId: 'file-1',
      storageKey: 'key-1',
      byteSize: 0,
      sha256: 'x',
      declaredMediaType: 'application/pdf',
      scanState: 'scanning',
      alreadySettled: false,
      ...this.claim,
    };
  }

  async recordScanResult(
    _fileObjectId: string,
    body: RecordScanResultRequest,
  ): Promise<{ fileObjectId: string; scanState: string }> {
    this.recorded.push(body);
    return { fileObjectId: 'file-1', scanState: body.verdict };
  }
}

function handlerFor(
  bytes: Buffer,
  opts: {
    api?: ApiSpy;
    scanner?: Scanner;
    claim?: Partial<BeginScanResponse>;
    maxInspectBytes?: number;
    scanTimeoutMs?: number;
    maxAttempts?: number;
    declaredMediaType?: string;
    readError?: Error;
  } = {},
): { run: (e?: OutboxEventRow) => Promise<void>; api: ApiSpy } {
  const digest = createHash('sha256').update(bytes).digest('hex');
  const api =
    opts.api ??
    new ApiSpy({
      storageKey: 'key-1',
      byteSize: bytes.byteLength,
      sha256: digest,
      declaredMediaType: opts.declaredMediaType ?? 'application/pdf',
      ...opts.claim,
    });
  const store = {
    async getBytes(): Promise<Buffer> {
      if (opts.readError) throw opts.readError;
      return bytes;
    },
  };
  const handler = fileFinalizedHandler({
    store: store as unknown as ScanHandlerOptions['store'],
    scanner: opts.scanner ?? scanner,
    api: api as unknown as ScanHandlerOptions['api'],
    log,
    maxInspectBytes: opts.maxInspectBytes ?? 1024 * 1024,
    scanTimeoutMs: opts.scanTimeoutMs ?? 5_000,
    maxAttempts: opts.maxAttempts ?? 8,
  });
  return { run: (e = event()) => handler(e), api };
}

describe('File inspection corpus (doc 13 §6)', () => {
  for (const entry of fileCorpus()) {
    it(`${entry.key}: ${entry.what} → ${entry.expected.verdict}/${entry.expected.reason}`, async () => {
      const outcome = await scanner.scan({
        bytes: entry.bytes,
        declaredMediaType: entry.declaredMediaType,
        filename: entry.filename,
      });
      expect({ verdict: outcome.verdict, reason: outcome.reason }).toEqual(entry.expected);
    });
  }

  it('never returns clean for anything the corpus marks unsafe', async () => {
    const unsafe = fileCorpus().filter((entry) => entry.expected.verdict !== 'clean');
    for (const entry of unsafe) {
      const outcome = await scanner.scan({
        bytes: entry.bytes,
        declaredMediaType: entry.declaredMediaType,
        filename: entry.filename,
      });
      expect(outcome.verdict).not.toBe('clean');
    }
  });
});

describe('dms.file_finalized handler (F-03.3)', () => {
  it('records the scanner verdict through the internal command', async () => {
    const corpus = fileCorpus();
    const cleanPdf = corpus.find((c) => c.key === 'clean-pdf')!;
    const { run, api } = handlerFor(cleanPdf.bytes);
    await run();

    expect(api.beginCalls).toBe(1);
    expect(api.recorded).toHaveLength(1);
    expect(api.recorded[0]?.verdict).toBe('clean');
    expect(api.recorded[0]?.scanner.name).toBe(scanner.name);
    expect(api.recorded[0]?.retriesExhausted).toBe(false);
  });

  it('quarantines the whole corpus of unsafe files, never releasing one', async () => {
    for (const entry of fileCorpus().filter((c) => c.expected.verdict !== 'clean')) {
      const { run, api } = handlerFor(entry.bytes, {
        declaredMediaType: entry.declaredMediaType,
      });
      await run(event({ data: { fileObjectId: 'file-1', extension: entry.filename.split('.').pop() } }));
      expect(api.recorded[0]?.verdict, entry.key).not.toBe('clean');
      expect(api.recorded[0]?.reason, entry.key).toBe(entry.expected.reason);
    }
  });

  it('refuses bytes whose digest no longer matches what was finalized', async () => {
    const { run, api } = handlerFor(Buffer.from('%PDF-1.7 swapped\n%%EOF\n'), {
      claim: { sha256: createHash('sha256').update('the original bytes').digest('hex') },
    });
    await run();
    expect(api.recorded[0]).toMatchObject({
      verdict: 'unsupported',
      reason: 'truncated_or_corrupt',
    });
  });

  it('refuses a file too large to inspect rather than retrying forever', async () => {
    const { run, api } = handlerFor(Buffer.from('%PDF-1.7\n%%EOF\n'), {
      readError: new ObjectStoreError('object exceeds the 10 byte inspection limit'),
    });
    await run();
    expect(api.recorded[0]).toMatchObject({
      verdict: 'unsupported',
      reason: 'too_large_to_inspect',
    });
  });

  it('retries a scanner timeout, then quarantines once retries are spent', async () => {
    const slow: Scanner = {
      name: 'slow-scanner',
      version: '1',
      scan: () => new Promise<ScanOutcome>(() => undefined),
    };
    const bytes = Buffer.from('%PDF-1.7\n%%EOF\n');

    const first = handlerFor(bytes, { scanner: slow, scanTimeoutMs: 20, maxAttempts: 8 });
    // Throwing is what schedules the retry, and the failure is on file meanwhile.
    await expect(first.run(event({ attempts: 1 }))).rejects.toThrow(/retrying/);
    expect(first.api.recorded[0]).toMatchObject({
      verdict: 'failed',
      reason: 'scanner_timeout',
      retriesExhausted: false,
    });

    const last = handlerFor(bytes, { scanner: slow, scanTimeoutMs: 20, maxAttempts: 8 });
    await expect(last.run(event({ attempts: 8 }))).resolves.toBeUndefined();
    expect(last.api.recorded[0]).toMatchObject({
      verdict: 'failed',
      reason: 'scanner_timeout',
      // Terminal: the API settles the waiting versions as quarantined.
      retriesExhausted: true,
    });
  });

  it('retries a scanner crash the same way, never guessing clean', async () => {
    const broken: Scanner = {
      name: 'broken-scanner',
      version: '1',
      scan: () => Promise.reject(new Error('engine unavailable')),
    };
    const { run, api } = handlerFor(Buffer.from('%PDF-1.7\n%%EOF\n'), { scanner: broken });
    await expect(run()).rejects.toThrow(/retrying/);
    expect(api.recorded[0]).toMatchObject({ verdict: 'failed', reason: 'scanner_error' });
  });

  it('stops when the file already carries a verdict', async () => {
    const api = new ApiSpy({ alreadySettled: true, scanState: 'infected' });
    const { run } = handlerFor(Buffer.from('%PDF-1.7\n%%EOF\n'), { api });
    await run();
    expect(api.recorded).toHaveLength(0);
  });

  it('treats a duplicate delivery hitting a recorded verdict as done, not as a failure', async () => {
    const conflicting = new ApiSpy();
    conflicting.recordScanResult = () =>
      Promise.reject(new InternalApiError('conflict', 409, 'SCAN_VERDICT_CONFLICT'));
    const { run } = handlerFor(Buffer.from('%PDF-1.7\n%%EOF\n'), { api: conflicting });
    await expect(run()).resolves.toBeUndefined();
  });
});
