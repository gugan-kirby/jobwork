/**
 * Golden measurement cases (IN-14 F-14.2; doc 13 §9; doc 07 §§14, 18). Each expected outcome is
 * worked by hand in `working`, independently of the engine, and is the reference the engine is
 * held to. Units and conversions mirror migration 0022's v1 seed exactly; the API suite checks
 * that the database still says the same.
 */

export type GoldenBound = { value: string; inclusive: boolean } | null;

export type GoldenCharacteristic =
  | { kind: 'variable'; unit: string; lower: GoldenBound; upper: GoldenBound }
  | { kind: 'attribute'; acceptedValues: string[] };

export interface GoldenMeasurementCase {
  name: string;
  characteristic: GoldenCharacteristic;
  measurement: { value: string; unit: string | null; declaredPrecision: number | null };
  expected:
    | { outcome: 'pass' | 'fail' | 'cannot_evaluate'; normalized: { value: string; unit: string } | null }
    | { refused: 'MEASUREMENT_MALFORMED' | 'MEASUREMENT_PRECISION' | 'MEASUREMENT_UNIT_UNEXPECTED' };
  working: string;
}

export const UNITS_V1 = [
  { code: 'mm', dimension: 'length', isNormalized: true },
  { code: 'um', dimension: 'length', isNormalized: false },
  { code: 'm', dimension: 'length', isNormalized: false },
  { code: 'inch', dimension: 'length', isNormalized: false },
  { code: 'deg', dimension: 'angle', isNormalized: true },
  { code: 'degC', dimension: 'temperature', isNormalized: true },
  { code: 'degF', dimension: 'temperature', isNormalized: false },
  { code: 'K', dimension: 'temperature', isNormalized: false },
  { code: 'kg', dimension: 'mass', isNormalized: true },
  { code: 'g', dimension: 'mass', isNormalized: false },
  { code: 'N_m', dimension: 'torque', isNormalized: true },
  { code: 'HRC', dimension: 'hardness', isNormalized: false },
  { code: 'HRB', dimension: 'hardness', isNormalized: false },
  { code: 'HV', dimension: 'hardness', isNormalized: false },
  { code: 'count', dimension: 'count', isNormalized: true },
] as const;

/** normalized = value × factor + offset; [numerator, denominator]. */
export const CONVERSIONS_V1 = [
  { from: 'um', to: 'mm', factor: [1, 1000], offset: [0, 1] },
  { from: 'm', to: 'mm', factor: [1000, 1], offset: [0, 1] },
  { from: 'inch', to: 'mm', factor: [254, 10], offset: [0, 1] },
  { from: 'degF', to: 'degC', factor: [5, 9], offset: [-160, 9] },
  { from: 'K', to: 'degC', factor: [1, 1], offset: [-27315, 100] },
  { from: 'g', to: 'kg', factor: [1, 1000], offset: [0, 1] },
] as const;

const bore = (inclusive: boolean): GoldenCharacteristic => ({ kind: 'variable', unit: 'mm', lower: { value: '11.98', inclusive }, upper: { value: '12.02', inclusive } });
const mm = (value: string, places: number) => ({ value, unit: 'mm', declaredPrecision: places });

export const MEASUREMENT_GOLDEN: GoldenMeasurementCase[] = [
  // ------------------------------------------------------------- boundaries (doc 19 §6)
  { name: 'on the lower limit, inclusive', characteristic: bore(true), measurement: mm('11.98', 2), expected: { outcome: 'pass', normalized: { value: '11.98', unit: 'mm' } }, working: '11.98 ≥ 11.98 holds for an inclusive bound' },
  { name: 'on the upper limit, inclusive', characteristic: bore(true), measurement: mm('12.020', 3), expected: { outcome: 'pass', normalized: { value: '12.02', unit: 'mm' } }, working: '12.020 = 12.02 ≤ 12.02' },
  { name: 'one digit below the lower limit', characteristic: bore(true), measurement: mm('11.979', 3), expected: { outcome: 'fail', normalized: { value: '11.979', unit: 'mm' } }, working: '11.979 < 11.98' },
  { name: 'one digit above the upper limit', characteristic: bore(true), measurement: mm('12.021', 3), expected: { outcome: 'fail', normalized: { value: '12.021', unit: 'mm' } }, working: '12.021 > 12.02' },
  { name: 'just inside', characteristic: bore(true), measurement: mm('11.981', 3), expected: { outcome: 'pass', normalized: { value: '11.981', unit: 'mm' } }, working: '11.98 < 11.981 < 12.02' },
  { name: 'on the lower limit, exclusive', characteristic: bore(false), measurement: mm('11.98', 2), expected: { outcome: 'fail', normalized: { value: '11.98', unit: 'mm' } }, working: '11.98 > 11.98 is false for an exclusive bound' },
  { name: 'on the upper limit, exclusive', characteristic: bore(false), measurement: mm('12.02', 2), expected: { outcome: 'fail', normalized: { value: '12.02', unit: 'mm' } }, working: '12.02 < 12.02 is false' },
  { name: 'just inside an exclusive bound', characteristic: bore(false), measurement: mm('11.9801', 4), expected: { outcome: 'pass', normalized: { value: '11.9801', unit: 'mm' } }, working: '11.9801 > 11.98' },
  // ------------------------------------------------------------- negative values
  { name: 'negative limit, on it', characteristic: { kind: 'variable', unit: 'mm', lower: { value: '-0.05', inclusive: true }, upper: { value: '0.05', inclusive: true } }, measurement: mm('-0.050', 3), expected: { outcome: 'pass', normalized: { value: '-0.05', unit: 'mm' } }, working: '−0.050 ≥ −0.05' },
  { name: 'negative limit, beyond it', characteristic: { kind: 'variable', unit: 'mm', lower: { value: '-0.05', inclusive: true }, upper: { value: '0.05', inclusive: true } }, measurement: mm('-0.051', 3), expected: { outcome: 'fail', normalized: { value: '-0.051', unit: 'mm' } }, working: '−0.051 < −0.05' },
  // ------------------------------------------------------------- unit conversion (exact)
  { name: 'inches against a millimetre bore', characteristic: bore(true), measurement: { value: '0.4724', unit: 'inch', declaredPrecision: 4 }, expected: { outcome: 'pass', normalized: { value: '11.99896', unit: 'mm' } }, working: '0.4724 × 25.4 = 11.99896; 11.98 ≤ 11.99896 ≤ 12.02' },
  { name: 'inches just under the bore', characteristic: bore(true), measurement: { value: '0.4716', unit: 'inch', declaredPrecision: 4 }, expected: { outcome: 'fail', normalized: { value: '11.97864', unit: 'mm' } }, working: '0.4716 × 25.4 = 11.97864 < 11.98' },
  {
    name: 'exactly on a limit after conversion, where floating point says otherwise',
    characteristic: { kind: 'variable', unit: 'mm', lower: null, upper: { value: '2.54', inclusive: true } },
    measurement: { value: '0.1', unit: 'inch', declaredPrecision: 1 },
    expected: { outcome: 'pass', normalized: { value: '2.54', unit: 'mm' } },
    working: '0.1 × 25.4 = 2.54 exactly ≤ 2.54. In binary floating point 0.1 * 25.4 = 2.5400000000000005, which would fail',
  },
  { name: 'micrometres against a micrometre limit, measured in millimetres', characteristic: { kind: 'variable', unit: 'um', lower: null, upper: { value: '3.2', inclusive: true } }, measurement: mm('0.0032', 4), expected: { outcome: 'pass', normalized: { value: '0.0032', unit: 'mm' } }, working: 'limit 3.2 µm × 1/1000 = 0.0032 mm; 0.0032 ≤ 0.0032' },
  { name: 'surface finish over its limit', characteristic: { kind: 'variable', unit: 'um', lower: null, upper: { value: '3.2', inclusive: true } }, measurement: mm('0.0033', 4), expected: { outcome: 'fail', normalized: { value: '0.0033', unit: 'mm' } }, working: '0.0033 mm > 0.0032 mm' },
  { name: 'same non-normalized unit still records the normalized value', characteristic: { kind: 'variable', unit: 'inch', lower: { value: '0.47', inclusive: true }, upper: { value: '0.48', inclusive: true } }, measurement: { value: '0.4724', unit: 'inch', declaredPrecision: 4 }, expected: { outcome: 'pass', normalized: { value: '11.99896', unit: 'mm' } }, working: '0.47 ≤ 0.4724 ≤ 0.48 compared in inches; normalized 0.4724 × 25.4 = 11.99896 mm' },
  // ------------------------------------------------------------- offset units (°F, K)
  { name: '100 °F inside a Celsius band', characteristic: { kind: 'variable', unit: 'degC', lower: { value: '37.5', inclusive: true }, upper: { value: '38.0', inclusive: true } }, measurement: { value: '100', unit: 'degF', declaredPrecision: 0 }, expected: { outcome: 'pass', normalized: { value: '37.777778', unit: 'degC' } }, working: '(100 − 32) × 5/9 = 340/9 = 37.7̅ exactly; shown to 6 places, half-even' },
  { name: '99.5 °F exactly on the lower Celsius limit', characteristic: { kind: 'variable', unit: 'degC', lower: { value: '37.5', inclusive: true }, upper: { value: '38.0', inclusive: true } }, measurement: { value: '99.5', unit: 'degF', declaredPrecision: 1 }, expected: { outcome: 'pass', normalized: { value: '37.5', unit: 'degC' } }, working: '(99.5 − 32) × 5/9 = 67.5 × 5/9 = 37.5' },
  { name: 'a Fahrenheit limit converted as an absolute value, exclusive', characteristic: { kind: 'variable', unit: 'degF', lower: null, upper: { value: '212', inclusive: false } }, measurement: { value: '100', unit: 'degC', declaredPrecision: 0 }, expected: { outcome: 'fail', normalized: { value: '100', unit: 'degC' } }, working: 'limit (212 − 32) × 5/9 = 100 °C; 100 < 100 is false' },
  { name: 'a span trap: 77 °F in a 20–30 °C band', characteristic: { kind: 'variable', unit: 'degC', lower: { value: '20', inclusive: true }, upper: { value: '30', inclusive: true } }, measurement: { value: '77', unit: 'degF', declaredPrecision: 0 }, expected: { outcome: 'pass', normalized: { value: '25', unit: 'degC' } }, working: '(77 − 32) × 5/9 = 25. Converting 77 as a span (77 × 5/9 = 42.7̅) would wrongly fail' },
  { name: 'kelvin on the upper Celsius limit', characteristic: { kind: 'variable', unit: 'degC', lower: { value: '20', inclusive: true }, upper: { value: '25', inclusive: true } }, measurement: { value: '298.15', unit: 'K', declaredPrecision: 2 }, expected: { outcome: 'pass', normalized: { value: '25', unit: 'degC' } }, working: '298.15 − 273.15 = 25 ≤ 25' },
  { name: 'kelvin one digit over', characteristic: { kind: 'variable', unit: 'degC', lower: { value: '20', inclusive: true }, upper: { value: '25', inclusive: true } }, measurement: { value: '298.16', unit: 'K', declaredPrecision: 2 }, expected: { outcome: 'fail', normalized: { value: '25.01', unit: 'degC' } }, working: '298.16 − 273.15 = 25.01 > 25' },
  // ------------------------------------------------------------- cannot evaluate (doc 07 §14)
  { name: 'unknown unit', characteristic: bore(true), measurement: { value: '12', unit: 'furlong', declaredPrecision: 0 }, expected: { outcome: 'cannot_evaluate', normalized: null }, working: 'furlong is not a unit in v1' },
  { name: 'missing unit', characteristic: bore(true), measurement: { value: '12', unit: null, declaredPrecision: 0 }, expected: { outcome: 'cannot_evaluate', normalized: null }, working: 'a measured value without a unit is never assumed to be in the characteristic unit' },
  { name: 'different dimensions', characteristic: bore(true), measurement: { value: '12', unit: 'kg', declaredPrecision: 0 }, expected: { outcome: 'cannot_evaluate', normalized: null }, working: 'mass cannot be compared with length' },
  { name: 'hardness scales without an exact conversion', characteristic: { kind: 'variable', unit: 'HRC', lower: { value: '58', inclusive: true }, upper: { value: '62', inclusive: true } }, measurement: { value: '95', unit: 'HRB', declaredPrecision: 0 }, expected: { outcome: 'cannot_evaluate', normalized: null }, working: 'HRB→HRC tables (ASTM E140) are empirical, so no validated factor exists' },
  { name: 'hardness on its own scale', characteristic: { kind: 'variable', unit: 'HRC', lower: { value: '58', inclusive: true }, upper: { value: '62', inclusive: true } }, measurement: { value: '60', unit: 'HRC', declaredPrecision: 0 }, expected: { outcome: 'pass', normalized: { value: '60', unit: 'HRC' } }, working: '58 ≤ 60 ≤ 62 on the same scale' },
  // ------------------------------------------------------------- counts and attributes
  { name: 'zero defects allowed, none found', characteristic: { kind: 'variable', unit: 'count', lower: null, upper: { value: '0', inclusive: true } }, measurement: { value: '0', unit: 'count', declaredPrecision: 0 }, expected: { outcome: 'pass', normalized: { value: '0', unit: 'count' } }, working: '0 ≤ 0' },
  { name: 'zero defects allowed, one found', characteristic: { kind: 'variable', unit: 'count', lower: null, upper: { value: '0', inclusive: true } }, measurement: { value: '1', unit: 'count', declaredPrecision: 0 }, expected: { outcome: 'fail', normalized: { value: '1', unit: 'count' } }, working: '1 > 0' },
  { name: 'a fractional count', characteristic: { kind: 'variable', unit: 'count', lower: null, upper: { value: '0', inclusive: true } }, measurement: { value: '0.5', unit: 'count', declaredPrecision: 1 }, expected: { outcome: 'cannot_evaluate', normalized: null }, working: 'counts are whole numbers' },
  { name: 'attribute accepted', characteristic: { kind: 'attribute', acceptedValues: ['conforming'] }, measurement: { value: 'conforming', unit: null, declaredPrecision: null }, expected: { outcome: 'pass', normalized: null }, working: 'value is in the accepted set' },
  { name: 'attribute rejected', characteristic: { kind: 'attribute', acceptedValues: ['conforming'] }, measurement: { value: 'burr on edge', unit: null, declaredPrecision: null }, expected: { outcome: 'fail', normalized: null }, working: 'value is not in the accepted set' },
  // ------------------------------------------------------------- refused input
  { name: 'more places than declared precision', characteristic: bore(true), measurement: mm('12.0101', 3), expected: { refused: 'MEASUREMENT_PRECISION' }, working: '4 places written, 3 declared: which digit is real is unknown' },
  { name: 'exponent notation', characteristic: bore(true), measurement: mm('1.2e1', 1), expected: { refused: 'MEASUREMENT_MALFORMED' }, working: 'only plain decimals are accepted' },
  { name: 'precision missing', characteristic: bore(true), measurement: { value: '12', unit: 'mm', declaredPrecision: null }, expected: { refused: 'MEASUREMENT_PRECISION' }, working: 'a measured value must declare its precision (FR-702)' },
  { name: 'unit on an attribute', characteristic: { kind: 'attribute', acceptedValues: ['conforming'] }, measurement: { value: 'conforming', unit: 'mm', declaredPrecision: null }, expected: { refused: 'MEASUREMENT_UNIT_UNEXPECTED' }, working: 'attributes carry no unit' },
];
