'use client';

import type { LeakageFinding } from '@jobwork/contracts';
import { Button } from '../primitives/Button';
import { Callout } from '../data/Callout';

/**
 * Text with flagged spans marked (doc 14 §11 "identifies risk"). The text is split into
 * plain and marked segments and rendered as React text — never as HTML — so a message
 * cannot smuggle markup into the page that reviews it.
 */
export function HighlightedText({
  text,
  spans,
}: {
  text: string;
  spans: ReadonlyArray<Pick<LeakageFinding, 'start' | 'end' | 'label'>>;
}): React.JSX.Element {
  const ordered = [...spans].sort((a, b) => a.start - b.start);
  const parts: React.JSX.Element[] = [];
  let cursor = 0;
  ordered.forEach((span, i) => {
    if (span.end <= cursor) return;
    const from = Math.max(cursor, span.start);
    if (from > cursor) parts.push(<span key={`t${i}`}>{text.slice(cursor, from)}</span>);
    parts.push(
      <mark key={`m${i}`} className="jw-leak-mark" title={span.label}>
        {text.slice(from, span.end)}
      </mark>,
    );
    cursor = span.end;
  });
  if (cursor < text.length) parts.push(<span key="tail">{text.slice(cursor)}</span>);
  return <span className="jw-highlighted-text">{parts}</span>;
}

export interface LeakWarningProps {
  action: 'warn' | 'quarantine';
  findings: ReadonlyArray<LeakageFinding>;
  /** The text that was checked, so the flagged parts can be shown in place. */
  body: string;
  /** Back to the composer with the text intact. */
  onEdit: () => void;
  /** `warn`: send as written. `quarantine`: send it to JobWork's reviewers. */
  onProceed: () => void;
  busy?: boolean | undefined;
}

/**
 * The composer's contact-leakage warning (doc 14 §11): names each risk, shows where it is,
 * and offers the two ways forward — edit, or proceed. Proceeding with a quarantine-level
 * finding never sends the message to its readers; it sends it to a reviewer.
 */
export function LeakWarning({ action, findings, body, onEdit, onProceed, busy }: LeakWarningProps): React.JSX.Element {
  const held = action === 'quarantine';
  return (
    <Callout
      tone={held ? 'blocked' : 'attention'}
      assertive
      title={held ? 'This message will be held for review' : 'Check this message before sending'}
    >
      <p>
        {held
          ? 'It may name another party or carry contact details. A JobWork reviewer decides before anyone outside JobWork can read it.'
          : 'It may contain contact details. Keep the conversation here so the record stays complete.'}
      </p>
      {findings.length > 0 ? (
        <ul className="jw-leak-findings">
          {findings.map((f) => (
            <li key={`${f.kind}:${f.start}:${f.end}`}>
              {f.label}: <q>{f.text}</q>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="jw-leak-preview">
        <HighlightedText text={body} spans={findings} />
      </p>
      <div className="jw-leak-actions">
        <Button variant="secondary" size="sm" onClick={onEdit} disabled={busy}>
          Edit message
        </Button>
        <Button variant={held ? 'primary' : 'secondary'} size="sm" onClick={onProceed} busy={busy}>
          {held ? 'Send for review' : 'Send anyway'}
        </Button>
      </div>
    </Callout>
  );
}
