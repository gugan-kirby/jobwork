'use client';

import { useCallback, useEffect, useState } from 'react';
import type { NotificationFeed, NotificationItem } from '@jobwork/contracts';
import { Card, CommandButton, ErrorState, LoadingState, NotificationList, Page, Stack } from '@jobwork/ui';
import { api, ApiError } from '../../lib/api';

/**
 * JobWork staff's notification feed (F-10.3). Queues with live counts are on the home
 * screen; this is what happened, newest first, each item opening its record.
 */
export default function NotificationsPage(): React.JSX.Element {
  const [feed, setFeed] = useState<NotificationFeed | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const report = useCallback((err: unknown) => {
    if (!(err instanceof ApiError)) throw err;
    setError(err);
  }, []);

  useEffect(() => {
    api<NotificationFeed>('/notifications').then(setFeed).catch(report);
  }, [report]);

  function open(notification: NotificationItem): void {
    if (notification.readAt) return;
    void api<NotificationFeed>(`/notifications/${notification.notificationId}/read`, { method: 'POST' }).then(setFeed, report);
  }

  async function readAll(): Promise<void> {
    setFeed(await api<NotificationFeed>('/notifications/read-all', { method: 'POST' }));
  }

  return (
    <Page title="Notifications" description="What has happened on the records you work, newest first." width="narrow">
      <Stack gap={4}>
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} correlationId={error.problem.correlationId} /> : null}
        <Card
          title="Updates"
          description={feed && feed.unread > 0 ? `${feed.unread} unread` : undefined}
          actions={
            feed && feed.unread > 0 ? (
              <CommandButton variant="secondary" size="sm" receiptLabel="All read" onCommand={readAll}>
                Mark all as read
              </CommandButton>
            ) : undefined
          }
        >
          {feed === null ? (error ? null : <LoadingState label="Loading updates" />) : <NotificationList notifications={feed.notifications} onOpen={open} />}
        </Card>
      </Stack>
    </Page>
  );
}
