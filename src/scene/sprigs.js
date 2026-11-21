// Sub-cards: the one layout shared by the atlas's pictures that are made of others (atlas.js paints them) and the
// quads that stand out of a card near the walker (W_LEAF vsN unfolds them), so a near card turns out the very
// branchlets, sprays and leaf clusters its picture shows, from where it shows them.
// Pictures, P: 0-3 layer 2's boughs (cells 0-3: two firs', a hemlock's, a cedar's), made of branchlets; 4-14 layer
// 1's cells 0-10: branchlets (fir, fir, hemlock, hemlock, cedar, dead) made of sprays, and limb ends (maple, maple,
// birch, oak, vine maple) made of clusters of leaves. A sub-card: its foot (x, y in its picture's units: across 0
// to 1, along 0 to 1, a bough's 0 to 2), the angle it heads at, its length, its width (below 0 mirrored), its cell
// of the layer below
import { SPRIGS, TWIGQ } from './quality.js';

const fract = (x) => x - Math.floor(x);
const h1 = (x) => {
  let q = fract(x * 0.1031 + 0.137);
  q *= q + 33.33;
  q *= q + q;
  return fract(q);
};
// the stems of a bough and of a branchlet: from x, y to x, y
export const STEM_B = [0.5, 0.04, 0.5, 1.6],
  STEM_T = [0.5, 0.03, 0.5, 0.76];
// a stem's half width at its foot, to its length (it narrows to 40% at its tip: atlas.js stick)
export const STEM_W = 0.006;

// A stem with sub-cards down both sides, raked forward, longest about 60% of the way out, and one heading on from
// its tip. reach: the longest; wd: how wide one is to its length; ca, cb: its two cells, taken by chance
const feather = (stem, n, reach, wd, ca, cb, sd) => {
  const [ax, ay, bx, by] = stem,
    subs = [];
  for (let k = 0; k < n; k++) {
    const u = (k + 0.6) / n,
      side = (k % 2) * 2 - 1,
      hk = h1(k * 4.3 + sd * 11),
      len =
        reach *
        (0.2 + 0.8 * Math.sin(Math.PI * Math.pow(u, 0.8))) *
        (0.75 + 0.35 * hk);
    subs.push([
      ax + (bx - ax) * u,
      ay + (by - ay) * u,
      -side * (0.96 + (hk - 0.5) * 0.4),
      len,
      len * wd * side,
      h1(hk * 9) > 0.5 ? cb : ca,
    ]);
  }
  const lt = reach * 0.6;
  subs.push([bx, by - lt * 0.1, 0, lt, lt * wd, ca]);
  return { sticks: [[ax, ay, bx, by, STEM_W * (by - ay)]], subs };
};
// A limb's end: three twigs from one foot, clusters of leaves along them and at their ends, some missing, so its
// outline is uneven and the sky shows through
const limbEnd = (ca, cb, sd) => {
  const sticks = [],
    subs = [];
  for (let j = 0; j < 3; j++) {
    const hj = h1(j * 2.9 + sd * 7),
      aj = (j - 1) * 0.5 + (hj - 0.5) * 0.25,
      r = (j === 1 ? 0.48 : 0.28) * (0.9 + 0.25 * hj),
      ex = 0.5 + Math.sin(aj) * r,
      ey = 0.03 + Math.cos(aj) * r;
    sticks.push([0.5, 0.03, ex, ey, 0.008]);
    for (let m = 0; m < 3; m++) {
      const hm = h1((j * 3 + m) * 6.1 + sd * 3);
      if (hm < 0.18 && m < 2) continue;
      const sz = 0.36 * (0.85 + 0.3 * h1(hm * 5)),
        t = 0.32 + 0.34 * m,
        ang =
          m === 2
            ? aj * 0.6 + (hm - 0.5) * 0.5
            : aj + (((m + j) % 2) * 2 - 1) * (0.45 + 0.5 * hm);
      subs.push([
        0.5 + (ex - 0.5) * t,
        0.03 + (ey - 0.03) * t,
        -Math.max(-0.95, Math.min(0.95, ang)),
        sz,
        sz * (hm > 0.6 ? -1 : 1),
        h1(hm * 3) > 0.5 ? cb : ca,
      ]);
    }
  }
  return { sticks, subs };
};
// mid: the y where its card's two flat halves meet (a limb end's card is one flat quad: none). A conifer's are
// full: a bough of 14 or 15 branchlets (16 sub-cards at most), as wide as long; a branchlet of 12 to 15 sprays
export const PICS = [
  { ...feather(STEM_B, 15, 0.6, 1, 0, 1, 3), mid: 1 },
  { ...feather(STEM_B, 15, 0.6, 1, 0, 1, 4), mid: 1 },
  { ...feather(STEM_B, 15, 0.58, 1, 2, 3, 7), mid: 1 },
  { ...feather(STEM_B, 14, 0.6, 1, 4, 4, 9), mid: 1 },
  { ...feather(STEM_T, 13, 0.4, 0.75, 0, 0, 1), mid: 0.5 },
  { ...feather(STEM_T, 13, 0.4, 0.75, 0, 0, 2), mid: 0.5 },
  { ...feather(STEM_T, 15, 0.38, 0.75, 1, 1, 3), mid: 0.5 },
  { ...feather(STEM_T, 15, 0.38, 0.75, 1, 1, 4), mid: 0.5 },
  { ...feather(STEM_T, 12, 0.41, 0.75, 2, 2, 5), mid: 0.5 },
  { ...feather(STEM_T, 5, 0.34, 0.7, 3, 3, 6), mid: 0.5 },
  { ...limbEnd(4, 5, 6), mid: 0 },
  { ...limbEnd(4, 5, 7), mid: 0 },
  { ...limbEnd(6, 7, 8), mid: 0 },
  { ...limbEnd(8, 8, 9), mid: 0 },
  { ...limbEnd(9, 9, 10), mid: 0 },
];
// at most this many sub-cards and sticks to a picture
const SUBN = 16,
  STKN = 3;

// The lowest and highest y of a sub-card's quad
const ySpan = ([, y, ang, len, wid]) => {
  const dx = -Math.sin(ang),
    dy = Math.cos(ang),
    hw = Math.abs(wid) / 2,
    ys = [
      y + dx * hw,
      y - dx * hw,
      y + dx * hw + dy * len,
      y - dx * hw + dy * len,
    ];
  return [Math.min(...ys), Math.max(...ys)];
};
// How many sub-cards a card unfolds near the walker: SPRIGS quads, two of them the card's own, TWIGQ its stem
export const SLOTS = SPRIGS - 2 - TWIGQ;
// For each picture the sub-cards a near card unfolds, biggest first, as two vec4 (x, y, angle, length; width,
// cell, which half or quad of the card it lies on); a length of 0: none. A sheet's halves meet at an angle, so a
// sub-card across its middle could not lie flat on it: that one stays painted only. A limb end's are shared out
// between its two quads in turn
export const slotTable = () => {
  const o = new Float32Array(PICS.length * SLOTS * 8);
  PICS.forEach((pic, P) => {
    const fit = [];
    for (const s of pic.subs) {
      const [lo, hi] = ySpan(s);
      if (!pic.mid) fit.push([s, 0]);
      else if (hi <= pic.mid) fit.push([s, 0]);
      else if (lo >= pic.mid) fit.push([s, 1]);
    }
    fit.sort(
      (a, b) => b[0][3] * Math.abs(b[0][4]) - a[0][3] * Math.abs(a[0][4]),
    );
    for (let k = 0; k < Math.min(SLOTS, fit.length); k++) {
      const [s, half] = fit[k];
      o.set(
        [s[0], s[1], s[2], s[3], s[4], s[5], pic.mid ? half : k % 2, 0],
        (P * SLOTS + k) * 8,
      );
    }
  });
  return o;
};
// WGSL for the bake (atlas.js): SUB, two vec4 to a sub-card; STK and STW, the sticks and their half widths
const num = (v) => {
  const s = (+v.toFixed(5)).toString();
  return s.includes('.') || s.includes('e') ? s : s + '.';
};
const vec4 = (a) => `vec4f(${a.map(num).join(', ')})`;
export const SUB_WGSL = (() => {
  const sub = [],
    stk = [],
    stw = [];
  for (const pic of PICS) {
    for (let j = 0; j < SUBN; j++) {
      const s = pic.subs[j] || [0, 0, 0, 0, 0, 0];
      sub.push(vec4(s.slice(0, 4)), vec4([s[4], s[5], 0, 0]));
    }
    for (let j = 0; j < STKN; j++) {
      const s = pic.sticks[j] || [0, 0, 0, 0, 0];
      stk.push(vec4(s.slice(0, 4)));
      stw.push(num(s[4]));
    }
  }
  return `const SUBN = ${SUBN}; const STKN = ${STKN};
const SUB = array<vec4f, ${sub.length}>(${sub.join(', ')});
const STK = array<vec4f, ${stk.length}>(${stk.join(', ')});
const STW = array<f32, ${stw.length}>(${stw.join(', ')});`;
})();
