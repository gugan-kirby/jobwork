import { expect } from 'vitest';

const PUBLIC_CARD = ['city', 'name', 'ratingAverage', 'ratingCount', 'state', 'verified'];

/**
 * ADR-0007: a customer payload may carry the supplier's public card and nothing else about
 * it. This checks each card holds only public fields and hands back the payload without
 * them, so the shield tests go on refusing every other trace of the buy side.
 */
export function withoutSupplierCard<T>(value: T): T {
  if (Array.isArray(value)) return value.map((row) => withoutSupplierCard(row)) as T;
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (key === 'supplier') {
      if (inner !== null) expect(Object.keys(inner as object).sort()).toEqual(PUBLIC_CARD);
      continue;
    }
    out[key] = withoutSupplierCard(inner);
  }
  return out as T;
}
