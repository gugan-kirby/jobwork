'use client';

import Link from 'next/link';
import { BrandGlyph, Hero } from '@jobwork/ui';

/**
 * The splash (VF-01, VF-18, reference screen 01), word for word. Owner decision
 * 2026-11-04: the reference copy stands (`D-10` amended).
 */
export default function WelcomePage() {
  return (
    <Hero
      variant="splash"
      illustration={<BrandGlyph size={150} />}
      headline="JobWork"
      subline={
        <>
          Find Trusted Machines.
          <br />
          Get Quality Work Done.
        </>
      }
      actions={
        <div className="jw-splash-actions">
          <Link href="/start" className="jw-splash-cta">
            Get Started
          </Link>
          <Link href="/login" className="jw-splash-link">
            Login / Register
          </Link>
        </div>
      }
    />
  );
}
