// Colour-aware value comparison for `compare`: one colour written two ways (`rgb(169, 169, 169)` and
// `lab(69.2378 0 0)`, as when a stylesheet moves its colours to lab()) is the same computed style. Colours are
// converted to CIE lab (D50) with the CSS Color 4 matrices and compared by ΔE (CIE76); the rest of the value must match
// exactly.

const COLOUR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|lab|lch|oklab|oklch|color)\([^()]*\)/g;

const mul = (m, v) => m.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
const gamma = (c) => { const a = Math.abs(c); return Math.sign(c) * (a <= 0.04045 ? a / 12.92 : ((a + 0.055) / 1.055) ** 2.4); };
const SRGB_TO_XYZ65 = [[0.41239079926595934, 0.357584339383878, 0.1804807884018343], [0.21263900587151027, 0.715168678767756, 0.07219231536073371], [0.01933081871559182, 0.11919477979462598, 0.9505321522496607]];
const P3_TO_XYZ65 = [[0.4865709486482162, 0.26566769316909306, 0.1982172852343625], [0.2289745640697488, 0.6917385218365064, 0.079286914093745], [0, 0.04511338185890264, 1.043944368900976]];
const D65_TO_D50 = [[1.0479298208405488, 0.022946793341019088, -0.05019222954313557], [0.029627815688159344, 0.990434484573249, -0.01707382502938514], [-0.009243058152591178, 0.015055144896577895, 0.7518742899580008]];
const OKLAB_TO_LMS = [[1, 0.3963377773761749, 0.2158037573099136], [1, -0.1055613458156586, -0.0638541728258133], [1, -0.0894841775298119, -1.2914855480194092]];
const LMS_TO_XYZ65 = [[1.2268798758459243, -0.5578149944602171, 0.2813910456659647], [-0.0405757452148008, 1.112286803280317, -0.0717110580655164], [-0.0763729366746601, -0.4214933324022432, 1.5869240198367816]];
const D50 = [0.3457 / 0.3585, 1, (1 - 0.3457 - 0.3585) / 0.3585];

function xyz50ToLab([x, y, z]) {
  const e = 216 / 24389, k = 24389 / 27;
  const f = [x / D50[0], y / D50[1], z / D50[2]].map((v) => (v > e ? Math.cbrt(v) : (k * v + 16) / 116));
  return [116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])];
}
const xyz65ToLab = (xyz) => xyz50ToLab(mul(D65_TO_D50, xyz));
const oklabToLab = (L, a, b) => xyz65ToLab(mul(LMS_TO_XYZ65, mul(OKLAB_TO_LMS, [L, a, b]).map((v) => v ** 3)));
const polar = (c, h) => [c * Math.cos((h * Math.PI) / 180), c * Math.sin((h * Math.PI) / 180)];
const num = (s, pct = 1) => (s === 'none' ? 0 : s.endsWith('%') ? (parseFloat(s) / 100) * pct : parseFloat(s));

function hslToRgb(h, s, l) {
  const f = (n) => { const k = (n + h / 30) % 12; const a = s * Math.min(l, 1 - l); return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0), f(8), f(4)];
}

/** One colour literal → { lab: [L, a, b], alpha }, or null when it is not one this module reads. */
export function parseColour(text) {
  const s = text.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/.exec(s);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const v = [0, 2, 4, 6].map((i) => (i < h.length ? parseInt(h.slice(i, i + 2), 16) / 255 : 1));
    return { lab: xyz65ToLab(mul(SRGB_TO_XYZ65, v.slice(0, 3).map(gamma))), alpha: v[3] };
  }
  const m = /^([a-z]+)\((.*)\)$/.exec(s);
  if (!m) return null;
  const [body, a] = m[2].includes('/') ? m[2].split('/') : [m[2], null];
  let parts = body.includes(',') ? body.split(',') : body.split(/\s+/);
  parts = parts.map((p) => p.trim()).filter(Boolean);
  let alpha = a !== null ? num(a.trim()) : 1;
  switch (m[1]) {
    case 'rgb': case 'rgba': {
      if (parts.length === 4) alpha = num(parts[3]);
      return { lab: xyz65ToLab(mul(SRGB_TO_XYZ65, parts.slice(0, 3).map((p) => gamma(num(p, 255) / 255)))), alpha };
    }
    case 'hsl': case 'hsla': {
      if (parts.length === 4) alpha = num(parts[3]);
      const rgb = hslToRgb(num(parts[0]), num(parts[1], 1) / (parts[1].endsWith('%') ? 1 : 100), num(parts[2], 1) / (parts[2].endsWith('%') ? 1 : 100));
      return { lab: xyz65ToLab(mul(SRGB_TO_XYZ65, rgb.map(gamma))), alpha };
    }
    case 'lab': return { lab: [num(parts[0], 100), num(parts[1], 125), num(parts[2], 125)], alpha };
    case 'lch': return { lab: [num(parts[0], 100), ...polar(num(parts[1], 150), num(parts[2]))], alpha };
    case 'oklab': return { lab: oklabToLab(num(parts[0], 1), num(parts[1], 0.4), num(parts[2], 0.4)), alpha };
    case 'oklch': return { lab: oklabToLab(num(parts[0], 1), ...polar(num(parts[1], 0.4), num(parts[2]))), alpha };
    case 'color': {
      const [space, ...c] = parts;
      const v = c.slice(0, 3).map((p) => num(p, 1));
      if (space === 'srgb') return { lab: xyz65ToLab(mul(SRGB_TO_XYZ65, v.map(gamma))), alpha };
      if (space === 'srgb-linear') return { lab: xyz65ToLab(mul(SRGB_TO_XYZ65, v)), alpha };
      if (space === 'display-p3') return { lab: xyz65ToLab(mul(P3_TO_XYZ65, v.map(gamma))), alpha };
      if (space === 'xyz' || space === 'xyz-d65') return { lab: xyz65ToLab(v), alpha };
      if (space === 'xyz-d50') return { lab: xyz50ToLab(v), alpha };
      return null;
    }
    default: return null;
  }
}

/**
 * Whether two computed values are the same once their colours are compared as colours: everything outside the colour
 * literals is identical, and each pair of colours is within `tolerance` ΔE with the same alpha (to 0.002).
 */
export function sameUpToColours(a, b, tolerance) {
  if (a === b) return true;
  if (!tolerance) return false;
  const ca = a.match(COLOUR) ?? [], cb = b.match(COLOUR) ?? [];
  if (!ca.length || ca.length !== cb.length) return false;
  if (a.replace(COLOUR, '\u0000') !== b.replace(COLOUR, '\u0000')) return false;
  return ca.every((x, i) => {
    const p = parseColour(x), q = parseColour(cb[i]);
    if (!p || !q) return x === cb[i];
    const dE = Math.hypot(p.lab[0] - q.lab[0], p.lab[1] - q.lab[1], p.lab[2] - q.lab[2]);
    return dE <= tolerance && Math.abs(p.alpha - q.alpha) <= 0.002;
  });
}
