import { UiLink } from '../primitives/Link';
import type { ReactNode } from 'react';
import { Icon } from '../primitives/Icon';

/**
 * The reference screens' inner header (VF-03 onward): a back chevron and the screen
 * title, which is the page's h1. `trailing` holds a bell or a menu when a screen has one.
 */
export function TopBar({
  title,
  back,
  backLabel = 'Back',
  trailing,
  centred = false,
}: {
  title: string;
  back?: string | undefined;
  backLabel?: string | undefined;
  trailing?: ReactNode | undefined;
  centred?: boolean | undefined;
}): React.JSX.Element {
  return (
    <header className={centred ? 'jw-topbar jw-topbar-centred' : 'jw-topbar'}>
      {back ? (
        <UiLink href={back} className="jw-topbar-back" aria-label={backLabel}>
          <Icon name="back" size={1.6} />
        </UiLink>
      ) : (
        <span className="jw-topbar-back" aria-hidden="true" />
      )}
      <h1 className="jw-topbar-title">{title}</h1>
      <span className="jw-topbar-trailing">{trailing}</span>
    </header>
  );
}
