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
  /**
   * `banner` is the compact home card, under the page's own heading; `splash` fills the
   * screen for an entry page and is its only heading, so its headline is the h1 (FW W14:
   * the welcome page had no heading for assistive technology).
   */
  variant?: 'banner' | 'splash' | undefined;
}

export function Hero({
  headline,
  subline,
  actions,
  illustration,
  variant = 'banner',
}: HeroProps): React.JSX.Element {
  if (variant === 'splash') {
    // VF-01: the mark, name and line sit in the optical centre; the actions are pinned
    // to the bottom of the screen where a thumb reaches them.
    return (
      <section className="jw-hero jw-hero-splash">
        <div className="jw-hero-splash-centre">
          {illustration ? (
            <div className="jw-hero-art" aria-hidden="true">
              {illustration}
            </div>
          ) : null}
          <h1 className="jw-hero-headline">{headline}</h1>
          {subline ? <p className="jw-hero-subline">{subline}</p> : null}
        </div>
        {actions ? <div className="jw-hero-actions">{actions}</div> : null}
      </section>
    );
  }

  return (
    <section className="jw-hero">
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
