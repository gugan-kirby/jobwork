'use client';

import type { NotificationItem } from '@jobwork/contracts';
import { EmptyState } from '../data/States';
import { UiLink } from '../primitives/Link';

export interface NotificationListProps {
  notifications: ReadonlyArray<NotificationItem>;
  /** Called as the reader opens one; the link itself navigates. */
  onOpen?: ((notification: NotificationItem) => void) | undefined;
}

function when(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * The notification feed (F-10.3, doc 14 §11). Each entry names the record and links to
 * it; the detail lives behind sign-in, never in the notification. Unread is said in words
 * as well as marked, so it is not colour alone (`DS-07`).
 */
export function NotificationList({ notifications, onOpen }: NotificationListProps): React.JSX.Element {
  if (notifications.length === 0) {
    return <EmptyState title="No updates yet" detail="When something changes on your enquiries, quotations or orders, it is listed here." />;
  }
  return (
    <ol className="jw-notifications">
      {notifications.map((n) => (
        <li key={n.notificationId}>
          <UiLink
            href={n.link}
            className={n.readAt ? 'jw-notification' : 'jw-notification jw-notification-unread'}
            onClick={() => onOpen?.(n)}
          >
            {/* Text separators keep the link's accessible name readable as three phrases. */}
            <span className="jw-notification-title">
              {n.readAt ? null : <><span className="jw-visually-hidden">Unread:</span>{' '}</>}
              {n.title}
            </span>{' '}
            <span className="jw-notification-body">{n.body}</span>{' '}
            <time className="jw-notification-time" dateTime={n.createdAt}>
              {when(n.createdAt)}
            </time>
          </UiLink>
        </li>
      ))}
    </ol>
  );
}
