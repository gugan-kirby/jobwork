/**
 * Exact rational numbers over `BigInt` for measurement evaluation (IN-14 F-14.2; doc 07 §14).
 *
 * A measured value arrives as a decimal string and is compared against limits after an affine
 * unit conversion whose factor may have no finite decimal (°F → °C is ×5/9). Any decimal or
 * floating type would round before the comparison; a fraction never does. Rounding happens
 * only in `toDisplay`, for reading.
 */

const DECIMAL = /^-?(\d+)(?:\.(\d+))?$/;

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

export class Rational {
  private constructor(
    readonly num: bigint,
    readonly den: bigint,
  ) {}

  static of(num: bigint | number, den: bigint | number = 1n): Rational {
    let n = BigInt(num);
    let d = BigInt(den);
    if (d === 0n) throw new RangeError('zero denominator');
    if (d < 0n) [n, d] = [-n, -d];
    const g = gcd(n, d) || 1n;
    return new Rational(n / g, d / g);
  }

  /** A plain decimal string: optional minus, digits, optional fraction. No exponent, no plus sign. */
  static parse(text: string): Rational {
    const m = DECIMAL.exec(text);
    if (!m) throw new RangeError(`not a decimal: ${text}`);
    const fraction = m[2] ?? '';
    const negative = text.startsWith('-');
    const digits = BigInt(`${m[1]}${fraction}`);
    return Rational.of(negative ? -digits : digits, 10n ** BigInt(fraction.length));
  }

  static isDecimal(text: string): boolean {
    return DECIMAL.test(text);
  }

  /** Digits after the decimal point as written ("12.70" → 2). */
  static places(text: string): number {
    const m = DECIMAL.exec(text);
    return m?.[2]?.length ?? 0;
  }

  add(o: Rational): Rational {
    return Rational.of(this.num * o.den + o.num * this.den, this.den * o.den);
  }

  sub(o: Rational): Rational {
    return Rational.of(this.num * o.den - o.num * this.den, this.den * o.den);
  }

  mul(o: Rational): Rational {
    return Rational.of(this.num * o.num, this.den * o.den);
  }

  compare(o: Rational): -1 | 0 | 1 {
    const l = this.num * o.den;
    const r = o.num * this.den;
    return l < r ? -1 : l > r ? 1 : 0;
  }

  isInteger(): boolean {
    return this.den === 1n;
  }

  /** The exact decimal if it terminates within `maxPlaces`; otherwise rounded half-even. */
  toDisplay(maxPlaces: number): string {
    const scale = 10n ** BigInt(maxPlaces);
    const scaled = this.num * scale;
    let q = scaled / this.den;
    const r = scaled % this.den;
    if (r !== 0n) {
      const twice = (r < 0n ? -r : r) * 2n;
      const away = twice > this.den || (twice === this.den && (q < 0n ? -q : q) % 2n === 1n);
      if (away) q += scaled < 0n ? -1n : 1n;
    }
    const negative = q < 0n;
    const abs = (negative ? -q : q).toString().padStart(maxPlaces + 1, '0');
    const whole = abs.slice(0, abs.length - maxPlaces);
    const fraction = abs.slice(abs.length - maxPlaces).replace(/0+$/, '');
    return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
  }
}
