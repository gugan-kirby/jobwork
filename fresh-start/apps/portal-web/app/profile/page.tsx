'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { MeResponse } from '@jobwork/contracts';
import {
  Card,
  ErrorState,
  Icon,
  LoadingState,
  Page,
  Stack,
  type IconName,
} from '@jobwork/ui';
import { purgeOfflineCaches } from '@jobwork/web-kit';
import { api, ApiError } from '../../lib/api';

/**
 * Profile (VF-16, VF-18, reference screen 16): the reference's rows, word for word. Payment
 * Methods opens the payments page: JobWork stores no cards or mandates (`F-08.4`), each
 * invoice is paid through the gateway. Initials stand in for the photo, since no image is
 * stored. Addresses, documents, team, about and terms are in the header menu.
 */

const APP_VERSION = '1.0.0';

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('');
}

interface MenuRow {
  href: string;
  icon: IconName;
  label: string;
  detail: string;
  tint: 'blue' | 'violet' | 'green' | 'orange' | 'sky' | 'neutral';
}

export default function ProfilePage() {
  const router = useRouter();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<MeResponse>('/auth/me')
      .then(setMe)
      .catch((err) => {
        if (err instanceof ApiError) setError(err);
      });
  }, []);

  async function logout(): Promise<void> {
    setBusy(true);
    try {
      await api('/auth/logout', { method: 'POST', body: {} });
    } finally {
      // BR-AUTH-05: nothing of this session stays on a shared phone.
      await purgeOfflineCaches().catch(() => undefined);
      router.push('/welcome');
    }
  }

  if (!me) {
    return (
      <Page title="Profile" back={{ href: '/', label: 'Back to home' }}>
        {error ? (
          <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} />
        ) : (
          <Card>
            <LoadingState label="Loading your account" />
          </Card>
        )}
      </Page>
    );
  }

  const supplier = me.organizationType === 'supplier';

  const rows: MenuRow[] = [
    {
      href: supplier ? '/supplier/company' : '/team',
      icon: 'capabilities',
      label: 'Company Details',
      detail: 'Update your company information',
      tint: 'blue',
    },
    { href: '/profile/edit', icon: 'profile', label: 'Account Settings', detail: 'Manage your login, email and security', tint: 'violet' },
    {
      href: supplier ? '/supplier/bills' : '/payments',
      icon: 'payment',
      label: 'Payment Methods',
      detail: 'Add or manage payment options',
      tint: 'green',
    },
    { href: '/notifications', icon: 'bell', label: 'Notifications', detail: 'Control your alerts and updates', tint: 'orange' },
    { href: '/account/security', icon: 'shieldCheck', label: 'Privacy & Security', detail: 'Manage data, password and access', tint: 'violet' },
    { href: '/help', icon: 'help', label: 'Help & Support', detail: 'Get help or raise a request', tint: 'sky' },
  ];

  return (
    <Page title="Profile" description="Manage your account, company and preferences">
      <Stack gap={4}>
        <Link href="/profile/edit" className="jw-tinted-card jw-identity">
          <span className="jw-identity-avatar" aria-hidden="true">
            {initials(me.displayName || me.email)}
            <span className="jw-identity-badge">
              <Icon name="edit" size={0.9} />
            </span>
          </span>
          <span className="jw-identity-main">
            <span className="jw-identity-top">
              <span className="jw-counterpart-name">{me.displayName || me.email}</span>
              <span className="jw-count-badge">{supplier ? 'Vendor' : 'Buyer'}</span>
            </span>
            <span className="jw-summary-fact">
              <Icon name="mail" size={1.15} />
              {me.email}
            </span>
            {me.phone ? (
              <span className="jw-summary-fact">
                <Icon name="phone" size={1.15} />
                {me.phone}
              </span>
            ) : null}
            <span className="jw-visually-hidden">Edit profile</span>
          </span>
          <span className="jw-record-chevron" aria-hidden="true">
            <Icon name="chevron" size={1.4} />
          </span>
        </Link>

        <nav aria-label="Account" className="jw-menu jw-menu-rich">
          {rows.map((row) => (
            <Link key={row.href} href={row.href} className="jw-menu-row">
              <span className={`jw-record-tile jw-record-tile-${row.tint}`} aria-hidden="true">
                <Icon name={row.icon} size={1.4} />
              </span>
              <span className="jw-menu-label">
                <span className="jw-menu-title">{row.label}</span>
                <span className="jw-menu-detail">{row.detail}</span>
              </span>
              <span className="jw-menu-chevron">
                <Icon name="chevron" size={1.3} />
              </span>
            </Link>
          ))}
        </nav>

        <button type="button" className="jw-logout" onClick={() => void logout()} disabled={busy}>
          <Icon name="logout" size={1.3} />
          Log Out
        </button>

        <p className="jw-app-version">App Version {APP_VERSION}</p>
      </Stack>
    </Page>
  );
}
