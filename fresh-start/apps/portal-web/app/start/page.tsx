'use client';

import Link from 'next/link';
import { ButtonLink, Icon } from '@jobwork/ui';
import { AssuranceStrip, PublicFrame } from '../public-frame';

/**
 * The welcome fork (prototype tile 2): sign in, register, or look around as a guest.
 * Guest browsing is category education only (`D-17`) and the link says where it goes.
 */
export default function StartPage() {
  return (
    <PublicFrame
      eyebrow="Welcome to"
      title="JobWork"
      lede="One place for all your job work needs — enquiry, quotation, production and delivery."
      footer={<AssuranceStrip />}
    >
      <div
        aria-hidden="true"
        style={{
          display: 'flex',
          justifyContent: 'center',
          gap: 'var(--space-4)',
          color: 'var(--color-action)',
          padding: 'var(--space-4) 0',
        }}
      >
        <Icon name="factory" size={3} />
        <Icon name="settings" size={3} />
        <Icon name="truck" size={3} />
      </div>

      <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
        <ButtonLink href="/login" fullWidth>Login</ButtonLink>
        <ButtonLink href="/register" fullWidth variant="secondary">Register</ButtonLink>
        <Link href="/explore" style={{ textAlign: 'center', font: 'var(--text-body-strong)' }}>
          Continue as guest
        </Link>
        <p style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)', textAlign: 'center' }}>
          As a guest you can see what we make. Raising an enquiry needs an account.
        </p>
      </div>
    </PublicFrame>
  );
}
