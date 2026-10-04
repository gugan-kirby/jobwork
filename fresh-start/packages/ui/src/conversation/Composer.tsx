'use client';

import { useId, useState } from 'react';
import type {
  CheckMessageResponse,
  PostingOption,
  PostMessageRequest,
  PostMessageResponse,
} from '@jobwork/contracts';
import { Button } from '../primitives/Button';
import { TextArea } from '../primitives/Field';
import { Callout } from '../data/Callout';
import { ErrorState } from '../data/States';
import { AudienceBanner } from './AudienceBanner';
import { LeakWarning } from './LeakWarning';

export interface ComposerProps {
  /** What the server says this reader may write to here. */
  options: PostingOption[];
  /** The leakage pre-check; stores nothing. */
  onCheck: (request: PostMessageRequest) => Promise<CheckMessageResponse>;
  onPost: (request: PostMessageRequest) => Promise<PostMessageResponse>;
  onPosted?: ((response: PostMessageResponse) => void) | undefined;
}

function problemOf(err: unknown): { message: string; code?: string } {
  const code = (err as { problem?: { code?: string } }).problem?.code;
  return { message: err instanceof Error ? err.message : 'The message was not sent.', ...(code ? { code } : {}) };
}

/**
 * The doc 21 composer. It always says who will read the message. An internal note is a
 * separate mode, entered and left only by a button that says so — never a keyboard
 * shortcut, so a note cannot be turned into a customer message by a stray keystroke
 * (doc 14 §11). Outward text is checked first; anything the gate would warn about or hold
 * is shown to the author before it is sent (doc 14 §11 "safe edit/review route").
 */
export function Composer({ options, onCheck, onPost, onPosted }: ComposerProps): React.JSX.Element | null {
  const external = options.filter((o) => o.audience !== 'internal');
  const internal = options.find((o) => o.audience === 'internal');
  const [mode, setMode] = useState<'message' | 'internal'>(external.length > 0 ? 'message' : 'internal');
  const [choice, setChoice] = useState(0);
  const [body, setBody] = useState('');
  const [warning, setWarning] = useState<CheckMessageResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const groupId = useId();

  if (options.length === 0) {
    return <Callout tone="neutral">This conversation is closed. You can still read it.</Callout>;
  }

  const target = mode === 'internal' ? internal! : external[Math.min(choice, external.length - 1)]!;
  const request = (): PostMessageRequest => ({
    audience: target.audience,
    body: body.trim(),
    ...(target.supplierOrganizationId ? { supplierOrganizationId: target.supplierOrganizationId } : {}),
  });

  async function post(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const response = await onPost(request());
      setBody('');
      setWarning(null);
      setNotice(
        response.status === 'held'
          ? 'Held for review. A JobWork reviewer decides before anyone outside JobWork can read it.'
          : null,
      );
      onPosted?.(response);
    } catch (err) {
      setError(problemOf(err));
    } finally {
      setBusy(false);
    }
  }

  async function send(): Promise<void> {
    setNotice(null);
    if (target.audience === 'internal') return post();
    setBusy(true);
    setError(null);
    try {
      const check = await onCheck(request());
      if (check.action === 'allow') {
        setBusy(false);
        return post();
      }
      setWarning(check);
    } catch (err) {
      setError(problemOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={mode === 'internal' ? 'jw-composer jw-composer-internal' : 'jw-composer'}>
      <AudienceBanner audience={target.audience} label={target.label} />

      {mode === 'message' && external.length > 1 ? (
        <fieldset className="jw-audience-choice">
          <legend>Send to</legend>
          {external.map((option, i) => (
            <label key={`${option.audience}:${option.supplierOrganizationId ?? ''}`}>
              <input
                type="radio"
                name={groupId}
                checked={i === choice}
                onChange={() => {
                  setChoice(i);
                  setWarning(null);
                }}
              />{' '}
              {option.label}
            </label>
          ))}
        </fieldset>
      ) : null}

      {warning ? (
        <LeakWarning
          action={warning.action === 'quarantine' ? 'quarantine' : 'warn'}
          findings={warning.findings}
          body={body}
          busy={busy}
          onEdit={() => setWarning(null)}
          onProceed={() => void post()}
        />
      ) : (
        <TextArea
          label={mode === 'internal' ? 'Internal note' : 'Message'}
          value={body}
          rows={4}
          maxLength={8000}
          onChange={(event) => {
            setBody(event.target.value);
            setNotice(null);
          }}
        />
      )}

      {error ? <ErrorState message={error.message} code={error.code} /> : null}
      {notice ? <Callout tone="attention">{notice}</Callout> : null}

      {warning ? null : (
        <div className="jw-composer-actions">
          <Button onClick={() => void send()} busy={busy} disabled={body.trim().length === 0} disabledReason="Write a message first">
            {mode === 'internal' ? 'Save internal note' : 'Send'}
          </Button>
          {mode === 'message' && internal ? (
            <Button variant="ghost" onClick={() => setMode('internal')}>
              Write an internal note instead
            </Button>
          ) : null}
          {mode === 'internal' && external.length > 0 ? (
            <Button variant="ghost" onClick={() => setMode('message')}>
              Back to the message
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}
