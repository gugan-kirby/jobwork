# Data structures and algorithms

This document identifies algorithmic components, their input structures, invariants, complexity, explainability, and safe first implementation. “AI” is not a substitute for hard eligibility, authority, or quality decisions.

## 1. Core data structures

| Problem | Primary structure | Why |
|---|---|---|
| Workflow transitions | adjacency map keyed by `(aggregate, state, command)` | Fast guard/handler lookup; explicit legal graph |
| Capability taxonomy | rooted DAG/tree plus synonym index | Hierarchical filtering with shared aliases |
| Supplier eligibility | inverted indexes/search projection plus bitsets/sets | Intersect hard requirements efficiently |
| Ranking | feature vector per supplier/result | Reproducible weighted scoring/explanation |
| Work routing | operation DAG | Precedence and critical path |
| SLA queues | min-heap by next-due time plus durable DB queue | Efficient next escalation; DB remains truth |
| Document baseline | ordered immutable manifest/hash map | Exact version lookup and deterministic hash |
| Audit/outbox | append-only sequence per aggregate/event ID | Causality, replay protection |
| Idempotency | unique hash-map-like DB index `(scope, operation, key)` | Race-safe duplicate suppression |
| Ledger | append-only journals with debit/credit lines | Balanced financial truth |
| Contact terms | normalized pattern sets/trie plus detectors | Efficient known-token scanning with context review |
| Quality characteristics | typed rule objects by measurement/category | Correct decimal/unit evaluation |

## 2. Supplier matching: filter, score, diversify

### 2.1 Two-stage rule

Never rank an ineligible supplier into eligibility.

1. **Hard filter**: process, material, machine envelope, tolerance, required certification, geography/serviceability, verification, NDA/conflict, quantity range, and mandatory date/capacity rules.
2. **Soft score**: capability closeness, quality, delivery, response, capacity confidence, logistics, commercial history, and concentration risk.

Record every exclusion code and every score component so operations can explain and override only permissible factors.

### 2.2 Candidate representation

```text
RequirementVector
  required_process_ids: Set
  material_grade/standard
  dimensions and machine envelope
  max_tolerance / surface-finish requirement
  certification_ids: Set
  destination/geography
  quantity/date/capacity interval
  quality-template requirements

SupplierFeatureVector
  verified capabilities and validity windows
  machines/envelopes
  capacity intervals with confidence
  historical quality/delivery/response metrics
  distance/route estimate
  commercial/risk features
```

### 2.3 Scoring

For eligible supplier `s`:

```text
score(s) = 100 * (
    w_fit       * capability_fit(s)
  + w_quality   * quality_confidence(s)
  + w_delivery  * on_time_confidence(s)
  + w_response  * response_confidence(s)
  + w_capacity  * capacity_confidence(s)
  + w_logistics * logistics_score(s)
  + w_commerce  * commercial_reliability(s)
  - w_risk      * concentration_and_exception_risk(s)
)
```

Each feature is normalized to `[0,1]`; active configuration stores weights and formula version. Missing data should reduce confidence, not be imputed optimistically. Sponsored boost, if ever allowed, is applied only after eligibility and is displayed separately.

### 2.4 Small-sample confidence

Raw success percentage unfairly over-ranks a supplier with one job. Use Bayesian shrinkage toward the category prior:

```text
posterior_rate = (successes + prior_strength * category_prior)
               / (trials + prior_strength)
```

Optionally time-decay observations for changing capacity/performance, but store the score date, inputs, window, and version. Do not hide raw counts.

### 2.5 Diversified shortlist

After base ranking, avoid selecting a shortlist whose members share one site, ownership group, or fragile process dependency. Greedy maximal-marginal-relevance is sufficient initially:

```text
selected = []
while len(selected) < k:
  choose candidate maximizing
    lambda * base_score(candidate)
    - (1-lambda) * max_similarity(candidate, selected)
```

Operations approves the result. Complexity is approximately `O(n*k*f)` for `n` eligible suppliers, shortlist `k`, and similarity features `f`; `k` is small.

## 3. Capability search and taxonomy

- Model category/process/material/machine terms as canonical IDs with versioned synonyms.
- Use an inverted search projection for token-to-supplier candidate lookup.
- Traverse descendants/ancestors only where taxonomy semantics permit; “CNC machining” does not automatically prove every specialized tolerance.
- Combine PostgreSQL FTS/trigram for text with structured filters and PostGIS radius/route approximations.
- Natural-language extraction produces proposed structured requirements with confidence and human confirmation; it never bypasses hard fields.

Query complexity is dominated by indexed candidate retrieval and sort, approximately `O(log n + m log k)` for `m` matched rows and top `k`, subject to database plan.

## 4. Bid normalization and comparison

Source bid values remain untouched. Build a normalized evaluation row:

```text
normalized_landed_cost =
  item_cost
  + tooling_or_NRE_allocated
  + expected_freight
  + inspection_packaging_cost
  + financing/risk_adjustment
  + non_recoverable_tax
```

Normalization captures quantity basis, unit conversion, currency-rate snapshot, tax assumption, freight scenario, validity, and exclusions. A comparison displays both original and normalized values internally.

For NRE allocation across lines, use declared allocation policy (quantity, value, equal, or direct attribution) and deterministic remainder allocation. Never spread a cost merely to make totals look comparable.

## 5. Multi-supplier award and operation routing

Represent manufacturing steps as a directed acyclic graph:

```text
node = operation/work package
edge = technical precedence/custody transfer
node attributes = eligible suppliers, cost, duration, capacity, quality risk
```

MVP: operations chooses among generated feasible routes; validate coverage, quantity conservation, precedence, lead time, and supplier eligibility.

Later optimization can minimize:

```text
total_cost + lateness_penalty + quality_risk + transfer_cost + concentration_penalty
```

subject to capacity, precedence, quantity, certification, max-suppliers, and due-date constraints. This is a mixed-integer optimization problem and may be NP-hard; use a solver only after clean input data and explainable constraints exist. Do not market a greedy heuristic as globally optimal.

## 6. Critical-path and delivery-risk forecast

On the operation DAG:

1. Topologically sort nodes, `O(V+E)`.
2. Compute earliest start/finish from actual/forecast durations.
3. Reverse pass computes latest start/finish and slack.
4. Zero/low-slack operations form the critical/near-critical path.
5. Propagate holds, change impact, material delay, inspection, and shipment buffers.

Forecast versions retain input dates and confidence. Customer-facing ETA is curated and cannot simply mirror a supplier-entered date.

## 7. State-machine engine

Represent allowed transitions in code, not configurable arbitrary edges for core legal state:

```text
TransitionKey = aggregateType + currentState + commandType
TransitionDefinition = {
  requiredPermission,
  guards[],
  handler,
  nextState,
  auditAction,
  emittedEventType
}
```

Lookup is `O(1)` average in a map. Guards are pure where possible and return machine-readable failure codes. Dynamic policy controls thresholds/checklists, but deploy-reviewed code owns invariants.

## 8. Relationship authorization

Authorization should compile to bounded indexed checks, not load an entire relationship graph in memory.

```text
authorize(actor, action, subject):
  verify active user/session/membership
  verify role grants action
  query subject relationship scoped to actor organization
  evaluate artifact audience/classification/state/NDA
  evaluate amount/approval and SoD constraints
  return allow with obligations or deny reason
```

Cache only coarse permission metadata with short lifetime and revocation version. Object relationship/state is read from authoritative DB/projection suitable for security. Batch/list endpoints incorporate policy predicates into SQL.

## 9. Idempotent command handling

Use a database unique index as the concurrency primitive:

```text
begin
  existing = find(scope, operation, key)
  if existing.completed:
    require existing.request_hash == hash(canonical_request)
    return existing.result
  insert/claim key or lose unique-key race
  execute domain command with expected aggregate version
  save result reference + audit + outbox
commit
```

Hash a canonical representation excluding volatile headers. Do not store secrets unnecessarily. Complexity is indexed `O(log n)` and race behavior is deterministic.

## 10. Outbox scheduling and retry

Workers claim due rows ordered by priority and `next_attempt_at` using an indexed query and `FOR UPDATE SKIP LOCKED`. Retry uses capped exponential backoff with jitter — the cap is applied after jitter so the ceiling actually holds:

```text
delay = min(cap, base * 2^attempt * random(0.5, 1.5))
```

Permanent validation failures do not retry indefinitely. Dead-letter review contains safe error metadata and a controlled replay command. Per-provider circuit breaking and concurrency limits prevent retry storms.

## 11. SLA escalation queue

Authoritative rows store `due_at`, current owner, policy version, and escalation level, backed by `work_queue`/`queue_assignment`/`sla_policy_version`/`business_calendar_version` (doc 05 §4): queues have owning teams, assignment/reassignment is an audited command, and due dates compute from the versioned SLA policy against the versioned business calendar (`BR-SYS-07`). A worker queries the next due indexed rows; an in-memory min-heap may optimize a single worker but cannot be the only state.

When work changes, recompute the next deadline from calendar/timezone/policy. Escalation is idempotent by unique `(subject, policy_step, due_version)`.

## 12. Contact-leakage detection

Use a pipeline because one regex is insufficient:

1. Unicode normalization and confusable handling.
2. Detectors for phone, email, URL/domain, social handle, address phrases, and known party names.
3. Metadata extraction from supported documents/images/CAD packages.
4. OCR/QR detection for images/previews where policy permits.
5. Known-token matching using normalized sets or Aho-Corasick trie for many names/domains.
6. Context risk score and action: allow, redact candidate, quarantine for review, or block.

False positives matter in engineering text (part numbers resemble phone numbers). Preserve the original securely, show reviewer evidence, and create sanitized derived artifacts with lineage. Never silently alter governing engineering geometry/text.

For text length `L` and pattern set total size `P`, Aho-Corasick construction is `O(P)` and scan is `O(L + matches)`. OCR and file parsing are asynchronous and sandboxed.

## 13. Baseline hashing and file integrity

Each file object has SHA-256. A baseline manifest is canonicalized by stable item order and fields:

```text
baseline_hash = SHA256(
  canonical_json([
    {document_id, version_id, file_sha256, purpose, governing_priority}, ...
  ])
)
```

The hash proves the manifest, not semantic CAD equivalence. A changed filename with same bytes may create a new document version for business history even if storage de-duplicates bytes.

## 14. Measurement normalization and tolerance evaluation

Use decimal arithmetic and versioned exact conversion factors where possible:

```text
normalized = original * factor + offset          # affine map applied to absolute values
passes = compare(normalized, limits, rule)       # rule states inclusive/exclusive per bound
```

Limits are stored with their declared unit and converted as absolute values through the same affine map — never by converting a tolerance span (offset units such as °C/°F make span conversion wrong). The comparison operator per bound (inclusive/exclusive) is part of the versioned rule, not a code literal, because "exactly on the boundary" must evaluate deterministically (doc 19 §6). Rules must also address significant digits, temperature/reference conditions, categorical criteria, geometric tolerances, and uncertainty where required. Avoid rounding before comparison; round only for display according to rule.

Unit mismatch or unknown conversion produces “cannot evaluate,” never pass/fail by guess.

## 15. Money, tax rounding, and allocation

- Compute in fixed precision at the legally/configurably required level.
- Store line tax results and rounding adjustments.
- When an exact total adjustment must be distributed, use deterministic largest-remainder allocation with stable line-ID tie-break:

```text
raw shares -> floor/round toward policy -> remaining minor units
-> give one unit to largest fractional remainders in stable order
```

This preserves sum equality and reproducibility. Tax applicability itself remains a reviewed policy/provider result, not a hard-coded algorithm from this analysis.

## 16. Payment allocation and ledger checks

Payment allocation across invoices is explicit and deterministic (customer instruction, oldest-due, or finance-reviewed policy). Use row locks/version checks to prevent over-allocation. A journal validation groups lines by currency and requires:

```text
sum(debits_minor) == sum(credits_minor)
```

Refund/reversal creates compensating entries; it never deletes the original journal.

## 17. Supplier score recomputation

On closure/quality events, append raw facts to an analytics projection and generate versioned score snapshots. Use:

- counts and denominators, not only percentages;
- category/process/site segmentation;
- Bayesian shrinkage for sparse history;
- agreed time window/decay;
- exclusions/overrides with reason;
- prevention of duplicate event contribution through event ID.

Scores assist shortlisting; they do not override mandatory capability or permit automatic exclusion without governance.

## 18. Algorithm verification

Each algorithm needs:

- golden examples with hand-calculated output;
- property tests for conservation (money/quantity), monotonicity, determinism, and bounds;
- adversarial cases for missing data, extreme decimals, Unicode, unit confusion, duplicate/out-of-order events, and concurrency;
- configuration/model version captured in every decision;
- shadow evaluation before changing production rankings/policies;
- human-readable explanation for operations.

Safety rule: matching, scoring, forecasting, OCR, and extraction can recommend or flag. Only authorized humans/domain commands award suppliers, approve prices, freeze baselines, accept deviations, release quality, or move money.
