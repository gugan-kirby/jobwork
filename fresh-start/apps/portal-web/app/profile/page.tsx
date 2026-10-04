'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { MeResponse } from '@jobwork/contracts';
import {
  ButtonLink,
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
  detail?: string;
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
        { href: '/supplier/company', icon: 'factory', label: 'Company profile' },
        { href: '/supplier/compliance', icon: 'shield', label: 'Compliance & evidence' },
        { href: '/capabilities', icon: 'capabilities', label: 'Capabilities & machines' },
        { href: '/documents', icon: 'document', label: 'My documents' },
        { href: '/supplier/team', icon: 'team', label: 'Team' },
        { href: '/notifications', icon: 'bell', label: 'Notifications' },
        { href: '/account/security', icon: 'settings', label: 'Security', detail: 'Password, two-factor, sessions' },
      ]
    : [
        { href: '/account/addresses', icon: 'location', label: 'My addresses' },
        { href: '/documents', icon: 'document', label: 'My documents' },
        { href: '/team', icon: 'team', label: 'Team' },
        { href: '/notifications', icon: 'bell', label: 'Notifications' },
        { href: '/account/security', icon: 'settings', label: 'Security', detail: 'Password, two-factor, sessions' },
      ];

  const about: MenuRow[] = [
    { href: '/help', icon: 'help', label: 'Help & support' },
    { href: '/about', icon: 'info', label: 'About JobWork' },
    { href: '/terms', icon: 'document', label: 'Terms & conditions' },
  ];

  return (
    <Page title="Profile" back={{ href: supplier ? '/supplier' : '/', label: 'Back to home' }}>
      <Stack gap={4}>
        <Card>
          <div style={{ display: 'flex', gap: 'var(--space-4)', alignItems: 'center', flexWrap: 'wrap' }}>
            <span
              aria-hidden="true"
              style={{
                width: 'var(--space-9)',
                height: 'var(--space-9)',
                borderRadius: '50%',
                background: 'var(--status-progress-bg)',
                color: 'var(--color-action)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                font: 'var(--text-heading-1)',
              }}
            >
              {initials(me.displayName || me.email)}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ font: 'var(--text-heading-2)' }}>{me.displayName || me.email}</p>
              <p style={{ color: 'var(--color-text-muted)', font: 'var(--text-caption)' }}>
                {organization?.organizationName ?? 'No organization selected'}
                {roleLine ? ` · ${roleLine}` : ''}
              </p>
              <p style={{ color: 'var(--color-text-muted)', font: 'var(--text-caption)' }}>{me.email}</p>
            </div>
            <ButtonLink
              href="/profile/edit"
              variant="secondary"
              size="sm"
              iconStart={<Icon name="edit" size={1} />}
            >
              Edit profile
            </ButtonLink>
          </div>
        </Card>

        <nav aria-label="Account" className="jw-menu">
          {rows.map((row) => (
            <Link key={row.href} href={row.href} className="jw-menu-row">
              <span className="jw-menu-icon">
                <Icon name={row.icon} size={1.3} />
              </span>
              <span className="jw-menu-label">
                {row.label}
                {row.detail ? (
                  <span style={{ display: 'block', font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
                    {row.detail}
                  </span>
                ) : null}
              </span>
              <span className="jw-menu-chevron">
                <Icon name="chevron" />
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

        <div className="jw-menu">
          <button type="button" className="jw-menu-row jw-menu-row-danger" onClick={() => void logout()} disabled={busy}>
            <Icon name="logout" size={1.2} />
            Logout
          </button>
        </div>
      </Stack>
    </Page>
  );
}
