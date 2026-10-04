'use client';

import type { CSSProperties, ReactNode } from 'react';
import { Icon } from '../primitives/Icon';
import { UiLink } from '../primitives/Link';

/**
 * Page rhythm, declared once (doc 21 §11: no page-local magic values).
 *
 * Before this, every screen chose its own `padding` and `maxWidth`, so the portal and
 * operations apps drifted apart by a few pixels per page. `width` maps to the container
 * tokens: `narrow` for a single decision, `page` for normal reading, `wide` for the
 * dense operations surfaces doc 21 §1 says should optimise for scanning.
 *
 * F-MX.2 adds the phone header from the prototype: `back` puts a chevron before the
 * title and centres the title on narrow screens (tiles 5–16), and `titleHidden` keeps
 * the `h1` for assistive technology on pages whose visible heading is a hero (tile 4).
 */

export interface PageProps {
  title: string;
  description?: ReactNode | undefined;
  /** Rendered above the title — a back link or breadcrumb. Prefer `back` on phone screens. */
  breadcrumb?: ReactNode | undefined;
  /** Where the back chevron goes. Renders the prototype's "‹ Title" header row. */
  back?: { href: string; label?: string | undefined } | undefined;
  /** Primary actions, right-aligned beside the title on wide screens. */
  actions?: ReactNode | undefined;
  /** Status chip or reference shown under the title. */
  meta?: ReactNode | undefined;
  width?: 'narrow' | 'page' | 'wide' | undefined;
  /** Keep the `h1` for the accessibility tree but let a hero carry the visible heading. */
  titleHidden?: boolean | undefined;
  children: ReactNode;
}

const WIDTH: Record<NonNullable<PageProps['width']>, string> = {
  narrow: 'var(--container-narrow)',
  page: 'var(--container-page)',
  wide: 'var(--container-wide)',
};

export function Page({
  title,
  description,
  breadcrumb,
  back,
  actions,
  meta,
  width = 'page',
  titleHidden,
  children,
}: PageProps): React.JSX.Element {
  return (
    <div
      style={{
        maxWidth: WIDTH[width],
        margin: '0 auto',
        padding: 'var(--space-5) var(--space-4) var(--space-8)',
      }}
    >
      {breadcrumb ? (
        <div style={{ font: 'var(--text-caption)', marginBottom: 'var(--space-2)' }}>{breadcrumb}</div>
      ) : null}
      <div
        className={back ? 'jw-page-head jw-page-head-back' : 'jw-page-head'}
        style={titleHidden && !back && !actions && !meta && !description ? { marginBottom: 0 } : undefined}
      >
        {back ? (
          <UiLink href={back.href} className="jw-icon-button jw-page-back" aria-label={back.label ?? 'Back'}>
            <Icon name="back" size={1.4} />
          </UiLink>
        ) : null}
        <div className="jw-page-title-block">
          <h1
            className={titleHidden ? 'jw-visually-hidden' : 'jw-page-title'}
            style={{ font: 'var(--text-display)', margin: 0, overflowWrap: 'anywhere' }}
          >
            {title}
          </h1>
          {meta ? (
            <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', marginTop: 'var(--space-2)', flexWrap: 'wrap' }}>
              {meta}
            </div>
          ) : null}
          {description ? (
            <p style={{ color: 'var(--color-text-muted)', marginTop: 'var(--space-2)' }}>{description}</p>
          ) : null}
        </div>
        {actions ? <div className="jw-page-actions">{actions}</div> : null}
      </div>
      {children}
    </div>
  );
}

export interface CardProps {
  /** Usually a string; a node so a card can title itself with a link to its record. */
  title?: ReactNode | undefined;
  description?: ReactNode | undefined;
  actions?: ReactNode | undefined;
  /** Removes the inner padding for cards whose body is a full-bleed table. */
  flush?: boolean | undefined;
  style?: CSSProperties | undefined;
  children: ReactNode;
}

export function Card({
  title,
  description,
  actions,
  flush,
  style,
  children,
}: CardProps): React.JSX.Element {
  return (
    <section
      style={{
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-raised)',
        overflow: 'hidden',
        ...style,
      }}
    >
      {title || actions ? (
        <header
          style={{
            display: 'flex',
            gap: 'var(--space-3)',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: 'var(--space-4) var(--space-5)',
            borderBottom: '1px solid var(--color-border)',
            flexWrap: 'wrap',
          }}
        >
          <div>
            {title ? <h2 style={{ font: 'var(--text-heading-2)', margin: 0 }}>{title}</h2> : null}
            {description ? (
              <p style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)', marginTop: 'var(--space-1)' }}>
                {description}
              </p>
            ) : null}
          </div>
          {actions ? <div style={{ display: 'flex', gap: 'var(--space-2)' }}>{actions}</div> : null}
        </header>
      ) : null}
      <div style={flush ? undefined : { padding: 'var(--space-5)' }}>{children}</div>
    </section>
  );
}
