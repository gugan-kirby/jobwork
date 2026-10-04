'use client';

import Link from 'next/link';
import { ButtonLink, Hero, Icon } from '@jobwork/ui';

/**
 * The splash (prototype tile 1). One message, one action. The copy says what JobWork
 * is — a managed way to get custom parts made — and nothing it cannot yet stand behind
 * (`D-10`).
 */
export default function WelcomePage() {
  return (
    <Hero
      variant="splash"
      illustration={
        <span
          style={{
            width: 'var(--space-10)',
            height: 'var(--space-10)',
            borderRadius: '50%',
            background: 'var(--brand-hero-fg)',
            color: 'var(--color-action)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name="wrench" size={2.6} />
        </span>
      }
      headline={<span style={{ font: 'inherit' }}>JobWork</span>}
      subline="Custom parts, made to your drawing. One accountable counterpart from enquiry to delivery."
      actions={
        <div style={{ display: 'grid', gap: 'var(--space-3)', width: '100%', maxWidth: 360 }}>
          <ButtonLink
            href="/start"
            fullWidth
            variant="secondary"
            style={{ background: 'var(--brand-hero-fg)', color: 'var(--color-action)' }}
          >
            Get started
          </ButtonLink>
          <Link
            href="/login"
            style={{ color: 'var(--brand-hero-fg)', font: 'var(--text-body-strong)', textAlign: 'center' }}
          >
            Login / Register
          </Link>
        </div>
      }
    />
  );
}
