'use client';

import type { ConversationView, ExternalMessage, InternalMessage } from '@jobwork/contracts';
import { Button } from '../primitives/Button';
import { EmptyState } from '../data/States';
import { StatusChip } from '../status/StatusChip';
import { AudienceChip } from './AudienceBanner';

function when(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

function ExternalItem({ message }: { message: ExternalMessage }): React.JSX.Element {
  return (
    <li className={message.mine ? 'jw-message jw-message-mine' : 'jw-message'}>
      <p className="jw-message-meta">
        <strong>{message.mine ? 'You' : message.authorLabel}</strong> · {when(message.postedAt)}
        {message.status === 'held' ? (
          <>
            {' '}
            <StatusChip tone="attention">Waiting for JobWork</StatusChip>
          </>
        ) : null}
      </p>
      <p className="jw-message-body">{message.body}</p>
    </li>
  );
}

const STATUS_LABEL: Record<InternalMessage['status'], string | null> = {
  visible: null,
  held: 'Held for review',
  rejected: 'Rejected',
  superseded: 'Replaced by an edited copy',
};

function InternalItem({ message, onShare }: { message: InternalMessage; onShare?: ((m: InternalMessage) => void) | undefined }): React.JSX.Element {
  const status = STATUS_LABEL[message.status];
  return (
    <li className={message.audience === 'internal' ? 'jw-message jw-message-internal' : 'jw-message'}>
      <p className="jw-message-meta">
        <strong>{message.authorName}</strong>
        {message.authorParty === 'internal' ? '' : ` (${message.authorOrganizationName})`} · {when(message.postedAt)}{' '}
        <AudienceChip audience={message.audience} detail={message.audience === 'supplier' ? message.counterpartName : null} />
        {status ? (
          <>
            {' '}
            <StatusChip tone={message.status === 'held' ? 'attention' : message.status === 'rejected' ? 'blocked' : 'neutral'}>{status}</StatusChip>
          </>
        ) : null}
        {message.review?.status === 'noted' ? (
          <>
            {' '}
            <StatusChip tone="neutral">Flagged, sent</StatusChip>
          </>
        ) : null}
      </p>
      {message.derivation ? (
        <p className="jw-message-lineage">
          {message.derivation === 'redacted' ? 'Edited copy of a held message.' : 'Published to every invited supplier from a supplier’s question.'}
        </p>
      ) : null}
      <p className="jw-message-body">{message.body}</p>
      {message.shareable && onShare ? (
        <Button variant="ghost" size="sm" onClick={() => onShare(message)}>
          Answer for every supplier…
        </Button>
      ) : null}
    </li>
  );
}

export interface ThreadProps {
  view: ConversationView;
  /** JobWork only: republish a supplier's RFQ question to every invited supplier. */
  onShare?: ((message: InternalMessage) => void) | undefined;
}

/**
 * The conversation itself (doc 14 §11). JobWork sees every message with its audience
 * labelled; a customer or supplier sees only what was written to them, with JobWork staff
 * shown as "JobWork".
 */
export function Thread({ view, onShare }: ThreadProps): React.JSX.Element {
  if (view.messages.length === 0) {
    return <EmptyState title="No messages yet" detail="Questions and answers about this record stay here, with it." />;
  }
  return (
    <ol className="jw-thread" aria-label={`Conversation about ${view.context.label}`}>
      {view.viewer === 'internal'
        ? view.messages.map((m) => <InternalItem key={m.messageId} message={m} onShare={onShare} />)
        : view.messages.map((m) => <ExternalItem key={m.messageId} message={m} />)}
    </ol>
  );
}
