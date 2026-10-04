import { Rational } from './rational';

/**
 * Measurement evaluation (IN-14 F-14.2; doc 07 §14; doc 05 §9; doc 19 §6).
 *
 * - The value and both limits are converted as absolute values through the same exact affine
 *   map onto the dimension's normalized unit; a tolerance span is never converted.
 * - Each bound is compared with the inclusivity the characteristic stores, exactly, with no
 *   rounding before the comparison.
 * - An unknown unit, units of different dimensions, or a pair with no validated factor is
 *   "cannot evaluate", never a pass or fail by guess.
 * - The decision rule is simple acceptance (no guard band); its name is the rule version.
 */

export const MEASUREMENT_RULE_VERSION = 'MEAS-1';

/** Normalized values are kept exact for judging and shown to this many places. */
export const NORMALIZED_DISPLAY_PLACES = 6;

export type Dimension = 'length' | 'angle' | 'temperature' | 'mass' | 'torque' | 'hardness' | 'count';

export interface UnitDefinition {
  code: string;
  dimension: Dimension;
  isNormalized: boolean;
}

/** normalized = value × factor + offset, onto the normalized unit of the same dimension. */
export interface Conversion {
  from: string;
  to: string;
  factor: Rational;
  offset: Rational;
}

export interface ConversionTable {
  versionId: string;
  units: ReadonlyMap<string, UnitDefinition>;
  toNormalized: ReadonlyMap<string, Conversion>;
}

export interface Bound {
  value: string;
  inclusive: boolean;
}

export type CharacteristicRule =
  | { kind: 'variable'; unit: string; lower: Bound | null; upper: Bound | null }
  | { kind: 'attribute'; acceptedValues: readonly string[] };

export interface Measurement {
  value: string;
  unit: string | null;
  declaredPrecision: number | null;
}

export type Outcome = 'pass' | 'fail' | 'cannot_evaluate';

export interface Evaluation {
  outcome: Outcome;
  reason: string;
  normalized: { value: string; unit: string } | null;
  ruleVersion: string;
  conversionVersionId: string | null;
}

/** The input itself is malformed: the submitter must fix it, nothing is judged. */
export class MeasurementRefused extends Error {
  constructor(
    readonly code: 'MEASUREMENT_MALFORMED' | 'MEASUREMENT_PRECISION' | 'MEASUREMENT_UNIT_UNEXPECTED',
    message: string,
  ) {
    super(message);
  }
}

const result = (outcome: Outcome, reason: string, normalized: Evaluation['normalized'], conversionVersionId: string | null): Evaluation => ({
  outcome,
  reason,
  normalized,
  ruleVersion: MEASUREMENT_RULE_VERSION,
  conversionVersionId,
});

/** The map from `unit` onto its dimension's normalized unit, or null when none is validated. */
function mapping(unit: UnitDefinition, table: ConversionTable): { to: string; apply: (v: Rational) => Rational } | null {
  if (unit.isNormalized) return { to: unit.code, apply: (v) => v };
  const c = table.toNormalized.get(unit.code);
  if (!c) return null;
  return { to: c.to, apply: (v) => v.mul(c.factor).add(c.offset) };
}

export function evaluate(measurement: Measurement, rule: CharacteristicRule, table: ConversionTable): Evaluation {
  if (rule.kind === 'attribute') {
    if (measurement.unit !== null) throw new MeasurementRefused('MEASUREMENT_UNIT_UNEXPECTED', 'An attribute result has no unit');
    const value = measurement.value.trim();
    if (value.length === 0) throw new MeasurementRefused('MEASUREMENT_MALFORMED', 'An attribute result needs a value');
    return rule.acceptedValues.includes(value)
      ? result('pass', `"${value}" is accepted`, null, null)
      : result('fail', `"${value}" is not one of: ${rule.acceptedValues.join(', ')}`, null, null);
  }

  if (!Rational.isDecimal(measurement.value)) throw new MeasurementRefused('MEASUREMENT_MALFORMED', `"${measurement.value}" is not a decimal number`);
  if (measurement.declaredPrecision === null || !Number.isInteger(measurement.declaredPrecision) || measurement.declaredPrecision < 0 || measurement.declaredPrecision > 12) {
    throw new MeasurementRefused('MEASUREMENT_PRECISION', 'A measured value needs its declared precision (0–12 decimal places)');
  }
  if (Rational.places(measurement.value) > measurement.declaredPrecision) {
    throw new MeasurementRefused('MEASUREMENT_PRECISION', `"${measurement.value}" has more decimal places than its declared precision of ${measurement.declaredPrecision}`);
  }
  const value = Rational.parse(measurement.value);
  const unitCode = measurement.unit ?? '';
  const given = table.units.get(unitCode);
  const specified = table.units.get(rule.unit);
  if (!given) return result('cannot_evaluate', `Unknown unit "${unitCode}"`, null, null);
  if (!specified) return result('cannot_evaluate', `Unknown unit "${rule.unit}" on the characteristic`, null, null);
  if (given.dimension !== specified.dimension) {
    return result('cannot_evaluate', `${given.code} (${given.dimension}) cannot be compared with ${specified.code} (${specified.dimension})`, null, null);
  }
  if (given.dimension === 'count' && !value.isInteger()) return result('cannot_evaluate', 'A count must be a whole number', null, null);

  // Same unit: compare as written; the normalized form is still recorded where one exists.
  if (given.code === specified.code) {
    const m = mapping(given, table);
    const normalized = m ? { value: m.apply(value).toDisplay(NORMALIZED_DISPLAY_PLACES), unit: m.to } : { value: value.toDisplay(NORMALIZED_DISPLAY_PLACES), unit: given.code };
    return judge(value, rule, (limit) => limit, normalized, m && !given.isNormalized ? table.versionId : null);
  }
  // Different units: the value and both limits go onto the normalized unit through their own maps.
  const fromGiven = mapping(given, table);
  const fromSpecified = mapping(specified, table);
  if (!fromGiven || !fromSpecified) {
    return result('cannot_evaluate', `No validated conversion for ${!fromGiven ? given.code : specified.code} (${given.dimension})`, null, null);
  }
  const normalizedValue = fromGiven.apply(value);
  return judge(normalizedValue, rule, fromSpecified.apply, { value: normalizedValue.toDisplay(NORMALIZED_DISPLAY_PLACES), unit: fromGiven.to }, table.versionId);
}

function judge(
  v: Rational,
  rule: Extract<CharacteristicRule, { kind: 'variable' }>,
  limitOnScale: (limit: Rational) => Rational,
  normalized: { value: string; unit: string },
  conversionVersionId: string | null,
): Evaluation {
  const lower = rule.lower ? { at: limitOnScale(Rational.parse(rule.lower.value)), inclusive: rule.lower.inclusive, text: rule.lower.value } : null;
  const upper = rule.upper ? { at: limitOnScale(Rational.parse(rule.upper.value)), inclusive: rule.upper.inclusive, text: rule.upper.value } : null;
  if (lower) {
    const c = v.compare(lower.at);
    if (c < 0 || (c === 0 && !lower.inclusive)) {
      return result('fail', `Below the lower limit ${lower.text} ${rule.unit} (${lower.inclusive ? 'inclusive' : 'exclusive'})`, normalized, conversionVersionId);
    }
  }
  if (upper) {
    const c = v.compare(upper.at);
    if (c > 0 || (c === 0 && !upper.inclusive)) {
      return result('fail', `Above the upper limit ${upper.text} ${rule.unit} (${upper.inclusive ? 'inclusive' : 'exclusive'})`, normalized, conversionVersionId);
    }
  }
  return result('pass', 'Within limits', normalized, conversionVersionId);
}
