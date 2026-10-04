import { describe, expect, it } from 'vitest';
import { NOTIFIED_EVENT_TYPES } from '@jobwork/contracts';
import { render, TemplateRenderRefused, type TemplateVersion } from '../src/modules/communication/domain/templates';
import { dateLabel, NOTIFICATION_RULES } from '../src/modules/communication/application/notification-rules';

/** F-10.3 leak guard: a template renders only what its version allows (doc 11 "notification leak"). */

const quoteSent: TemplateVersion = {
  id: 't1',
  templateKey: 'customer.quote_sent',
  version: 1,
  subject: 'Your quotation {{quoteReference}} is ready',
  body: 'Valid until {{validityUntil}}. {{link}}',
  variables: ['quoteReference', 'validityUntil', 'link'],
};

describe('template rendering', () => {
  it('fills allowed placeholders', () => {
    expect(render(quoteSent, { quoteReference: 'QUO-2026-0001', validityUntil: '31 Oct 2026', link: '/quotations/q' })).toEqual({
      subject: 'Your quotation QUO-2026-0001 is ready',
      body: 'Valid until 31 Oct 2026. /quotations/q',
    });
  });

  it('refuses a placeholder the version does not allow', () => {
    const leaky = { ...quoteSent, body: 'Made by {{supplierName}}. {{link}}' };
    expect(() => render(leaky, { quoteReference: 'Q', validityUntil: 'd', link: '/x' })).toThrow(TemplateRenderRefused);
    expect(() => render(leaky, { quoteReference: 'Q', validityUntil: 'd', link: '/x' })).toThrow(/supplierName.*not in the version 1 allowlist/);
  });

  it('refuses a variable the builder was never allowed to pass', () => {
    expect(() => render(quoteSent, { quoteReference: 'Q', validityUntil: 'd', link: '/x', supplierName: 'Anand' })).toThrow(/outside the allowlist: supplierName/);
  });

  it('refuses to send a sentence with a hole in it', () => {
    expect(() => render(quoteSent, { quoteReference: 'Q', link: '/x' })).toThrow(/no value for \{\{validityUntil\}\}/);
  });

  it('writes dates the way Chennai reads them, in IST', () => {
    expect(dateLabel('2026-10-31')).toBe('31 Oct 2026');
    expect(dateLabel('2026-10-31T20:00:00.000Z')).toBe('1 Nov 2026');
    expect(dateLabel(null)).toBe('the stated date');
  });
});

describe('notification rules', () => {
  it('has exactly one rule per event type the worker subscribes to', () => {
    expect(Object.keys(NOTIFICATION_RULES).sort()).toEqual([...NOTIFIED_EVENT_TYPES].sort());
  });
});
