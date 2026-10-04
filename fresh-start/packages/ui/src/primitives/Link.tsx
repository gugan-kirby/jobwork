'use client';

import {
  createContext,
  useContext,
  type AnchorHTMLAttributes,
  type CSSProperties,
  type ElementType,
  type ReactNode,
} from 'react';
import { Button, buttonStyle, type ButtonSize, type ButtonVariant } from './Button';

/**
 * Internal navigation, rendered by whatever link the app's router provides (F-FE.4).
 *
 * `packages/ui` does not depend on Next. Each app hands its router link in once, at its
 * shell, and every internal link in the system — navigation, tabs, record and queue
 * cards, back links, button links — then navigates client-side and prefetches. Before
 * this, each of them was a bare `<a>`: a full document load per tap.
 *
 * Without a provider (tests, Storybook-style previews) links are plain anchors.
 */

export type UiLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
  href: string;
  children?: ReactNode | undefined;
};

/**
 * Anything that renders an anchor from anchor props: `'a'`, or a router link such as
 * `next/link`. Typed as an element type rather than `ComponentType<UiLinkProps>` because
 * router links declare their optional handlers without `| undefined`, which
 * `exactOptionalPropertyTypes` will not reconcile with React's anchor attributes.
 */
export type LinkComponent = ElementType;

const LinkContext = createContext<LinkComponent>('a');

export function LinkProvider({
  component,
  children,
}: {
  component: LinkComponent;
  children: ReactNode;
}): React.JSX.Element {
  return <LinkContext.Provider value={component}>{children}</LinkContext.Provider>;
}

/** An internal link. Fragment links (`#main`) and downloads stay plain anchors. */
export function UiLink(props: UiLinkProps): React.JSX.Element {
  const Component = useContext(LinkContext);
  return <Component {...props} />;
}

export interface ButtonLinkProps {
  href: string;
  variant?: ButtonVariant | undefined;
  size?: ButtonSize | undefined;
  fullWidth?: boolean | undefined;
  iconStart?: ReactNode | undefined;
  /**
   * A navigation that is not available yet. It renders as a disabled button carrying
   * the reason — never as a link, which the keyboard would still follow.
   */
  disabled?: boolean | undefined;
  disabledReason?: string | undefined;
  style?: CSSProperties | undefined;
  children: ReactNode;
}

/**
 * A link that looks like a button: one `<a>`, one tab stop, announced as a link. It
 * replaces `<Link><Button/></Link>`, which nests a button in a link — invalid
 * interactive content with two tab stops and an ambiguous accessible role (`NFR-08`).
 */
export function ButtonLink({
  href,
  variant = 'primary',
  size = 'md',
  fullWidth,
  iconStart,
  disabled = false,
  disabledReason,
  style,
  children,
}: ButtonLinkProps): React.JSX.Element {
  if (disabled) {
    return (
      <Button
        variant={variant}
        size={size}
        fullWidth={fullWidth}
        iconStart={iconStart}
        disabled
        disabledReason={disabledReason}
        style={style}
      >
        {children}
      </Button>
    );
  }
  return (
    <UiLink
      href={href}
      style={{ ...buttonStyle({ variant, size, fullWidth }), textDecoration: 'none', ...style }}
    >
      {iconStart}
      {children}
    </UiLink>
  );
}
