import { describe, expect, it } from 'vitest';
import { AhoCorasick } from '../src/modules/communication/domain/aho-corasick';
import { redact, scanText, type Registry } from '../src/modules/communication/domain/leakage';
import { decideAction, findingsForAuthor } from '../src/modules/communication/domain/leakage-policy';

/**
 * F-10.4 detector (doc 07 §12 stages 1, 2, 5, 6). The cases are the ones the doc warns
 * about: engineering numbers that look like phones, contact details written to dodge a
 * filter, look-alike letters, and names that are only a match at a word boundary.
 */

const registry: Registry = {
  shielded: [
    { party: 'supplier', kind: 'name', value: 'Anand Engineering Pvt Ltd' },
    { party: 'supplier', kind: 'name', value: 'Precision Works' },
    { party: 'supplier', kind: 'domain', value: 'https://www.anandengg.com' },
    { party: 'supplier', kind: 'email', value: 'sales@anandengg.com' },
    { party: 'supplier', kind: 'phone', value: '+91 90000 11111' },
    { party: 'customer', kind: 'name', value: 'Kovai Pumps' },
  ],
  allowed: [{ kind: 'domain', value: 'jobwork.in' }],
};

const kinds = (text: string) => scanText(text, registry).map((f) => f.kind);

describe('contact-leakage detector', () => {
  it('reads part, drawing, lot and dimension numbers as engineering, not phones', () => {
    for (const text of [
      'Part no 9876543210 rev C',
      'Please use drawing DWG-9876543210 for the bracket.',
      'Lot: 9123456780, heat 7',
      'Order qty 9876543210 pcs',
      'Bore 98765.43210 mm across',
      'Item code AB9876543210',
    ]) {
      expect(kinds(text), text).toEqual(['engineering_number']);
      expect(scanText(text, registry).every((f) => f.confidence === 'low'), text).toBe(true);
    }
  });

  it('finds real phone numbers however they are spaced', () => {
    expect(kinds('call me on 98765 43210 after six')).toEqual(['phone']);
    expect(kinds('mobile +91 98765-43210')).toEqual(['phone']);
    expect(kinds('office (044) 2345 6789')).toEqual(['phone']);
    // A date and an eight-digit number are not phones.
    expect(kinds('delivered 2026-10-04, ref 12345678')).toEqual([]);
  });

  it('catches email addresses written to dodge a filter', () => {
    expect(kinds('write to anand [at] gmail (dot) com')).toEqual(['email']);
    expect(kinds('write to anand at gmail dot com')).toEqual(['email']);
    const hidden = 'mail an​and@gm​ail.com today';
    const [finding] = scanText(hidden, registry);
    expect(finding).toMatchObject({ kind: 'email' });
    // Offsets point into the text as written, zero-width characters and all.
    expect(hidden.slice(finding!.start, finding!.end)).toBe(finding!.text);
    expect(finding!.text).toBe('an​and@gm​ail.com');
  });

  it('finds web addresses, handles and outside messaging apps', () => {
    expect(kinds('catalogue at www.example.in/parts')).toEqual(['url']);
    expect(kinds('follow @anand_works')).toEqual(['handle']);
    const app = scanText('send the photos on WhatsApp', registry);
    expect(app).toMatchObject([{ kind: 'handle', confidence: 'low' }]);
  });

  it('names a shielded party even with look-alike letters, legal suffix dropped, any hyphenation', () => {
    // The first letter is Cyrillic А (U+0410).
    const found = scanText('Machined by Аnand-Engineering last week', registry);
    expect(found).toMatchObject([{ kind: 'party_identity', confidence: 'high', label: 'Names a supplier', text: 'Аnand-Engineering' }]);
    expect(kinds('Kovai Pumps approved the sample')).toEqual(['party_identity']);
  });

  it('matches names only at word boundaries, and never on generic words alone', () => {
    expect(kinds('Prasanand Engineering College')).toEqual([]);
    expect(kinds('We need precision works on the flange')).toEqual([]);
  });

  it('recognises a shielded party by its domain, email and phone number', () => {
    const domain = scanText('see anandengg.com/catalog', registry);
    expect(domain.map((f) => f.kind).sort()).toEqual(['party_identity', 'url']);
    const email = scanText('mail sales@anandengg.com', registry);
    expect(email.map((f) => f.kind).sort()).toEqual(['email', 'party_identity']);
    const phone = scanText('ring 90000 11111', registry);
    expect(phone.map((f) => f.kind).sort()).toEqual(['party_identity', 'phone']);
    expect(phone.find((f) => f.kind === 'party_identity')!.label).toBe('Contact detail of a supplier');
  });

  it("ignores JobWork's own addresses", () => {
    expect(kinds('reply to support@jobwork.in or see https://portal.jobwork.in')).toEqual([]);
  });

  it('replaces each flagged span in a suggested redaction and leaves the rest alone', () => {
    const text = 'Call 98765 43210 about part no 9123456780.';
    const findings = scanText(text, registry).filter((f) => f.kind === 'phone');
    expect(redact(text, findings)).toBe('Call [removed] about part no 9123456780.');
  });
});

describe('leakage policy', () => {
  const phone = scanText('call 98765 43210', registry);
  const part = scanText('part no 9876543210', registry);
  const party = scanText('made by Anand Engineering', registry);

  it('holds a named party or hard contact JobWork is sending outward', () => {
    expect(decideAction({ audience: 'customer', authorParty: 'internal', findings: party })).toBe('quarantine');
    expect(decideAction({ audience: 'supplier', authorParty: 'internal', findings: phone })).toBe('quarantine');
  });

  it('holds anything risky that is shared with every invited supplier', () => {
    expect(decideAction({ audience: 'shared_technical', authorParty: 'internal', findings: phone })).toBe('quarantine');
  });

  it('only warns when a customer or supplier writes to JobWork, which is the only reader', () => {
    expect(decideAction({ audience: 'customer', authorParty: 'customer', findings: [...phone, ...party] })).toBe('warn');
    expect(decideAction({ audience: 'supplier', authorParty: 'supplier', findings: phone })).toBe('warn');
  });

  it('never stops a message for an engineering number', () => {
    expect(decideAction({ audience: 'customer', authorParty: 'internal', findings: part })).toBe('warn');
  });

  it('allows a clean message', () => {
    expect(decideAction({ audience: 'customer', authorParty: 'internal', findings: [] })).toBe('allow');
  });

  it('never tells an outside author that a name belongs to one of our parties', () => {
    expect(findingsForAuthor([...party, ...phone], 'customer').map((f) => f.kind)).toEqual(['phone']);
    expect(findingsForAuthor(party, 'internal').map((f) => f.kind)).toEqual(['party_identity']);
  });
});

describe('Aho-Corasick', () => {
  it('finds every overlapping pattern in one pass', () => {
    const ac = new AhoCorasick(['he', 'she', 'his', 'hers'].map((p) => ({ pattern: p, value: p })));
    const found = ac.search('ushers').map((m) => `${m.value}@${m.start}`).sort();
    expect(found).toEqual(['he@2', 'hers@2', 'she@1']);
  });
});
