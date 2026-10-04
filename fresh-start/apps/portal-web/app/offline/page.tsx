import { Callout, Page } from '@jobwork/ui';

/**
 * What an installed portal shows when there is no connection (F-11.6). The service
 * worker keeps this page and nothing a person's session produced, so it says plainly
 * what works and what does not — and that nothing waits to be sent later.
 */
export default function OfflinePage(): React.JSX.Element {
  return (
    <Page title="You are offline" description="JobWork needs a connection to show your enquiries, quotations and orders.">
      <Callout tone="neutral" title="Nothing was sent">
        Payments, approvals and anything else you were doing are never kept to send later. When you are connected
        again, open the page and do it once more — it will not be applied twice.
      </Callout>
    </Page>
  );
}
