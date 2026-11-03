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
 * Profile (prototype tile 16, doc 14 §15 "expand to organization, security, verification,
 * sessions"). The header answers who you are and for whom; the list is every account
 * surface in one place; logout is the one destructive row and sits apart.
 */

const ROLE_LABELS: Record<string, string> = {
  org_admin: 'Organization administrator',
  customer_requester: 'Requester',
  customer_approver: 'Approver',
  supplier_estimator: 'Estimator',
  supplier_production: 'Production',
  supplier_quality: 'Quality',
};

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
  const organization = me.memberships.find((m) => m.organizationId === me.organizationId);
  const roleLine = me.roles.map((r) => ROLE_LABELS[r] ?? r.replace(/_/g, ' ')).join(' · ');

  const rows: MenuRow[] = supplier
    ? [
        { href: '/supplier/company', icon: 'factory', label: 'Company Profile', detail: 'Your company, sites and contacts', tint: 'blue' },
        { href: '/supplier/compliance', icon: 'shield', label: 'Compliance & Evidence', detail: 'Registrations and certificates', tint: 'violet' },
        { href: '/capabilities', icon: 'capabilities', label: 'Capabilities & Machines', detail: 'What you make and with what', tint: 'green' },
        { href: '/documents', icon: 'document', label: 'My Documents', detail: 'Files you have shared', tint: 'sky' },
        { href: '/supplier/team', icon: 'team', label: 'Team', detail: 'People in your company', tint: 'neutral' },
        { href: '/notifications', icon: 'bell', label: 'Notifications', detail: 'Your alerts and updates', tint: 'orange' },
        { href: '/account/security', icon: 'shieldCheck', label: 'Privacy & Security', detail: 'Password, two-factor, sessions', tint: 'violet' },
        { href: '/help', icon: 'help', label: 'Help & Support', detail: 'Get help or raise a request', tint: 'blue' },
      ]
    : [
        { href: '/account/addresses', icon: 'location', label: 'My Addresses', detail: 'Where your parts are delivered', tint: 'blue' },
        { href: '/documents', icon: 'document', label: 'My Documents', detail: 'Drawings and files you have shared', tint: 'sky' },
        { href: '/team', icon: 'team', label: 'Team', detail: 'People in your organization', tint: 'green' },
        { href: '/notifications', icon: 'bell', label: 'Notifications', detail: 'Your alerts and updates', tint: 'orange' },
        { href: '/account/security', icon: 'shieldCheck', label: 'Privacy & Security', detail: 'Password, two-factor, sessions', tint: 'violet' },
        { href: '/help', icon: 'help', label: 'Help & Support', detail: 'Get help or raise a request', tint: 'blue' },
      ];

  const about: Array<{ href: string; icon: IconName; label: string }> = [
    { href: '/about', icon: 'info', label: 'About JobWork' },
    { href: '/terms', icon: 'document', label: 'Terms & Conditions' },
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
              <span className="jw-count-badge">{supplier ? 'Supplier' : 'Customer'}</span>
            </span>
            <span className="jw-counterpart-line">
              {organization?.organizationName ?? 'No organization selected'}
              {roleLine ? ` · ${roleLine}` : ''}
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

        <nav aria-label="About" className="jw-menu">
          {about.map((row) => (
            <Link key={row.href} href={row.href} className="jw-menu-row">
              <span className="jw-menu-icon">
                <Icon name={row.icon} size={1.3} />
              </span>
              <span className="jw-menu-label">{row.label}</span>
              <span className="jw-menu-chevron">
                <Icon name="chevron" />
              </span>
            </Link>
          ))}
        </nav>

        <button type="button" className="jw-logout" onClick={() => void logout()} disabled={busy}>
          <Icon name="logout" size={1.3} />
          Log Out
        </button>
      </Stack>
    </Page>
  );
}
