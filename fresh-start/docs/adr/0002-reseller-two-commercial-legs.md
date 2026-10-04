# ADR-0002: Reseller with two commercial legs

- Status: Proposed; business intent confirmed by source, legal/tax details pending
- Date: 2026-09-01

## Context

The core business rule is that customer and supplier do not directly exchange raw quotations, payments, contacts or delivery information. JobWork buys from supplier and resells to customer.

## Decision

Model buy side and sell side separately:

- supplier RFQ/bid/award/PO/bill/settlement;
- internal landed-cost and margin versions;
- JobWork customer quote/acceptance/sales order/invoice/payment/warranty.

Link them through lineage and work allocation without reusing one record for both. Default physical route has supplier-to-JobWork and JobWork-to-customer shipment legs.

## Consequences

- Protects supplier network and margin and reconstructs disputes.
- Supports different payment milestones, taxes, terms and responsibilities.
- Adds finance, logistics, warranty and working-capital complexity JobWork must operationally own.
- Legal entity, GST/invoice, title/risk, direct-ship and warranty details must be approved before launch.

## Rejected alternatives

- Raw supplier quote shown to customer with commission added: conflicts with reseller privacy/control.
- One order/invoice/payment record for both parties: ambiguous and unsafe accounting/authorization.
