'use client';

import Link from 'next/link';
import { BrandGlyph, Hero } from '@jobwork/ui';

/**
 * The splash (VF-01, reference screen 01). One message, one action. The reference line
 * "Find trusted machines. Get quality work done." is replaced: it promises trust and
 * quality JobWork cannot yet stand behind (`D-10`) and sells machines, not a managed
 * counterpart. The two-line rhythm is kept.
 */
export default function WelcomePage() {
  return (
    <Hero
      variant="splash"
      illustration={<BrandGlyph size={150} />}
      headline="JobWork"
      subline={
        <>
          Custom parts, made to your drawing.
          <br />
          One partner from enquiry to delivery.
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
