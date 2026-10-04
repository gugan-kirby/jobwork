# Documents, engineering change, and quality

## 1. Principle

Custom manufacturing fails when “the latest file in chat” becomes production authority. JobWork must treat document release, configuration baseline, technical change, inspection, non-conformance, deviation, and quality release as connected controlled workflows.

## 2. Document lifecycle

```text
upload initiated
-> bytes uploaded
-> finalized/hash verified
-> quarantined for scanning
-> scan/format inspection
-> metadata extraction and leakage review
-> derived preview/sanitized artifact
-> classified
-> eligible for explicit audience release
-> retained/held/expired according to policy
```

A logical document may have many immutable system versions and customer engineering revision labels. These are not the same number.

## 3. Required document metadata

- logical type: 3D CAD, 2D drawing, BOM, SOW, image, certificate, quote, PO, inspection, etc.;
- title and business owner;
- customer/supplier drawing number when applicable;
- system version and declared engineering revision;
- source party/uploader and timestamp;
- SHA-256, byte size, detected type, storage reference;
- scan, conversion, preview, and leakage-review states;
- confidentiality classification and retention class;
- governing/non-governing purpose;
- audience grants and release/revocation history;
- predecessor/superseding version and change reason.

## 4. Upload security

- Allowlist extensions only as user guidance; validate file signature/content type independently.
- Enforce purpose-specific maximum size/count and decompression limits.
- Reject/quarantine nested archives, password-protected/encrypted content, malformed files, or active content according to policy.
- Scan in an isolated worker with CPU/memory/time/network limits.
- Strip unsafe preview features; never serve original Office/PDF/CAD inline from the application origin.
- Use private storage, encryption, opaque keys, short-lived authorized downloads, safe content-disposition, and optional watermark.
- Preserve original bytes for authorized evidence while releasing a derived sanitized version when safe.
- Extract metadata/contact leakage only with reviewed parsers and log safe results.

## 5. Audience and transmittals

Audience is explicit per version:

- JobWork internal;
- customer organization/selected memberships;
- one supplier organization in one RFQ/work package;
- all invited suppliers for a common technical clarification;
- controlled shared technical group;
- auditor/legal export.

A transmittal is a formal delivery manifest:

```text
transmittal number/purpose
sender and recipients
exact document version IDs and hashes
issue/release timestamp
access expiry and download policy
required acknowledgment/deadline
superseding/revocation relationship
```

Email may notify a transmittal but should not be the only release record.

## 6. Baseline types

| Baseline | Purpose |
|---|---|
| RFQ baseline | Exact requirement package suppliers quote against |
| Quote baseline | Technical package underlying customer commercial offer |
| Production baseline | Authorized files/instructions for manufacturing |
| Inspection baseline | Characteristics/specifications used for verification |
| As-built baseline | Final approved configuration including accepted changes/deviations |

A baseline is immutable after release. A new baseline supersedes it; existing evidence continues to reference the old baseline actually used.

## 7. Engineering change process

1. Propose change with origin, reason, urgency, affected items, and candidate documents.
2. Classify as clarification, correction, or scope/configuration change.
3. Stop/continue/contain affected work through a scoped interim decision.
4. Collect supplier feasibility, WIP, material, scrap/rework, tooling, price, and date impact.
5. Analyze JobWork sell-side price, tax, delivery, quality, logistics, and warranty impact.
6. Obtain internal technical/commercial approvals and required customer approval.
7. Release a new baseline/transmittal.
8. Obtain supplier acknowledgment before implementation.
9. Replan affected work and inspections.
10. Verify implementation and close with evidence.

Chat cannot approve a change. Urgent verbal action is recorded as containment and must enter the formal workflow.

## 8. Change impact matrix

| Area | Questions |
|---|---|
| Configuration | Which item, revision, interface, BOM, cavity, serial/lot, and quantity? |
| Work in progress | What is complete, in machine, procured, reusable, reworkable, or scrap? |
| Process/tooling | Route, program, fixture, tool/mould, setup, subcontractor impact? |
| Quality | New characteristics, sampling, FAI/PPAP, instrument, validation, or regression? |
| Commercial | Supplier delta, JobWork margin, customer price, tax, cancellation liability? |
| Schedule | Critical path, material, rework, approval, inspection, and shipment effect? |
| Contract | Warranty, acceptance, IP/NDA, liability, or terms amendment? |
| Logistics | Extra movement, return, packaging, customs/e-waybill/document impact? |

## 9. Quality plan

Quality templates are configurable by category/customer, not one-size-fits-all. A plan includes:

- governing baseline and item/operation;
- characteristic identifier and drawing/BOM reference;
- criticality/severity classification;
- nominal/limits or categorical specification;
- unit and method;
- stage: incoming, in-process, FAI/trial, final, JobWork incoming, customer receiving;
- sampling scheme/quantity and acceptance rule;
- instrument/equipment and calibration requirement;
- responsible submitter and independent verifier;
- required document/photo/video/certificate evidence;
- reaction plan on failure.

Automotive APQP/Control Plan/PPAP/FAI capabilities should be optional templates activated by contract/category—not forced onto every basic machining job.

## 10. Inspection result model

Each result retains:

- plan/characteristic and exact baseline;
- sample/serial/lot/cavity and quantity;
- original value/unit/precision and normalized value/unit;
- pass/fail/cannot-evaluate plus calculation-rule version;
- method, instrument, calibration record/status;
- inspector, organization, location/time;
- attachments and tamper-safe hashes;
- review/disposition and invalidation/supersession history.

Changing a specification does not rewrite past results. Re-evaluation creates an explicit later assessment against a different baseline/rule.

## 11. NCR workflow and data

An NCR records:

- affected item, operation, baseline, lot/serial/cavity and quantity;
- characteristic/specification, actual evidence, severity, detection stage;
- containment action and custody/location;
- suspected cause and responsible owner;
- disposition options: rework, remake, use-as-is under deviation, sort, return, scrap;
- dates/SLA, communication, cost responsibility;
- reinspection and independent closure evidence.

One NCR may contain several related defects, but scope must remain clear. Repeated failure after rework branches/reopens with lineage rather than erasing the first attempt.

## 12. Deviation/concession

A deviation is authorization to accept known non-conformance under defined conditions. It includes:

- failed requirement and actual result;
- exact item/quantity/serial/lot/cavity;
- rationale and risk assessment;
- time/use/customer scope and expiry;
- downstream fit/function/safety assessment;
- price, warranty, traceability, and labeling effect;
- internal quality/engineering decision and customer decision when required;
- signatures/authority snapshots and evidence.

It never changes the original result to pass and never establishes a permanent new specification.

## 13. Corrective action

For category/severity where required:

1. Immediate containment.
2. Problem definition with evidence.
3. Root-cause analysis distinguishing occurrence and escape causes.
4. Corrective and preventive actions with owners/dates.
5. Implementation evidence.
6. Effectiveness verification after an appropriate period/sample.
7. Supplier score/knowledge update and closure approval.

Text claiming “operator mistake” without causal evidence/action should not satisfy a configured corrective-action template.

## 14. Quality release

Quality release is an independent decision over a computed checklist:

- correct production/inspection baseline and acknowledged changes;
- required operations/milestones verified;
- material/heat-treatment/coating certificates valid;
- FAI/trial and final inspections complete;
- instrument calibrations valid/dispositioned;
- NCRs closed or authorized scoped deviations active;
- quantities/identity/traceability match;
- packaging and required customer evidence complete;
- release actor has authority and no prohibited conflict.

Release creates an immutable snapshot/hash. A newly discovered defect after release opens a new hold/NCR/warranty flow; it does not rewrite release history.

## 15. Evidence authenticity

Photos/video can be reused or misleading. Apply proportionate controls:

- direct in-app capture option with server timestamp and job/milestone context;
- file hash and duplicate-image similarity flag;
- EXIF retained privately and sanitized externally according to policy;
- optional location policy with consent and accuracy disclosure;
- required wide/context and detail shots;
- measurement/certificate/receiving corroboration;
- anomaly review, never automatic fraud accusation.

## 16. Category templates

Templates version mandatory intake fields, release gates, operation milestones, quality characteristics, documents, sampling, approvals, and SLA. Jobs snapshot the activated template version. Changing a template affects new jobs unless a formal migration/reapproval is executed.
