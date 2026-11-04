'use client';

import Link from 'next/link';
import { Icon, WorkshopIllustration } from '@jobwork/ui';

/**
 * The welcome fork (VF-02, VF-18, reference screen 02), word for word. Guest browsing is
 * category education only (`D-17`).
 */
const ASSURANCES = [
  { icon: 'shieldLock' as const, label: 'Secure' },
  { icon: 'shieldCheck' as const, label: 'Reliable' },
  { icon: 'shieldBolt' as const, label: 'Fast' },
];

export default function StartPage() {
  return (
    <div className="jw-entry">
      <header>
        <p className="jw-entry-eyebrow">Welcome to</p>
        <h1 className="jw-entry-title">JobWork</h1>
        <p className="jw-entry-lede">
          One Platform for All Your
          <br />
          Job Work Needs
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
            <span>{item.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
