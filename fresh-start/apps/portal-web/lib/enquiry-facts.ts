import type { CapabilityRef, CustomerEnquiry, DocumentSummary, OrganizationSite } from '@jobwork/contracts';
import { formatMoney } from '@jobwork/ui';
import { api } from './api';

/** What the quote and order screens read back about an enquiry (VF-18, references 10 and 12). */
export interface EnquiryFacts {
  category: string;
  material: string;
  quantity: string;
  location: string;
  specifications: string;
  files: Array<{ name: string; documentId: string; versionId: string }>;
}

export function unitLabel(unit: string | null | undefined): string {
  return !unit || unit === 'piece' ? 'Nos' : unit;
}

/** "₹ 12,500": whole rupees read as the references do, paise only when there are any. */
export function displayMoney(amountMinor: number, currency: string): string {
  return formatMoney({ amountMinor, currency }).replace(/\.00$/, '').replace(/^₹/, '₹ ');
}

export async function loadEnquiryFacts(enquiryId: string): Promise<EnquiryFacts> {
  const [detail, taxonomy, sites, documents] = await Promise.all([
    api<{ enquiry: CustomerEnquiry }>(`/enquiries/${enquiryId}`),
    api<{ capabilities: CapabilityRef[] }>('/suppliers/me/taxonomy').catch(() => ({ capabilities: [] })),
    api<{ sites: OrganizationSite[] }>('/organizations/me/sites').catch(() => ({ sites: [] })),
    api<{ documents: DocumentSummary[] }>('/documents').catch(() => ({ documents: [] })),
  ]);
  const { enquiry } = detail;
  const byId = new Map(taxonomy.capabilities.map((c) => [c.capabilityId, c]));
  const process = enquiry.processCapabilityId ? byId.get(enquiry.processCapabilityId) : undefined;
  const family = process?.parentId ? byId.get(process.parentId) : undefined;
  const site = sites.sites.find((s) => s.siteId === enquiry.deliverySiteId);
  return {
    category: family?.label ?? process?.label ?? '—',
    material: (enquiry.materialCapabilityId && byId.get(enquiry.materialCapabilityId)?.label) || '—',
    quantity: enquiry.quantity ? `${enquiry.quantity} ${unitLabel(enquiry.unit)}` : '—',
    location: site ? `${site.city}, ${site.state}` : '—',
    specifications: enquiry.specifications,
    files: documents.documents
      .filter((doc) => doc.currentVersionId && enquiry.documentVersionIds.includes(doc.currentVersionId))
      .map((doc) => ({ name: doc.currentVersionFilename ?? doc.title, documentId: doc.documentId, versionId: doc.currentVersionId! })),
  };
}
