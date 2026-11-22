// The world's layout and everything placed in it, made once at load on the CPU: the trail and side paths, the
// terrain's shape (buildTerrain, trailField), every tree, plant, rock and piece of woodwork (makeWorld, as instance
// stores sorted by culling cell), and the procedural meshes. scene.js calls it. Each part seeds the random stream
// (rseed): a part that draws more or fewer numbers moves everything drawn after it up to the next rseed.
import { HIGH, NEAR_D, THIN } from './quality.js';
import {
  abs,
  atan2,
  CELLS,
  CELLW,
  clamp,
  cos,
  fbm,
  floor,
  hypot,
  icosphere,
  ihash,
  lakeD,
  LAKE,
  max,
  Mesh,
  min,
  mix,
  NCHUNK,
  NTRUNK,
  NX,
  OPEN,
  NY,
  NZ,
  OX,
  OY,
  OZ,
  PI,
  pow,
  qAxis,
  qFromY,
  qMul,
  qRand,
  rnd,
  round,
  rr,
  rseed,
  sampler3,
  sin,
  sqrt,
  sstep,
  SUBS,
  surfaceNets,
  TAU,
  TDN,
  VS,
} from './math.js';
import { farOutline } from './atlas.js';
import { alongStreams, creekAt } from './water.js';

// ============================================================================
// world layout + procedural content generation (load-time only)
// ============================================================================

// rock outcrops: ax, az, bx, bz, radius, top (y), overhang, waist
export const MESAS = [
  [-74, -64, -62, -48, 9, 24, 2.5, 1.5],
  [-18, -112, -4, -106, 8, 22, 2, 1],
  [44, -74, 56, -66, 7, 21, 2, 1.2],
  [-112, 14, -106, 30, 8, 25, 3, 2],
  [104, -34, 112, -22, 7, 22, 2, 1],
  [10, -32, 18, -28, 5.5, 20, 2, 1],
];
// what W_DENS reads: two vec4 per outcrop
export const primBuffer = () => new Float32Array(MESAS.flat());

// The trail (x, z): a loop from the old growth over the creek, through the maples to the lake, back over the creek's
// mouth and round the meadow. TRAIL is the same curve as points about a metre apart; the walk starts at TRAIL[0]
const TRAIL_PTS = [
  [-64, 96],
  [-52, 72],
  [-36, 50],
  [-22, 30],
  [-12, 12],
  [4, -8],
  [26, -20],
  [48, -18],
  [66, -6],
  [62, 4],
  [40, 10],
  [26, 22],
  [13, 40],
  [2, 54],
  [-14, 58],
  [-28, 72],
  [-38, 90],
  [-52, 100],
];
// the loop's points the boardwalk runs over, first and last
export const BOARDWALK = [196, 222];
export const TRAIL = (() => {
  const out = [],
    n = TRAIL_PTS.length;
  for (let i = 0; i < n; i++) {
    const a = TRAIL_PTS[(i + n - 1) % n],
      b = TRAIL_PTS[i],
      c = TRAIL_PTS[(i + 1) % n],
      d = TRAIL_PTS[(i + 2) % n],
      steps = Math.ceil(hypot(c[0] - b[0], c[1] - b[1]));
    const cr = (k, u) =>
      0.5 *
      (2 * b[k] +
        (c[k] - a[k]) * u +
        (2 * a[k] - 5 * b[k] + 4 * c[k] - d[k]) * u * u +
        (3 * b[k] - a[k] - 3 * c[k] + d[k]) * u * u * u);
    for (let s = 0; s < steps; s++)
      out.push([cr(0, s / steps), cr(1, s / steps)]);
  }
  return out;
})();
// The trail changes its make along the loop: 0 a wide pale gravel path, 1 a narrow dirt track with roots, 2 a path
// under fallen leaves, 3 a worn track in grass. PATHS: from which point of TRAIL each stretch runs, its make, half
// its width in metres. Neighbouring stretches differ by one make where they can: the ground shader blends by number
const PATHS = [
  [0, 0, 1.4],
  [26, 1, 1.05],
  [66, 1, 0.75],
  [98, 2, 0.9],
  [124, 2, 1.15],
  [158, 1, 0.85],
  [188, 1, 1],
  [226, 0, 1.1],
  [250, 1, 0.8],
  [282, 2, 0.9],
  [296, 3, 0.7],
  [334, 2, 1],
  [352, 1, 1.1],
  [368, 0, 1.4],
];
const pathAt = (k) => {
  let p = PATHS[0];
  for (const q of PATHS) if (k >= q[0]) p = q;
  return p;
};
// Side paths off the loop, narrower than it: their bends (x, z), make and half their width. The first leaves the
// loop about 22 m from the start and swings west through the old growth back to the loop, where the second
// carries on east across the middle of it from a few steps further on; then a track to the west glade, a spur to the foot of the
// rock outcrop, and a grass path through the meadow to the lake
const BRANCHES = [
  {
    pts: [
      TRAIL[22],
      [-59, 68],
      [-66, 64],
      [-76, 52],
      [-72, 40],
      [-58, 36],
      [-48, 40],
      [-41.7, 44.3],
      TRAIL[50],
    ],
    make: 1,
    half: 0.6,
  },
  {
    pts: [
      [-36, 50],
      [-22, 56],
      [-8, 50],
      [2, 54],
    ],
    make: 2,
    half: 0.6,
  },
  {
    pts: [
      [-29, 40],
      [-40, 34],
      [-50, 28],
      [-57, 24],
    ],
    make: 2,
    half: 0.5,
  },
  {
    pts: [
      [26, -20],
      [22, -24],
      [18, -23],
      [14, -24],
    ],
    make: 1,
    half: 0.5,
  },
  {
    pts: [
      [-14, 58],
      [-8, 68],
      [-2, 76],
      [10, 78],
      [23, 78],
    ],
    make: 3,
    half: 0.55,
  },
  // The first side path forks before it meets the loop at either end: these are its second prongs. Between the
  // two prongs and the loop the ground is left alone, an island (makeWorld plants it)
  { pts: [TRAIL[32], [-54.2, 67.2], [-59, 68]], make: 1, half: 0.6, prong: 1 },
  {
    pts: [TRAIL[60], [-37.2, 44.4], [-41.7, 44.3]],
    make: 1,
    half: 0.6,
    prong: 1,
  },
];
// What the signposts' boards can say (scene.js draws the names into a texture, a name to a row), and what each
// side path leads to, from its first end and from its last, in the order of BRANCHES
export const LABELS = [
  'Lake',
  'Meadow',
  'Creek',
  'Old growth',
  'Glade',
  'Rock',
  'Trailhead',
  'Bridge',
];
const WHERE = [
  ['Old growth', 'Old growth'],
  ['Meadow', 'Old growth'],
  ['Glade', 'Trailhead'],
  ['Rock', 'Trailhead'],
  ['Meadow', 'Meadow'],
];
// where a second prong meets the loop: no signpost of its own
const PRONGS = BRANCHES.filter((b) => b.prong).map((b) => b.pts[0]);
// their points about a metre apart, each x, z, make, half width (uneven along the way), after the loop's points in
// every count of path points; ENDS: where each begins and ends (a junction, or its far end)
const SIDE = [];
export const ENDS = [];
const RUNS = []; // where in SIDE each side path's points begin, and after the last where they end
for (const b of BRANCHES) {
  const pts = b.pts,
    n = pts.length;
  RUNS.push(SIDE.length);
  ENDS.push(pts[0], pts[n - 1]);
  for (let i = 0; i < n - 1; i++) {
    const a = pts[Math.max(i - 1, 0)],
      p = pts[i],
      c = pts[i + 1],
      d = pts[Math.min(i + 2, n - 1)],
      steps = Math.ceil(hypot(c[0] - p[0], c[1] - p[1]));
    const cr = (k, u) =>
      0.5 *
      (2 * p[k] +
        (c[k] - a[k]) * u +
        (2 * a[k] - 5 * p[k] + 4 * c[k] - d[k]) * u * u +
        (3 * p[k] - a[k] - 3 * c[k] + d[k]) * u * u * u);
    for (let s = 0; s <= steps; s++)
      SIDE.push([
        cr(0, s / steps),
        cr(1, s / steps),
        b.make,
        b.half *
          (1 +
            0.25 * sin(SIDE.length * 0.31) +
            0.15 * sin(SIDE.length * 0.083 + 1)),
      ]);
  }
}
RUNS.push(SIDE.length);
// a path point by its number: the loop's first, then the side paths'
const pathXZ = (k) => (k < TRAIL.length ? TRAIL[k] : SIDE[k - TRAIL.length]);
// The make of the path at point k and half its width there. The loop's is its stretch's, swelling and narrowing
// unevenly along the way
export const trailMake = (k) =>
  k < TRAIL.length ? pathAt(k)[1] : SIDE[k - TRAIL.length][2];
// At a fork the ground is worn wide: every path point within 6 m of where a side path meets the loop is up to
// 0.5 m wider on each side
const JUNC = ENDS.filter((e) =>
  TRAIL.some((p) => hypot(p[0] - e[0], p[1] - e[1]) < 2.5),
);
const WIDE = Array.from({ length: TRAIL.length + SIDE.length }, (_, k) => {
  const p = pathXZ(k);
  let d = 1e9;
  for (const e of JUNC) d = min(d, hypot(p[0] - e[0], p[1] - e[1]));
  return 0.5 * sstep(6, 1.5, d);
});
export const trailHalf = (k) =>
  WIDE[k] +
  (k < TRAIL.length
    ? pathAt(k)[2] *
      (1 +
        0.22 * sin(k * 0.21) +
        0.14 * sin(k * 0.057 + 2) +
        0.1 * sin(k * 0.83 + 1))
    : SIDE[k - TRAIL.length][3]);
// Metres to the middle line of the nearest path (the loop or a side path), on a grid of 1.5 m cells (good to about a
// third of a metre), and in TK which path point is the nearest. scene.js builds
// it first, with trailField(): the ground shader shapes the terrain round the trail by it (W_DENS), and trailD
// reads it for everything placed afterwards
const TDW = (NX * VS) / TDN;
let TD = null,
  TK = null;
export function trailField() {
  TD = new Float32Array(TDN * TDN);
  TK = new Uint16Array(TDN * TDN);
  for (let j = 0; j < TDN; j++)
    for (let i = 0; i < TDN; i++) {
      const x = OX + (i + 0.5) * TDW,
        z = OZ + (j + 0.5) * TDW;
      let m = 1e9,
        at = 0;
      for (let k = 0; k < TRAIL.length + SIDE.length; k++) {
        const p = pathXZ(k),
          dx = x - p[0],
          dz = z - p[1],
          d = dx * dx + dz * dz;
        if (d < m) {
          m = d;
          at = k;
        }
      }
      TD[i + TDN * j] = sqrt(m);
      TK[i + TDN * j] = at;
    }
  return TD;
}
export const trailD = (x, z) => {
  const u = clamp((x - OX) / TDW - 0.5, 0, TDN - 1.001),
    v = clamp((z - OZ) / TDW - 0.5, 0, TDN - 1.001),
    i = u | 0,
    j = v | 0,
    fu = u - i,
    fv = v - j,
    o = i + TDN * j;
  return mix(
    mix(TD[o], TD[o + 1], fu),
    mix(TD[o + TDN], TD[o + TDN + 1], fu),
    fv,
  );
};
// the point of the trail nearest a place
export const trailK = (x, z) =>
  TK[
    clamp(floor((x - OX) / TDW), 0, TDN - 1) +
      TDN * clamp(floor((z - OZ) / TDW), 0, TDN - 1)
  ];

// ---------------------------------------------------------------- terrain mesh from the density grid
// One mesh of the grid sampled every f voxels, its quads bucketed into the XZ culling grid. f > 1 are the far
// levels of detail: `sink` moves their surface into the rock, so the finer mesh in front covers them where the
// two overlap (scene.js draws one ring of cells in both, which hides the cracks between levels).
function terrainMesh(D, smp, f, sink) {
  let G = D,
    nx = NX,
    ny = NY,
    nz = NZ;
  if (f > 1) {
    nx = NX / f;
    ny = NY / f;
    nz = NZ / f;
    G = new Float32Array(nx * ny * nz);
    for (let z = 0; z < nz; z++)
      for (let y = 0; y < ny; y++)
        for (let x = 0; x < nx; x++) {
          const edge =
            x === 0 || z === 0 || x === nx - 1 || z === nz - 1 || y === ny - 1; // closed like the fine grid
          G[x + nx * (y + ny * z)] = edge
            ? -1
            : D[x * f + NX * (y * f + NY * z * f)] - sink;
        }
  }
  const sn = surfaceNets(G, nx, ny, nz),
    nv = sn.nv,
    gp = sn.pos;
  const vb = new ArrayBuffer(nv * 16),
    vf = new Float32Array(vb),
    v8 = new Int8Array(vb);
  const wp = new Float32Array(nv * 3),
    wn = new Float32Array(nv * 3);
  for (let k = 0; k < nv; k++) {
    const x = gp[k * 3] * f,
      y = gp[k * 3 + 1] * f,
      z = gp[k * 3 + 2] * f,
      e = 0.8; // (the same step on every level: the light must not change where one takes over)
    let nx = smp(x - e, y, z) - smp(x + e, y, z),
      ny = smp(x, y - e, z) - smp(x, y + e, z),
      nz = smp(x, y, z - e) - smp(x, y, z + e);
    const l = hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    const X = OX + x * VS,
      Y = OY + y * VS,
      Z = OZ + z * VS;
    wp[k * 3] = vf[k * 4] = X;
    wp[k * 3 + 1] = vf[k * 4 + 1] = Y;
    wp[k * 3 + 2] = vf[k * 4 + 2] = Z;
    wn[k * 3] = nx;
    wn[k * 3 + 1] = ny;
    wn[k * 3 + 2] = nz;
    v8[k * 16 + 12] = round(nx * 127);
    v8[k * 16 + 13] = round(ny * 127);
    v8[k * 16 + 14] = round(nz * 127);
    v8[k * 16 + 15] = 127;
  }
  // bucket quads into the XZ culling grid
  const nq = sn.ni / 6,
    key = new Uint8Array(nq),
    cnt = new Uint32Array(CELLS * CELLS + 1);
  const lo = new Float32Array(CELLS * CELLS).fill(1e9),
    hi = new Float32Array(CELLS * CELLS).fill(-1e9);
  for (let q = 0; q < nq; q++) {
    const a = sn.idx[q * 6] * 3;
    const c =
      clamp(floor((wp[a] - OX) / CELLW), 0, CELLS - 1) +
      CELLS * clamp(floor((wp[a + 2] - OZ) / CELLW), 0, CELLS - 1);
    key[q] = c;
    cnt[c + 1]++;
    for (let j = 0; j < 6; j++) {
      const y = wp[sn.idx[q * 6 + j] * 3 + 1];
      if (y < lo[c]) lo[c] = y;
      if (y > hi[c]) hi[c] = y;
    }
  }
  for (let c = 0; c < CELLS * CELLS; c++) cnt[c + 1] += cnt[c];
  const ib = new Uint32Array(sn.ni),
    fill = cnt.slice();
  for (let q = 0; q < nq; q++) {
    const o = fill[key[q]]++ * 6;
    for (let j = 0; j < 6; j++) ib[o + j] = sn.idx[q * 6 + j];
  }
  return { vb, ib, nv, wp, wn, start: cnt, lo, hi };
}
// The full mesh (the generator places things on its vertices) and, in `far`, the same ground at 1/4 and 1/16
// of the triangles for the distance, where haze leaves only its outline.
export function buildTerrain(D) {
  const smp = sampler3(D, NX, NY, NZ),
    T = terrainMesh(D, smp, 1, 0);
  T.far = [terrainMesh(D, smp, 2, 0.3), terrainMesh(D, smp, 4, 0.9)].map(
    ({ vb, ib, start, lo, hi }) => ({ vb, ib, start, lo, hi }),
  );
  return T;
}
// The ground's height over every grid column (the topmost rock): what the walker, the trees and the animals stand on
function heightMap(D) {
  const H = new Float32Array(NX * NZ);
  for (let z = 0; z < NZ; z++)
    for (let x = 0; x < NX; x++) {
      const c = x + NX * NY * z;
      let y = NY - 2;
      while (y > 0 && D[c + NX * y] <= 0) y--;
      const d = D[c + NX * y],
        da = D[c + NX * (y + 1)];
      H[x + NX * z] = OY + (y + (d > 0 && da <= 0 ? d / (d - da) : 0)) * VS;
    }
  return H;
}
// a height map read at any point
export const heightAt = (H) => (x, z) => {
  const u = clamp((x - OX) / VS, 0, NX - 1.001),
    v = clamp((z - OZ) / VS, 0, NZ - 1.001),
    i = u | 0,
    j = v | 0,
    fu = u - i,
    fv = v - j,
    o = i + NX * j;
  return mix(mix(H[o], H[o + 1], fu), mix(H[o + NX], H[o + NX + 1], fu), fv);
};

// ---------------------------------------------------------------- instance stores
export function makeWorld(D, T) {
  const H = heightMap(D),
    gy = heightAt(H),
    W = NX * VS,
    N = TRAIL.length;
  // the ground normal's y at a point: 1 on the level
  const flat = (x, z) => {
    const e = 0.75,
      dx = gy(x + e, z) - gy(x - e, z),
      dz = gy(x, z + e) - gy(x, z - e);
    return 1 / sqrt(1 + (dx * dx + dz * dz) / (4 * e * e));
  };
  const nCells = CELLS * CELLS;
  const cellOf = (x, z) =>
    clamp(floor((x - OX) / CELLW), 0, CELLS - 1) +
    CELLS * clamp(floor((z - OZ) / CELLW), 0, CELLS - 1);
  // Inside a cell every packed store is ordered by sub-cell, and `sub[cell * NSUB + s]` is where sub-cell s starts:
  // with it scene.js cuts a level of detail through a cell instead of around it.
  const NSUB = SUBS * SUBS,
    SW = CELLW / SUBS,
    subMax = CELLS * SUBS - 1;
  const subOf = (x, z) =>
    (clamp(floor((x - OX) / SW), 0, subMax) % SUBS) +
    SUBS * (clamp(floor((z - OZ) / SW), 0, subMax) % SUBS);
  // one cell's instances (every `step`th, `stride` floats each) as offsets into its array, grouped by sub-cell
  const bySub = (a, stride, step = 1) => {
    const groups = Array.from({ length: NSUB }, () => []);
    for (let i = 0; i < a.length; i += stride * step)
      groups[subOf(a[i], a[i + 2])].push(i);
    return groups;
  };
  // leaf stores: the trees' crowns (drawn to where the fog ends them), the shrubs' (young trees and bushes: nearer),
  // and the small plants of the ground (ferns, grass, fallen leaves: nearer still). The first two turn into
  // branches with sprays close to the walker (W_LEAF vsN)
  const big = Array.from({ length: nCells }, () => []),
    shrub = Array.from({ length: nCells }, () => []),
    small = Array.from({ length: nCells }, () => []);
  // The trees' cards again, in two: those low enough to come within NEAR_D of the walker (they gain sprays there,
  // W_LEAF vsN, which tells them by the same height) and those high in a crown. And the bare limbs and stems
  // farT: one card to a tree, its whole crown as a picture, for where its own cards have thinned away (W_LEAF vsFar)
  const farT = Array.from({ length: nCells }, () => []);
  const low = Array.from({ length: nCells }, () => []),
    high = Array.from({ length: nCells }, () => []),
    limb = Array.from({ length: nCells }, () => []);
  // places to look at from a debugger (scene.js debug.near): x, y, z, size
  // dead branches a bird may sit on: root x y z, length, bearing, tilt, bend, and 1 for one by a path (birds.js)
  const perches = [];
  const tops = []; // the tops of posts, for a bird to stand on: x y z
  const spots = {
    bush: [],
    young: [],
    bough: [],
    maple: [],
    log: [],
    stump: [],
    fence: [],
    fall: [],
    sign: [],
  };
  // High keeps one pebble in 2, Medium and Low one in 4 (THIN; picked by a hash, so the random stream stays the same).
  // Leaves are all kept on every tier: the fog ends the view early instead, and what is near is what is looked at
  let nth = 0;
  const kept = (thin = THIN) => ihash(nth++, 3, 5) * thin < 1;
  // a ribbon leaf (W_LEAF): root, length, yaw, tilt from upright, width, height up its plant, type, tree hue, seed, bend
  const leaf = (L, x, y, z, len, yaw, tilt, wid, hA, type, s1, s2, bend) => {
    // Nothing reaches over a path below head height: a card that could come within half a metre of a path's edge
    // and is (or hangs) under 2.3 m over the ground is cut short to that, or left out. (Not short grass and the
    // leaves lying on the ground: a grass track is made of them)
    const room = trailD(x, z) - trailHalf(trailK(x, z)) - 0.5;
    if (
      room < len &&
      !(type === 4 && len < 0.9) &&
      !(hA === 0 && len < 0.3) &&
      y - (tilt > 1.6 ? len : 0) - gy(x, z) < 2.3
    ) {
      if (room < 0.25) return;
      wid *= room / len;
      len = room;
    }
    L[cellOf(x, z)].push(x, y, z, len, yaw, tilt, wid, hA, type, s1, s2, bend);
    if (L === big)
      (hA < NEAR_D + 3 ? low : high)[cellOf(x, z)].push(
        x,
        y,
        z,
        len,
        yaw,
        tilt,
        wid,
        hA,
        type,
        s1,
        s2,
        bend,
      );
  };
  const solids = []; // per mesh id: arrays of 12 floats
  const props = Array.from({ length: NTRUNK }, () =>
    Array.from({ length: nCells }, () => []),
  );
  const boulders = Array.from({ length: 4 }, () =>
    Array.from({ length: nCells }, () => []),
  );
  // mesh ids as scene.js registers them: 0-1 boulders, 2 a log, 3 a stump, then the NTRUNK trunks by kind, then the woodwork
  const WOOD = 4 + NTRUNK;
  const solid = (mesh, x, y, z, sc, q, mat, seed, ts = 1, bob = 0) => {
    (mesh < 4
      ? boulders[mesh][cellOf(x, z)]
      : mesh < WOOD
        ? props[mesh - 4][cellOf(x, z)]
        : (solids[mesh] ||= [])
    ).push(x, y, z, sc, q[0], q[1], q[2], q[3], mat, seed, ts, bob);
  };
  // loose pieces: kinds 0-1 small rocks, 2 mushrooms, 3-5 large rocks, 6 pebbles, 7 fallen branches and roots,
  // 8 stepping stones;
  // `fade`: where a small rock is gone (1 for wood: its material reads that value as its grain's scale)
  const chunks = Array.from({ length: NCHUNK }, () =>
    Array.from({ length: nCells }, () => []),
  );
  const chunk = (kind, x, y, z, sc, q, mat, seed, fade) =>
    chunks[kind][cellOf(x, z)].push(
      x,
      y,
      z,
      sc,
      q[0],
      q[1],
      q[2],
      q[3],
      mat,
      seed,
      fade,
      0,
    );
  const shade = new Float32Array((NX / 2) * (NY / 2) * (NZ / 2)); // light the crowns take, per cell of the light volume
  const blocks = []; // x, z, radius of what the walker goes round: trunks, boulders, logs, posts
  // What stops the walker along a line (rails, fences, the unseen edges of crossings and the dock): x0, z0, x1, z1,
  // radius. A row of discs there was a wall with a bump at each disc, and the walker sliding along it bounced. Their
  // discs of old stay in `touch`, for the contact map only, so the ground's shading is as it was
  const walls = [],
    touch = [];
  // How much of a level line of sight each metre of forest blocks, on a grid of 3 m cells: every trunk, young tree
  // and bush adds its width over its cell's area. scene.js leaves out what stands behind enough of it
  const OCN = 128,
    OCW = (NX * VS) / OCN,
    occ = new Float32Array(OCN * OCN);
  const screen = (x, z, wide) => {
    occ[
      clamp(floor((x - OX) / OCW), 0, OCN - 1) +
        OCN * clamp(floor((z - OZ) / OCW), 0, OCN - 1)
    ] += wide / (OCW * OCW);
  };
  const trees = [],
    litter = []; // trees: the big trunks (debug.near 'trunk'); litter: x, z, radius where a broadleaf drops its leaves

  // --- where things grow
  const MEADOW = OPEN[0],
    GLADES = OPEN.slice(1);
  // 1 in the meadow and the glades (grass, no trees), falling to 0 over their last metres
  const openAt = (x, z) => {
    let o = 0;
    for (const p of OPEN)
      o = max(o, sstep(p[2], p[2] - p[3], hypot(x - p[0], z - p[1])));
    return o;
  };
  // stands of maple and of birch among the conifers: x, z, radius, share of the trees there
  const MAPLES = [
    [30, -30, 52, 0.8],
    [-30, 70, 30, 0.45],
    [74, 2, 30, 0.6],
    [-80, 40, 34, 0.5],
  ];
  const BIRCHES = [
    [-46, 108, 30, 0.7],
    [18, 54, 22, 0.6],
    [100, 22, 30, 0.6],
    [-20, -60, 30, 0.5],
  ];
  const zone = (list, x, z) => {
    let m = 0;
    for (const p of list)
      m = max(m, p[3] * sstep(p[2], p[2] * 0.5, hypot(x - p[0], z - p[1])));
    return m;
  };
  // far enough from the lake's shore, the trail's middle and the edge of any running water?
  const clearOf = (x, z, lake, trail, creek) =>
    lakeD(x, z) > lake && trailD(x, z) > trail && creekAt(x, z)[0] > creek;
  // where a ribbon leaf is, v of the way along it: the leaf shader's own curve, without its waving
  const onLeaf = (x, y, z, len, yaw, tilt, bend, v) => {
    const ka = (bend - 0.3) * 3.4 || 0.06,
      ct = cos(tilt),
      st = sin(tilt),
      a = (sin(ka * v) / ka) * len,
      b = ((1 - cos(ka * v)) / ka) * len;
    return [
      x + (st * a + ct * b) * cos(yaw),
      y + ct * a - st * b,
      z + (st * a + ct * b) * sin(yaw),
    ];
  };
  // a crown's shade, into the cells of the light volume it fills
  const canopy = (x, y0, y1, z, r, k) => {
    const hx = round((x - OX) / VS / 2),
      hz = round((z - OZ) / VS / 2),
      n = Math.ceil(r / VS / 2);
    for (
      let hy = max(floor((y0 - OY) / VS / 2), 0);
      hy <= min(floor((y1 - OY) / VS / 2), NY / 2 - 1);
      hy++
    )
      for (let j = -n; j <= n; j++)
        for (let i = -n; i <= n; i++) {
          const cx = hx + i,
            cz = hz + j;
          if (
            i * i + j * j <= n * n &&
            cx > 0 &&
            cx < NX / 2 - 1 &&
            cz > 0 &&
            cz < NZ / 2 - 1
          )
            shade[cx + (NX / 2) * (hy + (NY / 2) * cz)] += k;
        }
  };

  // --- trees. A trunk is an instance of a mesh 1 tall, scaled to the tree's height; its seed is kind + hue
  // Every tree leans its own way a little, a few of them a lot: [x, z] is how far it goes sideways per metre up
  const lean = () => {
    const a = rnd() * TAU,
      m = 0.015 + 0.09 * pow(rnd(), 2.2) + (rnd() < 0.06 ? 0.12 : 0);
    return [cos(a) * m, sin(a) * m];
  };
  // Most trunks within 10 m of a path have one low dead branch turned toward it, 2.4 to 3.6 m up (never cut short
  // by leaf's rule): where a jay crossing the path lands in the walker's view. Drawn by a hash: rnd's stream stays
  const pathPerch = (x, y, z, l, r0, H) => {
    const hash = (salt) => ihash(round(x * 20), round(z * 20), salt);
    if (trailD(x, z) > 10 || hash(1) > 0.9) return;
    const h = 2.4 + 1.2 * hash(2),
      len = 0.9 + 0.6 * hash(3),
      tilt = PI / 2 + 0.05 + 0.25 * hash(4),
      bend = 0.3 + 0.1 * hash(5),
      a =
        atan2(
          trailD(x, z - 0.5) - trailD(x, z + 0.5),
          trailD(x - 0.5, z) - trailD(x + 0.5, z),
        ) +
        (hash(6) - 0.5) * 1.4,
      rt = r0 * (1 - (0.85 * h) / H),
      bx = x + l[0] * h + cos(a) * rt,
      bz = z + l[1] * h + sin(a) * rt;
    leaf(
      big,
      bx,
      y + h,
      bz,
      len,
      a,
      tilt,
      len * 0.62,
      h,
      13,
      0.5,
      hash(7),
      bend,
    );
    perches.push(bx, y + h, bz, len, a, tilt, bend, 1);
  };
  // the trunk's turn for a lean: tipped that way, spun about itself by chance
  const tipped = (l) => {
    const n = hypot(l[0], 1, l[1]);
    return qMul(qFromY(l[0] / n, 1 / n, l[1] / n), qAxis(0, 1, 0, rnd() * TAU));
  };
  // A conifer's far pictures' outlines (atlas.js farOutline: 0 fir, 1 broken top, 2 hemlock, 3 cedar, 4 pole), and
  // for each how far out the boughs reach to fill it: set so the crown seen from 20 m (cards and all) is as wide as
  // the picture from 58 m, on the mean of its middle eight of ten heights
  const OUTLINE = [0, 1, 2, 3, 4].map(farOutline),
    FILL = [1.14, 1.22, 1.26, 1.18, 1.22];
  // A conifer (0 fir, 1 cedar, 6 a thin pole with a small crown at its top): whorls of drooping boughs from h0 up,
  // each with sprays hanging from it. The boughs are drawn first and laid once the far picture is chosen (its kind
  // last of the tree's draws, as it always was), each reaching to that picture's outline where its tip ends
  const conifer = (x, y, z, kind, H) => {
    const pole = kind === 6,
      hue =
        kind === 1 ? rr(0.4, 0.8) : rnd() < 0.08 ? rr(0.88, 0.99) : rr(0, 0.6),
      l = lean(); // (hues over .86: a few of the brightest green)
    const h0 = H * (pole ? rr(0.55, 0.72) : rr(kind ? 0.36 : 0.26, 0.48)),
      r0 = H * (pole ? 0.011 : kind ? 0.03 : 0.021),
      ph = rnd() * TAU;
    const Lm =
      min(H * (pole ? rr(0.09, 0.13) : rr(0.14, 0.2)), 6.5) *
      (kind === 1 ? 1.15 : 1);
    solid(4 + kind, x, y - 0.5, z, H, tipped(l), 2, kind + hue * 0.99);
    blocks.push(x, z, r0 * 1.25 + 0.15);
    screen(x, z, r0 * 2.2 + (pole ? 0.15 : 0.5));
    if (r0 > 0.55) trees.push({ x, y, z, r: r0, h: H });
    if (!pole) spots.bough.push([x + l[0] * h0, y + h0, z + l[1] * h0, Lm]);
    const boughs = [],
      tops = [];
    // a bough added to a whorl at h (t of the way up the crown), heading a, by a hash of the tree's place and salt:
    // the generator's own draws are left as they were, so no tree moves
    const added = (h, t, a, rt, salt) => {
      const hs = (k) => ihash(round(x * 20), round(z * 20), salt * 16 + k);
      boughs.push({
        h,
        a,
        tilt: PI / 2 - 0.1 + 0.4 * hs(0) - 0.55 * t * t,
        bend: 0.42 + 0.2 * hs(1) - 0.12 * t,
        rt,
        f: (0.8 + 0.32 * hs(2)) / 0.96,
        wide: 0.5 + 0.18 * hs(3),
        seed: hs(4),
        spray:
          hs(5) < 0.65
            ? {
                v: 0.45 + 0.45 * hs(6),
                len: (0.9 + 0.9 * hs(7)) * (kind === 1 ? 1.3 : 1),
                yaw: a - 0.8 + 1.6 * hs(8),
                tilt: PI - 0.3 * hs(9),
                wid: 0.55 + 0.3 * hs(10),
                seed: hs(11),
                bend: 0.3 + 0.12 * hs(12),
              }
            : null,
      });
    };
    let w = 0;
    for (let h = h0; h < H - 0.5; h += rr(1.1, 1.7) * (pole ? 1.2 : 1), w++) {
      const t = (h - h0) / (H - h0),
        f = rr(0.8, 1.12) / 0.96,
        n = pole || t > 0.8 ? 3 : 4 + (rnd() < 0.5),
        rt = r0 * (1 - (0.85 * h) / H);
      for (let j = 0; j < n; j++) {
        const a = ph + w * 2.4 + (j * TAU) / n + rr(-0.3, 0.3),
          tilt = PI / 2 + rr(-0.1, 0.3) - 0.55 * t * t,
          bend = rr(0.42, 0.62) - 0.12 * t;
        boughs.push({
          h,
          a,
          tilt,
          bend,
          rt,
          f,
          wide: rr(0.5, 0.68),
          seed: rnd(),
          spray:
            rnd() < 0.65
              ? {
                  v: rr(0.45, 0.9),
                  len: rr(0.9, 1.8) * (kind === 1 ? 1.3 : 1),
                  yaw: a + rr(-0.8, 0.8),
                  tilt: PI - rr(0, 0.3),
                  wid: rr(0.55, 0.85),
                  seed: rnd(),
                  bend: rr(0.3, 0.42),
                }
              : null,
        });
      }
      // (a whorl short of six boughs gets more, between its own)
      for (let j = n; j < 6; j++)
        added(h, t, ph + w * 2.4 + ((j - n + 0.5) * TAU) / n, rt, w * 8 + j);
      // (a pole's crown a whorl more between each two, half its mean step on)
      if (pole && h + 0.84 < H - 0.5)
        for (let j = 0; j < 3; j++)
          added(
            h + 0.84,
            (h + 0.84 - h0) / (H - h0),
            ph + (w + 0.5) * 2.4 + (j * TAU) / 3,
            r0 * (1 - (0.85 * (h + 0.84)) / H),
            w * 8 + 5 + j,
          );
    }
    for (let j = 0; j < 3; j++)
      tops.push([
        rr(0.8, 1.3),
        rnd() * TAU,
        rr(0.1, 0.5),
        rr(0.3, 0.45),
        rnd(),
      ]);
    // dead branches below the live crown: bare grey sticks with their twigs (type 13), from over head height up
    if (!pole)
      for (let j = 3 + ((rnd() * 5) | 0); j > 0; j--) {
        const h = rr(2.8, h0),
          a = rnd() * TAU,
          rt = r0 * (1 - (0.85 * h) / H),
          L = rr(0.7, 2.1),
          tilt = PI / 2 + rr(0.05, 0.45),
          seed = rnd(),
          bend = rr(0.3, 0.4),
          bx = x + l[0] * h + cos(a) * rt,
          bz = z + l[1] * h + sin(a) * rt;
        leaf(big, bx, y + h, bz, L, a, tilt, L * 0.62, h, 13, 0.5, seed, bend);
        // (a stick for a bird to sit on: birds.js works out any place along it, as onLeaf does)
        perches.push(bx, y + h, bz, L, a, tilt, bend, 0);
      }
    pathPerch(x, y, z, l, r0, H);
    canopy(
      x + (l[0] * (h0 + H)) / 2,
      y + h0,
      y + H,
      z + (l[1] * (h0 + H)) / 2,
      Lm * 0.75,
      pole ? 0.025 : 0.05,
    );
    // its far picture (atlas.js farTree): a fir's, now and then one with a broken top or a hemlock's; a cedar's; a pole's
    const seed = rnd(),
      far = pole ? 4 : kind === 1 ? 3 : rnd() < 0.14 ? 1 : rnd() < 0.3 ? 2 : 0,
      band = H - h0 + 0.8;
    farT[cellOf(x, z)].push(
      x + l[0] * h0,
      y + h0 - 0.5,
      z + l[1] * h0,
      band,
      atan2(l[1], l[0]),
      Math.atan(hypot(l[0], l[1])),
      Lm * 2.3,
      h0,
      12,
      hue,
      seed,
      (far + 0.5) / 8,
    );
    // its boughs, each out to the picture's outline at its tip (it falls or rises along the bough's curve, as
    // onLeaf has it), none above where a broken top ends
    const out = OUTLINE[far],
      reach = Lm * 2.3 * FILL[far],
      halfAt = (h) => {
        const r = round(((h - h0 + 0.5) * 200) / band);
        return r < 0 || r > 200 ? 0 : out[r] * reach;
      },
      type = kind === 1 ? 10 : 0;
    for (const b of boughs) {
      if (!(halfAt(b.h) > 0)) continue;
      const ka = (b.bend - 0.3) * 3.4 || 0.06,
        across = (sin(b.tilt) * sin(ka) + cos(b.tilt) * (1 - cos(ka))) / ka,
        up = (cos(b.tilt) * sin(ka) - sin(b.tilt) * (1 - cos(ka))) / ka;
      let L = 0;
      for (let k = 0; k < 2; k++)
        L = max(halfAt(b.h + L * up) - b.rt, 0) / across;
      L = max(L, 0.4) * b.f;
      const bx = x + l[0] * b.h + cos(b.a) * b.rt,
        bz = z + l[1] * b.h + sin(b.a) * b.rt;
      // (a bough 1.6 times as wide as it once was: its picture's branchlets reach to its edges now)
      leaf(
        big,
        bx,
        y + b.h,
        bz,
        L,
        b.a,
        b.tilt,
        L * b.wide * 1.6,
        b.h,
        type,
        hue,
        b.seed,
        b.bend,
      );
      const s = b.spray;
      if (s) {
        const p = onLeaf(bx, y + b.h, bz, L, b.a, b.tilt, b.bend, s.v);
        leaf(
          big,
          p[0],
          p[1],
          p[2],
          s.len,
          s.yaw,
          s.tilt,
          s.wid,
          b.h,
          6,
          hue,
          s.seed,
          s.bend,
        );
      }
    }
    // (a broken top's at the break: its picture's top, 1.5 of its 2)
    const ht = far === 1 ? min(H - 0.8, h0 - 0.5 + band * 0.75) : H - 0.8,
      hx = far === 1 ? ht : H;
    for (const [len, yaw, tilt, wid, s2] of tops)
      leaf(
        big,
        x + l[0] * hx,
        y + ht,
        z + l[1] * hx,
        len,
        yaw,
        tilt,
        wid,
        H,
        type,
        hue,
        s2,
        0.35,
      );
  };
  // A broadleaf (2 maple, 3 birch, 4 oak). Limbs reach from the top of its bole into the crown, each a bare strip
  // (type 8), and the leaf cards sit along the outer part of each limb, heading on outward: a crown is clumps of
  // leaves along limbs with sky between them, not an even ball. Each card carries a spread of small leaves
  // (W_LEAF), so a crown needs few of them
  const broadleaf = (x, y, z, kind) => {
    const H = kind === 3 ? rr(9, 15) : kind === 4 ? rr(11, 18) : rr(9, 17),
      hue = rnd(),
      type = kind === 2 ? 3 : kind === 3 ? 5 : 7,
      l = lean();
    const cy = H * rr(0.62, 0.7),
      rx = H * (kind === 3 ? rr(0.17, 0.23) : rr(0.27, 0.36)),
      ry = H * rr(0.28, 0.34),
      n = floor(rx * ry * (kind === 3 ? 13 : 16));
    const nl = 5 + ((rnd() * 4) | 0),
      bh = H * (kind === 3 ? 0.5 : 0.36),
      sx = x + l[0] * bh,
      sy = y + bh,
      sz = z + l[1] * bh;
    solid(4 + kind, x, y - 0.4, z, H, tipped(l), 2, kind + hue * 0.99);
    blocks.push(x, z, H * 0.022 + 0.15);
    pathPerch(x, y, z, l, H * 0.022, H);
    screen(x, z, H * 0.044 + 0.4);
    for (let j = 0; j < nl; j++) {
      const az = (j / nl) * TAU + rr(-0.4, 0.4),
        u = rr(-0.25, 0.95),
        s = sqrt(1 - u * u),
        reach = rr(0.75, 1);
      const dx = x + l[0] * cy + cos(az) * s * rx * reach - sx,
        dy = y + cy + u * ry * reach - sy,
        dz = z + l[1] * cy + sin(az) * s * rx * reach - sz,
        ll = hypot(dx, dy, dz);
      leaf(
        limb,
        sx,
        sy,
        sz,
        ll,
        atan2(dz, dx),
        Math.acos(clamp(dy / ll, -1, 1)),
        H * 0.009 + 0.04,
        bh,
        8,
        0.5,
        rnd(),
        0.3,
      );
      // It forks on its way: the fork leaves it part way out, to one side and a little up, about half as long.
      // The leaf cards sit along the limb's outer part and along its fork
      const ends = [[sx, sy, sz, dx, dy, dz, 0.4]];
      for (const side of [j % 2 ? 1 : -1]) {
        const t = rr(0.35, 0.65),
          fl = ll * rr(0.38, 0.55),
          fa = az + side * rr(0.5, 1),
          fu = clamp(dy / ll + rr(-0.1, 0.35), -0.3, 0.95),
          fs = sqrt(1 - fu * fu);
        const fx = sx + dx * t,
          fy = sy + dy * t,
          fz = sz + dz * t;
        leaf(
          limb,
          fx,
          fy,
          fz,
          fl,
          fa,
          Math.acos(fu),
          H * 0.005 + 0.025,
          bh,
          8,
          0.5,
          rnd(),
          0.3,
        );
        ends.push([
          fx,
          fy,
          fz,
          cos(fa) * fs * fl,
          fu * fl,
          sin(fa) * fs * fl,
          0.45,
        ]);
      }
      // A card's root lies on its limb or fork, never past the tip, so its tufts' twigs meet on wood (W_LEAF limbPF).
      // Its jitter is drawn as before (y, the length, x, z: the random stream stays the same) but moves it only along
      // the line
      for (let i = Math.ceil(n / nl); i > 0; i--) {
        const e = ends[i % 2],
          t = rr(e[6], 1.05),
          o = ll * 0.1,
          jy = rr(-o, o),
          L = rr(1.2, 2.1) * (kind === 3 ? 0.75 : 1),
          jx = rr(-o, o),
          jz = rr(-o, o),
          along = (jx * e[3] + jy * e[4] + jz * e[5]) / (e[3] * e[3] + e[4] * e[4] + e[5] * e[5]),
          on = clamp(t + along, e[6], 1),
          py = e[1] + e[4] * on;
        leaf(
          big,
          e[0] + e[3] * on,
          py,
          e[2] + e[5] * on,
          L,
          az + rr(-0.7, 0.7),
          clamp(
            Math.acos(u) + rr(-0.5, 0.5) + (kind === 3 ? 0.5 : 0),
            0.15,
            2.8,
          ),
          L * rr(0.75, 1),
          py - y,
          type,
          clamp(hue + rr(-0.05, 0.05), 0, 0.999),
          rnd(),
          rr(0.3, 0.6),
        );
      }
    }
    canopy(
      x + l[0] * cy,
      y + cy - ry,
      y + cy + ry,
      z + l[1] * cy,
      rx * 0.8,
      0.04,
    );
    // (its far picture's crown fills the middle two thirds of the picture's height)
    farT[cellOf(x, z)].push(
      x + l[0] * (cy - ry * 1.6),
      y + cy - ry * 1.6,
      z + l[1] * (cy - ry * 1.6),
      ry * 3.1,
      atan2(l[1], l[0]),
      Math.atan(hypot(l[0], l[1])),
      rx * 2.2,
      cy - ry,
      12,
      hue,
      rnd(),
      (kind + 3.5) / 8,
    );
    litter.push(x, z, rx * 1.7);
    if (kind === 2)
      spots.maple.push([x + l[0] * cy, y + cy, z + l[1] * cy, rx]);
  };
  const snag = (x, y, z) => {
    const h = rr(6, 11);
    solid(9, x, y - 0.3, z, h, tipped(lean()), 2, 5 + rnd() * 0.99);
    blocks.push(x, z, h * 0.05 + 0.2);
    screen(x, z, h * 0.1);
  };
  // A young hemlock of the understory: a pole's trunk and flat lacy sprays in tiers almost to the ground. With the
  // bushes these fill the space between the big trunks, which is what makes a forest read as dense
  const young = (x, y, z, H = rr(2.5, 9)) => {
    const hue = rr(0.5, 0.85),
      ph = rnd() * TAU,
      l = lean();
    solid(4 + 6, x, y - 0.2, z, H, tipped(l), 2, 6 + hue * 0.99);
    // (a seedling under 2 m, as on a log's back, is in nobody's way and screens nothing)
    if (H >= 2) {
      spots.young.push([x, y, z, H]);
      blocks.push(x, z, 0.3);
      screen(x, z, H * 0.3);
    }
    // a soft cone of short drooping boughs in tiers, from a hand over the ground to its nodding tip (type 9)
    for (let h = 0.2, w = 0; h < H - 0.2; h += rr(0.3, 0.44), w++) {
      const t = h / H,
        L = min(H * 0.3 * (1 - 0.85 * t) + 0.32, 1.7);
      for (let j = 0; j < 5; j++)
        leaf(
          shrub,
          x + l[0] * h,
          y + h,
          z + l[1] * h,
          L * rr(0.75, 1.1),
          ph + w * 2.4 + (j * TAU) / 5 + rr(-0.4, 0.4),
          PI / 2 + rr(0, 0.3) - 0.35 * t,
          L * rr(0.75, 0.95),
          h,
          9,
          hue,
          rnd(),
          rr(0.42, 0.56),
        );
    }
    leaf(
      shrub,
      x + l[0] * H,
      y + H - 0.25,
      z + l[1] * H,
      rr(0.5, 0.8),
      rnd() * TAU,
      rr(0.5, 1),
      0.3,
      H,
      9,
      hue,
      rnd(),
      0.6,
    );
  };
  // A bush in autumn colours: a few long stems from one root that arch over (bare strips, type 8), with the leaf
  // cards lying level along them in tiers (type 11): every leaf hangs from a twig that leads to the ground (like
  // all the understory, in the store drawn only near)
  const bush = (x, y, z) => {
    // most still green, some turned yellow, a few orange or red (the maple's hues, folC in shaders.js)
    const R = rr(0.9, 2.1),
      turn = rnd(),
      hue =
        turn < 0.45
          ? rr(0.91, 0.99)
          : turn < 0.75
            ? rr(0, 0.3)
            : turn < 0.9
              ? rr(0.34, 0.6)
              : rr(0.64, 0.88);
    if (R > 1.2) screen(x, z, R);
    spots.bush.push([x, y, z, R]);
    // (the walker goes round a bush, not through its leaves; but it never narrows a path)
    {
      const r = min(R * 0.55, trailD(x, z) - trailHalf(trailK(x, z)) - 0.65);
      if (r > 0.15) blocks.push(x, z, r);
    }
    const ns = 3 + ((rnd() * 3) | 0),
      nc = 14 + ((rnd() * 14) | 0);
    for (let j = 0; j < ns; j++) {
      const az = (j / ns) * TAU + rr(-0.5, 0.5),
        tilt = rr(0.3, 0.8),
        ll = R * rr(1.3, 1.9),
        bend = rr(0.5, 0.6);
      leaf(
        limb,
        x,
        y,
        z,
        ll,
        az,
        tilt,
        0.035 + R * 0.012,
        0.3,
        8,
        0.5,
        rnd(),
        bend,
      );
      for (let i = Math.ceil(nc / ns); i > 0; i--) {
        const p = onLeaf(x, y, z, ll, az, tilt, bend, rr(0.4, 1)),
          L = rr(0.6, 1.1);
        leaf(
          shrub,
          p[0] + rr(-0.15, 0.15),
          p[1] + rr(-0.05, 0.1),
          p[2] + rr(-0.15, 0.15),
          L,
          az + rr(-1.1, 1.1),
          PI / 2 + rr(-0.15, 0.25),
          L * rr(0.75, 1),
          max(p[1] - y, 0.05),
          11,
          clamp(hue + rr(-0.06, 0.06), 0, 0.999),
          rnd(),
          rr(0.3, 0.4),
        );
      }
    }
  };
  // ribbons fanning out from one root: a fern (type 2) or a clump of reeds (type 4)
  const cluster = (x, y, z, n, type, lmin, lmax, wmin, wmax, tmax, sway) => {
    for (let i = 0; i < n; i++) {
      const a = rnd() * TAU,
        r = rnd() * 0.25,
        L = rr(lmin, lmax);
      leaf(
        small,
        x + cos(a) * r,
        y - 0.1,
        z + sin(a) * r,
        L,
        a,
        rr(0.05, tmax),
        rr(wmin, wmax),
        sway,
        type,
        rnd(),
        rnd(),
        rr(0.3, 0.8),
      );
    }
  };

  // The forest: one tree at most per 2.6 m cell, thinner where a noise says so; none on the trail, in the creek, by
  // the water or in the clearings. Half the conifers are thin poles: it is the many trunks that make a forest dense
  const taken = new Set();
  const plant = (x, z, u, v, giant) => {
    const key = floor(x / 2.6) * 4096 + floor(z / 2.6);
    if (taken.has(key) || !clearOf(x, z, 3.5, 2.8, 1.5) || openAt(x, z) > 0.3)
      return;
    const y = gy(x, z);
    if (
      y < 0.5 ||
      flat(x, z) < 0.74 ||
      v > 0.45 + 0.5 * sstep(0.3, 0.62, fbm(x * 0.02, 4, z * 0.02, 3))
    )
      return;
    taken.add(key);
    const mp = zone(MAPLES, x, z) * 0.85,
      bp = zone(BIRCHES, x, z) * 0.8;
    if (giant) conifer(x, y, z, 1, rr(34, 40));
    else if (u < mp) broadleaf(x, y, z, rnd() < 0.22 ? 4 : 2);
    else if (u < mp + bp) broadleaf(x, y, z, 3);
    else if (u > 0.9)
      broadleaf(x, y, z, rnd() < 0.6 ? 2 : rnd() < 0.5 ? 4 : 3); // maples, oaks and birches among the conifers
    else if (u > 0.885) snag(x, y, z);
    else {
      const c = rnd();
      if (c < 0.54) conifer(x, y, z, 6, rr(9, 24));
      else if (c < 0.86) conifer(x, y, z, 0, rr(18, 36));
      else conifer(x, y, z, 1, rr(26, 40));
    }
  };
  // the trail's left-hand normal at point k
  const tnorm = (k) => {
    const a = TRAIL[(k - 1 + N) % N],
      b = TRAIL[(k + 1) % N],
      l = hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [-(b[1] - a[1]) / l, (b[0] - a[0]) / l];
  };
  rseed(1);
  // giant cedars beside the first stretch of the trail, which the walk opens on
  for (const [k, side] of [
    [7, 1],
    [12, -1],
    [19, 1],
    [25, -1],
    [33, 1],
    [40, -1],
  ]) {
    const n = tnorm(k);
    plant(
      TRAIL[k][0] + n[0] * side * 4.6,
      TRAIL[k][1] + n[1] * side * 4.6,
      0,
      0,
      true,
    );
  }
  for (let i = 0; i < 12000; i++) {
    const a = rnd() * TAU,
      r = sqrt(rnd()) * 186;
    plant(cos(a) * r, sin(a) * r, rnd(), rnd(), false);
  }
  // the understory: young firs, bushes and ferns, lusher by the creek
  rseed(2);
  for (let i = 0; i < 25000; i++) {
    const a = rnd() * TAU,
      r = sqrt(rnd()) * 176,
      x = cos(a) * r,
      z = sin(a) * r,
      u = rnd();
    // (and nothing by a bridge: the water beside it must show from the trail)
    if (
      !clearOf(x, z, 1.5, trailHalf(trailK(x, z)) + 0.5, 0.35) ||
      openAt(x, z) > 0.5 ||
      (creekAt(x, z)[0] < 4.5 && trailD(x, z) < 8)
    )
      continue;
    const y = gy(x, z);
    if (y < 0.3 || flat(x, z) < 0.7) continue;
    if (u < 0.15) young(x, y, z);
    else if (u < 0.3) bush(x, y, z);
    else if (
      u <
      0.6 +
        0.4 *
          max(
            sstep(10, 0.5, creekAt(x, z)[0]),
            sstep(0.35, 0.6, fbm(x * 0.05, 2, z * 0.05, 2)),
          )
    )
      cluster(x, y, z, 6 + ((rnd() * 6) | 0), 2, 0.7, 1.6, 0.3, 0.5, 1.3, 0.4);
  }

  // ferns line the trail on both sides, as they do every path through these woods
  for (let k = 0; k < N; k++)
    for (let j = 0; j < 7; j++) {
      const n = tnorm(k),
        side = rnd() < 0.5 ? -1 : 1,
        off = trailHalf(k) + rr(0.3, 6),
        x = TRAIL[k][0] + n[0] * side * off + rr(-0.5, 0.5),
        z = TRAIL[k][1] + n[1] * side * off + rr(-0.5, 0.5),
        y = gy(x, z);
      if (
        y > 0.3 &&
        clearOf(x, z, 1.5, trailHalf(k) + 0.25, 4.5) &&
        openAt(x, z) < 0.5
      )
        cluster(
          x,
          y,
          z,
          7 + ((rnd() * 7) | 0),
          2,
          0.8,
          1.7,
          0.34,
          0.55,
          1.3,
          0.4,
        );
    }

  // and the side paths, where they may stand anywhere round a point of the path that is clear of it
  for (const p of SIDE)
    for (let j = 0; j < 5; j++) {
      const a = rnd() * TAU,
        off = p[3] + rr(0.3, 5),
        x = p[0] + cos(a) * off,
        z = p[1] + sin(a) * off,
        y = gy(x, z);
      if (
        y > 0.3 &&
        clearOf(x, z, 1.5, trailHalf(trailK(x, z)) + 0.25, 0.3) &&
        openAt(x, z) < 0.5
      )
        cluster(
          x,
          y,
          z,
          7 + ((rnd() * 7) | 0),
          2,
          0.8,
          1.7,
          0.34,
          0.55,
          1.3,
          0.4,
        );
    }

  // At each fork an island: a bush and ferns in the wedge between the two branches, where nobody walks (the wedge:
  // the narrowest run of directions round the fork that are clear of any path). Where a side path meets the loop
  // in two prongs, the two wedges are the two ends of the triangle between them
  for (const e of JUNC) {
    const on = [];
    let best = -1,
      run = 99;
    for (let a = 0; a < 48; a++) {
      const x = e[0] + cos((a / 48) * TAU) * 4.4,
        z = e[1] + sin((a / 48) * TAU) * 4.4;
      on.push(trailD(x, z) < trailHalf(trailK(x, z)) + 0.2);
    }
    for (let a = 0; a < 48; a++)
      if (on[a] && !on[(a + 1) % 48]) {
        let l = 1;
        while (l < 48 && !on[(a + 1 + l) % 48]) l++;
        if (l < run) {
          run = l;
          best = a + 1 + (l - 1) / 2;
        }
      }
    if (best < 0) continue;
    const x = e[0] + cos((best / 48) * TAU) * 4.8,
      z = e[1] + sin((best / 48) * TAU) * 4.8;
    bush(x, gy(x, z), z);
    for (let j = 0; j < 4; j++) {
      const px = x + rr(-1.4, 1.4),
        pz = z + rr(-1.4, 1.4);
      cluster(
        px,
        gy(px, pz),
        pz,
        7 + ((rnd() * 5) | 0),
        2,
        0.7,
        1.5,
        0.32,
        0.5,
        1.3,
        0.4,
      );
    }
  }

  // --- leaf fall: how thick the fallen leaves lie, on the ground map's grid (under every broadleaf, more in the maples)
  const LIT = new Float32Array(512 * 512);
  for (let i = 0; i < litter.length; i += 3) {
    const cx = ((litter[i] + W / 2) / W) * 512,
      cz = ((litter[i + 1] + W / 2) / W) * 512,
      r = (litter[i + 2] / W) * 512;
    for (let j = max(floor(cz - r), 0); j <= min(Math.ceil(cz + r), 511); j++)
      for (let k = max(floor(cx - r), 0); k <= min(Math.ceil(cx + r), 511); k++)
        LIT[k + 512 * j] +=
          max(1 - hypot(k + 0.5 - cx, j + 0.5 - cz) / r, 0) * 0.8;
  }
  const litterAt = (x, z) =>
    min(
      LIT[
        clamp(floor(((x + W / 2) / W) * 512), 0, 511) +
          512 * clamp(floor(((z + W / 2) / W) * 512), 0, 511)
      ],
      1,
    );

  // --- ground cover (the small store, drawn only near the walker)
  rseed(4);
  const tuft = (x, z, tall, onTrack = false) => {
    const y = gy(x, z);
    if (y < 0.1 || (!onTrack && trailD(x, z) < 1.3)) return;
    for (let j = 0; j < 3; j++)
      leaf(
        small,
        x + rr(-0.12, 0.12),
        y - 0.04,
        z + rr(-0.12, 0.12),
        rr(0.22, 0.6) * tall,
        rnd() * TAU,
        rr(0.05, 0.6),
        rr(0.035, 0.06) * (HIGH ? 1 : 1.5),
        0,
        4,
        rnd(),
        rnd(),
        rr(0.3, 0.6),
      );
  };
  // (half as many tufts below High, of wider blades: a meadow in view is otherwise the most triangles of any place)
  for (const p of [MEADOW, ...GLADES])
    for (let i = p[2] * p[2] * PI * (HIGH ? 14 : 7); i > 0; i--) {
      const a = rnd() * TAU,
        r = sqrt(rnd()) * p[2],
        x = p[0] + cos(a) * r,
        z = p[1] + sin(a) * r;
      if (rnd() < openAt(x, z) + 0.15) tuft(x, z, 1);
    }
  // The edge of every path is a line of plants, not a fade: grass tufts stand right on it and lean in (fewer along
  // the gravel, which is kept)
  for (let k = 0; k < N + SIDE.length; k++)
    for (let j = trailMake(k) ? 6 : 3; j > 0; j--) {
      const p = pathXZ(k),
        a = rnd() * TAU,
        off = trailHalf(k) + rr(-0.05, 0.4),
        x = p[0] + cos(a) * off,
        z = p[1] + sin(a) * off;
      if (
        trailD(x, z) > trailHalf(trailK(x, z)) - 0.1 &&
        lakeD(x, z) > 1 &&
        creekAt(x, z)[0] > 0.3
      )
        tuft(x, z, rr(0.9, 1.6), true);
    }
  // grass along the grass track: on its verges and down its middle, none in the two ruts
  for (let k = 0; k < N; k++)
    if (trailMake(k) === 3)
      for (let j = 0; j < 46; j++) {
        const n = tnorm(k),
          off = rr(-3, 3),
          rut = abs(abs(off) - trailHalf(k) - 0.35);
        if (rut > 0.5)
          tuft(
            TRAIL[k][0] + n[0] * off + rr(-0.5, 0.5),
            TRAIL[k][1] + n[1] * off + rr(-0.5, 0.5),
            rut > 1.2 ? 1.2 : 0.7,
            true,
          );
      }
  const pickV = () => ((rnd() * T.nv) | 0) * 3;
  rseed(5);
  for (let i = 0; i < 210000; i++) {
    const k = pickV();
    if (T.wn[k + 1] < 0.75) continue;
    const x = T.wp[k] + rr(-0.4, 0.4),
      z = T.wp[k + 2] + rr(-0.4, 0.4),
      u = rnd();
    if (hypot(x, z) > 172) continue;
    const y = gy(x, z);
    if (y < 0.2) continue;
    if (u < litterAt(x, z) * 0.25) {
      // a few fallen leaves standing proud of the ground (the ground shader draws the flat ones)
      for (let j = 0; j < 2; j++) {
        const L = rr(0.12, 0.2);
        leaf(
          small,
          x + rr(-0.3, 0.3),
          y + 0.03,
          z + rr(-0.3, 0.3),
          L,
          rnd() * TAU,
          PI / 2 + rr(-0.25, 0.1),
          L * rr(0.7, 0.95),
          0,
          3,
          rnd(),
          rnd(),
          rr(0.28, 0.4),
        );
      }
    } else if (u > 0.55 && u < 0.7 && trailD(x, z) > 1.3) {
      // a patch of taller herbs over the carpet the ground shader draws
      for (let j = 0; j < 3; j++) {
        const L = rr(0.22, 0.45),
          a = rnd() * TAU;
        leaf(
          small,
          x + rr(-0.25, 0.25),
          y + 0.04,
          z + rr(-0.25, 0.25),
          L,
          a,
          rr(1.1, 1.5),
          L * rr(0.8, 1.1),
          0,
          3,
          rr(0.91, 0.99),
          rnd(),
          rr(0.28, 0.4),
        );
      }
    } else if (u > 0.7 && trailD(x, z) > 1.4) {
      // low plants: a small fern, or a tuft of woodland grass
      if (u > 0.85)
        for (let j = 0; j < 4; j++)
          leaf(
            small,
            x,
            y - 0.03,
            z,
            rr(0.18, 0.42),
            rnd() * TAU,
            rr(0.3, 1.1),
            rr(0.09, 0.16),
            0,
            2,
            rnd(),
            rnd(),
            rr(0.4, 0.7),
          );
      else
        for (let j = 0; j < 3; j++)
          leaf(
            small,
            x + rr(-0.1, 0.1),
            y - 0.04,
            z + rr(-0.1, 0.1),
            rr(0.15, 0.4),
            rnd() * TAU,
            rr(0.05, 0.6),
            rr(0.03, 0.05),
            0,
            4,
            rnd() * 0.3,
            0.7 + rnd() * 0.3,
            rr(0.3, 0.6),
          );
    }
  }

  // --- rocks, logs, stumps, mushrooms
  const pebble = (x, z) => {
    const y = gy(x, z),
      sc = 0.015 + 0.07 * pow(rnd(), 2.5),
      q = qRand(),
      sd = rnd();
    if (y > -0.5 && kept())
      chunk(6, x, y - sc * 0.25, z, sc, q, 1, sd, HIGH ? 24 : 12);
  }; // (they shrink away by where scene.js stops drawing them: PEBBLE)
  const shrooms = (x, z, n, R) => {
    const sd = rnd();
    for (let j = 0; j < n; j++) {
      const px = x + rr(-R, R),
        pz = z + rr(-R, R),
        py = gy(px, pz);
      if (py > 0.3)
        chunk(
          2,
          px,
          py - 0.01,
          pz,
          rr(0.07, 0.2),
          qAxis(rr(-0.2, 0.2), 1, rr(-0.2, 0.2), rnd() * TAU),
          4,
          sd + rr(-0.004, 0.004),
          HIGH ? 96 : 48,
        );
    }
  };
  rseed(8);
  for (let i = 0; i < 2400; i++) {
    // boulders: by the outcrops, along the creek and the shore, a few in the woods
    const k = pickV(),
      x = T.wp[k],
      y = T.wp[k + 1],
      z = T.wp[k + 2];
    if (hypot(x, z) > 172 || y < -0.6 || trailD(x, z) < 3) continue;
    if (
      rnd() >
      max(
        sstep(4, 0.5, creekAt(x, z)[0]),
        sstep(5, 0, abs(lakeD(x, z))),
        T.wn[k + 1] < 0.7 ? 1 : 0,
        0.06,
      ) *
        0.35
    )
      continue;
    // (few of the largest, and none of them by the water: a boulder there is an armchair, not a car)
    const sc = min(
      rr(0.3, 1.2) * (rnd() < 0.06 ? 2 : 1),
      creekAt(x, z)[0] < 6 ? 0.8 : 9,
    );
    solid((rnd() * 2) | 0, x, y - sc * 0.1, z, sc, qRand(), 1, rnd(), 1, 0);
    if (sc > 0.7) blocks.push(x, z, sc * 0.75);
  }
  // What grows on a log's back (its middle line at y in the middle, rising `rise` a metre along it): short green
  // tufts of moss, ferns, here and there a seedling
  const onLog = (x, y, z, dx, dz, len, rad, rise) => {
    for (let j = round(len * 1.3); j > 0; j--) {
      const s = rr(-0.44, 0.44) * len,
        px = x + dx * s,
        pz = z + dz * s,
        top = y + rise * s + rad * 0.72,
        u = rnd();
      if (u < 0.5)
        for (let i = 0; i < 4; i++)
          leaf(
            small,
            px + rr(-0.5, 0.5) * rad,
            top - 0.03,
            pz + rr(-0.5, 0.5) * rad,
            rr(0.1, 0.24),
            rnd() * TAU,
            rr(0.1, 1),
            rr(0.04, 0.07),
            0,
            4,
            rnd() * 0.3,
            0.7 + rnd() * 0.3,
            rr(0.3, 0.6),
          );
      else if (u < 0.92)
        cluster(
          px,
          top + 0.07,
          pz,
          4 + ((rnd() * 3) | 0),
          2,
          0.3,
          0.62,
          0.22,
          0.36,
          1.25,
          0.4,
        );
      else if (u < 0.96) young(px, top, pz, rr(0.7, 1.6));
    }
  };
  rseed(9);
  for (let i = 0; i < 1400; i++) {
    const a = rnd() * TAU,
      r = sqrt(rnd()) * 170,
      x = cos(a) * r,
      z = sin(a) * r;
    // (and none by where the walk starts: the first frame is the trail, the bridge and the water)
    if (
      !clearOf(x, z, 2, 4.5, 0.6) ||
      openAt(x, z) > 0.5 ||
      hypot(x - TRAIL[0][0], z - TRAIL[0][1]) < 14
    )
      continue;
    const y = gy(x, z);
    if (y < 0.4 || flat(x, z) < 0.8) continue;
    if (rnd() < 0.55) {
      // a fallen log, laid along the slope under it (its mesh is 1 long along x)
      const len = rr(5, 13),
        yaw = rnd() * TAU,
        rad = len * 0.055,
        dx = cos(yaw),
        dz = sin(yaw);
      // (no part of it on a path or by the start: its middle is clear of them, its ends may not be)
      let lies = true;
      for (let s = -0.5; s < 0.51; s += 0.1) {
        const px = x + dx * len * s,
          pz = z + dz * len * s;
        if (
          trailD(px, pz) < trailHalf(trailK(px, pz)) + 0.7 ||
          hypot(px - TRAIL[0][0], pz - TRAIL[0][1]) < 14
        )
          lies = false;
      }
      if (!lies) continue;
      const tilt = atan2(
        gy(x + dx * len * 0.4, z + dz * len * 0.4) -
          gy(x - dx * len * 0.4, z - dz * len * 0.4),
        len * 0.8,
      );
      // (a third sunk into the ground; gone round all along its length, which also banks the fallen leaves along
      // it: the ground's contact map is made from what the walker goes round)
      solid(
        2,
        x,
        y + rad * 0.25,
        z,
        len,
        qMul(qAxis(0, 1, 0, -yaw), qAxis(0, 0, 1, tilt)),
        2,
        8 + rnd() * 0.99,
      );
      for (let s = -0.46; s < 0.47; s += 0.8 / len)
        blocks.push(x + dx * len * s, z + dz * len * s, rad + 0.2);
      onLog(x, y + rad * 0.25, z, dx, dz, len, rad, sin(tilt));
      spots.log.push([x, y, z, len, yaw]);
      if (rnd() < 0.6)
        shrooms(
          x + dx * rr(-0.3, 0.3) * len,
          z + dz * rr(-0.3, 0.3) * len,
          3 + ((rnd() * 6) | 0),
          rad + 0.5,
        );
    } else {
      const sc = rr(0.5, 1.3);
      solid(
        3,
        x,
        y - 0.1,
        z,
        sc,
        qAxis(0, 1, 0, rnd() * TAU),
        2,
        9 + rnd() * 0.99,
      );
      spots.stump.push([x, y, z, sc]);
      blocks.push(x, z, sc * 0.55);
      if (rnd() < 0.5) shrooms(x, z, 3 + ((rnd() * 5) | 0), sc * 0.8);
    }
  }
  for (let i = 0; i < 260; i++) {
    const a = rnd() * TAU,
      r = sqrt(rnd()) * 165,
      x = cos(a) * r,
      z = sin(a) * r;
    if (clearOf(x, z, 2, 1.2, 0.5) && openAt(x, z) < 0.5)
      shrooms(x, z, 2 + ((rnd() * 6) | 0), 0.7);
  }
  // fallen branches: sticks a few metres long and as thick as an arm, lying any way on the ground; nothing to walk
  // round
  for (let i = 0; i < 3200; i++) {
    const a = rnd() * TAU,
      r = sqrt(rnd()) * 168,
      x = cos(a) * r,
      z = sin(a) * r,
      len = rr(1.2, 3.6),
      y = gy(x, z),
      yaw = rnd() * TAU,
      dx = (cos(yaw) * len) / 2,
      dz = (sin(yaw) * len) / 2;
    // (lying along the ground under it, and no part of it over a path)
    const ya = gy(x - dx * 0.9, z - dz * 0.9),
      yb = gy(x + dx * 0.9, z + dz * 0.9),
      off = (px, pz) => trailD(px, pz) > trailHalf(trailK(px, pz)) + 0.4;
    if (
      y > 0.4 &&
      clearOf(x, z, 1, 1.6, 0.2) &&
      openAt(x, z) < 0.5 &&
      off(x - dx, z - dz) &&
      off(x + dx, z + dz)
    )
      chunk(
        7,
        x,
        max((ya + yb) / 2, y - 0.06) + len * 0.01,
        z,
        len,
        qMul(qAxis(0, 1, 0, -yaw), qAxis(0, 0, 1, atan2(yb - ya, len * 0.9))),
        2,
        8 + rnd() * 0.99,
        1,
      );
  }
  rseed(10);
  for (let i = 0; i < 26000; i++) {
    // loose rock where the ground is steep or stony: the outcrops, the creek, the shore
    const k = pickV(),
      x = T.wp[k],
      y = T.wp[k + 1],
      z = T.wp[k + 2],
      ny = T.wn[k + 1];
    if (hypot(x, z) > 172 || y < -1 || trailD(x, z) < 2) continue;
    if (
      rnd() >
      max(
        ny < 0.72 ? 0.9 : 0,
        sstep(2.5, 0, creekAt(x, z)[0]) * 0.4,
        sstep(3, 0, abs(lakeD(x, z))) * 0.6,
        0.03,
      )
    )
      continue;
    const sc = (0.3 + 1.6 * pow(rnd(), 2.6)) * (ny > 0.8 ? 0.5 : 1),
      q = qRand(),
      large = sc > 1.05;
    chunk(
      (large ? 3 : 0) + ((rnd() * (large ? 3 : 2)) | 0),
      x - T.wn[k] * sc * 0.3,
      y - ny * sc * 0.3,
      z - T.wn[k + 2] * sc * 0.3,
      sc,
      q,
      1,
      rnd(),
      large ? 0 : HIGH ? 96 : 48,
    );
  }
  rseed(11); // pebbles: the trail's gravel, the creek's bed
  for (let k = 0; k < N; k++)
    for (let j = trailMake(k) ? 10 : 22; j > 0; j--) {
      const w = trailHalf(k);
      pebble(TRAIL[k][0] + rr(-w, w), TRAIL[k][1] + rr(-w, w));
    }
  for (const p of SIDE)
    for (let j = p[2] ? 6 : 14; j > 0; j--)
      pebble(p[0] + rr(-p[3], p[3]), p[1] + rr(-p[3], p[3]));
  // roots across the trail: short sticks two thirds sunk into it (in the planks' brown wood: a
  // log's bark would be all moss; seed 1 and over tells the material it is a root), two or three in a line, every
  // few metres
  for (let k = 5; k < N; k += 4 + ((rnd() * 6) | 0)) {
    if (trailMake(k) !== 1) continue; // only the dirt track has them
    const n = tnorm(k),
      yaw = atan2(n[1], n[0]) + rr(-0.7, 0.7),
      dx = cos(yaw),
      dz = sin(yaw),
      len = rr(0.6, 1.1);
    let x = TRAIL[k][0] - dx * len * rr(0.6, 1.3),
      z = TRAIL[k][1] - dz * len * rr(0.6, 1.3);
    for (let j = 2 + (rnd() < 0.5); j > 0; j--) {
      const y = gy(x, z);
      if (y > 0.3)
        chunk(
          7,
          x,
          y - len * 0.008,
          z,
          len,
          qMul(
            qAxis(0, 1, 0, -yaw + rr(-0.25, 0.25)),
            qAxis(0, 0, 1, rr(-0.08, 0.08)),
          ),
          3,
          1 + rnd(),
          1,
        );
      x += dx * len * 0.85;
      z += dz * len * 0.85;
    }
  }
  // Along the running water (water.js), sample by sample: stones in the bed and on both banks, of many sizes
  // (more and bigger where it falls), a boulder now and then, a fallen trunk across it; pebbles on the bars;
  // ferns, grass and here and there a bush on the banks, reaching over the edge
  rseed(16);
  let lips = 0;
  const foam = new Float32Array(NX * NX);
  alongStreams((x, z, tx, tz, hw, lv, steep, lip) => {
    const at = (ac) => [x - tz * ac, z + tx * ac];
    const stone = (ac, sc, big) => {
      const [px, pz] = at(ac),
        y = gy(px, pz);
      if (
        y < 0.2 ||
        trailD(px, pz) < trailHalf(trailK(px, pz)) + 0.8 ||
        lakeD(px, pz) < 1
      )
        return;
      // (one mesh of each, turned and sized by chance: stones of several kinds here would be several draws more)
      // (half sunk into the ground, as stones lie)
      if (big) {
        solid(0, px, y - sc * 0.15, pz, sc, qRand(), 1, rnd(), 1, 0);
        if (sc > 0.7) blocks.push(px, pz, sc * 0.7);
      } else
        chunk(0, px, y - sc * 0.08, pz, sc, qRand(), 1, rnd(), HIGH ? 96 : 48);
    };
    for (let j = steep > 0.12 ? 2 : 1; j > 0; j--)
      if (rnd() < (steep > 0.12 ? 0.5 : 0.25))
        stone(
          rr(-hw, hw),
          (steep > 0.12 ? rr(0.16, 0.42) : rr(0.1, 0.3)) *
            (rnd() < 0.15 ? 1.7 : 1),
          false,
        );
    if (lip) spots.fall.push([x, lv, z, hw]);
    // Stones standing in a fall's slope, half sunk, and the white water that gathers just below each and at the
    // fall's foot. foam: how much of it, on the stream field's grid (scene.js puts it in that texture's fourth
    // channel, W_STREAM draws it): a stone stands just upstream of its cell's middle. They draw on a stream of
    // chance of their own, by the fall's number: nothing else in the world moves when they change
    if (
      lip &&
      trailD(x, z) > trailHalf(trailK(x, z)) + 1.5 &&
      lakeD(x, z) > 2
    ) {
      let seed = Math.imul(spots.fall.length, 0x9e3779b1) | 1;
      const own = () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      // the water's level at a place (NaN out of the water), and `down` the stream from the lip
      const levelAt = (px, pz) => {
        const water = creekAt(px, pz);
        return water[0] < -0.12 ? water[1] : NaN;
      };
      const level = (down) => levelAt(x + tx * down, z + tz * down);
      // the slope: from where the level begins to drop to where it drops no more
      let top = -0.6;
      while (top < 3 && !(level(top) - level(top + 0.3) > 0.03)) top += 0.3;
      let foot = top;
      while (foot < top + 4 && level(foot) - level(foot + 0.3) > 0.03)
        foot += 0.3;
      // the cell of the grid a place lies in, and its middle
      const cell = (px, pz) => {
        const i = floor((px - OX) / VS),
          j = floor((pz - OZ) / VS);
        return [i + NX * j, OX + (i + 0.5) * VS, OZ + (j + 0.5) * VS];
      };
      if (foot > top) {
        for (let j = 3 + floor(own() * 4); j > 0; j--) {
          const down = top + 0.35 + own() * (foot - top - 0.1),
            across = (own() * 2 - 1) * hw * 0.7,
            sc = 0.2 + own() * 0.26,
            turn = qMul(
              qAxis(0, 1, 0, own() * TAU),
              qAxis(1, 0, 0, own() * TAU),
            ),
            much = 0.7 + 0.3 * own(),
            [at, fx, fz] = cell(
              x + tx * down - tz * across,
              z + tz * down + tx * across,
            ),
            sx = fx - tx * (sc * 0.5 + 0.2),
            sz = fz - tz * (sc * 0.5 + 0.2),
            here = levelAt(sx, sz);
          if (
            foam[at] ||
            !Number.isFinite(here) ||
            !Number.isFinite(levelAt(fx, fz))
          )
            continue;
          chunk(0, sx, here - sc * 0.2, sz, sc, turn, 1, own(), HIGH ? 96 : 48);
          foam[at] = much;
        }
        for (const across of [-0.5, 0, 0.5]) {
          const [at, fx, fz] = cell(
            x + tx * (foot + 0.4) - tz * across * hw,
            z + tz * (foot + 0.4) + tx * across * hw,
          );
          if (Number.isFinite(levelAt(fx, fz))) foam[at] = 1;
        }
      }
    }
    // What makes a fall: a line of stones across the channel at its lip, their tops about at the water's level,
    // the water pouring through the gaps; at every fourth a log lying across instead
    if (
      lip &&
      trailD(x, z) > trailHalf(trailK(x, z)) + 1.5 &&
      lakeD(x, z) > 2
    ) {
      // (a log only where none of it would lie on a path: its ends reach well past the banks)
      const log =
        lips++ % 4 === 3
          ? [hw * 2 + rr(1.6, 3), Math.atan2(tx, -tz) + rr(-0.25, 0.25)]
          : null;
      if (
        log &&
        [-0.5, -0.25, 0.25, 0.5].every((s) => {
          const px = x + cos(log[1]) * log[0] * s,
            pz = z + sin(log[1]) * log[0] * s;
          return trailD(px, pz) > trailHalf(trailK(px, pz)) + 0.8;
        })
      ) {
        const [len, yaw] = log;
        solid(
          2,
          x,
          lv - len * 0.012,
          z,
          len,
          qMul(qAxis(0, 1, 0, -yaw), qAxis(0, 0, 1, rr(-0.04, 0.04))),
          2,
          8 + rnd() * 0.99,
        );
      } else
        for (let ac = -hw + rr(0.05, 0.35); ac < hw; ac += rr(0.5, 0.9)) {
          const [px, pz] = at(ac + rr(-0.1, 0.1)),
            sc = rr(0.2, 0.45),
            up = rr(-0.25, 0.35); // (the line is uneven up and down the stream)
          chunk(
            0,
            px - tz * 0 + tx * up,
            lv + rr(0.02, 0.14) - sc * 0.45,
            pz + tz * up,
            sc,
            qRand(),
            1,
            rnd(),
            HIGH ? 96 : 48,
          );
        }
    }
    // now and then a fallen trunk lies across it, bank to bank, a little over the water
    if (rnd() < 0.014 && trailD(x, z) > 9 && lakeD(x, z) > 4) {
      const len = hw * 2 + rr(2.5, 4.5),
        yaw = Math.atan2(tx, -tz) + rr(-0.5, 0.5);
      solid(
        2,
        x,
        lv + rr(0.12, 0.35) + len * 0.05,
        z,
        len,
        qMul(qAxis(0, 1, 0, -yaw), qAxis(0, 0, 1, rr(-0.06, 0.06))),
        2,
        8 + rnd() * 0.99,
      );
      for (const s of [-0.4, 0, 0.4])
        blocks.push(
          x + Math.cos(yaw) * len * s,
          z + Math.sin(yaw) * len * s,
          len * 0.055 + 0.25,
        );
    }
    for (const side of [-1, 1]) {
      if (rnd() < 0.2)
        stone(side * (hw + rr(0, 1.2)), 0.07 + 0.4 * rnd() * rnd(), false);
      if (rnd() < 0.035) stone(side * (hw + rr(0.2, 1.4)), rr(0.4, 0.75), true);
      for (let j = 0; j < 3; j++) {
        const p = at(side * (hw * rr(0.5, 1) + rr(0, 1)));
        pebble(p[0], p[1]);
      }
      const [px, pz] = at(side * (hw + rr(0.35, 1.6))),
        y = gy(px, pz),
        u = rnd();
      if (
        y < lv + 0.05 ||
        lakeD(px, pz) < 1 ||
        trailD(px, pz) < trailHalf(trailK(px, pz)) + 0.5
      )
        continue;
      if (u < 0.1 && trailD(px, pz) > 8)
        cluster(
          px,
          y,
          pz,
          5 + ((rnd() * 4) | 0),
          2,
          0.6,
          1.4,
          0.3,
          0.5,
          1.4,
          0.4,
        );
      else if (u < 0.11 && trailD(px, pz) > 8) bush(px, y, pz);
      if (rnd() < 0.25) {
        const p = at(side * (hw + rr(0.15, 0.8)));
        if (gy(p[0], p[1]) > lv + 0.05) tuft(p[0], p[1], 1.3, true);
      }
    }
  });
  // the lake's shore: reeds in the shallows, grass and pebbles on the bank
  for (let i = 0; i < 16000; i++) {
    const c = LAKE[(rnd() * LAKE.length) | 0],
      a = rnd() * TAU,
      r = c[2] + rr(-2, 7),
      x = c[0] + cos(a) * r,
      z = c[1] + sin(a) * r,
      ld = lakeD(x, z),
      u = rnd();
    if (ld < -1.6 || ld > 6 || trailD(x, z) < 1.5) continue;
    if (ld < 0.5) {
      // reeds in dense clumps where a noise says so, bare water between; in each a few bent over and a few broken short
      if (u < 0.5 && fbm(x * 0.11, 5, z * 0.11, 2) > 0.56) {
        const y = max(gy(x, z), -0.5);
        cluster(
          x,
          y,
          z,
          7 + ((rnd() * 7) | 0),
          4,
          0.9,
          2,
          0.05,
          0.09,
          0.3,
          0.6,
        );
        if (rnd() < 0.5)
          cluster(x, y, z, 2, 4, 0.8, 1.6, 0.05, 0.08, 1.25, 0.6);
        if (rnd() < 0.4) cluster(x, y, z, 3, 4, 0.3, 0.6, 0.05, 0.08, 0.5, 0.3);
      }
    } else if (u < 0.5) tuft(x, z, 1.4);
    if (u > 0.6 && ld < 2.5) pebble(x, z);
  }

  // (the 232 draws of the flocks that were here: the dust and rain below keep the places they had)
  rseed(14);
  for (let i = 0; i < 232; i++) rnd();
  // random vec4s for the dust, the rain and the falling leaves (W_SPR)
  const snow = new Float32Array((HIGH ? 7000 : 3500) * 4);
  for (let i = 0; i < snow.length; i++) snow[i] = rnd();

  // --- pack leaves (36 bytes: 8 floats + 4 unorm8), sorted by culling cell
  const pack = (L, step = 1, wm = 1) => {
    let n = 0;
    const start = new Uint32Array(nCells + 1),
      sub = new Uint32Array(nCells * NSUB + 1);
    for (let c = 0; c < nCells; c++) {
      start[c] = n;
      n += Math.ceil(L[c].length / 12 / step);
    }
    start[nCells] = sub[nCells * NSUB] = n;
    const buf = new ArrayBuffer(n * 36),
      f = new Float32Array(buf),
      u8 = new Uint8Array(buf),
      lo = new Float32Array(nCells).fill(1e9),
      hi = new Float32Array(nCells).fill(-1e9);
    let k = 0;
    for (let c = 0; c < nCells; c++) {
      const a = L[c],
        groups = bySub(a, 12, step);
      for (let s = 0; s < NSUB; s++) {
        sub[c * NSUB + s] = k;
        for (const i of groups[s]) {
          for (let j = 0; j < 8; j++) f[k * 9 + j] = a[i + j];
          f[k * 9 + 6] *= wm;
          u8[k * 36 + 32] = a[i + 8];
          u8[k * 36 + 33] = a[i + 9] * 255;
          u8[k * 36 + 34] = a[i + 10] * 255;
          u8[k * 36 + 35] = a[i + 11] * 255;
          const y = a[i + 1],
            l = a[i + 3];
          if (y - l < lo[c]) lo[c] = y - l;
          if (y + l > hi[c]) hi[c] = y + l;
          k++;
        }
      }
    }
    return { buf, n, start, sub, lo, hi };
  };

  // --- half-res light volume: r = openness, g = skylight, let down through rock and crowns from the top layer
  const hx = NX / 2,
    hy = NY / 2,
    hz = NZ / 2,
    volD = new Uint8Array(hx * hy * hz * 2),
    gi = (x, y, z) => x + NX * (y + NY * z);
  let Lp = new Float32Array(hx * hz).fill(1),
    Ln = new Float32Array(hx * hz),
    tmp = new Float32Array(hx * hz);
  for (let y = hy - 1; y >= 0; y--) {
    for (let z = 0; z < hz; z++)
      for (let x = 0; x < hx; x++) {
        const i = x + hx * z;
        tmp[i] =
          (Lp[x > 0 ? i - 1 : i] + 2 * Lp[i] + Lp[x < hx - 1 ? i + 1 : i]) *
          0.25;
      }
    for (let z = 0; z < hz; z++)
      for (let x = 0; x < hx; x++) {
        const i = x + hx * z,
          b =
            (tmp[z > 0 ? i - hx : i] +
              2 * tmp[i] +
              tmp[z < hz - 1 ? i + hx : i]) *
            0.25;
        const g0 = gi(x * 2, y * 2, z * 2);
        const d =
          (D[g0] +
            D[g0 + 1] +
            D[g0 + NX] +
            D[g0 + NX + 1] +
            D[g0 + NX * NY] +
            D[g0 + NX * NY + 1] +
            D[g0 + NX * NY + NX] +
            D[g0 + NX * NY + NX + 1]) *
          0.125;
        const o = x + hx * (y + hy * z);
        Ln[i] = b * clamp(0.5 - d / 1.5, 0, 1) * (1 - min(shade[o], 0.5));
        volD[o * 2] = clamp(0.5 - d / 12, 0, 1) * 255;
        volD[o * 2 + 1] = min(1, b) * 255;
      }
    const t = Lp;
    Lp = Ln;
    Ln = t;
  }

  // --- ground map (W_SOLID, W_SURF, W_STREAM): r trail (by its width there), g fallen leaves, b the lake (1.5 m over
  // it at 0, its surface at .25, 4.5 m under it at 1), a the make of the nearest stretch of
  // trail (0-3 as 0-1; the grass of the clearings the shader works out from OPEN itself)
  const gm = new Uint8Array(512 * 512 * 4);
  for (let j = 0; j < 512; j++)
    for (let i = 0; i < 512; i++) {
      const x = ((i + 0.5) / 512) * W - W / 2,
        z = ((j + 0.5) / 512) * W - W / 2,
        o = (i + 512 * j) * 4;
      // (the grass track, make 3, falls off over 2.6 m instead: the shader reads its verge and its two ruts from that)
      const tk = trailK(x, z),
        half = trailHalf(tk);
      gm[o] =
        (trailMake(tk) === 3
          ? sstep(half + 2.4, half - 0.2, trailD(x, z))
          : sstep(half + 0.45, half - 0.35, trailD(x, z))) * 255;
      gm[o + 1] = min(LIT[i + 512 * j], 1) * 255;
      gm[o + 2] = clamp((1.5 - gy(x, z)) / 6, 0, 1) * 255;
      // (the make, evened out over five points up and down the path: one stretch gives way to the next over metres)
      let mk = 0;
      for (let j = -5; j <= 5; j++)
        mk += trailMake(
          tk < N
            ? (((tk + j) % N) + N) % N
            : clamp(tk + j, N, N + SIDE.length - 1),
        );
      gm[o + 3] = (mk / 11 / 3) * 255;
    }

  // --- woodwork, one mesh in world coordinates: fences along stretches of the trail, a bridge at each crossing of
  // running water, a boardwalk and a dock on the lake, a bench and signposts. Built last: the decks go into the
  // height map (so the walker steps onto them), which the ground map above must not see.
  // Every piece carries in its aux, one value for the whole piece, its own shade (0 to 7) and which way its grain
  // runs (0 to 14: a level heading in fifteenths of a half turn, 15: upright). W_SOLID material 3 reads both
  // (wood: the mesh the helpers below build into: the woodwork, or for a while the boat's own)
  let wood = new Mesh();
  const UPY = () => [0, 1, 0];
  const grain = (first, dx, dz, upright, tone) => {
    const code =
      (floor(tone * 7.99) * 16 +
        (upright ? 15 : floor(((atan2(dz, dx) / PI + 2) % 1) * 14.99))) /
      127;
    for (let v = first; v < wood.aux.length; v++) wood.aux[v] = code;
  };
  // a squared length of timber along `pts`
  const beam = (pts, w, h, up = UPY, tone = rnd()) => {
    const first = wood.aux.length,
      a = pts[0],
      b = pts[pts.length - 1],
      dx = b[0] - a[0],
      dz = b[2] - a[2];
    wood.sweep(pts, w, h, up);
    grain(first, dx, dz, abs(b[1] - a[1]) > hypot(dx, dz), tone);
  };
  // a round pole from a to b, its far end rounded off
  const pole = (a, b, r, tone = rnd()) => {
    const first = wood.aux.length,
      dx = b[0] - a[0],
      dy = b[1] - a[1],
      dz = b[2] - a[2],
      e = (0.6 * r) / (hypot(dx, dy, dz) || 1);
    wood.tube(
      [a, [b[0] - dx * e, b[1] - dy * e, b[2] - dz * e], b],
      (k) => (k < 2 ? r : r * 0.55),
      5,
      true,
    );
    grain(first, dx, dz, abs(dy) > hypot(dx, dz), tone);
  };
  // a trimmed pole along `pts`, r0 thick at its first end and r1 at its last, both ends sawn flat
  const trimmed = (pts, r0, r1, tone = rnd()) => {
    const first = wood.aux.length,
      n = pts.length - 1,
      a = pts[0],
      b = pts[n];
    wood.tube(pts, (k) => mix(r0, r1, k / n), 7, false);
    for (const [p, q, r] of [
      [a, pts[1], r0],
      [b, pts[n - 1], r1],
    ]) {
      // the sawn face: a fan of its own corners, square to the pole
      const t = [p[0] - q[0], p[1] - q[1], p[2] - q[2]],
        tl = hypot(...t),
        ux = t[2] / (hypot(t[0], t[2]) || 1),
        uz = -t[0] / (hypot(t[0], t[2]) || 1),
        vx = (t[1] * uz) / tl,
        vy = (t[2] * ux - t[0] * uz) / tl,
        vz = (-t[1] * ux) / tl,
        mid = wood.v(p[0], p[1], p[2]),
        at = (s) => {
          const an = (s / 7) * TAU;
          return wood.v(
            p[0] + (ux * cos(an) + vx * sin(an)) * r,
            p[1] + vy * sin(an) * r,
            p[2] + (uz * cos(an) + vz * sin(an)) * r,
          );
        };
      for (let s = 0; s < 7; s++) wood.tri(mid, at(s), at(s + 1));
    }
    grain(first, b[0] - a[0], b[2] - a[2], false, tone);
  };
  // a log split down its length from a to b, r wide to each side, its flat side up at the height of a and b
  const halfLog = (a, b, r, tone = rnd()) => {
    const first = wood.aux.length,
      dx = b[0] - a[0],
      dz = b[2] - a[2],
      l = hypot(dx, dz),
      sx = -dz / l,
      sz = dx / l;
    // its section at an end: the round underside from one edge to the other, in six
    const ring = (p, k) => {
      const an = (k / 6) * PI,
        w = -cos(an) * r,
        h = -sin(an) * r;
      return [p[0] + sx * w, p[1] + h, p[2] + sz * w];
    };
    for (let k = 0; k < 6; k++)
      wood.quad(
        wood.v(...ring(a, k)),
        wood.v(...ring(a, k + 1)),
        wood.v(...ring(b, k + 1)),
        wood.v(...ring(b, k)),
      );
    wood.quad(
      wood.v(...ring(a, 0)),
      wood.v(...ring(b, 0)),
      wood.v(...ring(b, 6)),
      wood.v(...ring(a, 6)),
    );
    for (const p of [a, b]) {
      const mid = wood.v(p[0], p[1], p[2]);
      for (let k = 0; k < 6; k++)
        wood.tri(mid, wood.v(...ring(p, k)), wood.v(...ring(p, k + 1)));
    }
    grain(first, dx, dz, false, tone);
  };
  // a squared post from 0.4 m in the ground to h over it, its top (at tx, tz if it leans) cut on a slant
  const post = (x, y, z, h, w = 0.14, tx = x, tz = z, tone = rnd()) => {
    const first = wood.aux.length,
      a = rnd() * TAU,
      c = cos(a) * w * 0.707,
      s = sin(a) * w * 0.707,
      slant = rr(0.1, 0.4) * w;
    const off = [
        [c, s],
        [-s, c],
        [-c, -s],
        [s, -c],
      ],
      lo = off.map((o) => [x + o[0], y - 0.4, z + o[1]]),
      hi = off.map((o, j) => [
        tx + o[0],
        y + h + (j < 2 ? slant : -slant) / 2,
        tz + o[1],
      ]);
    for (let j = 0; j < 4; j++) {
      const k = (j + 1) % 4;
      wood.quad(
        wood.v(...lo[j]),
        wood.v(...lo[k]),
        wood.v(...hi[k]),
        wood.v(...hi[j]),
      );
    }
    wood.quad(...hi.map((p) => wood.v(...p)));
    grain(first, 0, 0, true, tone);
    // (a post's top is a place for a bird: fence posts, rail posts, signposts, the pier's piles)
    if (h > 0.9 && h < 4) tops.push(tx, y + h, tz);
  };
  const rail = (a, b, w = 0.09, h = 0.12, up = UPY) => {
    beam([a, b], w, h, up);
    for (const t of [0.25, 0.5, 0.75])
      touch.push(mix(a[0], b[0], t), mix(a[2], b[2], t), 0.2);
  };
  // What is walked on along `pts` (x, y, z), `half` to each side, into the height map: the walker steps onto it.
  // (No narrower than 0.8 m: the map's cells are 0.75 m, and a narrower strip would be read between it and the bed)
  const stamp = (pts, half) => {
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k],
        b = pts[k + 1],
        dx = b[0] - a[0],
        dz = b[2] - a[2],
        l2 = dx * dx + dz * dz;
      for (
        let j = floor((min(a[2], b[2]) - half - OZ) / VS);
        j <= Math.ceil((max(a[2], b[2]) + half - OZ) / VS);
        j++
      )
        for (
          let i = floor((min(a[0], b[0]) - half - OX) / VS);
          i <= Math.ceil((max(a[0], b[0]) + half - OX) / VS);
          i++
        ) {
          const x = OX + i * VS,
            z = OZ + j * VS,
            t = clamp(((x - a[0]) * dx + (z - a[2]) * dz) / l2, 0, 1);
          if (hypot(x - a[0] - dx * t, z - a[2] - dz * t) < half)
            H[i + NX * j] = max(H[i + NX * j], mix(a[1], b[1], t));
        }
    }
  };
  // A deck along `pts` (x, y, z): planks laid across two beams, each of its own width, height and tilt, with a gap
  // to the next and its ends out of line, one in forty gone; its height stamped into the map. rails: 0 none, 1 a
  // handrail on the lake's side, 2 one on both sides (posts, a top rail and a lower one). deep: its beams' depth.
  // open: the point its lake side's span without rail or kick rail begins at (where the dock leaves the
  // boardwalk). Returns which side the lake lies on (-1 or 1)
  const deck = (pts, half, rails, deep = 0.14, open = -1) => {
    // (the two beams near its edges: from the side a beam's face shows under the planks' ends, not the dark below)
    for (const side of [-0.84, 0.84])
      beam(
        pts.map((p, k) => {
          const a = pts[max(k - 1, 0)],
            b = pts[min(k + 1, pts.length - 1)],
            l = hypot(b[0] - a[0], b[2] - a[2]) || 1;
          return [
            p[0] - ((b[2] - a[2]) / l) * half * side,
            p[1] - 0.07 - deep / 2,
            p[2] + ((b[0] - a[0]) / l) * half * side,
          ];
        }),
        0.12,
        deep,
        UPY,
        0.3,
      );
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k],
        b = pts[k + 1],
        dx = b[0] - a[0],
        dz = b[2] - a[2],
        l = hypot(dx, dz);
      for (let at = 0; at < l - 0.02;) {
        let pw = rr(0.19, 0.31);
        if (l - at - pw < 0.12) pw = l - at;
        const t = (at + pw / 2) / l,
          x = a[0] + dx * t,
          y = mix(a[1], b[1], t) - 0.03,
          z = a[2] + dz * t;
        at += pw;
        if (rnd() < 0.025 && k && k < pts.length - 2) continue;
        const un = rails < 2 ? 0.02 : 0.07,
          wl = half + rr(-un, un),
          wr = half + rr(-un, un);
        beam(
          [
            [x - (dz / l) * wl, y + rr(-0.014, 0.014), z + (dx / l) * wl],
            [x + (dz / l) * wr, y + rr(-0.014, 0.014), z - (dx / l) * wr],
          ],
          pw - rr(0.02, 0.045),
          0.045,
        );
      }
    }
    // The lake's side: the one the lake lies nearer to, over the whole deck. edge: each point's way out to the
    // deck's edge (the rails run along it, round a bend too)
    const edge = pts.map((p, k) => {
      const a = pts[max(k - 1, 0)],
        b = pts[min(k + 1, pts.length - 1)],
        l = hypot(b[0] - a[0], b[2] - a[2]) || 1;
      return [
        (-(b[2] - a[2]) / l) * (half - 0.05),
        ((b[0] - a[0]) / l) * (half - 0.05),
      ];
    });
    let lake = 0;
    for (let k = 0; k < pts.length; k++)
      lake +=
        lakeD(pts[k][0] - edge[k][0], pts[k][2] - edge[k][1]) -
        lakeD(pts[k][0] + edge[k][0], pts[k][2] + edge[k][1]);
    const lakeSide = lake > 0 ? 1 : -1;
    // the runs of points a rail follows on a side: the whole deck, or the two parts either side of the opening
    const runs = (side) =>
      open >= 0 && side === lakeSide
        ? [
            [0, open],
            [open + 1, pts.length - 1],
          ]
        : [[0, pts.length - 1]];
    // (a boardwalk or a dock: a kick rail lies along each edge, on the planks' ends)
    if (rails < 2)
      for (const side of [-1, 1])
        for (const [from, to] of runs(side))
          for (let k = from; k < to; k += 2) {
            const e = min(k + 2, to),
              run = [];
            for (let j = k; j <= e; j++) {
              const a = pts[max(j - 1, 0)],
                b = pts[min(j + 1, pts.length - 1)],
                l = hypot(b[0] - a[0], b[2] - a[2]) || 1;
              run.push([
                pts[j][0] - ((b[2] - a[2]) / l) * side * (half - 0.03),
                pts[j][1] + 0.03,
                pts[j][2] + ((b[0] - a[0]) / l) * side * (half - 0.03),
              ]);
            }
            beam(run, 0.08, 0.07);
          }
    stamp(pts, half);
    if (!rails) return lakeSide;
    // The handrails: a post at every third point of a run and at its end, the rails between them
    for (const side of [-1, 1]) {
      if (rails === 1 && side !== lakeSide) continue;
      const at = (k, h) => [
        pts[k][0] + edge[k][0] * side,
        pts[k][1] + h,
        pts[k][2] + edge[k][1] * side,
      ];
      for (const [from, to] of runs(side))
        for (let k = from; k <= to; k += 3) {
          const e = min(k + 3, to),
            run = [];
          post(...at(k, 0), 1 + rr(-0.03, 0.04), 0.11);
          if (e === k) break;
          for (let j = k; j <= e; j++) run.push(j);
          beam(
            run.map((j) => at(j, 0.94)),
            0.07,
            0.1,
          );
          beam(
            run.map((j) => at(j, 0.5)),
            0.05,
            0.09,
          );
          // (what stops the walker: along the rail, not across an opening)
          for (const j of run) {
            for (const t of j < to ? [0, 0.5] : [0]) {
              const q = pts[min(j + 1, pts.length - 1)],
                w = edge[j];
              touch.push(
                mix(pts[j][0], q[0], t) + w[0] * side,
                mix(pts[j][2], q[2], t) + w[1] * side,
                0.2,
              );
            }
            if (j < e) {
              const a = at(j, 0),
                b = at(j + 1, 0);
              walls.push(a[0], a[2], b[0], b[2], 0.2);
            }
          }
          if (e === to && (e - from) % 3)
            post(...at(e, 0), 1 + rr(-0.03, 0.04), 0.11);
        }
    }
    return lakeSide;
  };
  // Where a path crosses running water, on the loop and on the side paths. k: the loop's point over the water's
  // middle (-1 on a side path); line: the path's points from bank to bank and a step more; lv, hw: the water's
  // level and half its width there; make: what crosses it, by that width (BRIDGES below)
  const crossings = [];
  let wide = 0,
    mid = 0;
  const findCrossings = (pts, loop) => {
    const n = pts.length,
      P = (k) => pts[loop ? ((k % n) + n) % n : clamp(k, 0, n - 1)],
      edge = (k) => creekAt(P(k)[0], P(k)[1])[0];
    for (let k = 0, best = -1, be = 1e9; k <= n; k++) {
      const e = k < n ? edge(k) : 1e9;
      if (e < 0.4) {
        if (e < be) {
          be = e;
          best = k;
        }
        continue;
      }
      if (best < 0) continue;
      let k0 = best,
        k1 = best;
      while (best - k0 < 12 && edge(k0) < 1.3) k0--;
      while (k1 - best < 12 && edge(k1) < 1.3) k1++;
      const ck = creekAt(P(best)[0], P(best)[1]),
        line = [];
      for (let j = k0 - 1; j <= k1 + 1; j++) line.push(P(j));
      // 0 planks on posts and 4 stepping stones take the wide water in turn (the first, by the start, is planks);
      // 1 planks and 3 a split log the middling; over a narrow run 2 logs side by side
      const hw = ck[2],
        make =
          hw < 0.6 ? 2 : hw < 1.2 ? (mid++ % 2 ? 3 : 1) : wide++ % 2 ? 4 : 0;
      crossings.push({
        k: loop ? best : -1,
        line,
        at: P(best),
        lv: ck[1],
        hw,
        make,
      });
      best = -1;
      be = 1e9;
    }
  };
  findCrossings(TRAIL, true);
  for (let b = 0; b < RUNS.length - 1; b++)
    findCrossings(SIDE.slice(RUNS[b], RUNS[b + 1]), false);
  // Fences, in stretches that come and go by chance along the whole loop, each side by itself. Five makes (0 three
  // boards, 1 two rails on taller posts, 2 one thick round log on short round posts, 3 split rails stacked in a
  // zigzag with no posts, 4 round poles), each for a few lengths. Posts stand at uneven steps, heights and thicknesses; a
  // few lean, a few are broken off short; here and there a length or a single rail is missing, a board hangs by
  // one end, a span has a brace, and a length has fallen down. None by a bridge or the boardwalk
  rseed(21);
  const noFence = (k) =>
    crossings.some(
      (c) => c.k >= 0 && min(abs(k - c.k), N - abs(k - c.k)) < 9,
    ) ||
    (k > 190 && k < 228) ||
    ENDS.some((e) => hypot(TRAIL[k][0] - e[0], TRAIL[k][1] - e[1]) < 6);
  let fallen = 0;
  const MAKES = [3, 0, 4, 2, 1];
  for (const side of [-1, 1]) {
    // (the makes take turns in a fixed order, each side from its own place in it, so every make stands somewhere)
    let prev = null,
      turn = side > 0 ? 0 : 2,
      make = MAKES[turn],
      same = 4,
      on = true,
      run = 14,
      zig = 1;
    // one span of this make from a to b
    const span = (a, b) => {
      if (make === 0) rail(a, b, 0.05, 0.17);
      else if (make === 1) rail(a, b, 0.09, 0.09);
      else {
        const ex = (b[0] - a[0]) * 0.05,
          ey = (b[1] - a[1]) * 0.05,
          ez = (b[2] - a[2]) * 0.05;
        pole(
          [a[0] - ex, a[1] - ey, a[2] - ez],
          [b[0] + ex, b[1] + ey, b[2] + ez],
          make === 2 ? rr(0.075, 0.095) : rr(0.035, 0.05),
        );
        for (const t of [0.25, 0.5, 0.75])
          touch.push(mix(a[0], b[0], t), mix(a[2], b[2], t), 0.2);
      }
    };
    for (let k = 1; k < N - 2; k += 2 + ((rnd() * 3) | 0)) {
      if (run-- <= 0) {
        on = rnd() < 0.5;
        run = 4 + ((rnd() * 12) | 0);
        prev = null;
      }
      if (!on || noFence(k)) {
        prev = null;
        continue;
      }
      if (same-- <= 0) {
        make = MAKES[++turn % 5];
        same = (make === 3 ? 5 : 3) + ((rnd() * 6) | 0);
        prev = null;
      }
      const n = tnorm(k),
        base = trailHalf(k) + 0.45;
      if (make === 3) {
        // each length lies across the ends of the last, so the lengths' rails take turns up the stack
        zig = -zig;
        const off = base + 0.45 + zig * 0.4,
          x = TRAIL[k][0] + n[0] * side * off,
          z = TRAIL[k][1] + n[1] * side * off,
          y = gy(x, z);
        blocks.push(x, z, 0.25);
        spots.fence.push([x, y, z, make]);
        if (prev) walls.push(prev[0], prev[2], x, z, 0.2);
        if (prev)
          for (let j = 0; j < 4; j++) {
            const lift = (j + (zig > 0 ? 0.5 : 0)) * 0.2 + 0.07,
              ex = (x - prev[0]) * 0.09,
              ez = (z - prev[2]) * 0.09,
              roll = rnd() * TAU;
            rail(
              [prev[0] - ex, prev[1] + lift + rr(-0.02, 0.02), prev[2] - ez],
              [x + ex, y + lift + rr(-0.02, 0.02), z + ez],
              rr(0.09, 0.13),
              rr(0.07, 0.1),
              () => [cos(roll) * 0.5, 1, sin(roll) * 0.5],
            );
          }
        prev = [x, y, z, 1];
        continue;
      }
      const heights = [[0.34, 0.64, 0.94], [0.5, 0.92], [0.5], 0, [0.42, 0.84]][
          make
        ],
        postH = [1.02, 1.12, 0.62, 0, 1][make],
        thick =
          make === 2
            ? rr(0.085, 0.11)
            : make === 4
              ? rr(0.06, 0.08)
              : rr(0.11, 0.16);
      const off = base + rr(-0.1, 0.18),
        x = TRAIL[k][0] + n[0] * side * off,
        z = TRAIL[k][1] + n[1] * side * off,
        y = gy(x, z);
      const stump = rnd() < 0.07,
        h = stump ? rr(0.2, 0.45) : postH + rr(-0.09, 0.09);
      const lean = rnd() < 0.22 ? rr(0.06, 0.24) : rr(0, 0.03),
        la = rnd() * TAU,
        tx = x + cos(la) * lean,
        tz = z + sin(la) * lean;
      if (prev && !stump && (rnd() < 0.04 || (!fallen && k > 60))) {
        // a fallen length: its post lies on the ground, the rails slope down from the last post to lie beside it
        fallen++;
        spots.fence.push([x, y, z, 5]);
        // (all of it away from the path: the post fell outward, the rails lie on the far side of where it stood)
        const fa = atan2(n[1] * side, n[0] * side) + rr(-1.1, 1.1),
          ex = x + cos(fa) * h,
          ez = z + sin(fa) * h;
        if (make === 4 || make === 2)
          pole([x, y + thick, z], [ex, gy(ex, ez) + thick, ez], thick);
        else
          beam(
            [
              [x, y + thick / 2, z],
              [ex, gy(ex, ez) + thick / 2, ez],
            ],
            thick,
            thick,
          );
        for (const rh of heights) {
          const out = rr(0.1, 0.9),
            al = rr(-0.6, 0.6),
            bx = x + n[0] * side * out - n[1] * al,
            bz = z + n[1] * side * out + n[0] * al;
          if (rnd() < 0.75) {
            span(
              [prev[0], prev[1] + rh * prev[3], prev[2]],
              [bx, gy(bx, bz) + 0.07, bz],
            );
            walls.push(prev[0], prev[2], bx, bz, 0.2);
          }
        }
        prev = null;
        continue;
      }
      if (make === 4 || make === 2) {
        pole([x, y - 0.4, z], [tx, y + h, tz], thick);
        tops.push(tx, y + h, tz);
      } else post(x, y, z, h, thick, tx, tz);
      blocks.push(x, z, 0.2);
      spots.fence.push([x, y, z, make]);
      const gap = stump || rnd() < 0.1; // a length gone: the next post starts afresh
      if (prev && !gap) {
        let railed = false;
        for (const rh of heights) {
          if (rnd() < 0.06) continue; // this rail is gone
          const drop = make === 0 && rnd() < 0.05 ? rr(0.2, rh * 0.8) : 0; // a board with one end fallen toward the ground
          span(
            [prev[0], prev[1] + rh * prev[3] + rr(-0.03, 0.03), prev[2]],
            [tx, y + rh * (h / postH) - drop + rr(-0.03, 0.03), tz],
          );
          railed = true;
        }
        // (the walker is stopped from post foot to post foot, so a leaning post makes no bump)
        if (railed) walls.push(prev[4], prev[5], x, z, 0.2);
        if (make === 0 && rnd() < 0.12)
          rail(
            [prev[0], prev[1] + 0.3, prev[2]],
            [tx, y + 0.92, tz],
            0.05,
            0.12,
          ); // a brace
      }
      prev = gap ? null : [tx, y, tz, h / postH, x, z];
    }
  }
  // What crosses the water at each crossing, by its make. All are stamped into the height map; the ones without a
  // rail on a side get an unseen stop along it instead (walls), so the walker keeps to them
  // the line's two ends on the banks and the way across; y: the ground at each end
  for (const c of crossings) {
    const { line, lv, make } = c,
      n = line.length - 1,
      a = line[0],
      b = line[n],
      ya = gy(a[0], a[1]),
      yb = gy(b[0], b[1]),
      len = hypot(b[0] - a[0], b[1] - a[1]),
      dx = (b[0] - a[0]) / len,
      dz = (b[1] - a[1]) / len;
    // a stop along a side of the straight way across, `off` metres out
    const stops = (off) => {
      let s = 0.3;
      for (; s < len - 0.2; s += 0.45)
        touch.push(a[0] + dx * s - dz * off, a[1] + dz * s + dx * off, 0.22);
      s -= 0.45;
      walls.push(
        a[0] + dx * 0.3 - dz * off,
        a[1] + dz * 0.3 + dx * off,
        a[0] + dx * s - dz * off,
        a[1] + dz * s + dx * off,
        0.22,
      );
    };
    if (make < 2) {
      // planks on beams with rails, a little arched, the deck never less than two hands over the water; posts
      // under it where the water is wide
      const pts = line.map((p, j) => [
        p[0],
        max(
          mix(ya, yb, j / n) + 0.1 + 0.18 * sin((PI * j) / n),
          j && j < n ? lv + 0.42 : -1e9,
        ),
        p[1],
      ]);
      deck(pts, make ? 0.8 : 0.95, 2);
      if (!make)
        for (const j of [(n / 3) | 0, ((n * 2) / 3) | 0])
          post(pts[j][0], pts[j][1] - 1.7, pts[j][2], 1.6, 0.2);
    } else if (make < 4) {
      // A step-over crossing of trimmed timber, resting well up on both banks. A, B: on each side, half a metre
      // past where the bank has risen a good hand over the water (3 m from the middle at most), and the ground there
      const bank = (dir) => {
        let s = c.hw;
        while (
          s < 3 &&
          gy(c.at[0] + dx * s * dir, c.at[1] + dz * s * dir) < lv + 0.3
        )
          s += 0.25;
        s += 0.5;
        const x = c.at[0] + dx * s * dir,
          z = c.at[1] + dz * s * dir;
        return [x, gy(x, z), z, s];
      };
      const A = bank(-1),
        B = bank(1),
        span = A[3] + B[3],
        along = (s, off, h) => [
          A[0] + dx * s - dz * off,
          mix(A[1], B[1], s / span) + h,
          A[2] + dz * s + dx * off,
        ];
      // an unseen stop along a side, `off` metres out, for the length of the timber
      const edge = (off) => {
        let s = -0.1;
        for (; s < span + 0.2; s += 0.45) {
          const p = along(s, off, 0);
          touch.push(p[0], p[2], 0.22);
        }
        const p = along(-0.1, off, 0),
          q = along(s - 0.45, off, 0);
        walls.push(p[0], p[2], q[0], q[2], 0.22);
      };
      let top = 0.2,
        wide = 0.3;
      if (make === 2) {
        // three poles side by side, a finger apart, unlike each other: girth (18 to 32 cm), length, bend, taper
        // and weathering all each pole's own; their ends staggered and sunk into the banks
        const radii = [rr(0.09, 0.115), rr(0.135, 0.16), rr(0.11, 0.14)];
        wide = radii[0] + radii[1] + radii[2] + 0.02;
        let off = -wide;
        top = 0;
        for (const r of radii) {
          off += r;
          const s0 = rr(-0.45, 0.1),
            s1 = span + rr(-0.1, 0.45),
            lift = r * 0.15; // (two fifths of it under the ground at the banks)
          trimmed(
            [
              along(s0, off, lift),
              along(
                (s0 + s1) / 2,
                off + rr(-0.04, 0.04),
                lift + rr(-0.03, 0.02),
              ),
              along(s1, off, lift),
            ],
            r * rr(1, 1.12),
            r * rr(0.78, 0.92),
            rr(0.15, 0.95),
          );
          off += r + 0.02;
          top += (lift + r) / 3;
        }
        for (const side of [-1, 1]) edge(side * (wide + 0.24));
      } else {
        // half a trunk, its hewn side up and weathered grey, its round underside clear of the ground between the
        // banks; for a hand rail a pole on two posts set in the banks
        const side = rnd() < 0.5 ? 1 : -1,
          out = side * (wide + 0.12);
        halfLog(
          along(-0.1, 0, top),
          along(span + 0.1, 0, top),
          wide,
          rr(0.35, 0.5),
        );
        for (const s of [0.15, span - 0.15]) {
          const p = along(s, out, 0);
          pole([p[0], p[1] - 0.4, p[2]], [p[0], p[1] + 1.05, p[2]], 0.045);
        }
        pole(along(-0.05, out, 0.95), along(span + 0.05, out, 0.95), 0.035);
        edge(out);
        edge(-side * (wide + 0.26));
      }
      stamp([along(-0.15, 0, top), along(span + 0.15, 0, top)], 0.8);
      // (the line walked along, bank to bank, and how far the timber reaches to each side of it: scene.js lanes)
      c.walk = [A[0], A[2], B[0], B[2], wide];
    } else {
      // Stepping stones: five to seven, flat-topped, a stride apart and not in a line, pale and dry on top and
      // clearly proud of the water where each stands (the level steps down at a fall, and the stones with it).
      // What is walked on runs over their tops
      const way = [[a[0], ya, a[1]]];
      let bend = 0; // the line is a little crooked: each stone off to one side of the last
      for (let s = 0.4; s < len - 0.3; s += rr(0.55, 0.78)) {
        bend = bend * 0.6 + rr(-0.22, 0.22);
        const x = a[0] + dx * s - dz * bend,
          z = a[1] + dz * s + dx * bend,
          ck = creekAt(x, z);
        if (ck[0] > 0.3) continue;
        const top = ck[1] + 0.17 + rr(-0.05, 0.04);
        // (each of its own size and turn; its fade of 0.5 tells the rock's material it is a stepping stone)
        chunk(
          8,
          x,
          top,
          z,
          rr(0.4, 0.78),
          qAxis(0, 1, 0, rnd() * TAU),
          1,
          rnd(),
          0.5,
        );
        way.push([x, top, z]);
      }
      way.push([b[0], yb, b[1]]);
      stamp(way, 0.8);
      for (const side of [-1, 1]) stops(side * 0.72);
      c.walk = [a[0], a[1], b[0], b[1], 0];
    }
    c.ends = [a[0], a[1], b[0], b[1]];
  }
  // A boardwalk along the lake's shore, a hand over the wet ground, a handrail on the lake's side. The rail opens
  // on the span that comes nearest the lake: the dock leaves the boardwalk there (dockAt: the middle of that
  // span, x y z, and the way out over the water, x z)
  let dockAt;
  {
    const pts = [];
    const [first, last] = BOARDWALK;
    for (let k = first; k <= last; k += 2)
      pts.push([
        TRAIL[k][0],
        gy(TRAIL[k][0], TRAIL[k][1]) + (k === first || k === last ? 0.08 : 0.3),
        TRAIL[k][1],
      ]);
    const spanMid = (k) => [
      (pts[k][0] + pts[k + 1][0]) / 2,
      (pts[k][2] + pts[k + 1][2]) / 2,
    ];
    let gap = 1;
    for (let k = 2; k < pts.length - 2; k++)
      if (lakeD(...spanMid(k)) < lakeD(...spanMid(gap))) gap = k;
    const lakeSide = deck(pts, 0.8, 1, 0.3, gap),
      from = pts[gap],
      to = pts[gap + 1],
      span = hypot(to[0] - from[0], to[2] - from[2]);
    dockAt = [
      ...spanMid(gap),
      (from[1] + to[1]) / 2,
      (-(to[2] - from[2]) / span) * lakeSide,
      ((to[0] - from[0]) / span) * lakeSide,
    ];
    // grass and ferns push over its sides
    for (let j = 0; j < 90; j++) {
      const p = pts[1 + ((rnd() * (pts.length - 2)) | 0)],
        q = pts[min(pts.indexOf(p) + 1, pts.length - 1)],
        t = rnd(),
        sd = rnd() < 0.5 ? -1 : 1,
        l = hypot(q[0] - p[0], q[2] - p[2]) || 1,
        x = mix(p[0], q[0], t) - ((q[2] - p[2]) / l) * sd * rr(0.85, 1.25),
        z = mix(p[2], q[2], t) + ((q[0] - p[0]) / l) * sd * rr(0.85, 1.25),
        y = gy(x, z);
      if (y > 0.05) {
        if (rnd() < 0.25)
          cluster(x, y, z, 6, 2, 0.5, 0.9, 0.28, 0.42, 1.2, 0.4);
        else tuft(x, z, rr(1, 1.8), true);
      }
    }
  }
  // The dock: from the boardwalk's opening straight out over the water, its planks meeting the boardwalk's at
  // their height and sloping down in its first length to half a metre over the lake. It is walked on to its end:
  // blocks along both edges and across the end keep the walker on the planks. pier: where the walk onto it
  // begins, on the boardwalk, and where the planks end (x, z each)
  const pier = [];
  let boat;
  {
    const [mx, mz, my, dx, dz] = dockAt,
      pts = [];
    for (let j = 0; j <= 4; j++)
      pts.push([
        mx + dx * (0.78 + j * 2.75),
        j ? 0.55 : my - 0.03,
        mz + dz * (0.78 + j * 2.75),
      ]);
    deck(pts, 0.85, 0);
    const [ex, , ez] = pts[4],
      off = (along, across, y) => [
        pts[0][0] + dx * along - dz * across,
        y,
        pts[0][2] + dz * along + dx * across,
      ];
    // (over the water the height map is stamped wider than the planks and on past their end: the eye rides level
    // on them, to the last step)
    stamp([...pts.slice(1), off(13.5, 0, 0.55)], 1.15);
    for (let along = 0; along <= 11.3; along += 0.5)
      for (const side of [-1, 1]) {
        const p = off(along, side * 0.8, 0);
        touch.push(p[0], p[2], 0.2);
      }
    for (const across of [-0.4, 0, 0.4]) {
      const p = off(11.3, across, 0);
      touch.push(p[0], p[2], 0.2);
    }
    for (const [a, b] of [
      [off(0, -0.8, 0), off(11, -0.8, 0)],
      [off(0, 0.8, 0), off(11, 0.8, 0)],
      [off(11.3, -0.4, 0), off(11.3, 0.4, 0)],
    ])
      walls.push(a[0], a[2], b[0], b[2], 0.2);
    pier.push(mx, mz, ex, ez);
    for (let j = 1; j <= 3; j++)
      for (const side of [-1, 1])
        post(...off(j * 2.75, side * 0.8, -2.6), 3.5, 0.16);
    // The planks stop short of the last pair of piles: the two beams under them run on to a tie between the
    // piles, which stand taller than the others
    for (const side of [-1, 1]) {
      beam(
        [off(10.9, side * 0.714, 0.41), off(11.75, side * 0.714, 0.41)],
        0.12,
        0.14,
        UPY,
        0.3,
      );
      post(...off(11.6, side * 0.86, -2.6), 3.8, 0.17);
    }
    beam([off(11.6, -0.95, 0.27), off(11.6, 0.95, 0.27)], 0.12, 0.14, UPY, 0.3);
    // a mooring line: a few turns round one of the last piles, then slack down to the bow of a boat
    const rope = (line) => {
      const first = wood.aux.length;
      wood.tube(line, () => 0.014, 5, false);
      grain(first, 1, 0, false, 0.95);
    };
    const coil = [];
    for (let i = 0; i <= 26; i++)
      coil.push(
        off(
          11.6 + cos((i / 8) * TAU) * 0.14,
          0.86 + sin((i / 8) * TAU) * 0.14,
          0.84 + i * 0.006,
        ),
      );
    rope(coil);
    // A rowing boat tied alongside: a mesh of its own about its middle at the water's level, which scene.js floats
    // (it rises, rolls and pitches a little). a: along it from stern to bow, b: across it, y: over the water. Its
    // stations from stern to bow: where, half its beam at the gunwale, the gunwale's height (the sheer rises to
    // the bow), the keel's. Painted planks carry shade 5, its dark rail 1, bare wood 3 (W_SOLID paints by them)
    const mid = off(8.3, 1.85, 0),
      woodwork = wood,
      local = (a, b, y) => [dx * a - dz * b, y, dz * a + dx * b],
      STA = [-1.55, -1.1, -0.4, 0.3, 0.9, 1.35, 1.62],
      GUN = [0.4, 0.54, 0.62, 0.58, 0.44, 0.24, 0.02],
      TOP = [0.33, 0.31, 0.3, 0.31, 0.345, 0.39, 0.44],
      KEEL = [-0.13, -0.16, -0.17, -0.17, -0.15, -0.1, 0],
      // a side's section from the keel out: the flat of the bottom, the turn of the bilge, the flared side
      section = (k, side) => [
        local(STA[k], 0, KEEL[k]),
        local(STA[k], side * GUN[k] * 0.5, KEEL[k] + 0.006),
        local(STA[k], side * GUN[k] * 0.86, KEEL[k] + 0.1),
        local(STA[k], side * GUN[k], TOP[k]),
      ];
    wood = new Mesh();
    for (const side of [-1, 1]) {
      const rows = STA.map((_, k) => section(k, side).map((p) => wood.v(...p)));
      for (let k = 0; k < rows.length - 1; k++)
        for (let j = 0; j < 3; j++) {
          // (wound so that its front is the hull's outside on both sides: W_SOLID paints the outside only)
          const quad = [
            rows[k][j],
            rows[k + 1][j],
            rows[k + 1][j + 1],
            rows[k][j + 1],
          ];
          wood.quad(...(side > 0 ? quad : quad.reverse()));
        }
    }
    {
      // the transom: the stern's flat board
      const stern = [
          ...section(0, -1).reverse(),
          ...section(0, 1).slice(1),
        ].map((p) => wood.v(...p)),
        top = wood.v(...local(STA[0], 0, TOP[0]));
      for (let j = 0; j < stern.length - 1; j++)
        wood.tri(stern[j], stern[j + 1], top);
    }
    grain(0, dx, dz, false, 0.72);
    // the rails along the gunwales, the stem post, the floor boards, two thwarts, a pair of oars
    for (const side of [-1, 1])
      beam(
        STA.map((a, k) => local(a, side * GUN[k], TOP[k])),
        0.05,
        0.04,
        UPY,
        0.14,
      );
    beam(
      [local(1.6, 0, -0.02), local(1.69, 0, 0.53)],
      0.05,
      0.07,
      () => [dx, 0, dz],
      0.14,
    );
    // The inside: ribs across it every third of a metre, three bottom boards lying on them, a riser along each
    // side for the thwarts to rest on. hullAt: the half beam, the gunwale's height and the keel's at a place along
    const hullAt = (a) => {
      let k = 0;
      while (k < STA.length - 2 && a > STA[k + 1]) k++;
      const share = clamp((a - STA[k]) / (STA[k + 1] - STA[k]), 0, 1);
      return [
        mix(GUN[k], GUN[k + 1], share),
        mix(TOP[k], TOP[k + 1], share),
        mix(KEEL[k], KEEL[k + 1], share),
      ];
    };
    for (let a = -1.35; a < 1.3; a += 0.3) {
      const [gun, top, keel] = hullAt(a);
      for (const side of [-1, 1])
        beam(
          [
            local(a, 0, keel + 0.012),
            local(a, side * gun * 0.48, keel + 0.02),
            local(a, side * gun * 0.84, keel + 0.105),
            local(a, side * gun * 0.97, top - 0.03),
          ],
          0.022,
          0.035,
          () => [dx, 0, dz],
          0.43,
        );
    }
    const BOARDS = [-1.3, -0.7, 0, 0.6, 1.05];
    for (const part of [-1, 0, 1])
      beam(
        BOARDS.map((a) => {
          const [gun, , keel] = hullAt(a);
          return local(a, part * gun * 0.3, keel + 0.045);
        }),
        (k) => hullAt(BOARDS[k])[0] * 0.27,
        0.02,
        UPY,
        0.43,
      );
    for (const side of [-1, 1])
      beam(
        [-1.2, -0.5, 0.2, 0.8].map((a) => {
          const [gun, top, keel] = hullAt(a),
            low = keel + 0.1;
          return local(
            a,
            side * gun * (0.86 + (0.14 * (0.15 - low)) / (top - low)) * 0.96,
            0.15,
          );
        }),
        0.03,
        0.035,
        UPY,
        0.43,
      );
    for (const [where, reach] of [
      [-0.55, 0.55],
      [0.45, 0.52],
    ])
      beam(
        [local(where, -reach, 0.17), local(where, reach, 0.17)],
        0.2,
        0.03,
        UPY,
        0.43,
      );
    for (const side of [-1, 1]) {
      pole(
        local(-1.25, side * 0.14, 0.205),
        local(0.95, side * 0.3, 0.24),
        0.018,
        0.43,
      );
      beam(
        [local(0.95, side * 0.3, 0.24), local(1.4, side * 0.2, 0.25)],
        0.11,
        0.014,
        UPY,
        0.43,
      );
    }
    {
      // its mooring line, slack from the bow up to the coil on the pile (it moves with the boat)
      const bow = local(1.64, 0, 0.47),
        pile = off(11.6, 0.98, 0.9),
        end = [pile[0] - mid[0], 0.9, pile[2] - mid[2]],
        sag = (share, drop) => [
          mix(bow[0], end[0], share),
          mix(bow[1], end[1], share) - drop,
          mix(bow[2], end[2], share),
        ];
      rope([bow, sag(0.3, 0.22), sag(0.65, 0.2), end]);
    }
    const hull = wood;
    // The lid inside the hull: drawn into the depth only, it keeps the lake's surface out of the boat. A hand
    // over the lake's level: lower, the boat's roll and bob dipped an edge of it under the water, which then
    // showed on the floor as a wedge that came and went
    const LID = 0.1;
    wood = new Mesh();
    const brim = STA.map((a, k) => {
      const low = KEEL[k] + 0.1,
        share = clamp((LID - low) / (TOP[k] - low), 0, 1),
        wide = GUN[k] * (0.86 + 0.14 * share) * 0.97;
      return [wood.v(...local(a, -wide, LID)), wood.v(...local(a, wide, LID))];
    });
    for (let k = 0; k < brim.length - 1; k++)
      wood.quad(brim[k][0], brim[k + 1][0], brim[k + 1][1], brim[k][1]);
    // boat: its mesh and lid, where its middle floats, the way it lies, and where the piles stand in the water
    boat = {
      mesh: hull,
      lid: wood,
      at: [mid[0], mid[2]],
      along: [dx, dz],
      piles: [2.75, 5.5, 8.25, 11.6].flatMap((along) =>
        [-1, 1].map((side) => {
          const p = off(along, side * (along > 9 ? 0.86 : 0.8), 0);
          return [p[0], p[2]];
        }),
      ),
    };
    wood = woodwork;
    // a bench on the landward side of the boardwalk by the opening, facing the lake
    const bx = mx - dz * 2.6 - dx * 1.75,
      bz = mz + dx * 2.6 - dz * 1.75,
      by = gy(bx, bz);
    beam(
      [
        [bx - dz * 0.8, by + 0.45, bz + dx * 0.8],
        [bx + dz * 0.8, by + 0.45, bz - dx * 0.8],
      ],
      0.42,
      0.06,
    );
    beam(
      [
        [bx - dz * 0.8 - dx * 0.24, by + 0.82, bz + dx * 0.8 - dz * 0.24],
        [bx + dz * 0.8 - dx * 0.24, by + 0.82, bz - dx * 0.8 - dz * 0.24],
      ],
      0.06,
      0.3,
    );
    for (const e of [-0.65, 0.65])
      post(bx - dz * e - dx * 0.2, by, bz + dx * e - dz * 0.2, 0.95, 0.09);
    blocks.push(bx, bz, 0.7);
  }
  // A board's two faces, each wholly covered by a quad that paints it (W_SIGN: dark stain, the name raised in
  // off-white): the board's middle, the way it runs from its post to its point (x, z), half its length, its
  // thickness, its name (LABELS), half its height. A face reads from left to right for whoever stands before it;
  // the far face's row is 16 more, so the name is set on the part clear of the post on both
  const labels = [];
  const label = (x, y, z, dx, dz, half, thick, name, tall) => {
    const off = thick / 2 + 0.008;
    for (const s of [1, -1])
      labels.push(
        x - dz * s * off,
        y,
        z + dx * s * off,
        half,
        dx * s,
        dz * s,
        tall,
        LABELS.indexOf(name) + (s < 0 ? 16 : 0),
      );
  };
  // a finger board: fixed to its post at one end, reaching out the way `a` to a point; its name on both faces
  const finger = (px, y, pz, a, name, high) => {
    const at = (along) => [px + cos(a) * along, y, pz + sin(a) * along];
    beam([at(-0.08), at(0.6), at(0.72)], 0.045, (k) => [high, high, 0.03][k]);
    label(...at(0.32), cos(a), sin(a), 0.4, 0.045, name, high / 2);
  };
  // a signpost with two boards at every junction: where a side path begins, and where one runs back into the loop
  const signs = [];
  for (const e of ENDS) {
    // not at a side path's far end in the woods or at a fork's second prong, and one post where two side paths meet
    // the loop at the same place
    if (
      PRONGS.includes(e) ||
      !TRAIL.some((p) => hypot(p[0] - e[0], p[1] - e[1]) < 2.5) ||
      signs.some((q) => hypot(q[0] - e[0], q[1] - e[1]) < 6)
    )
      continue;
    signs.push(e);
    let bx = e[0],
      bz = e[1],
      bd = 0;
    for (let a = 0; a < TAU; a += TAU / 12) {
      const x = e[0] + cos(a) * 2.2,
        z = e[1] + sin(a) * 2.2,
        d = trailD(x, z);
      if (d > bd) {
        bd = d;
        bx = x;
        bz = z;
      }
    }
    // Its two boards point the two ways there are to go, and each names what lies that way: along the side path
    // (WHERE), and on round the loop
    const at = ENDS.indexOf(e),
      branch = BRANCHES[at >> 1].pts,
      next = at & 1 ? branch[branch.length - 2] : branch[1];
    let k = 0;
    for (let i = 1; i < N; i++)
      if (
        hypot(TRAIL[i][0] - e[0], TRAIL[i][1] - e[1]) <
        hypot(TRAIL[k][0] - e[0], TRAIL[k][1] - e[1])
      )
        k = i;
    const on = TRAIL[(k + 4) % N],
      y = gy(bx, bz);
    post(bx, y, bz, 1.75, 0.11);
    blocks.push(bx, bz, 0.25);
    spots.sign.push([bx, y, bz, k, atan2(next[1] - e[1], next[0] - e[0])]);
    for (const [h, a, name] of [
      [1.5, atan2(next[1] - e[1], next[0] - e[0]), WHERE[at >> 1][at & 1]],
      [
        1.2,
        atan2(on[1] - TRAIL[k][1], on[0] - TRAIL[k][0]),
        k < 93 ? 'Creek' : k < 262 ? 'Lake' : k < 309 ? 'Meadow' : 'Trailhead',
      ],
    ]) {
      finger(bx, y + h, bz, a, name, 0.22);
    }
  }
  // a signpost where the walk starts
  {
    const n = tnorm(4),
      x = TRAIL[4][0] - n[0] * 1.5,
      z = TRAIL[4][1] - n[1] * 1.5,
      y = gy(x, z);
    post(x, y, z, 1.7, 0.11);
    // (a finger too, pointing on along the trail to the first thing ahead)
    finger(x, y + 1.42, z, atan2(-n[0], n[1]), 'Bridge', 0.24);
    spots.sign.push([x, y, z, 4, atan2(-n[0], n[1])]);
  }
  // The woodwork's triangles in the order of the culling cells (scene.js draws it cell by cell), and in woodAt
  // which triangle each cell's begin with
  const woodAt = new Uint32Array(nCells + 1);
  {
    const I = wood.i,
      nt = I.length / 3,
      at = new Uint16Array(nt),
      out = new Array(I.length);
    for (let t = 0; t < nt; t++) {
      const v = I[t * 3] * 3;
      at[t] = cellOf(wood.p[v], wood.p[v + 2]);
      woodAt[at[t] + 1]++;
    }
    for (let c = 0; c < nCells; c++) woodAt[c + 1] += woodAt[c];
    const next = woodAt.slice(0, nCells);
    for (let t = 0; t < nt; t++) {
      const o = next[at[t]]++ * 3;
      out[o] = I[t * 3];
      out[o + 1] = I[t * 3 + 1];
      out[o + 2] = I[t * 3 + 2];
    }
    wood.i = out;
  }
  solid(WOOD, 0, 0, 0, 1, [0, 0, 0, 1], 3, 0.37, 1, 0);

  // A card's rank as the leaf shader works it out (W_LEAF rankOf: from its two seeds as bytes), and a store's cards
  // of rank under a half: beyond where the shader has thinned the others away, only these are drawn. (.53: a
  // little over, so that rounding never leaves out a card the shader still shows.) Further off still the shader
  // has thinned a store to its least (W_LEAF KMIN): from there a third set, of the ranks under `cut`
  const rankOf = (a, i) => {
    const r =
      (floor(a[i + 10] * 255) / 255) * 7.13 +
      (floor(a[i + 9] * 255) / 255) * 3.71;
    return r - floor(r);
  };
  const lowRank = (L, cut = 0.53) =>
    L.map((a) => {
      const o = [];
      for (let i = 0; i < a.length; i += 12)
        if (rankOf(a, i) < cut) for (let j = 0; j < 12; j++) o.push(a[i + j]);
      return o;
    });
  const sol = { data: [], ranges: [] };
  let si = 0;
  for (let m = 0; m <= WOOD; m++) {
    const a = solids[m] || [];
    sol.ranges.push([si, a.length / 12]);
    si += a.length / 12;
    for (let i = 0; i < a.length; i++) sol.data.push(a[i]);
  }
  // pad(sc): how far above and below its origin an instance of scale sc reaches, for the cells' height ranges
  const packC = (L, pad = () => 3) => {
    let n = 0;
    const start = new Uint32Array(nCells + 1),
      sub = new Uint32Array(nCells * NSUB + 1);
    for (let c = 0; c < nCells; c++) {
      start[c] = n;
      n += L[c].length / 12;
    }
    start[nCells] = sub[nCells * NSUB] = n;
    const data = new Float32Array(n * 12),
      lo = new Float32Array(nCells).fill(1e9),
      hi = new Float32Array(nCells).fill(-1e9);
    let k = 0;
    for (let c = 0; c < nCells; c++) {
      const a = L[c],
        groups = bySub(a, 12);
      for (let s = 0; s < NSUB; s++) {
        sub[c * NSUB + s] = k;
        for (const i of groups[s]) {
          for (let j = 0; j < 12; j++) data[k * 12 + j] = a[i + j];
          const p = pad(a[i + 3]);
          lo[c] = min(lo[c], a[i + 1] - p);
          hi[c] = max(hi[c], a[i + 1] + p);
          k++;
        }
      }
    }
    return { data, n, start, sub, lo, hi };
  };
  // The ravens' snags (birds.js): tall dead trunks standing in the open, two inside the meadow's edge and two on the
  // lake's shore by the boardwalk, each 10 to 21 m from the loop and seen against fog or sky from it. Placed last and by hand (no
  // draw from rnd): nothing else moves for them. Their tops, where a raven stands: x y z
  const ravenSnags = [
    [-15, 72, 9.5],
    [2, 76, 8.5],
    [74, 8, 9],
    [82, 12, 10],
  ].map(([x, z, h], k) => {
    const y = gy(x, z) - 0.3;
    solid(9, x, y, z, h, qAxis(0, 1, 0, k * 1.9), 2, 5.2 + k * 0.17);
    blocks.push(x, z, h * 0.05 + 0.2);
    return [x, y + h, z];
  });
  // The contact map (tC in the shaders): how close something stands on the ground, 1024 cells a side over the
  // world, a soft disc for each of the blocks the walker goes round (trunks, posts, logs, stones, bushes) and of
  // `touch` (each disc keeps the darker of what falls on it, so the order does not matter)
  const CMN = 1024,
    cm = new Uint8Array(CMN * CMN),
    discs = [...blocks, ...touch];
  for (let i = 0; i < discs.length; i += 3) {
    const cx = ((discs[i] - OX) / W) * CMN,
      cz = ((discs[i + 1] - OZ) / W) * CMN,
      r0 = discs[i + 2] * 0.8,
      r1 = discs[i + 2] + 0.45,
      rc = Math.ceil((r1 / W) * CMN);
    for (let j = max(floor(cz) - rc, 0); j <= min(floor(cz) + rc, CMN - 1); j++)
      for (
        let k = max(floor(cx) - rc, 0);
        k <= min(floor(cx) + rc, CMN - 1);
        k++
      ) {
        const v =
            sstep(r1, r0, (hypot(k + 0.5 - cx, j + 0.5 - cz) * W) / CMN) * 255,
          o = k + CMN * j;
        if (v > cm[o]) cm[o] = v;
      }
  }
  return {
    hm: H,
    occ,
    spots,
    labels: new Float32Array(labels),
    pier,
    boat,
    foam,
    perches: new Float32Array(perches),
    tops: new Float32Array(tops),
    // every path's points (x, z): the loop, then each side path (debug.paths)
    paths: [
      TRAIL,
      ...RUNS.slice(0, -1).map((at, b) => SIDE.slice(at, RUNS[b + 1])),
    ].map((line) => line.map((p) => [p[0], p[1]])),
    // how much light the crowns take in each cell of the light volume, in 800ths: where the sky is hidden
    crown: Uint8Array.from(shade, (v) => min(255, v * 800)),
    cm,
    woodAt,
    bridges: crossings.filter((c) => c.k >= 0).map((c) => c.k),
    // every crossing: its make, the water's half width, where its way across begins and ends (x, z each)
    crossings: crossings.map((c) => [
      c.make,
      c.hw,
      ...c.ends,
      ...(c.walk || []),
    ]),
    chunks: chunks.map((c) => packC(c)),
    props: props.map((c) => packC(c, (sc) => sc + 1)),
    boulders: boulders.map((b) => packC(b, (sc) => sc * 1.5 + 1)),
    blocks,
    walls,
    trees,
    ravenSnags,
    wood,
    // each leaf store whole, and again only its cards of the lower ranks, for the distance (scene.js LEAVES)
    farT: pack(farT),
    low: pack(low),
    lowM: pack(lowRank(low, 0.75)),
    high: pack(high),
    bigF: pack(lowRank(big)),
    bigL: pack(lowRank(big, 0.27)),
    limb: pack(limb),
    shrub: pack(shrub),
    shrubF: pack(lowRank(shrub)),
    small: pack(small),
    smallF: pack(lowRank(small)),
    smallL: pack(lowRank(small, 0.18)),
    solids: { data: new Float32Array(sol.data), ranges: sol.ranges },
    volD,
    gm,
    snow,
  };
}

// ---------------------------------------------------------------- procedural meshes
// a rock: an icosphere pushed about by noise and cut by four random planes
export function meshChunk(sd, sub = 2, det = sub > 2) {
  if (!HIGH && sub > 1) sub--; // below High: a quarter of the triangles
  rseed(100 + sd);
  // Nine planes, most cutting deep, on a lump only a little uneven: broken faces that meet at edges. And every
  // triangle gets its own corners, so each face is lit as a face (a few triangles shaded round read as a lump)
  const pl = [];
  for (let i = 0; i < 9; i++) {
    const q = qRand();
    pl.push([q[0], q[1], q[2], rr(0.5, 0.9)]);
    const l = hypot(q[0], q[1], q[2]) || 1;
    pl[i][0] /= l;
    pl[i][1] /= l;
    pl[i][2] /= l;
  }
  const m = icosphere(sub, (x, y, z) => {
    const r =
      1 +
      (fbm(x * 1.6 + sd, y * 1.6, z * 1.6, 2) - 0.5) * 0.55 +
      (det ? (fbm(x * 4 + sd, y * 4, z * 4, 2) - 0.5) * 0.2 : 0);
    let px = x * r,
      py = y * r * 0.8,
      pz = z * r;
    for (const p of pl) {
      const d = px * p[0] + py * p[1] + pz * p[2] - p[3];
      if (d > 0) {
        px -= p[0] * d;
        py -= p[1] * d;
        pz -= p[2] * d;
      }
    }
    return [px, py, pz];
  });
  const o = new Mesh();
  for (let t = 0; t < m.i.length; t += 3)
    o.tri(
      ...[0, 1, 2].map((j) => {
        const k = m.i[t + j];
        return o.v(m.p[k * 3], m.p[k * 3 + 1], m.p[k * 3 + 2], m.aux[k]);
      }),
    );
  return o;
}
// a shape turned about y from a profile of [radius, height, aux] rings
export function meshLathe(prof, seg, lump, ribs = 0) {
  const m = new Mesh(),
    rings = [];
  for (const [r, h, ao] of prof) {
    const ring = [];
    for (let s = 0; s < seg; s++) {
      const a = (s / seg) * TAU,
        rl =
          r *
          (1 +
            lump * (fbm(cos(a) * 1.5 + h * 2, h * 3, sin(a) * 1.5, 2) - 0.5) +
            0.07 * cos(ribs * a + h * 1.5));
      ring.push(m.v(cos(a) * rl, h, sin(a) * rl, ao));
    }
    rings.push(ring);
  }
  for (let k = 0; k < rings.length - 1; k++)
    for (let s = 0; s < seg; s++) {
      const s2 = (s + 1) % seg;
      m.quad(rings[k][s], rings[k + 1][s], rings[k + 1][s2], rings[k][s2]);
    }
  return m;
}
// A tree's trunk, 1 tall (an instance scales it to the tree's height): 0 fir, 1 cedar, 2 maple, 3 birch, 4 oak, 5 a
// dead snag, 6 a thin pole. One mesh for every distance, so a trunk never changes as the walker nears; its crown
// is leaf cards (and far off one picture, farT), a conifer's dead branches are cards too
export function meshTrunk(kind) {
  rseed(300 + kind);
  const pole = kind === 6,
    m = new Mesh(),
    sides = pole ? 5 : HIGH ? 8 : 6,
    bark = () => 1,
    r0 = [0.021, 0.03, 0.022, 0.016, 0.026, 0.05, 0.011][kind];
  if (kind < 2 || kind > 4) {
    // a flared foot, then an even taper to the tip; a snag keeps half its width to its broken top
    const hs = pole
      ? [0, 0.03, 0.3, 0.65, 1]
      : [0, 0.015, 0.04, 0.1, 0.35, 0.7, 1];
    const rad = (h) =>
      r0 *
      (1 + (kind === 1 ? 1.4 : 0.9) * pow(max(1 - h / 0.06, 0), 2)) *
      (kind === 5 ? 1 - 0.45 * h : 1 - 0.93 * h);
    m.tube(
      hs.map((h) => [0.008 * sin(h * 9 + kind), h, 0.008 * cos(h * 7)]),
      (k) => rad(hs[k]),
      sides,
      true,
      bark,
    );
    // a snag's bare stubs, all the way up it
    if (kind === 5)
      for (let i = 5; i > 0; i--) {
        const a = rnd() * TAU,
          h = rr(0.35, 0.9),
          r = rad(h) * 0.8,
          len = rr(0.008, 0.022);
        m.tube(
          [
            [cos(a) * r, h, sin(a) * r],
            [cos(a) * (r + len), h + rr(-0.02, 0.01), sin(a) * (r + len)],
          ],
          (k) => 0.003 * (1 - k * 0.6),
          3,
          true,
          bark,
        );
      }
  } else {
    // a bole that forks into limbs reaching up into the crown, each thinner and of fewer sides than the one it leaves
    const bole = kind === 3 ? 0.5 : 0.36;
    const limb = (p, d, r, len, depth) => {
      const q = [p[0] + d[0] * len, p[1] + d[1] * len, p[2] + d[2] * len],
        mid = [
          (p[0] + q[0]) / 2 + rr(-0.02, 0.02),
          (p[1] + q[1]) / 2,
          (p[2] + q[2]) / 2 + rr(-0.02, 0.02),
        ];
      m.tube([p, mid, q], (k) => r * (1 - 0.15 * k), 3 + depth, true, bark);
      if (depth > 0)
        for (let i = 2 + (rnd() < 0.5); i > 0; i--) {
          const a = rnd() * TAU,
            s = kind === 3 ? 0.28 : 0.6,
            nd = [d[0] + cos(a) * s, d[1] + rr(0, 0.3), d[2] + sin(a) * s],
            l = hypot(...nd);
          limb(
            q,
            nd.map((c) => c / l),
            r * 0.62,
            len * 0.72,
            depth - 1,
          );
        }
    };
    m.tube(
      [
        [0, 0, 0],
        [0, 0.02, 0],
        [0, bole * 0.5, 0.005],
        [0, bole, 0],
      ],
      (k) => r0 * [1.7, 1.15, 1, 0.9][k],
      sides,
      false,
      bark,
    );
    limb([0, bole, 0], [0, 1, 0], r0 * 0.85, 0.2, 2);
  }
  return m;
}
// A fallen log, 1 long along x and a little flattened: uneven in girth, with stubs of branches; its butt snapped to
// splinters round a hollow, its top end sawn. Aux: 1 bark, about 0.2 bare wood, 0 the dark inside of the hollow
// (lod: 0 near, 1 mid, 2 far)
export function meshLog(lod = 0) {
  rseed(77);
  if (!HIGH && !lod) lod = 1; // (below High: the middle mesh from the start, so a log never changes close by)
  const m = new Mesh(),
    sides = [10, 8, 4][lod],
    n = [12, 8, 1][lod],
    rings = [];
  const mid = (s) => [s - 0.5, 0.006 * sin(s * 7), 0.004 * cos(s * 5)];
  const rad = (s, a) =>
    0.055 *
    (1 - 0.22 * s) *
    (1 +
      0.12 * sin(a * 3 + s * 9) +
      0.08 * sin(a * 2 - s * 17 + 1) +
      0.06 * sin(s * 31 + a * 5) +
      0.14 * sin(s * 11 + 2) * sin(a + s * 4));
  const at = (s, a, aux = 1) => {
    const c = mid(s),
      r = rad(s, a);
    return m.v(c[0], c[1] + sin(a) * r * 0.88, c[2] + cos(a) * r, aux);
  };
  for (let k = 0; k <= n; k++) {
    const ring = [];
    for (let j = 0; j < sides; j++) ring.push(at(k / n, (j / sides) * TAU));
    rings.push(ring);
  }
  for (let k = 0; k < n; k++)
    for (let j = 0; j < sides; j++) {
      const j2 = (j + 1) % sides;
      m.quad(rings[k][j], rings[k][j2], rings[k + 1][j2], rings[k + 1][j]);
    }
  // the butt: splinters of uneven length standing out from its rim, and inside them a hollow
  const pit = m.v(-0.43, 0, 0, 0);
  for (let j = 0; j < sides; j++) {
    const a0 = (j / sides) * TAU,
      a1 = ((j + 1) / sides) * TAU,
      am = (a0 + a1) / 2,
      c = mid(0),
      r = rad(0, am) * 0.94;
    m.tri(
      at(0, a0, 0.24),
      at(0, a1, 0.24),
      m.v(
        c[0] - rr(0.006, 0.05),
        c[1] + sin(am) * r * 0.88,
        c[2] + cos(am) * r,
        0.16,
      ),
    );
    m.tri(at(0, a0, 0.1), at(0, a1, 0.1), pit);
  }
  // the top end: sawn
  {
    const c = mid(1),
      o = m.v(c[0], c[1], c[2], 0.13);
    for (let j = 0; j < sides; j++)
      m.tri(
        at(1, (j / sides) * TAU, 0.24),
        at(1, ((j + 1) / sides) * TAU, 0.24),
        o,
      );
  }
  // stubs of its branches, on its upper side
  if (lod < 2)
    for (let i = 0; i < 4; i++) {
      const s = rr(0.12, 0.85),
        a = rr(0.3, 2.8),
        c = mid(s),
        r = rad(s, a),
        L = rr(0.03, 0.075),
        lean = rr(-0.5, 0.5),
        b = [c[0], c[1] + sin(a) * r * 0.8, c[2] + cos(a) * r * 0.9];
      m.tube(
        [b, [b[0] + lean * L, b[1] + sin(a) * L, b[2] + cos(a) * L]],
        (k) => (k ? 0.006 : 0.011),
        lod ? 3 : 4,
        true,
        (k) => (k ? 0.22 : 1),
      );
    }
  return m;
}
// a stepping stone, 1 across and as deep (it stands on the bed), its flat top at y 0; every face lit as a face (as meshChunk)
export function meshSlab() {
  rseed(141);
  const m = icosphere(1, (x, y, z) => {
      // (an uneven outline, longer one way than the other: turned, no two stones look alike)
      const r = 1 + (fbm(x * 1.7 + 3, y * 1.7, z * 1.7, 2) - 0.5) * 0.85;
      return [
        x * r * 0.56,
        (min(y * r * 0.6, 0.12) - 0.12) / 0.72,
        z * r * 0.41,
      ];
    }),
    o = new Mesh();
  for (let t = 0; t < m.i.length; t += 3)
    o.tri(
      ...[0, 1, 2].map((j) => {
        const k = m.i[t + j];
        return o.v(m.p[k * 3], m.p[k * 3 + 1], m.p[k * 3 + 2], m.aux[k]);
      }),
    );
  return o;
}
// a fallen branch or a root, 1 long along x: a bent stick with one side twig
export function meshStick(far = false) {
  const m = new Mesh();
  // (far: the same stick and twig in three sides and one length each, so its outline hardly changes)
  if (far) {
    m.tube(
      [
        [-0.5, 0, 0],
        [0.5, 0.006, 0],
      ],
      (k) => 0.024 * (1 - 0.4 * k),
      3,
      false,
      () => 1,
    );
    m.tube(
      [
        [0, 0.005, 0],
        [0.2, 0.02, 0.08],
      ],
      (k) => (k ? 0.006 : 0.014),
      3,
      false,
      () => 1,
    );
    return m;
  }
  m.tube(
    [
      [-0.5, 0, 0],
      [-0.15, 0.008, 0.012],
      [0.2, 0.003, -0.014],
      [0.5, 0.008, 0],
    ],
    (k) => 0.024 * (1 - 0.2 * k),
    5,
    true,
    () => 1,
  );
  m.tube(
    [
      [0, 0.005, 0],
      [0.2, 0.02, 0.08],
    ],
    (k) => (k ? 0.006 : 0.014),
    4,
    true,
    () => 1,
  );
  return m;
}
// A stump with root flares, about 1 wide and 0.8 tall, snapped: its rim stands in splinters of uneven height (by
// the angle, so every level of detail has the same outline) round a hollow, pale wood at aux 0.24, dark at 0
export function meshStump(lod = 0) {
  const seg = [10, HIGH ? 7 : 10, 5][lod],
    m = meshLathe(
      [
        [0.66, 0, 0.6],
        [0.52, 0.12, 0.9],
        [0.43, 0.4, 1],
        [0.4, 0.78, 1],
        [0.34, 0.76, 0.24],
        [0.2, 0.5, 0.1],
        [0, 0.42, 0],
      ],
      seg,
      0.25,
      5,
    );
  for (let s = 0; s < seg; s++) {
    const a = (s / seg) * TAU,
      k = 0.72 + 0.4 * abs(sin(a * 3.5 + 1)) + 0.1 * sin(a * 9);
    m.p[(3 * seg + s) * 3 + 1] *= k;
    m.p[(4 * seg + s) * 3 + 1] *= k * 0.97;
  }
  return m;
}
// a mushroom 1 tall: the stem at aux 0, the cap at aux 1
export function meshShroom(far = false) {
  return far
    ? meshLathe(
        [
          [0.08, 0, 0],
          [0.07, 0.6, 0],
          [0.5, 0.62, 1],
          [0, 1, 1],
        ],
        5,
        0,
      )
    : meshLathe(
        [
          [0.09, 0, 0],
          [0.07, 0.5, 0],
          [0.08, 0.62, 0],
          [0.5, 0.6, 0.5],
          [0.52, 0.68, 1],
          [0.38, 0.86, 1],
          [0.18, 0.97, 1],
          [0, 1, 1],
        ],
        8,
        0.15,
      );
}
