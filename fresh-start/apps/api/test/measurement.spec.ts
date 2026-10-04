import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CONVERSIONS_V1, MEASUREMENT_GOLDEN, UNITS_V1 } from '@jobwork/test-kit';
import { type CharacteristicRule, type ConversionTable, evaluate, MeasurementRefused } from '../src/modules/quality/domain/measurement';
import { Rational } from '../src/modules/quality/domain/rational';

/** The v1 reference data exactly as migration 0022 seeds it. */
const TABLE_V1: ConversionTable = {
  versionId: 'v1',
  units: new Map(UNITS_V1.map((u) => [u.code, { code: u.code, dimension: u.dimension, isNormalized: u.isNormalized }])),
  toNormalized: new Map(CONVERSIONS_V1.map((c) => [c.from, { from: c.from, to: c.to, factor: Rational.of(c.factor[0], c.factor[1]), offset: Rational.of(c.offset[0], c.offset[1]) }])),
};

/** A decimal string with exactly `places` digits after the point, from an integer count of units in the last place. */
const decimal = (units: bigint, places: number): string => {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(places + 1, '0');
  const whole = digits.slice(0, digits.length - places);
  const fraction = digits.slice(digits.length - places);
  return `${negative ? '-' : ''}${whole}${places > 0 ? `.${fraction}` : ''}`;
};

const value = (places: number) => fc.bigInt({ min: -10_000_000n, max: 10_000_000n }).map((u) => decimal(u, places));

describe('measurement engine (F-14.2)', () => {
  describe('golden cases, hand-computed (doc 13 §9)', () => {
    for (const g of MEASUREMENT_GOLDEN) {
      it(g.name, () => {
        const rule = g.characteristic as CharacteristicRule;
        if ('refused' in g.expected) {
          const code = g.expected.refused;
          expect(() => evaluate(g.measurement, rule, TABLE_V1)).toThrow(MeasurementRefused);
          try {
            evaluate(g.measurement, rule, TABLE_V1);
          } catch (err) {
            expect((err as MeasurementRefused).code, g.working).toBe(code);
          }
          return;
        }
        const e = evaluate(g.measurement, rule, TABLE_V1);
        expect({ outcome: e.outcome, normalized: e.normalized }, g.working).toEqual(g.expected);
        expect(e.ruleVersion).toBe('MEAS-1');
        if (e.outcome === 'cannot_evaluate') expect(e.reason.length).toBeGreaterThan(0);
      });
    }
  });

  it('names the conversion version only when a conversion was used', () => {
    const inMm = evaluate({ value: '12', unit: 'mm', declaredPrecision: 0 }, { kind: 'variable', unit: 'mm', lower: null, upper: { value: '13', inclusive: true } }, TABLE_V1);
    const inInch = evaluate({ value: '0.5', unit: 'inch', declaredPrecision: 1 }, { kind: 'variable', unit: 'mm', lower: null, upper: { value: '13', inclusive: true } }, TABLE_V1);
    expect([inMm.conversionVersionId, inInch.conversionVersionId]).toEqual([null, 'v1']);
  });

  describe('properties (doc 13 §3)', () => {
    const band = fc
      .tuple(value(3), value(3), fc.boolean(), fc.boolean())
      .filter(([a, b]) => Rational.parse(a).compare(Rational.parse(b)) < 0)
      .map(([lower, upper, li, ui]): CharacteristicRule => ({ kind: 'variable', unit: 'mm', lower: { value: lower, inclusive: li }, upper: { value: upper, inclusive: ui } }));

    it('is deterministic', () => {
      fc.assert(
        fc.property(band, value(3), (rule, v) => {
          const m = { value: v, unit: 'mm', declaredPrecision: 3 };
          expect(evaluate(m, rule, TABLE_V1)).toEqual(evaluate(m, rule, TABLE_V1));
        }),
      );
    });

    it('gives the same outcome in inches as in the exact millimetre equivalent', () => {
      fc.assert(
        fc.property(band, fc.bigInt({ min: -400_000n, max: 400_000n }), (rule, units) => {
          const inches = decimal(units, 4);
          const millimetres = decimal(units * 254n, 5); // × 25.4 adds exactly one place
          const a = evaluate({ value: inches, unit: 'inch', declaredPrecision: 4 }, rule, TABLE_V1);
          const b = evaluate({ value: millimetres, unit: 'mm', declaredPrecision: 5 }, rule, TABLE_V1);
          expect(a.outcome).toBe(b.outcome);
          expect(Rational.parse(a.normalized!.value).compare(Rational.parse(millimetres))).toBe(0);
        }),
      );
    });

    it('passes everything between two passing values (no premature rounding makes a hole)', () => {
      fc.assert(
        fc.property(band, value(4), value(4), value(4), (rule, x, y, z) => {
          const [a, b, c] = [x, y, z].sort((p, q) => Rational.parse(p).compare(Rational.parse(q)));
          const at = (v: string) => evaluate({ value: v, unit: 'mm', declaredPrecision: 4 }, rule, TABLE_V1).outcome;
          if (at(a!) === 'pass' && at(c!) === 'pass') expect(at(b!)).toBe('pass');
        }),
      );
    });

    it('never passes a value outside a bound by any amount, however small', () => {
      fc.assert(
        fc.property(band, fc.bigInt({ min: 1n, max: 1_000_000n }), fc.integer({ min: 4, max: 12 }), (rule, units, places) => {
          if (rule.kind !== 'variable') return;
          const epsilon = Rational.of(units, 10n ** BigInt(places));
          const below = Rational.parse(rule.lower!.value).sub(epsilon);
          const above = Rational.parse(rule.upper!.value).add(epsilon);
          const show = (r: Rational) => r.toDisplay(12);
          expect(evaluate({ value: show(below), unit: 'mm', declaredPrecision: 12 }, rule, TABLE_V1).outcome).toBe('fail');
          expect(evaluate({ value: show(above), unit: 'mm', declaredPrecision: 12 }, rule, TABLE_V1).outcome).toBe('fail');
        }),
      );
    });

    it('round-trips a decimal through Rational exactly', () => {
      fc.assert(
        fc.property(value(6), (v) => {
          expect(Rational.parse(Rational.parse(v).toDisplay(6)).compare(Rational.parse(v))).toBe(0);
        }),
      );
    });
  });

  it('rounds for display half-even, never for judging', () => {
    expect(Rational.of(5, 100).toDisplay(1)).toBe('0'); // 0.05 → 0.0 (even)
    expect(Rational.of(15, 100).toDisplay(1)).toBe('0.2'); // 0.15 → 0.2 (even)
    expect(Rational.of(-25, 100).toDisplay(1)).toBe('-0.2');
    expect(Rational.of(2, 3).toDisplay(6)).toBe('0.666667');
    // 37.7̅ °C passes a 37.7777778 upper limit and fails 37.7777777: judged exactly, not as the displayed 37.777778.
    const rule: CharacteristicRule = { kind: 'variable', unit: 'degC', lower: null, upper: { value: '37.7777778', inclusive: true } };
    expect(evaluate({ value: '100', unit: 'degF', declaredPrecision: 0 }, rule, TABLE_V1).outcome).toBe('pass');
    const tighter: CharacteristicRule = { kind: 'variable', unit: 'degC', lower: null, upper: { value: '37.7777777', inclusive: true } };
    expect(evaluate({ value: '100', unit: 'degF', declaredPrecision: 0 }, tighter, TABLE_V1).outcome).toBe('fail');
  });
});
