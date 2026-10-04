'use client';

import { Card, Page, Stack } from '@jobwork/ui';

/** Help & support (prototype tile 16). Static copy; versioned text arrives with legal review. */
export default function StaticPage() {
  return (
    <Page title="Help & support" back={{ href: '/profile', label: 'Back to profile' }} width="narrow">
      <Stack gap={4}>
        <Card title="How JobWork works">
          <Stack gap={3}>
            <p><strong>1. Enquiry.</strong> Tell us what you need made: the job type, the part, the quantity, your drawing and when you need it.</p>
            <p><strong>2. Review.</strong> A JobWork engineer checks the requirement and asks structured questions if anything is unclear. What you submitted is never edited silently.</p>
            <p><strong>3. Quotation.</strong> JobWork sources the work and sends you its own quotation — price, tax, delivery and terms — valid until a stated date.</p>
            <p><strong>4. Order.</strong> Accepting the quotation starts the order. You follow released progress here and pay JobWork against its invoices.</p>
            <p><strong>5. Delivery.</strong> Parts are inspected and dispatched to the address you chose. Report a shortage or defect from the order itself.</p>
          </Stack>
        </Card>
        <Card title="Need a person?">
          <p>
            Every enquiry, quotation and order has a reference like <span className="mono">ENQ-2026-0001</span>.
            Quote it when you write to <a href="mailto:support@jobwork.example">support@jobwork.example</a> and we can find it at once.
          </p>
        </Card>
      </Stack>
    </Page>
  );
}
