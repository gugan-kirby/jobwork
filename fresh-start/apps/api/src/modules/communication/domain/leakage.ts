import type { LeakageFinding, LeakageFindingKind } from '@jobwork/contracts';
import { AhoCorasick } from './aho-corasick';

/**
 * Contact-leakage detection, text half (doc 07 §12 stages 1, 2 and 5; doc 11 §9).
 *
 * One regular expression is not enough: people write "anand [at] gmail dot com", paste
 * Cyrillic look-alike letters, and engineering text is full of ten-digit numbers that are
 * part numbers, not phones. So the text is normalized into views that each remember where
 * every character came from, the detectors run on the view that suits them, and every
 * finding is reported against the original text so a reviewer sees exactly what was
 * flagged. Nothing here edits the message.
 */

export const DETECTOR_VERSION = 'leakage-v1';

/** Who a registry entry identifies; JobWork's own contacts are `allowed`, never a leak. */
export type RegistryParty = 'customer' | 'supplier';

export interface RegistryEntry {
  party: RegistryParty;
  kind: 'name' | 'domain' | 'email' | 'phone';
  /** As stored; normalized here. */
  value: string;
}

export interface Registry {
  /** Identities the reader of this message must not learn. */
  shielded: RegistryEntry[];
  /** JobWork's own emails, domains and phones: findings that match these are dropped. */
  allowed: Array<{ kind: 'domain' | 'email' | 'phone'; value: string }>;
}

// ------------------------------------------------------------------ stage 1: views

interface View {
  text: string;
  /** Original offset of each view character's source. */
  start: number[];
  /** Original offset one past each view character's source. */
  end: number[];
}

const ZERO_WIDTH = new Set(['­', '​', '‌', '‍', '‎', '‏', '⁠', '﻿']);

/** Look-alike letters that survive NFKC (Cyrillic, Greek) folded to their Latin twins. */
const CONFUSABLES: Record<string, string> = {
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's', ԁ: 'd', һ: 'h', ӏ: 'l', ԛ: 'q', ԝ: 'w',
  ο: 'o', α: 'a', ν: 'v', ι: 'i', κ: 'k', τ: 't', ρ: 'p', ε: 'e', ϲ: 'c', υ: 'u', χ: 'x', ɡ: 'g', ı: 'i',
};

function baseView(input: string): View {
  const view: View = { text: '', start: [], end: [] };
  let offset = 0;
  const chars: string[] = [];
  for (const codePoint of input) {
    const width = codePoint.length;
    if (!ZERO_WIDTH.has(codePoint)) {
      for (const ch of codePoint.normalize('NFKC').toLowerCase()) {
        chars.push(CONFUSABLES[ch] ?? ch);
        view.start.push(offset);
        view.end.push(offset + width);
      }
    }
    offset += width;
  }
  view.text = chars.join('');
  return view;
}

/** Rewrites matches of `pattern` in a view, keeping every character traceable to its source. */
function rewrite(view: View, pattern: RegExp, replacement: (match: RegExpExecArray) => string): View {
  const out: View = { text: '', start: [], end: [] };
  const chars: string[] = [];
  let cursor = 0;
  const copy = (from: number, to: number) => {
    for (let i = from; i < to; i += 1) {
      chars.push(view.text[i]!);
      out.start.push(view.start[i]!);
      out.end.push(view.end[i]!);
    }
  };
  for (const match of view.text.matchAll(pattern)) {
    const at = match.index;
    const length = match[0].length;
    copy(cursor, at);
    const text = replacement(match as RegExpExecArray);
    for (const ch of text) {
      chars.push(ch);
      out.start.push(view.start[at]!);
      out.end.push(view.end[at + length - 1]!);
    }
    cursor = at + length;
  }
  copy(cursor, view.text.length);
  out.text = chars.join('');
  return out;
}

interface Views {
  original: string;
  base: View;
  /** Separators collapsed to one space: names match however they are hyphenated. */
  words: View;
  /** Bracketed "[at]"/"(dot)" spelled out as symbols: obfuscated addresses become addresses. */
  symbols: View;
}

function views(input: string): Views {
  const base = baseView(input);
  return {
    original: input,
    base,
    words: rewrite(base, /[\s_\-‐-―]+/g, () => ' '),
    symbols: rewrite(base, /\s*[[({<]\s*(at|dot)\s*[\])}>]\s*/g, (m) => (m[1] === 'at' ? '@' : '.')),
  };
}

// ------------------------------------------------------------------ stage 2: detectors

interface Raw {
  kind: LeakageFindingKind;
  confidence: 'high' | 'low';
  view: View;
  from: number;
  to: number;
  label: string;
  /** Machine value used for registry comparison (email, domain, national phone digits). */
  value?: string;
}

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/g;
/** "anand at gmail dot com" — spelled out without brackets. */
const SPELLED_EMAIL = /\b[a-z0-9._%+-]+ at [a-z0-9-]+(?: dot [a-z0-9-]+)+\b/g;
const SPELLED_DOMAIN = /\b[a-z0-9-]{2,}(?: dot [a-z0-9-]+)* dot (?:com|in|net|org|co|io)\b/g;
const URL_EXPLICIT = /\b(?:https?:\/\/|www\.)[^\s<>"')]+/g;
const URL_BARE =
  /\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)*\.(?:com|in|net|org|io|biz|info|co)(?:\.in)?\b(?:\/[^\s<>"')]*)?/g;
const HANDLE = /(?<![a-z0-9.@])@[a-z0-9_.]{3,30}\b/g;
const MESSAGING_APP = /\b(?:whats ?app|telegram|signal|instagram|insta|facebook|linkedin|skype|wechat|viber)\b/g;
const PHONE_CANDIDATE = /\+?\d[\d\s().-]{6,22}\d/g;
const PIN_CODE = /\b(?:pin|pincode|pin code)\s*[:-]?\s*\d{6}\b/g;
const PREMISES = /\b(?:plot|door|shed|flat|gala)\s*(?:no\.?)?\s*\d+[a-z]?\b/g;
const ADDRESS_WORDS = /\b(?:road|rd|street|st|nagar|salai|estate|layout|avenue|colony|sidco|phase|industrial|chennai|coimbatore|madurai|tamil nadu)\b/;

/** Words that, just before a number, say it is a part, drawing, lot or quantity — not a phone. */
const ENGINEERING_BEFORE =
  /(?:part|p\/n|pn|item|drawing|dwg|drg|rev|revision|lot|batch|heat|serial|s\/n|sku|code|ref|reference|model|hsn|gst|gstin|po|invoice|qty|quantity|size|dia|length|width|thk)\s*[.:#/-]*\s*(?:no|number|num)?\s*[.:#/-]*\s*$/;
const UNIT_AFTER = /^\s?(?:mm|cm|m|kg|g|nos|pcs|um|µm|in|deg|°|x|")(?![a-z])/;

type PhoneClass = 'mobile' | 'landline';

/** Indian numbering: a mobile is 10 digits from 6–9; a landline needs its trunk 0 or +91. */
function classifyPhone(candidate: string): { kind: PhoneClass; national: string } | null {
  const digits = candidate.replace(/\D/g, '');
  const explicitCountry = candidate.trim().startsWith('+');
  let national = digits;
  let prefixed = false;
  if (national.length === 12 && national.startsWith('91')) {
    national = national.slice(2);
    prefixed = true;
  } else if (national.length === 11 && national.startsWith('0')) {
    national = national.slice(1);
    prefixed = true;
  }
  if (explicitCountry && !prefixed) return null;
  if (national.length !== 10) return null;
  if (/^[6-9]/.test(national)) return { kind: 'mobile', national };
  if (prefixed && /^[1-9]/.test(national)) return { kind: 'landline', national };
  return null;
}

function looksLikeEngineering(view: View, from: number, to: number): boolean {
  const candidate = view.text.slice(from, to);
  const before = view.text.slice(Math.max(0, from - 28), from);
  const after = view.text.slice(to, to + 6);
  const prev = view.text[from - 1] ?? ' ';
  const next = view.text[to] ?? ' ';
  return (
    ENGINEERING_BEFORE.test(before) ||
    UNIT_AFTER.test(after) ||
    /[a-z/_]/.test(prev) ||
    /[a-z/_]/.test(next) ||
    /\d\.\d/.test(candidate)
  );
}

function detect(v: Views): Raw[] {
  const raw: Raw[] = [];
  const add = (r: Raw) => raw.push(r);

  for (const m of v.symbols.text.matchAll(EMAIL)) {
    add({ kind: 'email', confidence: 'high', view: v.symbols, from: m.index, to: m.index + m[0].length, label: 'Email address', value: m[0] });
  }
  for (const m of v.words.text.matchAll(SPELLED_EMAIL)) {
    const value = m[0].replace(/ at /, '@').replace(/ dot /g, '.');
    add({ kind: 'email', confidence: 'high', view: v.words, from: m.index, to: m.index + m[0].length, label: 'Email address written out in words', value });
  }
  for (const m of v.symbols.text.matchAll(URL_EXPLICIT)) {
    add({ kind: 'url', confidence: 'high', view: v.symbols, from: m.index, to: m.index + m[0].length, label: 'Web address', value: hostOf(m[0]) });
  }
  for (const m of v.symbols.text.matchAll(URL_BARE)) {
    add({ kind: 'url', confidence: 'high', view: v.symbols, from: m.index, to: m.index + m[0].length, label: 'Web address', value: hostOf(m[0]) });
  }
  for (const m of v.words.text.matchAll(SPELLED_DOMAIN)) {
    if (/ at /.test(v.words.text.slice(Math.max(0, m.index - 30), m.index + 1))) continue;
    add({ kind: 'url', confidence: 'high', view: v.words, from: m.index, to: m.index + m[0].length, label: 'Web address written out in words', value: m[0].replace(/ dot /g, '.') });
  }
  for (const m of v.symbols.text.matchAll(HANDLE)) {
    add({ kind: 'handle', confidence: 'high', view: v.symbols, from: m.index, to: m.index + m[0].length, label: 'Social or messaging handle' });
  }
  for (const m of v.words.text.matchAll(MESSAGING_APP)) {
    add({ kind: 'handle', confidence: 'low', view: v.words, from: m.index, to: m.index + m[0].length, label: 'Mentions an outside messaging app' });
  }
  for (const m of v.base.text.matchAll(PHONE_CANDIDATE)) {
    const from = m.index;
    const to = m.index + m[0].length;
    const phone = classifyPhone(m[0]);
    if (!phone) continue;
    if (looksLikeEngineering(v.base, from, to)) {
      add({ kind: 'engineering_number', confidence: 'low', view: v.base, from, to, label: 'Number shaped like a phone number (may be a part or drawing number)', value: phone.national });
    } else {
      add({ kind: 'phone', confidence: 'high', view: v.base, from, to, label: 'Phone number', value: phone.national });
    }
  }
  for (const m of v.base.text.matchAll(PIN_CODE)) {
    add({ kind: 'address', confidence: 'low', view: v.base, from: m.index, to: m.index + m[0].length, label: 'Looks like part of a postal address' });
  }
  for (const m of v.base.text.matchAll(PREMISES)) {
    const around = v.base.text.slice(m.index, m.index + m[0].length + 60);
    if (!ADDRESS_WORDS.test(around)) continue;
    add({ kind: 'address', confidence: 'low', view: v.base, from: m.index, to: m.index + m[0].length, label: 'Looks like part of a postal address' });
  }
  return raw;
}

function hostOf(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0]!;
}

// ------------------------------------------------------------------ stage 5: known tokens

const LEGAL_SUFFIX =
  /\s+(?:private limited|pvt\.? ltd\.?|pvt\.?|ltd\.?|limited|llp|inc\.?|& co\.?|and co\.?|co\.?)$/;
/** Words too common to identify anyone on their own. */
const GENERIC = new Set([
  'the', 'and', 'of', 'india', 'chennai', 'tamil', 'nadu', 'engineering', 'engineers', 'works', 'industries', 'industry',
  'enterprises', 'enterprise', 'precision', 'tools', 'tooling', 'components', 'manufacturing', 'manufacturers', 'products',
  'solutions', 'systems', 'technologies', 'tech', 'company', 'group', 'services', 'traders', 'trading', 'jobwork',
  'customer', 'supplier', 'machining', 'fabrication', 'fabricators', 'castings', 'forgings', 'pumps', 'motors',
]);

function normalizeToken(value: string): string {
  return baseView(value).text.replace(/[\s_\-‐-―]+/g, ' ').trim();
}

function nameTokens(value: string): string[] {
  const full = normalizeToken(value).replace(/[.,]+$/, '');
  const core = full.replace(LEGAL_SUFFIX, '').trim();
  return [...new Set([full, core])].filter(
    (token) => token.length >= 4 && token.split(' ').some((word) => !GENERIC.has(word) && word.length >= 3),
  );
}

function domainOf(value: string): string {
  const v = value.trim().toLowerCase();
  return hostOf(v.includes('@') ? v.split('@')[1]! : v);
}

function nationalDigits(value: string): string | null {
  return classifyPhone(value)?.national ?? (value.replace(/\D/g, '').length === 10 ? value.replace(/\D/g, '') : null);
}

const WORD = /[a-z0-9]/;
const DOMAIN_CHAR = /[a-z0-9-]/;

function partyLabel(party: RegistryParty, kind: RegistryEntry['kind']): string {
  const who = party === 'customer' ? 'a customer' : 'a supplier';
  return kind === 'name' ? `Names ${who}` : `Contact detail of ${who}`;
}

function knownTokens(v: Views, registry: Registry, detected: Raw[]): Raw[] {
  const raw: Raw[] = [];
  const names: Array<{ pattern: string; value: RegistryEntry }> = [];
  const domains: Array<{ pattern: string; value: RegistryEntry }> = [];
  const phones = new Map<string, RegistryEntry>();
  for (const entry of registry.shielded) {
    if (entry.kind === 'name') for (const token of nameTokens(entry.value)) names.push({ pattern: token, value: entry });
    if (entry.kind === 'domain' || entry.kind === 'email') {
      const token = entry.kind === 'email' ? entry.value.trim().toLowerCase() : domainOf(entry.value);
      if (token.length >= 4) domains.push({ pattern: token, value: entry });
    }
    if (entry.kind === 'phone') {
      const digits = nationalDigits(entry.value);
      if (digits) phones.set(digits, entry);
    }
  }

  for (const m of new AhoCorasick(names).search(v.words.text)) {
    const before = v.words.text[m.start - 1] ?? ' ';
    const after = v.words.text[m.end] ?? ' ';
    if (WORD.test(before) || WORD.test(after)) continue;
    raw.push({ kind: 'party_identity', confidence: 'high', view: v.words, from: m.start, to: m.end, label: partyLabel(m.value.party, 'name') });
  }
  for (const m of new AhoCorasick(domains).search(v.symbols.text)) {
    const before = v.symbols.text[m.start - 1] ?? ' ';
    const after = v.symbols.text[m.end] ?? ' ';
    if (DOMAIN_CHAR.test(before) || DOMAIN_CHAR.test(after)) continue;
    raw.push({ kind: 'party_identity', confidence: 'high', view: v.symbols, from: m.start, to: m.end, label: partyLabel(m.value.party, m.value.kind) });
  }
  for (const finding of detected) {
    if ((finding.kind === 'phone' || finding.kind === 'engineering_number') && finding.value) {
      const entry = phones.get(finding.value);
      if (entry) raw.push({ ...finding, kind: 'party_identity', confidence: 'high', label: partyLabel(entry.party, 'phone') });
    }
  }
  return raw;
}

// ------------------------------------------------------------------ assembly

function isAllowed(finding: Raw, registry: Registry): boolean {
  if (!finding.value) return false;
  for (const allowed of registry.allowed) {
    if (finding.kind === 'email' && allowed.kind === 'email' && finding.value === allowed.value.trim().toLowerCase()) return true;
    if ((finding.kind === 'email' || finding.kind === 'url') && allowed.kind === 'domain') {
      const host = domainOf(finding.value);
      const domain = domainOf(allowed.value);
      if (host === domain || host.endsWith(`.${domain}`)) return true;
    }
    if (finding.kind === 'phone' && allowed.kind === 'phone' && finding.value === nationalDigits(allowed.value)) return true;
  }
  return false;
}

function overlaps(a: { from: number; to: number }, b: { from: number; to: number }): boolean {
  return a.from < b.to && b.from < a.to;
}

/**
 * Every finding in `text`, against the original offsets, sorted by position. A web address
 * inside an email, or a handle inside one, is the same evidence and is reported once.
 */
export function scanText(text: string, registry: Registry): LeakageFinding[] {
  const v = views(text);
  const detected = detect(v).filter((finding) => !isAllowed(finding, registry));

  const emails = detected.filter((f) => f.kind === 'email').map(toOriginal);
  const contained = (f: Raw) => {
    const o = toOriginal(f);
    return emails.some((e) => overlaps(e, o));
  };
  const kept = detected.filter((f) => f.kind === 'email' || !((f.kind === 'url' || f.kind === 'handle') && contained(f)));

  // A registry domain inside a matched registry email is the same identity found twice.
  const parties = knownTokens(v, registry, kept);
  const outer = parties.map(toOriginal);
  const distinctParties = parties.filter((p, i) => {
    const o = outer[i]!;
    return !outer.some((other, j) => j !== i && other.from <= o.from && o.to <= other.to && other.to - other.from > o.to - o.from);
  });
  const all = [...kept, ...distinctParties];
  const seen = new Set<string>();
  const findings: LeakageFinding[] = [];
  for (const raw of all) {
    const { from, to } = toOriginal(raw);
    const key = `${raw.kind}:${from}:${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({ kind: raw.kind, confidence: raw.confidence, start: from, end: to, text: text.slice(from, to), label: raw.label });
  }
  return findings.sort((a, b) => a.start - b.start || b.end - a.end);
}

function toOriginal(raw: Raw): { from: number; to: number } {
  return { from: raw.view.start[raw.from]!, to: raw.view.end[raw.to - 1]! };
}

/** The doc 07 §12 "redacted derived" default: each flagged span replaced, the rest untouched. */
export function redact(text: string, findings: ReadonlyArray<Pick<LeakageFinding, 'start' | 'end'>>): string {
  const spans = [...findings].sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    if (span.end <= cursor) continue;
    out += text.slice(cursor, Math.max(cursor, span.start)) + '[removed]';
    cursor = span.end;
  }
  return out + text.slice(cursor);
}
