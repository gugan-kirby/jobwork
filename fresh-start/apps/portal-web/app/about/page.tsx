'use client';

import { Card, Page, Stack } from '@jobwork/ui';

/** About JobWork (prototype tile 16). Static copy; versioned text arrives with legal review. */
export default function StaticPage() {
  return (
    <Page title="About JobWork" back={{ href: '/profile', label: 'Back to profile' }} width="narrow">
      <Stack gap={4}>
        <Card>
          <Stack gap={3}>
            <p>JobWork is a managed custom-manufacturing service for India, starting in Chennai. You ask for a part; we take responsibility for getting it made — sourcing the right workshop, checking the engineering, inspecting the result and delivering it.</p>
            <p>You deal with one counterpart. JobWork quotes you, JobWork invoices you, and JobWork answers for quality and delivery. The workshops that do the machining, fabrication or casting are our suppliers, chosen and managed by us.</p>
            <p>Three kinds of work are supported: <strong>job work</strong> on material you own, <strong>new models</strong> made from your drawings with material we source, and <strong>corrections</strong> — engineering changes to a part already made.</p>
          </Stack>
        </Card>
      </Stack>
    </Page>
  );
}
