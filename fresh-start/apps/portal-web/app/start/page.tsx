'use client';

import Link from 'next/link';
import { Icon, WorkshopIllustration } from '@jobwork/ui';

/**
 * The welcome fork (VF-02, reference screen 02): sign in, register, or look around as a
 * guest. Guest browsing is category education only (`D-17`). The reference's
 * "Reliable · Fast" are promises JobWork cannot yet stand behind (`D-10`); the trio says
 * what the platform does instead, with the longer meaning spoken to assistive technology.
 */
const ASSURANCES = [
  { icon: 'shieldLock' as const, label: 'Secure', detail: 'your drawings stay yours' },
  { icon: 'shieldCheck' as const, label: 'Reviewed', detail: 'every requirement checked' },
  { icon: 'shieldBolt' as const, label: 'Managed', detail: 'one accountable counterpart' },
];

export default function StartPage() {
  return (
    <div className="jw-entry">
      <header>
        <p className="jw-entry-eyebrow">Welcome to</p>
        <h1 className="jw-entry-title">JobWork</h1>
        <p className="jw-entry-lede">
          One platform for all your
          <br />
          job work needs
        </p>
      </header>

      <div className="jw-entry-art">
        <WorkshopIllustration />
      </div>

      <div className="jw-entry-actions">
        <Link href="/login" className="jw-cta">
          Login
        </Link>
        <Link href="/register" className="jw-cta-outline">
          Register
        </Link>
        <Link href="/explore" className="jw-text-cta">
          Continue as Guest
        </Link>
      </div>

      <ul className="jw-assurance">
        {ASSURANCES.map((item) => (
          <li key={item.label}>
            <Icon name={item.icon} size={1.7} />
            <span>
              {item.label}
              <span className="jw-visually-hidden">: {item.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
