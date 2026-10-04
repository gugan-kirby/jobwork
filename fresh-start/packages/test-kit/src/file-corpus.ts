/**
 * The doc 13 §6 adversarial file corpus, built in memory rather than checked in as
 * files: the malware test sample must never sit on a developer's disk where a local
 * scanner will act on it, and archive cases need declared sizes and flags that no
 * editor would preserve.
 *
 * Every entry states the verdict the pipeline must reach. Nothing here is actually
 * malicious — the EICAR string is the industry's inert test sample, and the
 * "executable" is a two-byte header.
 */

export interface CorpusEntry {
  key: string;
  what: string;
  bytes: Buffer;
  filename: string;
  declaredMediaType: string;
  expected: {
    verdict: 'clean' | 'infected' | 'unsupported' | 'failed';
    reason: string;
  };
}

/** Assembled at runtime so the literal never appears in a source file. */
export const EICAR_TEST_STRING = [
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-',
  'ANTIVIRUS-TEST-FILE!$H+H*',
].join('');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntrySpec {
  name: string;
  content: Buffer;
  /** Overrides the stored uncompressed size — used to build a decompression bomb. */
  declaredUncompressedSize?: number;
  encrypted?: boolean;
}

/** Builds a real (stored, uncompressed) ZIP container. */
export function buildZip(entries: ZipEntrySpec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const flags = entry.encrypted ? 0x0001 : 0x0000;
    const crc = crc32(entry.content);
    const compressedSize = entry.content.length;
    const uncompressedSize = entry.declaredUncompressedSize ?? entry.content.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, entry.content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + entry.content.length;
  }

  const centralBlock = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBlock.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBlock, eocd]);
}

export function buildPdf(body = 'clean drawing', trailer = true): Buffer {
  return Buffer.from(`%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\n${body}\n${trailer ? '%%EOF\n' : ''}`);
}

export function buildPng(): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.concat([
    Buffer.from([0, 0, 0, 13]),
    Buffer.from('IHDR'),
    Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
    Buffer.from([0x1f, 0x15, 0xc4, 0x89]),
  ]);
  const iend = Buffer.concat([
    Buffer.from([0, 0, 0, 0]),
    Buffer.from('IEND'),
    Buffer.from([0xae, 0x42, 0x60, 0x82]),
  ]);
  return Buffer.concat([signature, ihdr, iend]);
}

const XLSX_MEDIA_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export function fileCorpus(): CorpusEntry[] {
  return [
    {
      key: 'clean-pdf',
      what: 'an ordinary drawing',
      bytes: buildPdf(),
      filename: 'bracket.pdf',
      declaredMediaType: 'application/pdf',
      expected: { verdict: 'clean', reason: 'clean' },
    },
    {
      key: 'clean-png',
      what: 'an ordinary photo',
      bytes: buildPng(),
      filename: 'part.png',
      declaredMediaType: 'image/png',
      expected: { verdict: 'clean', reason: 'clean' },
    },
    {
      key: 'clean-xlsx',
      what: 'an ordinary spreadsheet container',
      bytes: buildZip([
        { name: '[Content_Types].xml', content: Buffer.from('<Types/>') },
        { name: 'xl/worksheets/sheet1.xml', content: Buffer.from('<worksheet/>') },
      ]),
      filename: 'bom.xlsx',
      declaredMediaType: XLSX_MEDIA_TYPE,
      expected: { verdict: 'clean', reason: 'clean' },
    },
    {
      key: 'clean-step',
      what: 'a STEP model',
      bytes: Buffer.from("ISO-10303-21;\nHEADER;\nFILE_NAME('part.step');\nENDSEC;\nEND-ISO-10303-21;\n"),
      filename: 'part.step',
      declaredMediaType: 'model/step',
      expected: { verdict: 'clean', reason: 'clean' },
    },
    {
      key: 'eicar',
      what: 'the industry malware test sample',
      bytes: Buffer.from(`%PDF-1.7\n${EICAR_TEST_STRING}\n%%EOF\n`),
      filename: 'invoice.pdf',
      declaredMediaType: 'application/pdf',
      expected: { verdict: 'infected', reason: 'malware_signature' },
    },
    {
      key: 'executable-renamed',
      what: 'a Windows executable renamed to .pdf',
      bytes: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64, 0x00), Buffer.from('program')]),
      filename: 'drawing.pdf',
      declaredMediaType: 'application/pdf',
      expected: { verdict: 'infected', reason: 'malware_signature' },
    },
    {
      key: 'wrong-signature',
      what: 'PNG bytes declared as a PDF',
      bytes: buildPng(),
      filename: 'drawing.pdf',
      declaredMediaType: 'application/pdf',
      expected: { verdict: 'unsupported', reason: 'signature_mismatch' },
    },
    {
      key: 'truncated-pdf',
      what: 'a PDF cut off mid-transfer',
      bytes: buildPdf('partial', false),
      filename: 'bracket.pdf',
      declaredMediaType: 'application/pdf',
      expected: { verdict: 'unsupported', reason: 'truncated_or_corrupt' },
    },
    {
      key: 'active-pdf',
      what: 'a PDF carrying embedded JavaScript',
      bytes: buildPdf('<< /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >>'),
      filename: 'quote.pdf',
      declaredMediaType: 'application/pdf',
      expected: { verdict: 'unsupported', reason: 'active_content' },
    },
    {
      key: 'encrypted-zip',
      what: 'a password-protected container',
      bytes: buildZip([
        { name: 'secret.xml', content: Buffer.from('encrypted payload'), encrypted: true },
      ]),
      filename: 'bom.xlsx',
      declaredMediaType: XLSX_MEDIA_TYPE,
      expected: { verdict: 'unsupported', reason: 'password_protected' },
    },
    {
      key: 'nested-archive',
      what: 'an archive inside an archive',
      bytes: buildZip([
        { name: 'readme.txt', content: Buffer.from('hello') },
        { name: 'payload.zip', content: buildZip([{ name: 'a.txt', content: Buffer.from('a') }]) },
      ]),
      filename: 'bom.xlsx',
      declaredMediaType: XLSX_MEDIA_TYPE,
      expected: { verdict: 'unsupported', reason: 'nested_archive' },
    },
    {
      key: 'zip-bomb',
      what: 'a container declaring a vast expansion',
      bytes: buildZip([
        {
          name: 'big.xml',
          content: Buffer.alloc(1024, 0x41),
          declaredUncompressedSize: 900 * 1024 * 1024,
        },
      ]),
      filename: 'bom.xlsx',
      declaredMediaType: XLSX_MEDIA_TYPE,
      expected: { verdict: 'unsupported', reason: 'decompression_limit' },
    },
    {
      key: 'macro-document',
      what: 'an Office container with a macro project',
      bytes: buildZip([
        { name: '[Content_Types].xml', content: Buffer.from('<Types/>') },
        { name: 'word/vbaProject.bin', content: Buffer.from('macro') },
      ]),
      filename: 'spec.docx',
      declaredMediaType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      expected: { verdict: 'unsupported', reason: 'macro_content' },
    },
    {
      key: 'path-traversal',
      what: 'an archive entry escaping its root',
      bytes: buildZip([{ name: '../../etc/passwd', content: Buffer.from('root:x:0:0') }]),
      filename: 'bom.xlsx',
      declaredMediaType: XLSX_MEDIA_TYPE,
      expected: { verdict: 'unsupported', reason: 'path_traversal_name' },
    },
    {
      key: 'truncated-zip',
      what: 'a container whose directory was cut off',
      bytes: buildZip([{ name: 'sheet.xml', content: Buffer.from('<x/>') }]).subarray(0, 40),
      filename: 'bom.xlsx',
      declaredMediaType: XLSX_MEDIA_TYPE,
      expected: { verdict: 'unsupported', reason: 'truncated_or_corrupt' },
    },
  ];
}
