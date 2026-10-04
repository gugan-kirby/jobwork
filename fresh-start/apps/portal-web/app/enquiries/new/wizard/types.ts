import type {
  CapabilityRef,
  DocumentSummary,
  Enquiry,
  EnquiryDocumentInput,
  EnquiryItemInput,
  JobType,
  MaterialSupply,
} from '@jobwork/contracts';

/**
 * The wizard's shared vocabulary (F-MX.6). Three stages — the prototype's Details /
 * Requirements / Review — over the doc 14 §4 fields; the data is the same seven
 * concerns, grouped so a phone screen asks one kind of question at a time.
 */

export const STAGES = ['Details', 'Requirements', 'Review'] as const;

/** Which stage owns which field path, so a 422 can put the customer in front of the problem. */
export function stageForPath(path: string): number {
  if (/^(title|jobType|changeReference|changeDescription|relatedEnquiryId|deliverySiteId|materialSupply)/.test(path)) return 0;
  if (/partName|processCapabilityId|materialCapabilityId|materialGrade|quantityBreakpoints/.test(path)) return 0;
  if (/^documents|tolerance|inspection|quality|surface|heat|coating|requiredByDate|packaging|partialDelivery|confidentiality/i.test(path)) return 1;
  return 2;
}

export interface DraftState {
  jobType: JobType;
  materialSupply: MaterialSupply;
  changeReference: string;
  changeDescription: string;
  relatedEnquiryId: string;
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
    quantityBreakpoints: [{ quantity: 1, unit: 'piece', kind: 'production' }],
    inspectionLevel: 'standard',
    qualityNote: '',
  };
}

export const INITIAL: DraftState = {
  jobType: 'job_work',
  materialSupply: 'customer_supplied',
  changeReference: '',
  changeDescription: '',
  relatedEnquiryId: '',
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
    jobType: fresh.jobType,
    materialSupply: fresh.materialSupply,
    changeReference: fresh.changeReference,
    changeDescription: fresh.changeDescription,
    relatedEnquiryId: fresh.relatedEnquiryId ?? '',
    title: fresh.title,
    applicationNote: fresh.applicationNote,
    confidentiality: fresh.confidentiality,
    assistedIntake: fresh.assistedIntake,
    requiredByDate: fresh.requiredByDate ?? '',
    deliverySiteId: fresh.deliverySiteId ?? '',
    partialDelivery: fresh.partialDelivery,
    packagingNote: fresh.packagingNote,
    items: fresh.items.map(({ enquiryItemId: _id, ...rest }) => rest),
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
    jobType: draft.jobType,
    materialSupply: draft.materialSupply,
    changeReference: draft.changeReference,
    changeDescription: draft.changeDescription,
    ...(draft.relatedEnquiryId ? { relatedEnquiryId: draft.relatedEnquiryId } : {}),
    title: draft.title,
    applicationNote: draft.applicationNote,
    confidentiality: draft.confidentiality,
    assistedIntake: draft.assistedIntake,
    ...(draft.requiredByDate ? { requiredByDate: draft.requiredByDate } : {}),
    partialDelivery: draft.partialDelivery,
    packagingNote: draft.packagingNote,
    ...(draft.deliverySiteId ? { deliverySiteId: draft.deliverySiteId } : {}),
    items: draft.items,
    documents: draft.documents,
  };
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
