import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * F-12.3 (doc 11 §16 "audit coverage verified for all critical commands"; BR-SYS-02,
 * BR-SYS-05). The inventory is read from source, so a new command cannot slip in
 * unaudited:
 *
 * - every command run through the executor returns a non-empty `audit` on its working
 *   path (an early `audit: []` is allowed only for a no-op: a duplicate, an unchanged state);
 * - every audit written outside the executor goes through `AuditWriter.write(client, …)`,
 *   whose client parameter is a transaction client by type, so it cannot be written after
 *   the commit of the change it records;
 * - the inventory itself is a committed snapshot: adding, renaming or removing a command
 *   or a direct audit shows up in review.
 */
const SRC = join(__dirname, '..', 'src');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [path] : [];
  });
}

interface Operation {
  name: string;
  file: string;
  body: string;
}

/** Each `operation: '…'` and the source up to the next one: its handler. */
function operations(): Operation[] {
  const found: Operation[] = [];
  for (const path of sources(SRC)) {
    const text = readFileSync(path, 'utf8');
    const hits = [...text.matchAll(/operation: '([a-z0-9._-]+)'/g)];
    hits.forEach((hit, i) => {
      const end = i + 1 < hits.length ? hits[i + 1]!.index : text.length;
      found.push({ name: hit[1]!, file: relative(SRC, path), body: text.slice(hit.index, end) });
    });
    // IN-13: transitions run through the change command's `move()`, which always returns
    // one audit row for its transition; they are listed, and their body is that helper.
    // Helpers that run one executor command per call and write its audit themselves: `move` (IN-13, IN-15) and `correctiveCommand` (IN-15).
    for (const hit of text.matchAll(/this\.(?:move|correctiveCommand)\(\s*actor,\s*\w+,\s*'([a-z0-9._-]+)'/g)) {
      found.push({ name: hit[1]!, file: relative(SRC, path), body: 'audit: [this.audit(change, version, plan.action)]' });
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** The argument text of the call whose `(` is at `open`, skipping parentheses inside strings. */
function callArguments(text: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(') depth += 1;
    else if (ch === ')' && --depth === 0) return text.slice(open + 1, i);
  }
  return '';
}

/** Audit rows written directly (outside the executor), with the action they record. */
function directAudits(): string[] {
  const lines: string[] = [];
  for (const path of sources(SRC)) {
    if (path.includes(join('platform', 'commands'))) continue;
    const text = readFileSync(path, 'utf8');
    for (const call of text.matchAll(/(?:audit(?:Writer)?\.write|(?<!async )auditSecurity)\(/g)) {
      const args = callArguments(text, call.index + call[0].length - 1);
      for (const action of args.matchAll(/'([a-z_]+(?:\.[a-z_]+)+)'/g)) lines.push(`${relative(SRC, path)}  ${action[1]}`);
    }
  }
  return [...new Set(lines)].sort();
}

describe('audit coverage (F-12.3)', () => {
  const ops = operations();

  it('finds the command inventory', () => {
    expect(ops.length).toBeGreaterThan(80);
    const names = ops.map((o) => o.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('has every command record what it did', () => {
    const silent = ops.filter((op) => {
      const audits = [...op.body.matchAll(/audit:\s*([^,}\n]+)/g)].map((m) => m[1]!.trim());
      const nonEmpty = audits.some((value) => value !== '[]');
      return !nonEmpty && !/audit\.push\(/.test(op.body);
    });
    expect(silent.map((op) => `${op.name} (${op.file})`)).toEqual([]);
  });

  it('writes no audit row outside a transaction', () => {
    const outside: string[] = [];
    for (const path of sources(SRC)) {
      const text = readFileSync(path, 'utf8');
      if (/\.write\(null\b/.test(text) || /\.write\(this\.db\.pool\b/.test(text)) outside.push(relative(SRC, path));
    }
    expect(outside).toEqual([]);
  });

  it('matches the reviewed inventory', async () => {
    const inventory = [
      '# Commands run through the executor (operation  file)',
      ...ops.map((op) => `${op.name}  ${op.file}`),
      '',
      '# Audit rows written directly, inside the caller’s transaction (file  action)',
      ...directAudits(),
      '',
    ].join('\n');
    await expect(inventory).toMatchFileSnapshot('./__snapshots__/audit-inventory.txt');
  });
});
