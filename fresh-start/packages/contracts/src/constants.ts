/**
 * Contract values a browser needs at run time, kept free of `zod` (F-FE.3).
 *
 * `@jobwork/contracts` compiles to one CommonJS module graph, so a screen importing a
 * single constant from the package root loads every schema and the validator with it —
 * 117 KB gzipped on every route, `/login` included, before this split. Web code imports
 * values from `@jobwork/contracts/constants` and types from the root (types are erased).
 * Nothing in this file may import `zod` or a module that does; a test enforces it.
 */

/** Document purposes (doc 05 §7); `documentPurposeSchema` is built from this tuple. */
export const DOCUMENT_PURPOSES = [
  'cad_3d',
  'drawing_2d',
  'bom',
  'specification',
  'image',
  'certificate',
  'other',
] as const;

type DocumentPurposeValue = (typeof DOCUMENT_PURPOSES)[number];

export interface PurposePolicy {
  label: string;
  maxBytes: number;
  mediaTypes: readonly string[];
  extensions: readonly string[];
}

const MB = 1024 * 1024;

/**
 * Purpose-scoped size and format limits (doc 09 §4). The API enforces these on every
 * initiate; the upload component reads the same table for its accept list and its
 * refusal messages, so a user is never offered a file the server will reject.
 */
export const UPLOAD_POLICY: Record<DocumentPurposeValue, PurposePolicy> = {
  cad_3d: {
    label: '3D CAD model',
    maxBytes: 200 * MB,
    mediaTypes: [
      'model/step',
      'application/step',
      'application/iges',
      'model/stl',
      'application/octet-stream',
    ],
    extensions: [
      'step',
      'stp',
      'iges',
      'igs',
      'stl',
      'x_t',
      'x_b',
      'sldprt',
      'sldasm',
      'ipt',
      'iam',
    ],
  },
  drawing_2d: {
    label: '2D drawing',
    maxBytes: 50 * MB,
    mediaTypes: ['application/pdf', 'image/vnd.dwg', 'image/vnd.dxf', 'application/octet-stream'],
    extensions: ['pdf', 'dwg', 'dxf'],
  },
  bom: {
    label: 'Bill of materials',
    maxBytes: 20 * MB,
    mediaTypes: [
      'text/csv',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ],
    extensions: ['csv', 'xls', 'xlsx'],
  },
  specification: {
    label: 'Specification',
    maxBytes: 50 * MB,
    mediaTypes: [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',
    ],
    extensions: ['pdf', 'doc', 'docx', 'txt'],
  },
  image: {
    label: 'Photo',
    maxBytes: 25 * MB,
    mediaTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/heic'],
    extensions: ['jpg', 'jpeg', 'png', 'webp', 'heic'],
  },
  certificate: {
    label: 'Certificate',
    maxBytes: 25 * MB,
    mediaTypes: ['application/pdf', 'image/jpeg', 'image/png'],
    extensions: ['pdf', 'jpg', 'jpeg', 'png'],
  },
  other: {
    label: 'Other document',
    maxBytes: 25 * MB,
    mediaTypes: ['application/pdf', 'image/jpeg', 'image/png', 'text/csv', 'text/plain'],
    extensions: ['pdf', 'jpg', 'jpeg', 'png', 'csv', 'txt'],
  },
};

/** `accept` attribute value for a purpose (guidance only — bytes are verified server-side). */
export function acceptAttribute(purpose: DocumentPurposeValue): string {
  const policy = UPLOAD_POLICY[purpose];
  return [...policy.extensions.map((e) => `.${e}`), ...policy.mediaTypes].join(',');
}

/** The three kinds of work a customer can ask for (F-MX.1); `jobTypeSchema` is built from this tuple. */
export const JOB_TYPES = ['job_work', 'new_model', 'correction_ecn'] as const;

export const JOB_TYPE_LABELS: Record<(typeof JOB_TYPES)[number], string> = {
  job_work: 'Job work',
  new_model: 'New model',
  correction_ecn: 'Correction / ECN',
};

/** Doc 09 §8 change impact areas, in the order the matrix asks them (IN-13). */
export const CHANGE_IMPACT_AREAS = [
  { key: 'configuration', label: 'Configuration', question: 'Which item, revision, interface, BOM, cavity, serial/lot and quantity?' },
  { key: 'wip', label: 'Work in progress', question: 'What is complete, in machine, procured, reusable, reworkable or scrap?' },
  { key: 'process_tooling', label: 'Process and tooling', question: 'Route, program, fixture, tool or mould, setup, subcontractor impact?' },
  { key: 'quality', label: 'Quality', question: 'New characteristics, sampling, FAI/PPAP, instrument, validation or regression?' },
  { key: 'commercial', label: 'Commercial', question: 'Supplier delta, JobWork margin, customer price, tax, cancellation liability?' },
  { key: 'schedule', label: 'Schedule', question: 'Critical path, material, rework, approval, inspection and shipment effect?' },
  { key: 'contract', label: 'Contract', question: 'Warranty, acceptance, IP/NDA, liability or terms amendment?' },
  { key: 'logistics', label: 'Logistics', question: 'Extra movement, return, packaging, customs/e-waybill/document impact?' },
] as const;

/** Inspection stages (IN-14; doc 09 §9). */
export const INSPECTION_STAGES = ['incoming', 'in_process', 'fai', 'final', 'jobwork_incoming', 'customer_receiving'] as const;
