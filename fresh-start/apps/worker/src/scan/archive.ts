/**
 * Minimal ZIP central-directory reader for inspection only — it never expands an
 * archive. Office documents (docx/xlsx) are ZIP containers, so the same reader covers
 * them. Anything it cannot parse confidently is reported as unreadable, and the
 * scanner treats unreadable as a refusal (doc 09 §4 fail closed).
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const MAX_EOCD_SEARCH = 66_000; // 64KiB comment + the 22-byte record
const ZIP64_SENTINEL = 0xffffffff;

export interface ArchiveEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  encrypted: boolean;
  /** True when the record declares ZIP64 sizes this reader will not interpret. */
  sizesUnknown: boolean;
}

export interface ArchiveListing {
  entries: ArchiveEntry[];
  totalCompressed: number;
  totalUncompressed: number;
}

export function looksLikeZip(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50;
}

/** Returns null when the container is truncated or otherwise unreadable. */
export function readArchive(bytes: Buffer): ArchiveListing | null {
  const eocd = findEocd(bytes);
  if (eocd === null) return null;

  const entryCount = bytes.readUInt16LE(eocd + 10);
  const directorySize = bytes.readUInt32LE(eocd + 12);
  const directoryOffset = bytes.readUInt32LE(eocd + 16);
  if (
    directoryOffset === ZIP64_SENTINEL ||
    directorySize === ZIP64_SENTINEL ||
    directoryOffset + directorySize > bytes.length
  ) {
    return null;
  }

  const entries: ArchiveEntry[] = [];
  let cursor = directoryOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) return null;
    const flags = bytes.readUInt16LE(cursor + 8);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const nameEnd = cursor + 46 + nameLength;
    if (nameEnd > bytes.length) return null;

    entries.push({
      name: bytes.subarray(cursor + 46, nameEnd).toString('utf8'),
      compressedSize,
      uncompressedSize,
      // Bit 0 marks traditional encryption; bit 6 strong encryption.
      encrypted: (flags & 0x0001) !== 0 || (flags & 0x0040) !== 0,
      sizesUnknown: compressedSize === ZIP64_SENTINEL || uncompressedSize === ZIP64_SENTINEL,
    });
    cursor = nameEnd + extraLength + commentLength;
  }

  return {
    entries,
    totalCompressed: entries.reduce((sum, e) => sum + e.compressedSize, 0),
    totalUncompressed: entries.reduce((sum, e) => sum + e.uncompressedSize, 0),
  };
}

function findEocd(bytes: Buffer): number | null {
  const start = Math.max(0, bytes.length - MAX_EOCD_SEARCH);
  for (let i = bytes.length - 22; i >= start; i -= 1) {
    if (bytes.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return null;
}

const ARCHIVE_EXTENSIONS = ['.zip', '.gz', '.tgz', '.tar', '.rar', '.7z', '.bz2', '.xz'];

export function isNestedArchiveName(name: string): boolean {
  const lower = name.toLowerCase();
  return ARCHIVE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Absolute paths, parent traversal, and Windows drive prefixes are all refusals. */
export function isTraversalName(name: string): boolean {
  const normalized = name.replace(/\\/g, '/');
  return (
    normalized.startsWith('/') ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.split('/').includes('..')
  );
}
