import type { ReactNode } from 'react';

/**
 * The brand hero (F-MX.5, prototype tiles 1/2/4/14): a gradient card that carries the
 * one message a screen leads with. It is the only surface in the system that puts light
 * text on the brand blue, and the pair is a tested token (`--brand-hero-fg` on
 * `--brand-hero-bg`, `tokens.spec.ts`), not a per-screen choice.
 *
 * `D-10`: the copy inside is the caller's; nothing here claims trust or quality on its
 * own. `illustration` is a decorative slot and is hidden from assistive technology.
 */

export interface HeroProps {
  headline: ReactNode;
  subline?: ReactNode | undefined;
  /** One primary action, optionally a secondary — the prototype's "Get started / Login". */
  actions?: ReactNode | undefined;
  /** Purely decorative artwork or a mark; rendered `aria-hidden`. */
  illustration?: ReactNode | undefined;
  /** `banner` is the compact home card; `splash` fills the screen for the entry pages. */
  variant?: 'banner' | 'splash' | undefined;
}

export function Hero({
  headline,
  subline,
  actions,
  illustration,
  variant = 'banner',
}: HeroProps): React.JSX.Element {
  return (
    <section className={variant === 'splash' ? 'jw-hero jw-hero-splash' : 'jw-hero'}>
      {illustration ? (
        <div className="jw-hero-art" aria-hidden="true">
          {illustration}
        </div>
      ) : null}
      <div className="jw-hero-body">
        <p className="jw-hero-headline">{headline}</p>
        {subline ? <p className="jw-hero-subline">{subline}</p> : null}
        {actions ? <div className="jw-hero-actions">{actions}</div> : null}
      </div>
    </section>
  );
}
