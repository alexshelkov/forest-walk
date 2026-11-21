// ============================================================================
// the running water: where the creek and the brook go, how wide and how high they run, the mesh of their surface
// ============================================================================
// Order matters. scene.js takes the places to measure the ground at (probes), has the GPU work out their heights
// (W_LEVEL), and hands them to bake(): only then is it known how high each stream runs. bake() fills the field the
// terrain is cut by (W_DENS), that creekAt reads for everything placed afterwards, and that the shaders wet by (tS).
import {
  clamp,
  fbm,
  floor,
  hypot,
  ihash,
  lakeD,
  max,
  min,
  mix,
  NX,
  OX,
  OZ,
  PI,
  round,
  sin,
  sstep,
  VS,
} from './math.js';

// A course: its bends (x, z) from its head to the lake, its mean half width, how far its line wanders off the bends,
// where a pool must end in a fall (falls), where it must keep to its bends (pins: the trail's crossings), and where
// it is held wide (a pool) or narrow: x, z, radius, times the width. The creek comes down from the hills; the brook crosses the trail a few steps from where
// the walk starts, again on its way back, then runs through the meadow
const COURSES = [
  {
    pts: [
      [-132, -44],
      [-104, -24],
      [-78, -8],
      [-52, -2],
      [-30, 10],
      [-15.9, 18.5],
      [-4, 25],
      [8, 30],
      [16, 35.6],
      [24, 41],
      [31, 46],
    ],
    half: 1.25,
    wander: 1.2,
    falls: [],
    pins: [
      [-15.9, 18.5],
      [16, 35.6],
    ],
    hold: [
      [-15.9, 18.5, 5, 0.75],
      [-6.5, 23.5, 5, 1.8],
      [16, 35.6, 5, 0.8],
      [-27, 12, 5, 1.7],
    ],
  },
  {
    pts: [
      [-104, 100],
      [-92, 95.5],
      [-82, 91.5],
      [-74, 88.6],
      [-68, 86.8],
      [-64.6, 87.1],
      [-61.5, 88.5],
      [-58.2, 90],
      [-54, 91],
      [-48.5, 88.6],
      [-43.5, 83],
      [-39.5, 79.4],
      [-33.45, 82.2],
      [-27.5, 85],
      [-19, 84.5],
      [-7, 88],
      [7, 85.5],
      [19, 87.5],
      [30, 84.5],
      [37, 84],
    ],
    half: 0.7,
    wander: 0.7,
    // (it crosses the trail 8 m from where the walk starts, in a wide dark pool under and beside the bridge, with
    // a fall just above it: from the first frame water has to show left and right of the bridge)
    falls: [[-64.6, 87.1]],
    pins: [
      [-61.5, 88.5],
      [-33.45, 82.2],
    ],
    hold: [
      [-61.5, 88.5, 7, 3.1],
      [-43.5, 83.2, 4, 1.7],
      [-33.45, 82.2, 3, 0.75],
      [-7, 88, 6, 1.8],
    ],
  },
];
const DS = 0.75; // metres between the samples of a course
const MARGIN = 0.45; // how far the surface's mesh reaches past the water's edge, into the bank
const CUT = 0.36; // how far under the ground beside it a stream runs
// the field: SN cells a side over the whole world (as the terrain's own grid), exact out to REACH metres from a
// stream; beyond it FAR. W_DENS stops shaping the ground before REACH
export const SN = NX,
  FAR = 40;
const SW = VS,
  REACH = 27;

// the samples of every course, one after another: place, the way it runs (unit), half width, metres from its head
const X = [],
  Z = [],
  TX = [],
  TZ = [],
  HW = [],
  SA = [];
// A stream comes down in pools a few metres long, each ending in a short fall into the next: dark level water,
// then white over the drop. Per sample: the last sample of its pool, and how far through that fall it is (0 in
// the pool, 1 at its foot)
const PEND = [],
  FALL = [];
const FIRST = []; // where each course's samples begin; one more entry than there are courses
for (let c = 0; c < COURSES.length; c++) {
  const { pts, half, wander, pins, hold, falls } = COURSES[c],
    n = pts.length,
    px = [],
    pz = [];
  for (let i = 0; i < n - 1; i++) {
    const a = pts[max(i - 1, 0)],
      p = pts[i],
      q = pts[i + 1],
      d = pts[min(i + 2, n - 1)],
      steps = Math.ceil(hypot(q[0] - p[0], q[1] - p[1]) / DS);
    const cr = (k, u) =>
      0.5 *
      (2 * p[k] +
        (q[k] - a[k]) * u +
        (2 * a[k] - 5 * p[k] + 4 * q[k] - d[k]) * u * u +
        (3 * p[k] - a[k] - 3 * q[k] + d[k]) * u * u * u);
    for (let s = 0; s < steps; s++) {
      px.push(cr(0, s / steps));
      pz.push(cr(1, s / steps));
    }
  }
  // it wanders off its bends by a noise along its length, except by the pins
  let m = px.length,
    along = 0;
  const ox = [],
    oz = [];
  for (let i = 0; i < m; i++) {
    const j0 = max(i - 1, 0),
      j1 = min(i + 1, m - 1),
      l = hypot(px[j1] - px[j0], pz[j1] - pz[j0]) || 1;
    if (i) along += hypot(px[i] - px[i - 1], pz[i] - pz[i - 1]);
    let free = 1;
    for (const p of pins)
      free = min(free, sstep(3, 10, hypot(px[i] - p[0], pz[i] - p[1])));
    const off =
      wander *
      free *
      clamp((fbm(along * 0.06, c * 7.3 + 1.7, 2.1, 2) - 0.5) * 4.5, -1, 1);
    ox.push(px[i] - ((pz[j1] - pz[j0]) / l) * off);
    oz.push(pz[i] + ((px[j1] - px[j0]) / l) * off);
  }
  // stop a little way into the lake
  for (let i = 0; i < m; i++)
    if (lakeD(ox[i], oz[i]) < -2.5) {
      m = i;
      break;
    }
  FIRST.push(X.length);
  const inPool = []; // where in its pool a sample is, 0 at its head to 1 at its end
  const forced = falls.map((f) => {
    let at = 0;
    for (let i = 1; i < m; i++)
      if (
        hypot(ox[i] - f[0], oz[i] - f[1]) < hypot(ox[at] - f[0], oz[at] - f[1])
      )
        at = i;
    return at;
  });
  for (let i0 = 0; i0 < m;) {
    // (the brook in short steps of a hand or two, the creek in longer pools and bigger drops)
    let end =
      min(
        i0 +
          max(
            round(
              (c ? 3 + 3.5 * ihash(i0, c, 7) : 5.5 + 7 * ihash(i0, c, 7)) / DS,
            ),
            4,
          ),
        m,
      ) - 1;
    for (const f of forced) if (f > i0 && f <= end + 3) end = min(f, m - 1);
    const fall = (c ? 1 : 2) + (ihash(i0, c, 11) < 0.4 ? 1 : 0);
    for (let k = i0; k <= end; k++) {
      PEND.push(X.length + end);
      FALL.push(end - k < fall ? (fall - (end - k)) / fall : 0);
      inPool.push((k - i0) / max(end - i0, 1));
    }
    i0 = end + 1;
  }
  along = 0;
  for (let i = 0; i < m; i++) {
    const j0 = max(i - 2, 0),
      j1 = min(i + 2, m - 1),
      l = hypot(ox[j1] - ox[j0], oz[j1] - oz[j0]) || 1;
    if (i) along += hypot(ox[i] - ox[i - 1], oz[i] - oz[i - 1]);
    // its width swells and narrows by another noise, and is held where a pool or a narrow is wanted
    // (and by its pools: widest in the middle of one, narrow over the fall at its end)
    let hw =
      half *
      Math.exp(
        0.5 *
          clamp((fbm(along * 0.05, c * 3.1 + 9.2, 0.4, 2) - 0.5) * 4.5, -1, 1),
      ) *
      mix(0.72, 1.28, sin(PI * Math.sqrt(inPool[i])));
    for (const h of hold)
      hw = mix(
        hw,
        half * h[3],
        sstep(h[2], h[2] * 0.35, hypot(ox[i] - h[0], oz[i] - h[1])),
      );
    X.push(ox[i]);
    Z.push(oz[i]);
    TX.push((ox[j1] - ox[j0]) / l);
    TZ.push((oz[j1] - oz[j0]) / l);
    SA.push(along);
    HW.push(clamp(hw * mix(0.5, 1, sstep(0, 12, along)), 0.45, 3.2)); // (nothing narrower than the terrain's grid can carve)
  }
}
FIRST.push(X.length);
const N = X.length;
// what bake() works out: each sample's water level, how white it runs there (how steeply it falls, metres a
// metre, carried a metre or two on downstream of a fall) and its surface's own slope there
const LV = new Float32Array(N),
  STEEP = new Float32Array(N),
  SLOPE = new Float32Array(N);

// The places to measure the ground at, x z pairs: every sample's middle and both its banks
export function probes() {
  const a = new Float32Array(N * 6);
  for (let i = 0; i < N; i++) {
    const r = HW[i] + 1.1;
    a.set(
      [
        X[i],
        Z[i],
        X[i] - TZ[i] * r,
        Z[i] + TX[i] * r,
        X[i] + TZ[i] * r,
        Z[i] - TX[i] * r,
      ],
      i * 6,
    );
  }
  return a;
}

// the field, per cell: metres to the nearest water's edge (below 0 in the water), its level there, its half width
let FE = null,
  FL = null,
  FH = null;
// float to half float (for the rg16float texture; values here are far from the ends of its range)
const F32 = new Float32Array(1),
  U32 = new Uint32Array(F32.buffer);
export const half16 = (v) => {
  F32[0] = v;
  const x = U32[0],
    e = ((x >>> 23) & 255) - 112;
  return (
    ((x >>> 16) & 0x8000) |
    (e <= 0 ? 0 : e >= 31 ? 0x7c00 : (e << 10) | ((x >>> 13) & 0x3ff))
  );
};

// heights: the ground at probes(). Returns field (edge and level interleaved, for W_DENS), half (the same as half
// floats, for the texture tS) and the surface's mesh: vb 10 floats a vertex (x y z, metres across from the middle;
// metres to the edge, metres along, steepness, the surface's slope; the way it runs x z), ib
export function bake(heights) {
  for (let c = 0; c < COURSES.length; c++) {
    const a = FIRST[c],
      b = FIRST[c + 1],
      gr = new Float32Array(b - a);
    for (let i = a; i < b; i++)
      gr[i - a] = min(heights[i * 3], heights[i * 3 + 1], heights[i * 3 + 2]);
    // It runs CUT under the ground beside it (evened out over a few metres), never uphill: downstream it takes the
    // lowest it has reached, so it cuts through a rise instead of climbing it. Then no fall steeper than 0.28
    for (let i = a; i < b; i++) {
      let s = 0,
        n = 0;
      for (let j = max(i - 4, a); j <= min(i + 4, b - 1); j++) {
        s += gr[j - a];
        n++;
      }
      LV[i] = s / n - CUT;
    }
    for (let i = a + 1; i < b; i++) LV[i] = min(LV[i], LV[i - 1] - 0.002);
    for (let i = b - 2; i >= a; i--) LV[i] = min(LV[i], LV[i + 1] + 0.28 * DS);
    // That is the highest it may run. Each pool lies level at the lowest of it (its own end, rising a hair
    // upstream), and falls to the next pool's level over its last samples
    const top = LV.slice(a, b),
      pool = (i) => top[PEND[i] - a] + 0.002 * (PEND[i] - i);
    for (let i = a; i < b; i++)
      LV[i] =
        FALL[i] && PEND[i] + 1 < b
          ? mix(pool(i), pool(PEND[i] + 1), sstep(0, 1, FALL[i]))
          : pool(i);
    // (the lake lies at 0: a stream ends a finger over it, so the two surfaces never share a plane)
    for (let i = a; i < b; i++) LV[i] = max(LV[i], 0.03);
    for (let i = a, carry = 0; i < b; i++) {
      carry = max(
        (LV[max(i - 1, a)] - LV[min(i + 2, b - 1)]) / (3 * DS),
        carry * 0.42,
      );
      STEEP[i] = carry;
      SLOPE[i] = (LV[max(i - 1, a)] - LV[min(i + 1, b - 1)]) / (2 * DS);
    }
  }
  FE = new Float32Array(SN * SN).fill(FAR);
  FL = new Float32Array(SN * SN);
  FH = new Float32Array(SN * SN).fill(1);
  const cell = (v, o) => clamp(floor((v - o) / SW), 0, SN - 1);
  for (let c = 0; c < COURSES.length; c++)
    for (let i = FIRST[c]; i < FIRST[c + 1] - 1; i++) {
      const ax = X[i],
        az = Z[i],
        bx = X[i + 1] - ax,
        bz = Z[i + 1] - az,
        l2 = bx * bx + bz * bz || 1;
      for (
        let j = cell(min(az, az + bz) - REACH, OZ);
        j <= cell(max(az, az + bz) + REACH, OZ);
        j++
      )
        for (
          let k = cell(min(ax, ax + bx) - REACH, OX);
          k <= cell(max(ax, ax + bx) + REACH, OX);
          k++
        ) {
          const x = OX + (k + 0.5) * SW - ax,
            z = OZ + (j + 0.5) * SW - az,
            t = clamp((x * bx + z * bz) / l2, 0, 1),
            hw = mix(HW[i], HW[i + 1], t);
          const e = hypot(x - bx * t, z - bz * t) - hw,
            o = k + SN * j;
          if (e < FE[o] && e < REACH) {
            FE[o] = e;
            FL[o] = mix(LV[i], LV[i + 1], t);
            FH[o] = hw;
          }
        }
    }
  const field = new Float32Array(SN * SN * 2),
    half = new Uint16Array(SN * SN * 2);
  for (let o = 0; o < SN * SN; o++) {
    field[o * 2] = FE[o];
    field[o * 2 + 1] = FL[o];
    half[o * 2] = half16(FE[o]);
    half[o * 2 + 1] = half16(FL[o]);
  }
  // The surface: five vertices across at every sample (bank, edge, middle, edge, bank), at the water's level
  const vb = new Float32Array(N * 50),
    ib = [];
  for (let c = 0; c < COURSES.length; c++)
    for (let i = FIRST[c]; i < FIRST[c + 1]; i++) {
      const hw = HW[i];
      [-hw - MARGIN, -hw, 0, hw, hw + MARGIN].forEach((ac, k) =>
        vb.set(
          [
            X[i] - TZ[i] * ac,
            LV[i],
            Z[i] + TX[i] * ac,
            ac,
            Math.abs(ac) - hw,
            SA[i],
            STEEP[i],
            SLOPE[i],
            TX[i],
            TZ[i],
          ],
          (i * 5 + k) * 10,
        ),
      );
      if (i < FIRST[c + 1] - 1)
        for (let k = 0; k < 4; k++) {
          const v = i * 5 + k;
          ib.push(v, v + 5, v + 1, v + 1, v + 5, v + 6);
        }
    }
  return { field, half, vb, ib: new Uint32Array(ib) };
}

// creekAt(x, z): [metres to the nearest water's edge (below 0 in it, FAR away from any), its level there, its half
// width]; the array is reused. Before bake() there is no water anywhere
const CK = [FAR, 0, 1];
export const creekAt = (x, z) => {
  if (!FE) return CK;
  const u = clamp((x - OX) / SW - 0.5, 0, SN - 1.001),
    v = clamp((z - OZ) / SW - 0.5, 0, SN - 1.001),
    i = u | 0,
    j = v | 0,
    fu = u - i,
    fv = v - j,
    o = i + SN * j;
  CK[0] = mix(
    mix(FE[o], FE[o + 1], fu),
    mix(FE[o + SN], FE[o + SN + 1], fu),
    fv,
  );
  // (level and width from the nearest cell: next to a cell beyond REACH an average of them would mean nothing)
  const near = o + (fu > 0.5 ? 1 : 0) + (fv > 0.5 ? SN : 0);
  CK[1] = FL[near];
  CK[2] = FH[near];
  return CK;
};
// every sample of the streams, for what world.js lays along them: fn(x, z, the way it runs x z, half width, level,
// steepness, is this the lip of a fall)
export function alongStreams(fn) {
  for (let i = 0; i < N; i++)
    fn(
      X[i],
      Z[i],
      TX[i],
      TZ[i],
      HW[i],
      LV[i],
      STEEP[i],
      FALL[i] > 0 && !(i && FALL[i - 1] > 0),
    );
}
