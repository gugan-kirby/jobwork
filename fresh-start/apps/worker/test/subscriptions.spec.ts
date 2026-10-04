import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NOTIFIED_EVENT_TYPES } from '@jobwork/contracts';
import { ACKNOWLEDGED_EVENT_TYPES, HANDLED_EVENT_TYPES } from '../src/outbox/subscriptions';

const API_SRC = join(__dirname, '..', '..', 'api', 'src');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : path.endsWith('.ts') ? [path] : [];
  });
}

/**
 * Every event type the API commits to the outbox, read from its source: the literals in
 * every outbox spec's `eventType:` expression, communication's `messageEvent(…)` and the change command's `this.event(…)`
 * helper, plus the one templated family (supplier
 * onboarding decisions, `supplier.${verb}.v1`) expanded from its verb table. A new
 * template fails the suite until it is expanded here too.
 */
function emittedEventTypes(): Map<string, string> {
  const found = new Map<string, string>();
  // Outbox specs are built by commands (`application/`); adapters elsewhere speak their
  // providers' vocabularies (a payment gateway's `payment.captured` is not ours).
  for (const file of sources(API_SRC).filter((f) => f.includes('/application/'))) {
    const text = readFileSync(file, 'utf8');
    // `eventType:` up to the end of its expression, so a conditional over two types counts both.
    for (const m of text.matchAll(/eventType:([\s\S]*?),\n/g)) {
      for (const lit of m[1]!.matchAll(/'([a-z0-9_]+\.[a-z0-9_.]+)'/g)) found.set(lit[1]!, file);
    }
    // Communication builds its message events through one helper.
    for (const m of text.matchAll(/messageEvent\(\s*'([a-z0-9_.]+)'/g)) found.set(m[1]!, file);
    // IN-13's change command builds its events through `this.event(change, version, '…')`.
    for (const m of text.matchAll(/this\.event\([^,]+,[^,]+,\s*'([a-z0-9_]+\.[a-z0-9_.]+)'/g)) found.set(m[1]!, file);
    for (const m of text.matchAll(/eventType:\s*`([^`]+)`/g)) {
      if (m[1] !== 'supplier.${rule.verb}.v1') throw new Error(`unexpanded event type template ${m[1]} in ${file}`);
      for (const v of text.matchAll(/verb:\s*'([a-z_]+)'/g)) found.set(`supplier.${v[1]}.v1`, file);
    }
  }
  return found;
}

/**
 * F-11.3: an event type the worker has no handler for is dead-lettered on its first
 * attempt. The new dead-letter alert found five of them on the first scrape — every
 * supplier onboarding decision since F-SO — so the lists are now held to the source.
 */
describe('worker outbox subscriptions (F-11.3)', () => {
  const handled = new Set<string>([...HANDLED_EVENT_TYPES, ...ACKNOWLEDGED_EVENT_TYPES, ...NOTIFIED_EVENT_TYPES]);

  it('handles, notifies or acknowledges every event type the API commits', () => {
    const emitted = emittedEventTypes();
    expect(emitted.size).toBeGreaterThan(50);
    const orphans = [...emitted.entries()].filter(([type]) => !handled.has(type)).map(([type, file]) => `${type} (${file.split('/src/')[1]})`);
    expect(orphans).toEqual([]);
  });

  it('subscribes each type exactly once', () => {
    const all = [...HANDLED_EVENT_TYPES, ...ACKNOWLEDGED_EVENT_TYPES, ...NOTIFIED_EVENT_TYPES];
    expect(all.filter((t, i) => all.indexOf(t) !== i)).toEqual([]);
  });

  it('lists nothing the API no longer commits', () => {
    const emitted = emittedEventTypes();
    expect([...ACKNOWLEDGED_EVENT_TYPES, ...HANDLED_EVENT_TYPES].filter((t) => !emitted.has(t))).toEqual([]);
  });
});
