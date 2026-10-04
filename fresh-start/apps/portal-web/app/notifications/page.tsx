'use client';

import { useEffect, useState } from 'react';
import type { PortalSummary, SupplierSummary } from '@jobwork/contracts';
import {
  ActionNeededCard,
  ButtonLink,
  Card,
  EmptyState,
  LoadingState,
  Page,
  Stack,
} from '@jobwork/ui';
import { api } from '../../lib/api';

/**
 * The bell's destination (prototype tile 4). Until IN-10's notification centre, this is
 * the action queue rendered as cards: every count on the home screen becomes one card
 * here with its owner and the one thing to do. It never invents an item — a card exists
 * only where the summary has a count.
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
  const [supplier, setSupplier] = useState(false);

  useEffect(() => {
    api<{ organizationType: string | null }>('/auth/me')
      .then(async (me) => {
        if (me.organizationType === 'supplier') {
          setSupplier(true);
          const s = await api<SupplierSummary>('/suppliers/me/summary');
          setItems(
            s.queues
              .filter((q) => q.count > 0)
              .map((q) => ({
                key: q.key,
                label: q.label,
                detail: q.detail,
                count: q.count,
                href: '/supplier/compliance',
              })),
          );
          return;
        }
        const s = await api<PortalSummary>('/portal/summary');
        setItems(
          s.queues
            // "With JobWork" is progress, not a to-do; it lives on the home screen.
            .filter((q) => q.count > 0 && q.key !== 'enquiries_in_progress' && q.key !== 'orders_in_progress')
            .map((q) => ({
              key: q.key,
              label: q.label,
              detail: q.detail,
              count: q.count,
              href: q.href,
              since: q.oldestWaitingSince,
            })),
        );
      })
      .catch(() => setItems([]));
  }, []);

  return (
    <Page
      title="Notifications"
      back={{ href: supplier ? '/supplier' : '/', label: 'Back to home' }}
      description="What is waiting on you. Each item opens where the action is."
    >
      <Stack gap={3}>
        {items === null ? (
          <Card>
            <LoadingState label="Checking what is waiting" />
          </Card>
        ) : items.length === 0 ? (
          <Card>
            <EmptyState
              title="Nothing waiting on you"
              detail="When JobWork needs an answer, a decision or a payment from you, it appears here and on the home screen."
            />
          </Card>
        ) : (
          items.map((item) => (
            <ActionNeededCard
              key={item.key}
              title={`${item.label} (${item.count})`}
              detail={item.detail}
              {...(item.since
                ? {
                    due: `waiting since ${new Date(item.since).toLocaleDateString('en-IN', {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                      timeZone: 'Asia/Kolkata',
                    })} IST`,
                  }
                : {})}
              action={
                <ButtonLink href={item.href} size="sm">Open</ButtonLink>
              }
            />
          ))
        )}
      </Stack>
    </Page>
  );
}
