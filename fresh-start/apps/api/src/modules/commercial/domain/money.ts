/**
 * Integer money (doc 02, doc 10 §3). Every figure here is a whole number of minor units;
 * a rupee never touches a float. Rounding is half-up and happens exactly once per line,
 * so a total is reproducible from its stored inputs (`BR-COM-10`).
 */

/** Round a rational `numerator / denominator` to the nearest integer, half away from zero. */
export function roundDiv(numerator: number, denominator: number): number {
  if (denominator === 0) throw new Error('division by zero');
  const sign = Math.sign(numerator) * Math.sign(denominator) || 1;
  const n = Math.abs(numerator);
  const d = Math.abs(denominator);
  const q = Math.floor(n / d);
  const r = n - q * d;
  return sign * (r * 2 >= d ? q + 1 : q);
}

/** `amount × bp / 10000`, rounded half-up. */
export function applyBasisPoints(amountMinor: number, bp: number): number {
  return roundDiv(amountMinor * bp, 10_000);
}

/** A quantity (fixed precision, possibly fractional) times a unit price, rounded once. */
export function lineAmount(unitPriceMinor: number, quantity: number): number {
  // Quantities carry up to four decimals (numeric(18,4)); scale them to integers first so
  // 3.3333 × 100 does not pick up binary noise before rounding.
  const scaled = Math.round(quantity * 10_000);
  return roundDiv(unitPriceMinor * scaled, 10_000);
}

/**
 * Largest-remainder allocation of `totalMinor` across weights (doc 07 §4). Conserves
 * every minor unit: the parts always sum to the total. Ties are broken by position, so
 * the same inputs allocate the same way every time.
 */
export function allocateByWeights(totalMinor: number, weights: readonly number[]): number[] {
  if (weights.length === 0) return [];
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return allocateEqually(totalMinor, weights.length);
  const raw = weights.map((w) => (totalMinor * w) / sum);
  const floors = raw.map((v) => Math.floor(v));
  let remainder = totalMinor - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  const out = [...floors];
  for (const { i } of order) {
    if (remainder <= 0) break;
    out[i] = out[i]! + 1;
    remainder -= 1;
  }
  return out;
}

export function allocateEqually(totalMinor: number, parts: number): number[] {
  if (parts === 0) return [];
  const base = Math.floor(totalMinor / parts);
  let remainder = totalMinor - base * parts;
  return Array.from({ length: parts }, () => {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    return base + extra;
  });
}

/** Tax on an ex-tax subtotal at a basis-point rate. */
export function taxOn(subtotalMinor: number, rateBp: number): number {
  return applyBasisPoints(subtotalMinor, rateBp);
}

/** Strip an embedded tax from an inclusive figure: `inclusive × 10000 / (10000 + rateBp)`. */
export function exclusiveOf(inclusiveMinor: number, rateBp: number): number {
  return roundDiv(inclusiveMinor * 10_000, 10_000 + rateBp);
}

/** Margin on sell price in basis points: `(sell − landed) / sell × 10000`. */
export function marginBpOf(sellMinor: number, landedMinor: number): number {
  if (sellMinor <= 0) return landedMinor === 0 ? 0 : -10_000;
  return roundDiv((sellMinor - landedMinor) * 10_000, sellMinor);
}

/** Sell price that yields a target margin on sell: `landed × 10000 / (10000 − bp)`. */
export function sellForMargin(landedMinor: number, targetMarginBp: number): number {
  if (targetMarginBp >= 10_000) throw new Error('margin must be below 100 %');
  return roundDiv(landedMinor * 10_000, 10_000 - targetMarginBp);
}
