import type { ScanReason, ScanVerdict } from '@jobwork/contracts';
import {
  isNestedArchiveName,
  isTraversalName,
  looksLikeZip,
  readArchive,
} from './archive';

export interface ScanRequest {
  bytes: Buffer;
  declaredMediaType: string;
  filename: string;
}

export interface ScanOutcome {
  verdict: ScanVerdict;
  reason: ScanReason;
  detectedMediaType: string | null;
  detail?: string;
}

/**
 * The inspection port. The development adapter below reads signatures and container
 * structure only — it is not an anti-virus engine. `T-06` selects the real engine; its
 * adapter implements this same interface and is registered in `main.ts`, so nothing
 * else in the pipeline changes when it arrives.
 */
export interface Scanner {
  readonly name: string;
  readonly version: string;
  scan(request: ScanRequest): Promise<ScanOutcome>;
}

/** Split so the literal string never appears in the file (doc 13 §6 safe corpus). */
export const EICAR_SIGNATURE = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-',
  'ANTIVIRUS-TEST-FILE!$H+H*'].join('');

/** Above this expansion ratio the archive is a decompression bomb, not a document. */
const MAX_EXPANSION_RATIO = 120;
const MAX_EXPANDED_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 2_000;

type Family =
  | 'pdf'
  | 'zip'
  | 'png'
  | 'jpeg'
  | 'webp'
  | 'step'
  | 'iges'
  | 'stl'
  | 'dxf'
  | 'text'
  | 'executable'
  | 'unknown';

const DECLARED_FAMILIES: Record<string, Family> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
  'text/csv': 'text',
  'text/plain': 'text',
  'model/step': 'step',
  'application/step': 'step',
  'application/iges': 'iges',
  'model/stl': 'stl',
  'image/vnd.dxf': 'dxf',
  'application/vnd.ms-excel': 'zip',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'zip',
  'application/msword': 'zip',
};

const FAMILY_MEDIA_TYPES: Record<Family, string | null> = {
  pdf: 'application/pdf',
  zip: 'application/zip',
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  step: 'model/step',
  iges: 'application/iges',
  stl: 'model/stl',
  dxf: 'image/vnd.dxf',
  text: 'text/plain',
  executable: 'application/x-executable',
  unknown: null,
};

function detectFamily(bytes: Buffer): Family {
  const head = bytes.subarray(0, 512);
  if (head.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (looksLikeZip(bytes)) return 'zip';
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'png';
  }
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'webp';
  }
  // Executables and scripts must never masquerade as documents.
  if (head.subarray(0, 2).toString('latin1') === 'MZ') return 'executable';
  if (head.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return 'executable';
  if (head.subarray(0, 4).equals(Buffer.from([0xcf, 0xfa, 0xed, 0xfe]))) return 'executable';
  if (head.subarray(0, 2).toString('latin1') === '#!') return 'executable';

  const text = head.toString('latin1');
  if (text.includes('ISO-10303')) return 'step';
  if (/^\s*S\s*(\r?\n|\s)/.test(text) && text.includes('IGES')) return 'iges';
  if (text.startsWith('solid ')) return 'stl';
  if (/^\s*0\s*[\r\n]+\s*SECTION/.test(text) || text.includes('AutoCAD Binary DXF')) return 'dxf';
  if (isProbablyText(head)) return 'text';
  return 'unknown';
}

function isProbablyText(head: Buffer): boolean {
  if (head.length === 0) return false;
  for (const byte of head) {
    if (byte === 0) return false;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) return false;
  }
  return true;
}

/**
 * Signature, structure, and known-sample inspection with no expansion, no parsing of
 * untrusted content by third-party libraries, and no network. Reason codes are stable
 * so the portal can explain a refusal without leaking file content (doc 21 §6).
 */
export class SignatureScanner implements Scanner {
  readonly name = 'jobwork-signature-scanner';
  readonly version = '1';

  async scan(request: ScanRequest): Promise<ScanOutcome> {
    const { bytes } = request;
    const declared = request.declaredMediaType.split(';')[0]?.trim().toLowerCase() ?? '';
    const detected = detectFamily(bytes);
    const detectedMediaType = FAMILY_MEDIA_TYPES[detected];

    if (bytes.includes(EICAR_SIGNATURE)) {
      return {
        verdict: 'infected',
        reason: 'malware_signature',
        detectedMediaType,
        detail: 'test signature matched',
      };
    }

    if (detected === 'executable') {
      return {
        verdict: 'infected',
        reason: 'malware_signature',
        detectedMediaType,
        detail: 'executable content',
      };
    }

    const expected = DECLARED_FAMILIES[declared];
    // An unrecognised declared type (CAD is routinely octet-stream) only constrains the
    // file when the bytes themselves say something contradictory.
    if (expected !== undefined && expected !== detected) {
      return {
        verdict: 'unsupported',
        reason: 'signature_mismatch',
        detectedMediaType,
        detail: `declared ${declared}, bytes look like ${detected}`,
      };
    }

    switch (detected) {
      case 'pdf':
        return this.inspectPdf(bytes, detectedMediaType);
      case 'zip':
        return this.inspectArchive(bytes, request.filename, detectedMediaType);
      case 'png':
        return bytes.subarray(-12).includes(Buffer.from('IEND', 'latin1'))
          ? clean(detectedMediaType)
          : corrupt(detectedMediaType, 'PNG end marker missing');
      case 'jpeg':
        return bytes.length > 4 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9
          ? clean(detectedMediaType)
          : corrupt(detectedMediaType, 'JPEG end marker missing');
      case 'unknown':
        return {
          verdict: 'unsupported',
          reason: 'signature_mismatch',
          detectedMediaType,
          detail: 'file signature not recognised',
        };
      default:
        return clean(detectedMediaType);
    }
  }

  private inspectPdf(bytes: Buffer, detectedMediaType: string | null): ScanOutcome {
    const tail = bytes.subarray(Math.max(0, bytes.length - 2048)).toString('latin1');
    if (!tail.includes('%%EOF')) return corrupt(detectedMediaType, 'PDF trailer missing');

    const body = bytes.toString('latin1');
    for (const marker of ['/JavaScript', '/JS', '/OpenAction', '/Launch', '/EmbeddedFile']) {
      if (body.includes(marker)) {
        return {
          verdict: 'unsupported',
          reason: 'active_content',
          detectedMediaType,
          detail: `active content marker ${marker}`,
        };
      }
    }
    return clean(detectedMediaType);
  }

  private inspectArchive(
    bytes: Buffer,
    filename: string,
    detectedMediaType: string | null,
  ): ScanOutcome {
    const listing = readArchive(bytes);
    if (!listing) return corrupt(detectedMediaType, 'archive directory unreadable');
    if (listing.entries.length > MAX_ARCHIVE_ENTRIES) {
      return limitExceeded(detectedMediaType, `${listing.entries.length} entries`);
    }

    for (const entry of listing.entries) {
      if (entry.encrypted) {
        return {
          verdict: 'unsupported',
          reason: 'password_protected',
          detectedMediaType,
          detail: 'encrypted archive entry',
        };
      }
      if (entry.sizesUnknown) {
        return limitExceeded(detectedMediaType, 'ZIP64 sizes not verifiable');
      }
      if (isTraversalName(entry.name)) {
        return {
          verdict: 'unsupported',
          reason: 'path_traversal_name',
          detectedMediaType,
          detail: 'entry name escapes the archive root',
        };
      }
      if (isNestedArchiveName(entry.name)) {
        return {
          verdict: 'unsupported',
          reason: 'nested_archive',
          detectedMediaType,
          detail: 'archive contains another archive',
        };
      }
      if (entry.name.toLowerCase().endsWith('vbaproject.bin')) {
        return {
          verdict: 'unsupported',
          reason: 'macro_content',
          detectedMediaType,
          detail: 'embedded macro project',
        };
      }
    }

    if (/\.(docm|xlsm|pptm)$/i.test(filename)) {
      return {
        verdict: 'unsupported',
        reason: 'macro_content',
        detectedMediaType,
        detail: 'macro-enabled document format',
      };
    }

    const ratio =
      listing.totalCompressed > 0 ? listing.totalUncompressed / listing.totalCompressed : 0;
    if (listing.totalUncompressed > MAX_EXPANDED_BYTES || ratio > MAX_EXPANSION_RATIO) {
      return limitExceeded(
        detectedMediaType,
        `expands to ${listing.totalUncompressed} bytes (ratio ${Math.round(ratio)})`,
      );
    }
    return clean(detectedMediaType);
  }
}

function clean(detectedMediaType: string | null): ScanOutcome {
  return { verdict: 'clean', reason: 'clean', detectedMediaType };
}

function corrupt(detectedMediaType: string | null, detail: string): ScanOutcome {
  return { verdict: 'unsupported', reason: 'truncated_or_corrupt', detectedMediaType, detail };
}

function limitExceeded(detectedMediaType: string | null, detail: string): ScanOutcome {
  return { verdict: 'unsupported', reason: 'decompression_limit', detectedMediaType, detail };
}
