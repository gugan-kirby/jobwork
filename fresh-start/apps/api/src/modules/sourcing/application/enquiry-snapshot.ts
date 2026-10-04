import type { Enquiry } from '@jobwork/contracts';

/**
 * What a frozen revision contains. Deliberately not the whole row: lifecycle columns
 * (status, versions, timestamps) describe where the enquiry *is*, and would make two
 * identical requirements hash differently. A revision is what was asked for, only.
 */
export function requirementSnapshot(enquiry: Enquiry): Record<string, unknown> {
  return {
    title: enquiry.title,
    applicationNote: enquiry.applicationNote,
    confidentiality: enquiry.confidentiality,
    jobType: enquiry.jobType,
    materialSupply: enquiry.materialSupply,
    changeReference: enquiry.changeReference,
    changeDescription: enquiry.changeDescription,
    relatedEnquiryId: enquiry.relatedEnquiryId,
    assistedIntake: enquiry.assistedIntake,
    deliverySiteId: enquiry.deliverySiteId,
    requiredByDate: enquiry.requiredByDate,
    partialDelivery: enquiry.partialDelivery,
    packagingNote: enquiry.packagingNote,
    items: enquiry.items.map((item) => ({
      lineNo: item.lineNo,
      partName: item.partName,
      partNumber: item.partNumber ?? null,
      description: item.description,
      processCapabilityId: item.processCapabilityId ?? null,
      materialCapabilityId: item.materialCapabilityId ?? null,
      materialGrade: item.materialGrade ?? null,
      materialSourceRestriction: item.materialSourceRestriction ?? null,
      quantityBreakpoints: item.quantityBreakpoints,
      toleranceClass: item.toleranceClass ?? null,
      criticalTolerance: item.criticalTolerance ?? null,
      surfaceFinish: item.surfaceFinish ?? null,
      heatTreatment: item.heatTreatment ?? null,
      coating: item.coating ?? null,
      inspectionLevel: item.inspectionLevel,
      qualityNote: item.qualityNote,
      targetDate: item.targetDate ?? null,
      deliverySiteId: item.deliverySiteId ?? null,
    })),
    documents: enquiry.documents
      .map((doc) => ({
        documentVersionId: doc.documentVersionId,
        lineNo: doc.lineNo,
        role: doc.role,
        note: doc.note,
      }))
      .sort((a, b) => a.documentVersionId.localeCompare(b.documentVersionId)),
    // Answers qualify the requirement (doc 06 §3), so every revision frozen after them
    // carries them: the approved revision a round is built on included.
    clarifications: enquiry.clarifications
      .filter((c) => c.status === 'answered')
      .map((c) => ({
        sequenceNo: c.sequenceNo,
        roundNo: c.roundNo,
        topic: c.topic,
        question: c.question,
        answer: c.answer,
        askedAgainstRevisionNo: c.askedAgainstRevisionNo,
      })),
  };
}
