import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseColour, sameUpToColours } from '../src/colour.mjs';

const T = 0.02;

test('one colour written as rgb() and as lab() is the same computed value', () => {
  assert.ok(sameUpToColours('rgb(169, 169, 169)', 'lab(69.2378 0 0)', T));
  assert.ok(sameUpToColours('rgba(0, 0, 0, 0)', 'lab(0 0 0 / 0)', T));
  assert.ok(sameUpToColours('oklch(0.7157 0.1797 33.51)', 'lab(65.4459 53.8462 44.2739)', T));
  assert.ok(sameUpToColours('color(srgb 1 1 1 / 0.5)', 'lab(100 0 0 / 0.5)', T));
});

test('colours inside larger values compare as colours, the rest exactly', () => {
  assert.ok(sameUpToColours('rgb(255, 255, 255) 0px 1px 2px 0px', 'lab(100 0 0) 0px 1px 2px 0px', T));
  assert.ok(!sameUpToColours('rgb(255, 255, 255) 0px 1px 2px 0px', 'lab(100 0 0) 0px 1px 3px 0px', T));
  assert.ok(!sameUpToColours('rgb(255, 255, 255) 0px 1px 2px 0px', 'lab(100 0 0) 0px 1px 2px 0px, lab(0 0 0) 0px 0px 1px 0px', T));
});

test('different colours, alphas or no tolerance stay different', () => {
  assert.ok(!sameUpToColours('rgb(169, 169, 169)', 'rgb(170, 169, 169)', T));
  assert.ok(!sameUpToColours('rgba(0, 0, 0, 0.5)', 'lab(0 0 0 / 0.6)', T));
  assert.ok(!sameUpToColours('rgb(169, 169, 169)', 'lab(69.2378 0 0)', 0));
  assert.ok(!sameUpToColours('auto', 'none', T));
});

test('parseColour reads hex, hsl, lch, oklab and display-p3', () => {
  const near = (c, lab) => assert.ok(Math.hypot(...c.lab.map((v, i) => v - lab[i])) < 0.01, JSON.stringify(c));
  near(parseColour('#fff'), [100, 0, 0]);
  near(parseColour('hsl(0, 0%, 100%)'), [100, 0, 0]);
  near(parseColour('lch(50 0 0)'), [50, 0, 0]);
  near(parseColour('oklab(1 0 0)'), [100, 0, 0]);
  near(parseColour('color(display-p3 1 1 1)'), [100, 0, 0]);
  assert.equal(parseColour('currentcolor'), null);
});
