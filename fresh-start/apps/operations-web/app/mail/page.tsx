'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Mailbox, MailMessage } from '@jobwork/contracts';
import { Button, Callout, Card, ErrorState, LoadingState, Page, Stack } from '@jobwork/ui';
import { api, ApiError } from '../../lib/api';

/**
 * Mail this environment keeps instead of sending (F-CW.5, ADR-0009): sign-up checks,
 * invitations and notifications, newest first. The links in them are credentials, so the
 * API shows them to platform administrators only.
 */

const URL_PATTERN = /(https?:\/\/[^\s]+)/g;

/** The message as written, with its web addresses made into links. */
function MessageText({ text }: { text: string }): React.JSX.Element {
  return (
    <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 }}>
      {text.split(URL_PATTERN).map((part, index) =>
        index % 2 === 1 ? (
          <a key={index} href={part} rel="noreferrer">
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </p>
  );
}

function sentAt(message: MailMessage): string {
  return new Date(message.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

export default function MailPage(): React.JSX.Element {
  const [mailbox, setMailbox] = useState<Mailbox | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setMailbox(await api<Mailbox>('/mailbox'));
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      setError(err);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Page
      title="Mail"
      description="This environment sends no email. Everything it would have sent is kept here, newest first."
      width="wide"
      actions={
        <Button variant="secondary" size="sm" onClick={() => void load()}>
          Refresh
        </Button>
      }
    >
      <Stack gap={4}>
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} correlationId={error.problem.correlationId} /> : null}
        {!mailbox && !error ? <LoadingState label="Reading the mail" /> : null}
        {mailbox && mailbox.messages.length === 0 ? (
          <Callout tone="neutral" title="No mail yet">
            Mail appears here within a minute of the step that sends it, such as a sign-up or an invitation.
          </Callout>
        ) : null}
        {mailbox?.messages.map((message) => (
          <Card key={message.id} title={message.subject} description={`To ${message.to} · ${sentAt(message)}`}>
            <MessageText text={message.text} />
          </Card>
        ))}
      </Stack>
    </Page>
  );
}
