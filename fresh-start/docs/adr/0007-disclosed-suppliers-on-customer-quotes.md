# ADR-0007: Disclosed suppliers on customer quotes

- Status: Proposed; direction decided by the owner 2026-11-03, the design below awaits owner confirmation
- Date: 2026-11-04
- Amends: [ADR-0002](0002-reseller-two-commercial-legs.md) (its rejected alternative "raw supplier quote shown to customer" stays rejected; supplier identity on a JobWork quote is now allowed)

## Context

The reference screens 09–12 show a customer several named suppliers, with city, rating and a verified badge, and let the customer choose one. The owner chose to build that ("Show suppliers to customers"), reversing the anonymity default of `BR-COM-05` and `D-04`.

Today the customer never chooses. JobWork evaluates bids, awards before quoting, rejects every other live bid, costs the award and quotes the result (`cost_sheet.award_id` is unique, one approved award per RFQ, an offer set holds one quote per standard/fast/premium label). A quote reaches its supplier only through cost sheet → award → award line, and a split award has no single supplier. No rating data exists, a supplier's city is held on a site documented as never customer-facing, and no message audience reaches both a customer and a supplier.

## Decision

1. **JobWork stays the seller.** The two legs of ADR-0002 are unchanged: quotes, orders, invoices, payment and warranty are JobWork's, and the customer pays JobWork. What changes is that a quote names the supplier who will make the part.
2. **The customer sees a JobWork price, never a bid.** Supplier cost, bid amounts, margin and settlement stay hidden (`BR-COM-05` keeps these). Only identity moves: display name, city, verified state and rating.
3. **The customer's choice settles the award.** JobWork marks an award `customer_choice` for each supplier it offers, and each is costed, approved and quoted as usual; the quotes share an offer set and carry `supplier_organization_id` directly. Bids stay live and the round stays in evaluation until acceptance. Accepting a quote selects its bids, rejects the other bids and offers, withdraws sibling quotes and awards the round; only the chosen supplier gets a purchase order. An ordinary award is unchanged. A split award cannot be a customer choice.
4. **Ratings are earned, never seeded.** A new customer rating, one per delivered order, feeds an average and a count. A supplier with none reads "New". No figure is invented or imported.
5. **Disclosure belongs in the supplier's terms.** Admission terms must say a supplier is named to customers; that wording is a legal item, not a switch in the product.
6. **Customer identity stays masked from suppliers** (`BR-COM-06`, `D-05` unchanged). Quote and order threads gain a shared audience in which the customer appears as "Customer", the supplier by name, JobWork can read, and the leakage gate keeps stripping contact details.
7. **Supplier revenue is its own money.** The supplier home's Total Revenue is the taxable value of its own paid bills this month, from `finance.supplier_bill` and `finance.settlement`.
8. **No wallet.** Reference screen 14 shows Total Paid and Pending Payment, already built; nothing stores customer money.

## Build order

| Phase | Scope |
|---|---|
| P1 | Migration: `customer_quote.supplier_organization_id`, `supplier.rating`; offer set unique on supplier + option; several cost sheets per RFQ |
| P2 | Quote several bids; award on acceptance; split awards refused for disclosed quotes |
| P3 | Customer projections and screens 09–12 with supplier name, city, verified state |
| P4 | Ratings: capture after delivery, aggregate, show on 09–10 |
| P5 | Shared threads for "Chat" and "Contact Vendor" |
| P6 | Supplier home: enquiries, quotes, orders, revenue as reference 15 |

Each phase updates `BR-COM-05`, `D-04`, `FR-203`, `FR-406`, doc 03, doc 11 §9 and doc 14 as it lands, and narrows the shield tests to cost, bid and margin rather than deleting them. Security review repeats for the changed surfaces.

## Consequences

- A customer can go to a named supplier directly after one job, which puts the reseller margin at risk; contract terms must address this before launch.
- Non-solicitation, consent and data-sharing wording need legal review.
- Customer documents, emails and PDFs must be reviewed one by one, since each was written to carry no supplier.
- Direct-ship, labels and dispatch screens still assume anonymity and need the same review.
- Quote preparation costs more: one cost sheet per quoted bid, and bids must stay valid until the customer decides.

## Rejected alternatives

- Showing bid prices with commission added: exposes cost and margin, and was rejected in ADR-0002.
- Removing JobWork from the leg: changes tax, warranty and liability, and nobody asked for it.
- Seeding demo ratings: fabricated records shown to a buyer.
