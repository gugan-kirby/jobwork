'use client';

import type { MessageAudience } from '@jobwork/contracts';
import { Icon, type IconName } from '../primitives/Icon';
import type { Tone } from '../tokens';

/**
 * Who a message reaches, in words, icon and colour together (doc 21 §6, doc 14 §11). The
 * words carry the meaning; colour and icon only make it faster to see (`DS-07`).
 */
export const AUDIENCE_STYLE: Record<MessageAudience, { tone: Tone; icon: IconName; name: string }> = {
  internal: { tone: 'special', icon: 'shield', name: 'Internal note' },
  customer: { tone: 'progress', icon: 'profile', name: 'Customer' },
  supplier: { tone: 'positive', icon: 'factory', name: 'Supplier' },
  shared_technical: { tone: 'attention', icon: 'team', name: 'Every invited supplier' },
};

/** A compact audience label for a message in JobWork's view. */
export function AudienceChip({ audience, detail }: { audience: MessageAudience; detail?: string | null | undefined }): React.JSX.Element {
  const style = AUDIENCE_STYLE[audience];
  return (
    <span className={`jw-audience-chip jw-tone-${style.tone}`}>
      <Icon name={style.icon} size={1} />
      {style.name}
      {detail ? `: ${detail}` : ''}
    </span>
  );
}

export interface AudienceBannerProps {
  audience: MessageAudience;
  /** Who reads it, e.g. "JobWork and Kovai Pumps". */
  label: string;
}

export function AudienceBanner({ audience, label }: AudienceBannerProps): React.JSX.Element {
  const style = AUDIENCE_STYLE[audience];
  return (
    <div className={`jw-audience-banner jw-tone-${style.tone}`}>
      <Icon name={style.icon} size={1.2} />
      <span>
        {audience === 'internal' ? (
          <>
            <strong>Internal note.</strong> Only JobWork staff can read this.
          </>
        ) : (
          <>
            <strong>Writing to:</strong> {label}
          </>
        )}
      </span>
    </div>
  );
}
