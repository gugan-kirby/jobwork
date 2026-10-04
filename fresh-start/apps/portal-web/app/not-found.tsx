import { ButtonLink, Card, Page } from '@jobwork/ui';

/** F-FE.5: an address that matches no page says so inside the shell, with a way home. */
export default function NotFound(): React.JSX.Element {
  return (
    <Page title="That page does not exist" width="narrow">
      <Card>
        <p>The link may be out of date, or the address mistyped.</p>
        <div style={{ marginTop: 'var(--space-3)' }}>
          <ButtonLink href="/">Go to home</ButtonLink>
        </div>
      </Card>
    </Page>
  );
}
