import { z } from 'zod';

/**
 * File inspection vocabulary shared by the scan worker and the API (doc 09 §4).
 * `clean` is the only verdict that can ever make a version releasable; every other
 * outcome, including the absence of one, keeps the bytes quarantined.
 */
export const scanVerdictSchema = z.enum(['clean', 'infected', 'unsupported', 'failed']);

export const scanReasonSchema = z.enum([
  'clean',
  'malware_signature',
  'signature_mismatch',
  'truncated_or_corrupt',
  'password_protected',
  'nested_archive',
  'decompression_limit',
  'active_content',
  'macro_content',
  'too_large_to_inspect',
  'path_traversal_name',
  'scanner_timeout',
  'scanner_error',
]);

export const recordScanResultRequestSchema = z.object({
  verdict: scanVerdictSchema,
  reason: scanReasonSchema,
  /** What the bytes actually are, as detected — never what the uploader claimed. */
  detectedMediaType: z.string().max(255).nullable().default(null),
  detail: z.string().max(500).optional(),
  /** Verdicts are versioned so a later engine revision can supersede one (doc 11 §8). */
  scanner: z.object({
    name: z.string().min(1).max(64),
    version: z.string().min(1).max(64),
  }),
  /** Set when the worker has exhausted its retries: a failure becomes terminal. */
  retriesExhausted: z.boolean().default(false),
});

export const scanResultResponseSchema = z.object({
  fileObjectId: z.uuid(),
  scanState: z.enum(['quarantined', 'scanning', 'clean', 'infected', 'unsupported', 'failed']),
  versionsReleasable: z.number().int().nonnegative(),
  versionsQuarantined: z.number().int().nonnegative(),
});

export const beginScanResponseSchema = z.object({
  fileObjectId: z.uuid(),
  storageKey: z.string(),
  byteSize: z.number().int().nonnegative(),
  sha256: z.string(),
  declaredMediaType: z.string(),
  scanState: z.enum(['quarantined', 'scanning', 'clean', 'infected', 'unsupported', 'failed']),
  alreadySettled: z.boolean(),
});

export type ScanVerdict = z.infer<typeof scanVerdictSchema>;
export type ScanReason = z.infer<typeof scanReasonSchema>;
export type RecordScanResultRequest = z.infer<typeof recordScanResultRequestSchema>;
export type ScanResultResponse = z.infer<typeof scanResultResponseSchema>;
export type BeginScanResponse = z.infer<typeof beginScanResponseSchema>;
