# UX and screen map

## 1. UX direction

The existing 16-screen board is a useful visual foundation—clean, mobile-first, recognizable navigation—but models a direct vendor marketplace. Retain its simplicity and visual trust while replacing its transaction semantics with the managed reseller workflow.

Design around **current action, evidence, decision, and exception**, not around a long raw status list.

## 2. Terminology corrections

| Prototype term | Recommended term |
|---|---|
| Vendor | Supplier (internal/supplier portal); normally hidden from customer |
| Quotes Received | JobWork Quotations / Quotation Options |
| Message Vendor / Chat | Contact JobWork / Project Conversation |
| Payment to vendor | Payment to JobWork / Invoice payment |
| Wallet / Add Money | Payments and credits (gateway/bank); no stored wallet initially |
| Vendor dashboard earnings | Supplier work and settlements |
| Order confirmed | Commercial/technical release stages as relevant |

## 3. Shared application shell

- Authentication, MFA, recovery, organization switcher.
- Global action-needed inbox and notification center.
- Search appropriate to portal/role.
- Secure document viewer/download with version/audience.
- Conversation panel with audience indicator.
- Help/support and incident banner.
- Account, memberships, sessions, security, notification preferences.
- Consistent job/enquiry/order reference and correlation-friendly support code.

## 4. Customer portal information architecture

```text
Home
Enquiries
  New enquiry wizard
  Enquiry detail / clarification
Quotations
  JobWork quotation detail / revision comparison
  Approval and payment action
Orders
  Order overview / timeline
  Documents and approved baseline
  Changes and quality decisions
  Delivery / acceptance
Invoices & payments
Support / warranty
Organization / team / approvals
```

### Customer home

- Primary “Create enquiry” action.
- Action needed: clarifications, quote approval/expiry, payment, drawing/change/deviation, delivery acceptance.
- Active order risks and next commitment.
- Recent documents/invoices/support.
- Capability/category discovery without supplier contacts by default.

### Enquiry wizard

Use category-driven progressive steps:

1. Job type (job work / new model / correction-ECN, `FR-307`), job/application and confidentiality.
2. Items, process (category → sub category) and quantity/prototype-production breakpoints.
3. Material grade/standard, who supplies it, and source restrictions.
4. CAD/drawing/BOM upload with revision/governing document.
5. Tolerance/surface/heat treatment/coating/quality requirements.
6. target/required date, location, packaging and partial-delivery policy.
7. Review completeness, conflicts, terms and submit.

On a phone the seven concerns are presented as three stages — **Details** (1–3, 6 location), **Requirements** (4–5, 6 dates/packaging), **Review** (7) — matching the prototype's three-step wizard (F-MX.6, 2026-09-30); the data captured is the same. A correction/ECN adds its change reference, description and the enquiry it corrects to stage 1.

Autosave locally/server-side safely, show missing mandatory inputs, scan state, upload recovery, and assisted-intake path.

### Customer quotation

- JobWork legal identity and quote revision/status/validity countdown.
- Standard/Fast/Premium options only if each is a JobWork-created sell offer.
- Scope/items, quantity/unit, unit and total price, tax/freight, delivery commitment.
- payment schedule, warranty, assumptions, exclusions, terms version.
- revision diff and downloadable immutable PDF/hash reference.
- request revision, reject with reason, or approve within authority.
- never show supplier name, location, rating, raw bid, or direct contact.

### Customer order

- Clear next commitment and owner.
- Curated timeline separated into commercial, technical, manufacturing, quality, JobWork receiving, and customer delivery.
- Released evidence/documents only.
- Change/deviation decision card with impact and authority.
- ETA and risk explanation without exposing internal/supplier details.
- invoices/payments, delivery acceptance, support/warranty.

## 5. Supplier portal information architecture

```text
Work queue
RFQs
  Requirement package / clarification
  Feasibility and bid builder
Purchase orders
Production
  Plan / milestones / evidence
Quality
  Inspection / NCR / corrective action
Shipments
Bills & settlements
Capabilities
  Machines / materials / capacity / certifications
Performance
Organization / users / security
```

### Supplier RFQ workspace

- Countdown and acknowledgement/decline action.
- Sanitized exact RFQ baseline manifest and acknowledgment.
- Structured feasibility, questions, assumptions/exclusions.
- Bid lines, NRE/tooling, tax, freight, lead time, payment terms, validity.
- Validation and side-by-side diff for own revisions.
- Customer identity/contact/sell value absent.

### Supplier production workspace

- PO/work-package and current released baseline.
- Route and milestone plan, evidence checklist, blockers/delay risk.
- In-app capture/upload with baseline/milestone association.
- Inspection/certificate forms.
- NCR containment, action, rework, reinspection.
- Shipment readiness and settlement eligibility explanation.

## 6. Operations portal information architecture

```text
Action queues / command center
Intake & enquiries
Supplier matcher / supplier 360
RFQ control room / bid comparison
Cost sheets / customer quotes / approvals
Orders / work packages / critical path
Engineering baselines / transmittals / changes
Quality / inspections / NCR / deviations / release
Receiving / logistics / returns
Finance / reconciliation / bills / settlements
Support / warranty / disputes
Audit / reports
Configuration / access / integrations / incidents
```

### Intake workspace

Two-pane requirement and file viewer, completeness/conflict checklist, clarification builder, confidentiality, similar jobs, and approve/decline/sourcing actions.

### Supplier matcher

Hard-filter requirements, exclusion reason counts, explainable score components, capacity/certification freshness, map/logistics, concentration warning, shortlist and override reason. Sponsored/business priority is visually distinct from technical fit.

### Bid comparison and cost sheet

Original immutable bid values, normalized landed-cost scenario, assumptions/exclusions/diffs, technical/quality risk, lead time/capacity, award split, fallback, internal components/margin, approval status. Customer output preview uses a strict sell-side projection.

### Order command center

Gate matrix, current baseline, route/critical path, milestones/evidence, change/NCR/hold, payment, both shipment legs, decisions, forecast history, and audit timeline. Provide role-specific action buttons, not status dropdowns.

## 7. Admin and specialist separation

Configuration screens include users/memberships, taxonomy, category templates, approval policies, SLA/calendar, notification templates, integrations/webhooks, feature flags, retention/legal hold, and incident tooling. Admin screens do not confer automatic document, margin, bank, or job access.

## 8. Status and action design

Every card/detail header answers:

1. What is true now?
2. What happens next?
3. Who owns the next action?
4. When is it due?
5. What blocks it?
6. What evidence/decision created this state?

Use status plus text/icon; color alone is insufficient. Customer wording is curated. Internal users see detailed state and guards. Supplier/customer never see hidden party or price in tooltips, URLs, export names, analytics, or notification previews.

## 9. Approval interaction

An approval panel shows exact subject/version/hash, before/after diff, money/date/quality impact, authority being used, required checklist, conflicts/holds, and permanent decision effect. Require reason for rejection, override, deviation, manual match, and sensitive grant. Prevent double submission and show idempotent final receipt.

## 10. Document experience

- Manifest with logical name, revision, version, date, status, audience and governing flag.
- Preview derived/sanitized content with clear warning when preview may not preserve CAD detail.
- Original download only when authorized, with trace/watermark policy.
- Compare revision metadata and supported text/visual diffs; never imply semantic CAD diff without capability.
- Scan/quarantine/protected-file errors give corrective next action.
- Baseline view is immutable and acknowledges exactly what was released.

## 11. Conversation experience

- Thread is bound to enquiry/RFQ/order/change/NCR context.
- Composer displays current audience in words and color/icon.
- Internal note uses a visibly different mode and cannot be switched accidentally by keyboard shortcut.
- Contact-leakage warning identifies risk and offers safe edit/review route.
- Common RFQ clarification can be deliberately published to all invited suppliers without revealing the asker.
- Notifications link to authenticated thread; sensitive body content is minimized.

## 12. Mobile and desktop

Mobile prioritizes capture, acknowledgments, simple approvals, action queue, timeline, shipment/receiving, and notifications. Desktop prioritizes requirements, document/bid comparison, cost sheet, measurement grids, and command center. Responsive design may change layout but not remove evidence/authority context.

## 13. Accessibility and localization

- WCAG 2.2 AA target.
- Keyboard/screen-reader support for tables, dialogs, upload, timeline, and charts.
- Text alternatives for status/evidence; error summary and field association.
- Do not embed essential labels only inside large workflow images.
- Locale-aware display for INR/other currencies, decimals, units, date/time/timezone while API storage remains canonical.
- English first may be an MVP choice; content/templates prepared for Indian languages and supplier terminology.

## 14. Empty, loading, and error states

- Empty state explains eligibility/action, not just “no data.”
- Skeleton/loading never presents stale buttons as usable.
- Optimistic UI is avoided for money, approval, release, and status-changing commands.
- Timeout says outcome is being checked using operation/idempotency reference.
- Version conflict shows latest change and lets user refresh/reapply safely.
- Offline evidence draft clearly indicates not submitted/released.

## 15. Prototype disposition

| Existing concept | Disposition |
|---|---|
| Blue visual identity and simple cards | Retain/refine after brand/accessibility review |
| Customer enquiry wizard | Expand into category-driven structured intake |
| Direct named quote comparison | Replace with JobWork offer/options |
| Vendor chat/message | Replace with controlled JobWork conversation |
| Simple production timeline | Keep as customer projection; add full internal state/gates |
| Wallet/add money | Remove from MVP |
| Vendor dashboard | Rebuild as permission-specific supplier work queue |
| Profile | Expand to organization, security, verification, sessions |
| Missing operations app | Highest-priority new design |

## 16. Design validation plan

Prototype and test five difficult journeys before visual polish:

1. Incomplete enquiry plus drawing/CAD conflict.
2. Two supplier bids → normalized comparison → internal cost → customer quote.
3. Customer engineering change after production begins.
4. Failed inspection → NCR → rework/deviation → release.
5. Supplier shipment shortage → JobWork hold → customer dispatch resolution.

Test with representatives of customer requester/approver, supplier estimator/production/quality, and each JobWork specialist role using anonymized real scenarios.
