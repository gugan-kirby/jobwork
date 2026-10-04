import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STATUS_TONES } from '../src/tokens';

/**
 * `DS-06` says every status ships as a triple "tested for contrast". This is that test:
 * the ratios are computed from `tokens.css` itself, so a designer changing a hex there
 * cannot quietly drop a status below the doc 21 §9 bar.
 */

const SRC = join(__dirname, '..', 'src');
const CSS = readFileSync(join(SRC, 'tokens.css'), 'utf8');

function variables(): Map<string, string> {
  const map = new Map<string, string>();
  for (const [, name, value] of CSS.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
    map.set(name!, value!.trim());
  }
  return map;
}

/** Follows `var(--x)` chains down to a literal hex. */
function resolve(name: string, vars: Map<string, string>, depth = 0): string {
  const value = vars.get(name);
  if (!value) throw new Error(`token --${name} is not defined`);
  if (depth > 10) throw new Error(`token --${name} is circular`);
  const reference = /^var\(--([a-z0-9-]+)\)$/.exec(value);
  return reference ? resolve(reference[1]!, vars, depth + 1) : value;
}

function channel(component: number): number {
  const c = component / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const clean = hex.replace('#', '').trim();
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean;
  const r = Number.parseInt(full.slice(0, 2), 16);
  const g = Number.parseInt(full.slice(2, 4), 16);
  const b = Number.parseInt(full.slice(4, 6), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

describe('design tokens (DS-01, DS-06, doc 21 §9)', () => {
  const vars = variables();

  it.each([...STATUS_TONES])('status-%s text meets 4.5:1 on its own background', (tone) => {
    const fg = resolve(`status-${tone}-fg`, vars);
    const bg = resolve(`status-${tone}-bg`, vars);
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  /**
   * `DS-06`: what must clear the bar is what *identifies* the state. Because `DS-07`
   * puts a label and a glyph in every status surface, and both are drawn in `-fg`,
   * `-fg` is the thing tested — against its own background and against the two
   * backgrounds a chip can sit on. `-border` is a decorative separator and carries no
   * ratio; WCAG 1.4.11 asks for 3:1 only where colour is doing the identifying.
   */
  it.each([...STATUS_TONES])('status-%s label and glyph stay legible off-chip', (tone) => {
    const fg = resolve(`status-${tone}-fg`, vars);
    expect(contrast(fg, resolve('color-bg', vars))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(fg, resolve('color-surface', vars))).toBeGreaterThanOrEqual(4.5);
  });

  it('body text and muted text meet their bars on a surface', () => {
    const surface = resolve('color-surface', vars);
    expect(contrast(resolve('color-text', vars), surface)).toBeGreaterThanOrEqual(4.5);
    // Muted is confined to metadata but must still clear 4.5:1 at our 13px caption size.
    expect(contrast(resolve('color-text-muted', vars), surface)).toBeGreaterThanOrEqual(4.5);
  });

  it('the hero keeps its light text legible on the brand blue (F-MX.2)', () => {
    const fg = resolve('brand-hero-fg', vars);
    const solid = resolve('brand-hero-bg-solid', vars);
    expect(contrast(fg, solid)).toBeGreaterThanOrEqual(4.5);
    // The gradient runs from blue-800 to blue-500; the lightest stop is the risk.
    expect(contrast(fg, resolve('blue-500', vars))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(resolve('brand-hero-fg-muted', vars), solid)).toBeGreaterThanOrEqual(4.5);
  });

  it('the primary action meets 4.5:1 with its foreground', () => {
    expect(
      contrast(resolve('button-primary-fg', vars), resolve('button-primary-bg', vars)),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it('no component hard-codes a colour outside the stylesheet (DS-01)', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (!file.endsWith('.tsx') && !file.endsWith('.ts')) continue;
      const body = readFileSync(file, 'utf8');
      for (const [match] of body.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
        // White is the one literal the token layer itself defines as a value rather
        // than a ramp entry; components reference it through --button-primary-fg.
        if (match.toLowerCase() === '#fff' || match.toLowerCase() === '#ffffff') continue;
        offenders.push(`${file.replace(SRC, '')}: ${match}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * `DS-01` applies to the applications too: "a proposed new color/spacing/size must
 * become a token or be rejected — no page-local magic values". A grep is a blunt
 * instrument, but it is the one that actually holds the line in review, because the
 * alternative is noticing by eye in a 700-line screen diff.
 */
describe('applications use tokens, not magic values (DS-01, doc 21 §11)', () => {
  const APPS = join(__dirname, '..', '..', '..', 'apps');

  function appSources(): string[] {
    return walk(APPS).filter(
      (file) =>
        (file.endsWith('.tsx') || file.endsWith('.ts')) &&
        !file.includes('node_modules') &&
        !file.includes('.next'),
    );
  }

  it('declares no raw colour anywhere in an app screen', () => {
    const offenders: string[] = [];
    for (const file of appSources()) {
      for (const [match] of readFileSync(file, 'utf8').matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
        offenders.push(`${file.replace(APPS, 'apps')}: ${match}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('declares no raw pixel value anywhere in an app screen', () => {
    const offenders: string[] = [];
    for (const file of appSources()) {
      for (const [match] of readFileSync(file, 'utf8').matchAll(/\b\d+px\b/g)) {
        offenders.push(`${file.replace(APPS, 'apps')}: ${match}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
