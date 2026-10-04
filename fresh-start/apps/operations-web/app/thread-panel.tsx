'use client';

import { useCallback, useEffect, useState } from 'react';
import type {
  CheckMessageResponse,
  ConversationContextType,
  ConversationView,
  InternalMessage,
  PostMessageRequest,
  PostMessageResponse,
} from '@jobwork/contracts';
import {
  Button,
  Callout,
  Card,
  CommandButton,
  Composer,
  ErrorState,
  LoadingState,
  Stack,
  TextArea,
  Thread,
} from '@jobwork/ui';
import { api, ApiError } from '../lib/api';

/**
 * JobWork's side of a conversation (F-10.2): every audience labelled, the composer with
 * its internal-note mode, and — on an RFQ — a supplier's question republished in
 * JobWork's own words to every invited supplier, the asker never named (doc 14 §11).
 */
export function ThreadPanel({
  contextType,
  contextId,
  title = 'Conversation',
  description,
}: {
  contextType: ConversationContextType;
  contextId: string;
  title?: string;
  description?: string;
}): React.JSX.Element {
  const [view, setView] = useState<ConversationView | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [sharing, setSharing] = useState<InternalMessage | null>(null);
  const [shareText, setShareText] = useState('');
  const [shareResult, setShareResult] = useState<PostMessageResponse | null>(null);
  const base = `/conversations/${contextType}/${contextId}`;

  const load = useCallback(async () => {
    try {
      setView(await api<ConversationView>(base));
      setError(null);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      setError(err);
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  async function share(): Promise<void> {
    if (!sharing) return;
    const result = await api<PostMessageResponse>(`/messages/${sharing.messageId}/share`, {
      method: 'POST',
      body: { body: shareText.trim() },
      idempotencyKey: crypto.randomUUID(),
    });
    setShareResult(result);
    setSharing(null);
    setShareText('');
    await load();
  }

  return (
    <Card title={title} description={description}>
      {error ? (
        <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} correlationId={error.problem.correlationId} />
      ) : view === null ? (
        <LoadingState label="Loading the conversation" />
      ) : (
        <Stack gap={4}>
          <Thread
            view={view}
            onShare={(message) => {
              setSharing(message);
              // Empty on purpose: the supplier's own wording can identify it (doc 14 §11).
              setShareText('');
              setShareResult(null);
            }}
          />
          {sharing ? (
            <Card title="Answer for every invited supplier" description="Write the question and its answer in JobWork's words. The supplier who asked is not named, and its wording is not reused.">
              <Stack gap={3}>
                <blockquote className="jw-share-source">
                  <span>The supplier asked:</span> {sharing.body}
                </blockquote>
                <TextArea
                  label="Published text"
                  hint="Every invited supplier reads this."
                  value={shareText}
                  rows={4}
                  onChange={(event) => setShareText(event.target.value)}
                />
                <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                  <CommandButton receiptLabel="Published" disabled={shareText.trim().length === 0} disabledReason="Write the question" onCommand={share}>
                    Publish to every invited supplier
                  </CommandButton>
                  <Button variant="ghost" onClick={() => setSharing(null)}>
                    Cancel
                  </Button>
                </div>
              </Stack>
            </Card>
          ) : null}
          {shareResult?.status === 'held' ? (
            <Callout tone="attention" title="Held for review">
              The published text may name a party or carry contact details ({shareResult.findings.map((f) => f.label.toLowerCase()).join(', ')}). No supplier sees it until a reviewer decides.
            </Callout>
          ) : null}
          <Composer
            options={view.canPost}
            onCheck={(request: PostMessageRequest) => api<CheckMessageResponse>(`${base}/messages/check`, { method: 'POST', body: request })}
            onPost={(request: PostMessageRequest) =>
              api<PostMessageResponse>(`${base}/messages`, { method: 'POST', body: request, idempotencyKey: crypto.randomUUID() })
            }
            onPosted={() => void load()}
          />
        </Stack>
      )}
    </Card>
  );
}
