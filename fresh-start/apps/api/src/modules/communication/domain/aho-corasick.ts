/**
 * Multi-pattern matcher for the known-token stage of contact-leakage detection
 * (doc 07 §12 stage 5). Construction is O(total pattern length); a scan is
 * O(text length + matches), whatever the number of names in the registry.
 */
export interface Match<T> {
  /** Offset of the first matched character. */
  start: number;
  /** Offset one past the last matched character. */
  end: number;
  value: T;
}

export class AhoCorasick<T> {
  private readonly next: Array<Map<string, number>> = [new Map()];
  private readonly fail: number[] = [0];
  private readonly output: Array<Array<{ length: number; value: T }>> = [[]];

  constructor(patterns: ReadonlyArray<{ pattern: string; value: T }>) {
    for (const { pattern, value } of patterns) {
      if (pattern.length === 0) continue;
      let state = 0;
      for (const ch of pattern) {
        let target = this.next[state]!.get(ch);
        if (target === undefined) {
          target = this.next.length;
          this.next.push(new Map());
          this.fail.push(0);
          this.output.push([]);
          this.next[state]!.set(ch, target);
        }
        state = target;
      }
      this.output[state]!.push({ length: pattern.length, value });
    }

    // Breadth-first: a state's failure link is the longest proper suffix that is also a
    // prefix in the trie, and it inherits that state's outputs.
    const queue: number[] = [];
    for (const child of this.next[0]!.values()) queue.push(child);
    while (queue.length > 0) {
      const state = queue.shift()!;
      for (const [ch, child] of this.next[state]!) {
        queue.push(child);
        let f = this.fail[state]!;
        while (f !== 0 && !this.next[f]!.has(ch)) f = this.fail[f]!;
        const candidate = this.next[f]!.get(ch);
        this.fail[child] = candidate !== undefined && candidate !== child ? candidate : 0;
        this.output[child]!.push(...this.output[this.fail[child]!]!);
      }
    }
  }

  search(text: string): Array<Match<T>> {
    const matches: Array<Match<T>> = [];
    let state = 0;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i]!;
      while (state !== 0 && !this.next[state]!.has(ch)) state = this.fail[state]!;
      state = this.next[state]!.get(ch) ?? 0;
      for (const { length, value } of this.output[state]!) {
        matches.push({ start: i - length + 1, end: i + 1, value });
      }
    }
    return matches;
  }
}
