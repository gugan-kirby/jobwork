'use client';

import { useCallback, useEffect, useState } from 'react';
import type {
  CheckMessageResponse,
  ConversationContextType,
  ConversationView,
  PostMessageRequest,
  PostMessageResponse,
} from '@jobwork/contracts';
import { Card, Composer, ErrorState, LoadingState, Stack, Thread } from '@jobwork/ui';
import { api, ApiError } from '../lib/api';

/**
 * The conversation about one record (F-10.2, doc 14 §11). The thread is the record of
 * what was said (`D-18`); email only tells someone there is something to read here.
 */
export function ThreadPanel({
  contextType,
  contextId,
  title = 'Messages with JobWork',
  description,
}: {
  contextType: ConversationContextType;
  contextId: string;
  title?: string;
  description?: string;
}): React.JSX.Element {
  const [view, setView] = useState<ConversationView | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
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

  return (
    <Card title={title} description={description}>
      {error ? (
        <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} correlationId={error.problem.correlationId} />
      ) : view === null ? (
        <LoadingState label="Loading the conversation" />
      ) : (
        <Stack gap={4}>
          <Thread view={view} />
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
