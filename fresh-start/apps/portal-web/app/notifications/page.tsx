'use client';

import { useCallback, useEffect, useState } from 'react';
import type { NotificationFeed, NotificationItem, PortalSummary, SupplierSummary } from '@jobwork/contracts';
import {
  ActionNeededCard,
  ButtonLink,
  Card,
  CommandButton,
  EmptyState,
  ErrorState,
  LoadingState,
  NotificationList,
  Page,
  Stack,
} from '@jobwork/ui';
import { api, ApiError } from '../../lib/api';

/**
 * The bell's destination (prototype tile 4, F-10.3). Two different things live here:
 * what is waiting on you (queues you can act on, counted live — a card exists only where
 * the summary has a count) and what has happened (the notification feed, with read
 * state). Each item opens the authenticated page it is about; the detail is never in the
 * notification itself (doc 14 §11).
 */

interface Item {
  key: string;
  label: string;
  detail: string;
  count: number;
  href: string;
  since?: string | null | undefined;
}

export default function NotificationsPage() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [feed, setFeed] = useState<NotificationFeed | null>(null);
  const [supplier, setSupplier] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const report = useCallback((err: unknown) => {
    if (!(err instanceof ApiError)) throw err;
    setError(err);
  }, []);

  useEffect(() => {
    api<{ organizationType: string | null }>('/auth/me')
      .then(async (me) => {
        if (me.organizationType === 'supplier') {
          setSupplier(true);
          const s = await api<SupplierSummary>('/suppliers/me/summary');
          setItems(
            s.queues
              .filter((q) => q.count > 0)
              .map((q) => ({ key: q.key, label: q.label, detail: q.detail, count: q.count, href: '/supplier/compliance' })),
          );
          return;
        }
        const s = await api<PortalSummary>('/portal/summary');
        setItems(
          s.queues
            // "With JobWork" is progress, not a to-do; it lives on the home screen.
            .filter((q) => q.count > 0 && q.key !== 'enquiries_in_progress' && q.key !== 'orders_in_progress')
            .map((q) => ({ key: q.key, label: q.label, detail: q.detail, count: q.count, href: q.href, since: q.oldestWaitingSince })),
        );
      })
      .catch(report);
    api<NotificationFeed>('/notifications').then(setFeed).catch(report);
  }, [report]);

  function open(notification: NotificationItem): void {
    if (notification.readAt) return;
    // The link navigates either way; marking read is bookkeeping that must not block it.
    void api<NotificationFeed>(`/notifications/${notification.notificationId}/read`, { method: 'POST' }).then(setFeed, report);
  }

  async function readAll(): Promise<void> {
    setFeed(await api<NotificationFeed>('/notifications/read-all', { method: 'POST' }));
  }

  return (
    <Page
      title="Notifications"
      back={{ href: supplier ? '/supplier' : '/', label: 'Back to home' }}
      description="What is waiting on you, and what has changed. Each item opens where it happened."
    >
      <Stack gap={4}>
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} correlationId={error.problem.correlationId} /> : null}

        <Card title="Needs you" description="Answers, decisions and payments only you can give.">
          {items === null ? (
            error ? null : <LoadingState label="Checking what is waiting" />
          ) : items.length === 0 ? (
            <EmptyState title="Nothing waiting on you" detail="When JobWork needs an answer, a decision or a payment from you, it appears here and on the home screen." />
          ) : (
            <Stack gap={3}>
              {items.map((item) => (
                <ActionNeededCard
                  key={item.key}
                  title={`${item.label} (${item.count})`}
                  // "Waiting since" is age, not a deadline, so it is not the card's `due`.
                  detail={
                    item.since
                      ? `${item.detail} Oldest waiting since ${new Date(item.since).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })}.`
                      : item.detail
                  }
                  action={<ButtonLink href={item.href} size="sm">Open</ButtonLink>}
                />
              ))}
            </Stack>
          )}
        </Card>

        <Card
          title="Updates"
          description={feed && feed.unread > 0 ? `${feed.unread} unread` : 'Everything you have been told about, newest first.'}
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
