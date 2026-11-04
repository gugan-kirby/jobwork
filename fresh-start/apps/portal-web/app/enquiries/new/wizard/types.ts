import type {
  CapabilityRef,
  DocumentSummary,
  Enquiry,
  EnquiryDocumentInput,
  EnquiryItemInput,
  MaterialSupply,
} from '@jobwork/contracts';

/**
 * The wizard's shared vocabulary. Three stages — Details, Requirements, Review — asking
 * only what reference screens 05–07 ask (VF-17, doc 14 §4); everything else takes its
 * default. Each stage checks its own fields before Next (`stageIssues`).
 */

export const STAGES = ['Details', 'Requirements', 'Review'] as const;

/** Which stage owns which field path, so a 422 can put the customer in front of the problem. */
export function stageForPath(path: string): number {
  if (/^(title|deliverySiteId)/.test(path)) return 0;
  if (/partName|processCapabilityId|materialCapabilityId|materialGrade|quantityBreakpoints/.test(path)) return 0;
  if (/^documents|tolerance|surface/i.test(path)) return 1;
  return 2;
}

export interface DraftState {
  materialSupply: MaterialSupply;
  deliverySiteId: string;
  title: string;
  applicationNote: string;
  confidentiality: 'standard' | 'confidential' | 'nda_required';
  assistedIntake: boolean;
  requiredByDate: string;
  partialDelivery: 'allowed' | 'not_allowed';
  packagingNote: string;
  items: EnquiryItemInput[];
  documents: EnquiryDocumentInput[];
}

export function emptyItem(lineNo: number): EnquiryItemInput {
  return {
    lineNo,
    partName: '',
    description: '',
    // Quantity 0 is "not entered yet": the field shows its placeholder and the unit
    // has somewhere to live. `toPayload` never sends it.
    quantityBreakpoints: [{ quantity: 0, unit: 'piece', kind: 'production' }],
    inspectionLevel: 'standard',
    qualityNote: '',
  };
}

export const INITIAL: DraftState = {
  // The form names a material and the quotation prices it, so JobWork sources it (VF-17).
  materialSupply: 'to_be_sourced',
  deliverySiteId: '',
  title: '',
  applicationNote: '',
  confidentiality: 'confidential',
  assistedIntake: false,
  requiredByDate: '',
  partialDelivery: 'not_allowed',
  packagingNote: '',
  items: [emptyItem(1)],
  documents: [],
};

/** Server state replaces local state wholesale; a half-applied draft is worse than none. */
export function fromEnquiry(fresh: Enquiry): DraftState {
  return {
    materialSupply: fresh.materialSupply,
    title: fresh.title,
    applicationNote: fresh.applicationNote,
    confidentiality: fresh.confidentiality,
    assistedIntake: fresh.assistedIntake,
    requiredByDate: fresh.requiredByDate ?? '',
    deliverySiteId: fresh.deliverySiteId ?? '',
    partialDelivery: fresh.partialDelivery,
    packagingNote: fresh.packagingNote,
    items: fresh.items.map(({ enquiryItemId: _id, ...rest }) =>
      rest.quantityBreakpoints.length > 0 ? rest : { ...rest, quantityBreakpoints: emptyItem(rest.lineNo).quantityBreakpoints },
    ),
    documents: fresh.documents.map((d) => ({
      documentVersionId: d.documentVersionId,
      ...(d.lineNo !== null ? { lineNo: d.lineNo } : {}),
      role: d.role,
      note: d.note,
    })),
  };
}

/** The autosave payload: the whole draft, every time, under the version it was loaded at. */
export function toPayload(draft: DraftState, version: number | null): Record<string, unknown> {
  return {
    ...(version !== null ? { expectedVersion: version } : {}),
    jobType: 'job_work',
    materialSupply: draft.materialSupply,
    title: draft.title,
    applicationNote: draft.applicationNote,
    confidentiality: draft.confidentiality,
    assistedIntake: draft.assistedIntake,
    ...(draft.requiredByDate ? { requiredByDate: draft.requiredByDate } : {}),
    partialDelivery: draft.partialDelivery,
    packagingNote: draft.packagingNote,
    ...(draft.deliverySiteId ? { deliverySiteId: draft.deliverySiteId } : {}),
    items: draft.items.map((item) => ({
      ...item,
      quantityBreakpoints: item.quantityBreakpoints.filter((bp) => bp.quantity > 0),
    })),
    documents: draft.documents,
  };
}

/** The problems that hold a stage back, as field paths the stage already shows errors on. */
export function stageIssues(stage: number, draft: DraftState): Array<{ path: string; message: string }> {
  const issues: Array<{ path: string; message: string }> = [];
  if (stage === 0) {
    if (!draft.title.trim()) issues.push({ path: 'title', message: 'Enter the part or job name' });
    for (const item of draft.items) {
      const at = `items[${item.lineNo}]`;
      if (!item.processCapabilityId) issues.push({ path: `${at}.processCapabilityId`, message: 'Select a category and sub category' });
      if (!item.materialCapabilityId && !item.materialGrade) issues.push({ path: `${at}.materialCapabilityId`, message: 'Select a material' });
      if (!item.quantityBreakpoints.some((bp) => bp.quantity > 0)) issues.push({ path: `${at}.quantityBreakpoints`, message: 'Enter a quantity' });
    }
    if (!draft.deliverySiteId) issues.push({ path: 'deliverySiteId', message: 'Select a delivery location' });
  }
  if (stage === 1 && draft.documents.length === 0) {
    issues.push({ path: 'documents', message: 'Upload a drawing. It attaches once its scan clears.' });
  }
  return issues;
}

/**
 * Whether an attach would be accepted, in the customer's words. The server's rule is
 * `documentsUsable` (owned by the organization, scanned clean, not withdrawn); saying
 * the same thing here means the checkbox is never offered for a file the save would
 * reject, and a file that cannot be attached says why instead of vanishing.
 */
export function attachability(doc: DocumentSummary): { versionId: string | null; reason: string | null } {
  if (!doc.currentVersionId) return { versionId: null, reason: 'Still uploading' };
  if (doc.currentVersionStatus === 'revoked')
    return { versionId: null, reason: 'Withdrawn — upload a new version to use it' };
  switch (doc.currentVersionScanState) {
    case 'clean':
      return { versionId: doc.currentVersionId, reason: null };
    case 'scanning':
    case 'quarantined':
      return { versionId: null, reason: 'Scanning — it can be attached once the scan clears' };
    default:
      return { versionId: null, reason: 'The scan refused this file; it cannot be attached' };
  }
}

/** The extension, upper-cased, from a document title ("Bracket Drawing.pdf" → "PDF"). */
export function extensionOf(title: string | undefined): string {
  const match = title?.match(/\.([a-z0-9]{2,5})$/i);
  return match ? match[1]!.toUpperCase() : 'FILE';
}

/** The taxonomy split the Category → Sub category pair reads from. */
export interface Taxonomy {
  families: CapabilityRef[];
  processes: CapabilityRef[];
  materials: CapabilityRef[];
}

export function splitTaxonomy(all: CapabilityRef[]): Taxonomy {
  return {
    families: all.filter((c) => c.kind === 'process' && c.isFamily),
    processes: all.filter((c) => c.kind === 'process' && !c.isFamily),
    materials: all.filter((c) => c.kind === 'material'),
  };
}
