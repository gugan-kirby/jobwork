# Roles, permissions, and approvals

## 1. Model

Use a combination of:

- **RBAC** for job-function permissions;
- **relationship-based access** for organization/job/RFQ/order participation;
- **attributes** for audience, classification, geography, NDA, account state, amount, and transaction state;
- **segregation of duties** for conflicting create/approve/reconcile/release actions.

An authorization decision is conceptually:

```text
allow = authenticated
    AND account_active
    AND membership_active
    AND role_has_action
    AND relationship_allows_subject
    AND artifact_audience_allows_actor
    AND state_allows_action
    AND required_agreements_active
    AND approval_limit_sufficient
    AND no_separation_of_duties_conflict
```

Default is deny. List queries must apply the same policy at query time; filtering unauthorized records after fetching is unsafe.

`required_agreements_active` is backed by first-class records, not a flag: `agreement`/`agreement_version`/`agreement_acceptance` (doc 05 §4) model NDAs and terms with an explicit scope (organization relationship, RFQ, or document class), the accepting actor/authority, immutable accepted-version hash, validity/expiry, and renewal lineage. RFQ release and audience grants evaluate the acceptance state for their scope (doc 06 §4 guards).

## 2. Role catalogue

| Role | Core authority | Must not do |
|---|---|---|
| Customer requester | Draft/submit enquiry, upload, clarify, view released customer artifacts | View supplier identity/cost; approve beyond granted authority |
| Customer approver | Quote/change/deviation/delivery decisions within scope | Change JobWork internal records |
| Supplier estimator | Read invited RFQ, clarify, submit feasibility and bid versions | See customer identity/sell price; edit submitted bid |
| Supplier production | Acknowledge PO/baseline, plan, submit progress/evidence | Change commercial values; self-release quality |
| Supplier quality | Submit inspection/certificates/NCR response | Approve final JobWork release or customer deviation |
| JobWork sales | Customer communication, sell quote preparation | Approve own exception above threshold; expose buy-side data |
| JobWork sourcing | Shortlist, RFQ, evaluation, negotiation, award proposal | Expose supplier bid to customer; final self-approve restricted award |
| JobWork engineering | Requirement validation, feasibility, baseline/change control | Financial reconciliation or final quality release by default |
| JobWork quality | Plan, inspection, NCR, deviation recommendation, release | Alter quote/bid; approve supplier commercial settlement |
| JobWork finance | Receivable/payable, invoice, reconcile, refund/settlement proposal | Technical release or quality disposition |
| JobWork logistics | Shipment, receiving, POD, physical discrepancy | Edit price; dispatch while computed holds exist |
| Support/dispute | Open and coordinate cases, collect evidence | Issue unrestricted refund/deviation without approval |
| Platform admin | Users, roles, policy/configuration, integrations | Ambient access to CAD, bids, margin, bank data |
| Security admin | Session revoke, incident response, audit-security access | Business approval unless separately assigned and non-conflicting |
| Auditor | Scoped read/export with reason and watermark | Mutate or download ungranted sensitive content |

## 3. Resource visibility

| Resource | Customer | Supplier | JobWork business roles | Platform admin |
|---|---|---|---|---|
| Customer enquiry | Own/released | Only sanitized RFQ snapshot when invited | Scoped by function/job | Metadata only by default |
| Supplier profile | Anonymized view | Own full profile | Full as needed | Configuration/metadata only |
| Supplier bid | Never | Own versions | Sourcing/commercial-authorized | No default content access |
| Internal cost sheet | Never | Never | Sales/sourcing/finance by policy | No default content access |
| Customer quote | Own | Never | Sales/finance/authorized ops | No default content access |
| Baseline files | Released customer subset | Released supplier subset | Engineering/quality and scoped roles | No default content access |
| Quality record | Curated/released | Own work-package records | Engineering/quality/ops | No default content access |
| Ledger/bank data | Own invoices/payments | Own bills/settlements | Finance-authorized | No default content access |
| Audit | Own action receipts where designed | Own action receipts where designed | Auditor/security/scoped managers | Security metadata per duty |

## 4. Approval types

Approval policy is versioned data stored in `approval_policy`/`approval_policy_version` (doc 05 §4), not code constants. It may depend on amount, currency, margin, category, customer risk, supplier risk, quality severity, or geography. A policy version has a rule expression over those attributes, a scope with precedence (global → category → organization), a draft/review/activate/retire lifecycle with effective dating, and audited activation (`FR-1006`); a running approval evaluates and records the version active at decision time, so later policy changes never re-color history (§5).

| Approval | Typical initiator | Approver requirement | Separation rule |
|---|---|---|---|
| Below-floor margin/discount | Sales | Sales manager/finance within limit | Initiator cannot be sole approver |
| Single-source award | Sourcing | Sourcing manager/operations | Document reason and fallback |
| High-risk supplier/expired evidence exception | Sourcing | Engineering/quality/compliance as applicable | Independent domain owner |
| Credit/payment release | Sales/finance | Finance/credit authority | Sales cannot self-release |
| Technical baseline | Engineering | Authorized engineer; second approval by category | Supplier cannot approve JobWork baseline |
| Engineering change | Engineering | Customer approver plus internal commercial/technical gates | Affected cost/date separately approved |
| Deviation/concession | Quality | Internal quality and customer when contract requires | Supplier never final approver |
| Quality release | Quality | Independent authorized quality role | Creator of evidence cannot be sole releaser where policy demands |
| Manual payment match/refund | Finance | Second finance authority above threshold | Maker-checker |
| Dispatch override | Logistics | Quality/finance/compliance owners for corresponding holds | No global logistics bypass |
| Access grant/export | Data owner/security | Owner or policy approver | Admin cannot self-grant business access silently |

## 5. Approval evidence

Each decision records:

- approval type and policy version;
- subject type/id/version/hash;
- decision: approved, rejected, returned, expired, revoked;
- actor, organization, membership, and authority snapshot;
- reason/comment and any required checklist;
- amount/currency or scope used to evaluate limits;
- timestamp, device/session/IP risk metadata where appropriate;
- predecessor/superseding approval;
- audit correlation ID.

Approval is not a mutable boolean on the subject. It is an immutable decision record; current approval state is a projection over valid decisions.

## 6. Emergency and delegated access

- Delegation has a scope, start/end, delegator, delegate, reason, and approval.
- Break-glass access is time-limited, reason-required, alerted immediately, and reviewed after use.
- Support impersonation should be avoided; if required, it is visibly indicated and dual-audited as operator plus represented user.
- Signed URLs are short-lived capabilities and must not outlive access revocation expectations for highly sensitive files.

## 7. Required negative tests

- Customer A cannot enumerate or fetch Customer B's enquiry by guessed ID.
- Invited Supplier A cannot fetch Supplier B's bid or attachment.
- Supplier cannot infer customer identity through filenames, previews, metadata, notification, or download headers.
- Customer cannot infer supplier identity/cost through quotes, order events, labels, POD, or API expansion fields.
- Platform admin cannot open a CAD file merely because they manage accounts.
- Suspended membership loses API, WebSocket, file, and refresh-token access.
- Sales author cannot approve their own outside-policy margin.
- Supplier quality user cannot authorize JobWork quality release.
- Internal message/attachment never appears in any external listing, webhook, email, or generated PDF.
