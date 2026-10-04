'use client';

import { Callout, Card, Page, Stack } from '@jobwork/ui';

/** Terms & conditions (prototype tile 16). Static copy; versioned text arrives with legal review. */
export default function StaticPage() {
  return (
    <Page title="Terms & conditions" back={{ href: '/profile', label: 'Back to profile' }} width="narrow">
      <Stack gap={4}>
        <Callout tone="attention" title="Draft terms">
          These terms are a working draft pending legal review (decision T-02 in the product record). Nothing here is a contract until the reviewed version replaces it and is accepted inside a quotation.
        </Callout>
        <Card>
          <Stack gap={3}>
            <p><strong>Parties.</strong> JobWork sells manufactured goods to you as principal. Your contract is with JobWork; suppliers engaged by JobWork are not party to it.</p>
            <p><strong>Quotations.</strong> A quotation is valid until its stated date and binds JobWork only when you accept that exact version. Accepting creates an order on the terms the quotation names.</p>
            <p><strong>Payment.</strong> You pay JobWork against its invoices on the schedule the quotation states. No payment is ever due to a supplier directly.</p>
            <p><strong>Your material and drawings.</strong> Material you supply for job work remains yours throughout. Drawings and models you upload stay confidential and are shared only as far as needed to make your part.</p>
            <p><strong>Quality and delivery.</strong> JobWork inspects before dispatch and is answerable for conformance to the released drawing revision. Report shortages or defects within the window stated on the delivery note.</p>
          </Stack>
        </Card>
      </Stack>
    </Page>
  );
}
