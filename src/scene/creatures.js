// ============================================================================
// animals moved on the CPU: deer, a fox, squirrels on the trunks, owls on the snags and ducks on the lake
// ============================================================================
// Each is a few rigid parts, drawn as instances of the solid pipeline with material 6 (shaders.js), so they need
// no shader stage of their own. An instance is 12 floats: position, scale, quaternion, material, species + hue,
// texture scale, 0. update(t, camX, camZ) rewrites all of them; scene.js uploads the array and draws the groups.
import {
  abs,
  atan2,
  clamp,
  cos,
  exp,
  floor,
  hypot,
  icosphere,
  LAKE,
  lakeD,
  max,
  Mesh,
  min,
  rnd,
  rr,
  rseed,
  sin,
  sqrt,
  TAU,
} from './math.js';

const MAT = 6;
// species (the whole part of an instance's seed): the shader picks the coat by it
const DEER = 0,
  FOX = 1,
  SQUIRREL = 2,
  OWL = 3,
  DUCK = 4;
// a vertex's aux says what it is: coat, a dark part (shank, ear tip, nose, the duck's head), antler / hoof / bill, eye
const COAT = 1,
  DARK = 0.5,
  BONE = 0,
  EYE = -1;

// ---------------------------------------------------------------- meshes (metres at scale 1, nose at +z, up +y)
// The shader paints what faces down (-y in the mesh) as a pale belly, so bodies are built the right way up.
// a flat triangle; b is its tip and may take an aux of its own (a dark ear tip)
const fin = (m, a, b, c, aux = COAT, tip = aux) =>
  m.tri(
    m.v(a[0], a[1], a[2], aux),
    m.v(b[0], b[1], b[2], tip),
    m.v(c[0], c[1], c[2], aux),
  );
// an ellipsoid of 20 (sub 0) or 80 triangles, added to m
const blob = (m, c, r, aux, sub = 1) => {
  const s = icosphere(sub),
    base = m.p.length / 3;
  for (let k = 0; k < s.p.length; k += 3)
    m.v(
      c[0] + s.p[k] * r[0],
      c[1] + s.p[k + 1] * r[1],
      c[2] + s.p[k + 2] * r[2],
      aux,
    );
  for (let k = 0; k < s.i.length; k += 3)
    m.tri(base + s.i[k], base + s.i[k + 1], base + s.i[k + 2]);
};
// an eye: an octahedron, 8 triangles
const gem = (m, c, r, aux = EYE) => {
  const base = m.p.length / 3;
  for (const d of [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ])
    m.v(c[0] + d[0] * r, c[1] + d[1] * r, c[2] + d[2] * r, aux);
  for (const f of [
    [0, 2, 4],
    [2, 1, 4],
    [1, 3, 4],
    [3, 0, 4],
    [2, 0, 5],
    [1, 2, 5],
    [3, 1, 5],
    [0, 3, 5],
  ])
    m.tri(base + f[0], base + f[1], base + f[2]);
};
// A round limb through [x, y, z, radius] points, a fifth entry being that ring's own aux. Its far end is closed,
// its near end open (hidden in a body, or a first ring too thin to show); squeezed to `flat` of its width.
const limb = (m, pts, sides, aux = COAT, flat = 1) => {
  const first = m.p.length / 3;
  m.tube(
    pts,
    (k) => pts[k][3],
    sides,
    true,
    (k) => pts[k][4] ?? aux,
  );
  for (let k = first * 3; k < m.p.length; k += 3) m.p[k] *= flat;
};
// a limb along z through [z, radius, y] rings (y 0 when left out)
const hull = (m, rings, sides, flat = 1, aux = COAT) =>
  limb(
    m,
    rings.map((ring) => [0, ring[2] || 0, ring[0], ring[1]]),
    sides,
    aux,
    flat,
  );
// a spike from `a` to `b`, three sided: with a middle ring (15 triangles) or, as a tine, without (9)
const spike = (m, a, b, r, aux = BONE) =>
  m.tube(
    [a, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], b],
    (k) => r * (1 - k * 0.48),
    3,
    true,
    () => aux,
  );
const tine = (m, a, b, r, aux = BONE) =>
  m.tube(
    [a, b],
    (k) => r * (1 - k * 0.7),
    3,
    true,
    () => aux,
  );

// deer body, the fox's too at half the size: chest at +z, a short tail, the origin on its axis between the legs
function meshBody() {
  const m = new Mesh();
  hull(
    m,
    [
      [0.6, 0.012, 0.05],
      [0.54, 0.12, 0.05],
      [0.36, 0.2, 0.02],
      [0.05, 0.2],
      [-0.3, 0.195, 0.01],
      [-0.5, 0.17, 0.03],
      [-0.6, 0.09, 0.05],
    ],
    8,
    0.82,
  );
  limb(
    m,
    [
      [0, 0.1, -0.58, 0.035],
      [0, 0.09, -0.68, 0.025],
      [0, 0.02, -0.74, 0.012],
    ],
    4,
  );
  return m;
}
// a leg, drawn along +z from the hip (the rig aims it down): thigh, a dark shank, a hoof. 0.76 long: see `stand`
function meshLeg() {
  const m = new Mesh();
  limb(
    m,
    [
      [0, 0, -0.04, 0.062],
      [0, 0, 0.3, 0.042],
      [0, 0, 0.56, 0.024, DARK],
      [0, 0, 0.74, 0.027, BONE],
      [0, 0, 0.76, 0.02, BONE],
    ],
    5,
  );
  return m;
}
// deer neck and head, hinged at the chest (the origin): the neck runs along +z, the head bends 30 degrees under it
function meshDeerHead(antlers) {
  const m = new Mesh();
  limb(
    m,
    [
      [0, 0, -0.03, 0.11],
      [0, 0.01, 0.2, 0.085],
      [0, 0.03, 0.4, 0.07],
      [0, 0.025, 0.47, 0.082],
      [0, -0.035, 0.58, 0.06],
      [0, -0.1, 0.69, 0.04],
      [0, -0.118, 0.72, 0.018, DARK],
    ],
    antlers ? 5 : 6,
    COAT,
    0.85,
  );
  for (const s of [-1, 1]) {
    fin(
      m,
      [s * 0.045, 0.085, 0.47],
      [s * 0.17, 0.2, 0.4],
      [s * 0.06, 0.1, 0.39],
      COAT,
      DARK,
    );
    gem(m, [s * 0.058, 0.02, 0.535], 0.016);
    if (!antlers) continue;
    spike(m, [s * 0.04, 0.09, 0.43], [s * 0.24, 0.5, 0.3], 0.022);
    tine(m, [s * 0.13, 0.28, 0.37], [s * 0.15, 0.44, 0.5], 0.014);
    tine(m, [s * 0.2, 0.42, 0.32], [s * 0.34, 0.56, 0.4], 0.013);
  }
  return m;
}
// fox neck and head: a pointed muzzle and big ears
function meshFoxHead() {
  const m = new Mesh();
  limb(
    m,
    [
      [0, 0, -0.03, 0.1],
      [0, 0.02, 0.16, 0.085],
      [0, 0.03, 0.3, 0.105],
      [0, 0, 0.4, 0.062],
      [0, -0.03, 0.52, 0.028],
      [0, -0.038, 0.56, 0.014, DARK],
    ],
    6,
  );
  for (const s of [-1, 1]) {
    fin(
      m,
      [s * 0.03, 0.11, 0.3],
      [s * 0.1, 0.3, 0.26],
      [s * 0.1, 0.08, 0.24],
      COAT,
      DARK,
    );
    gem(m, [s * 0.07, 0.06, 0.38], 0.016);
  }
  return m;
}
// the fox's brush, drawn along +z from its root, its tip white
function meshFoxTail() {
  const m = new Mesh();
  limb(
    m,
    [
      [0, 0, 0, 0.05],
      [0, 0, 0.16, 0.11],
      [0, 0, 0.45, 0.14],
      [0, 0, 0.74, 0.1, BONE],
      [0, 0, 0.95, 0.02, BONE],
    ],
    6,
  );
  return m;
}
// squirrel, 1 long (the rig draws it a quarter of that): body and head in one, ears, a tail curled over the back.
// Its body's axis runs through the origin, so on a trunk the belly lies on the bark.
function meshSquirrel() {
  const m = new Mesh();
  limb(
    m,
    [
      [0, -0.03, 0.5, 0.012, DARK],
      [0, -0.02, 0.42, 0.06],
      [0, 0, 0.3, 0.085],
      [0, -0.015, 0.2, 0.07],
      [0, 0, 0, 0.11],
      [0, 0.01, -0.2, 0.125],
      [0, 0, -0.34, 0.07],
    ],
    6,
  );
  limb(
    m,
    [
      [0, 0, -0.33, 0.04],
      [0, 0.12, -0.47, 0.09],
      [0, 0.32, -0.46, 0.115],
      [0, 0.47, -0.3, 0.1],
      [0, 0.5, -0.13, 0.035],
    ],
    5,
  );
  for (const s of [-1, 1]) {
    fin(
      m,
      [s * 0.03, 0.07, 0.3],
      [s * 0.07, 0.16, 0.27],
      [s * 0.07, 0.05, 0.25],
      COAT,
      DARK,
    );
    gem(m, [s * 0.07, 0.03, 0.36], 0.018);
  }
  return m;
}
// owl body, upright, its feet at the origin and its breast toward +z: folded wings, a short tail
function meshOwlBody() {
  const m = new Mesh();
  blob(m, [0, 0.21, 0], [0.13, 0.22, 0.12], COAT);
  for (const s of [-1, 1]) {
    blob(m, [s * 0.115, 0.2, -0.02], [0.035, 0.19, 0.1], COAT, 0);
    tine(m, [s * 0.04, 0.03, 0.05], [s * 0.045, -0.01, 0.1], 0.014);
  }
  fin(
    m,
    [-0.07, 0.06, -0.08],
    [0, -0.1, -0.13],
    [0.07, 0.06, -0.08],
    COAT,
    DARK,
  );
  return m;
}
// owl head, turned by the rig on its own: ear tufts, two big eyes, a small beak
function meshOwlHead() {
  const m = new Mesh();
  blob(m, [0, 0, 0], [0.115, 0.1, 0.105], COAT);
  for (const s of [-1, 1]) {
    fin(
      m,
      [s * 0.04, 0.08, 0.02],
      [s * 0.1, 0.19, 0],
      [s * 0.1, 0.06, 0],
      COAT,
      DARK,
    );
    gem(m, [s * 0.048, 0.012, 0.088], 0.03);
  }
  tine(m, [0, -0.01, 0.1], [0, -0.055, 0.125], 0.016);
  return m;
}
// duck, afloat with the waterline through the origin: body, a dark neck and head, a bill
function meshDuck() {
  const m = new Mesh();
  hull(
    m,
    [
      [0.21, 0.012, 0.04],
      [0.14, 0.09, 0.035],
      [0, 0.115, 0.03],
      [-0.15, 0.09, 0.04],
      [-0.25, 0.02, 0.1],
    ],
    6,
  );
  limb(
    m,
    [
      [0, 0.07, 0.12, 0.042],
      [0, 0.17, 0.16, 0.032],
      [0, 0.235, 0.18, 0.046],
      [0, 0.245, 0.235, 0.03],
    ],
    5,
    DARK,
  );
  limb(
    m,
    [
      [0, 0.24, 0.235, 0.022],
      [0, 0.228, 0.31, 0.012],
    ],
    4,
    BONE,
  );
  for (const s of [-1, 1]) gem(m, [s * 0.04, 0.25, 0.2], 0.01);
  return m;
}

// ---------------------------------------------------------------- rotation helpers
// Writes at out[o..o+3] the quaternion of the frame whose x, y and z axes are the unit vectors r (right), u (up)
// and f (forward), at right angles with r x u = f.
const frame = (out, o, rx, ry, rz, ux, uy, uz, fx, fy, fz) => {
  const tr = rx + uy + fz;
  let x, y, z, w;
  if (tr > 0) {
    const s = sqrt(tr + 1) * 2;
    w = s / 4;
    x = (uz - fy) / s;
    y = (fx - rz) / s;
    z = (ry - ux) / s;
  } else if (rx > uy && rx > fz) {
    const s = sqrt(max(1 + rx - uy - fz, 1e-9)) * 2;
    w = (uz - fy) / s;
    x = s / 4;
    y = (ux + ry) / s;
    z = (fx + rz) / s;
  } else if (uy > fz) {
    const s = sqrt(max(1 + uy - rx - fz, 1e-9)) * 2;
    w = (fx - rz) / s;
    x = (ux + ry) / s;
    y = s / 4;
    z = (fy + uz) / s;
  } else {
    const s = sqrt(max(1 + fz - rx - uy, 1e-9)) * 2;
    w = (ry - ux) / s;
    x = (fx + rz) / s;
    y = (fy + uz) / s;
    z = s / 4;
  }
  const l = hypot(x, y, z, w) || 1; // unit whatever rounding the axes carry
  out[o] = x / l;
  out[o + 1] = y / l;
  out[o + 2] = z / l;
  out[o + 3] = w / l;
};
// The frame that turns +z to the unit direction (fx, fy, fz) with +y as upright as it can stay, rolled by `roll`
// around the direction. For a direction straight up or down the roll is arbitrary: the squirrels use frame().
const aim = (out, o, fx, fy, fz, roll) => {
  let rx = fz,
    rz = -fx;
  const rl = hypot(rx, rz); // right = up x forward
  if (rl < 1e-4) {
    rx = 1;
    rz = 0;
  } else {
    rx /= rl;
    rz /= rl;
  }
  let ry = 0,
    ux = fy * rz,
    uy = fz * rx - fx * rz,
    uz = -fy * rx; // up = forward x right
  if (roll) {
    const c = cos(roll),
      s = sin(roll),
      ax = rx * c + ux * s,
      ay = uy * s,
      az = rz * c + uz * s;
    ux = ux * c - rx * s;
    uy = uy * c;
    uz = uz * c - rz * s;
    rx = ax;
    ry = ay;
    rz = az;
  }
  frame(out, o, rx, ry, rz, ux, uy, uz, fx, fy, fz);
};

// ---------------------------------------------------------------- the cast
// How a walker behaves: speeds (m/s), how near the walking user may come before it runs (shy), where it stops
// running (calm) and inside which it stands and watches (wary), how long it moves and stays (s), and its neck's
// angle over its back: on the move (carry), idle with the head up, idle with it down.
const DEER_WAYS = {
  amble: 0.7,
  dash: 5,
  shy: 7,
  calm: 16,
  wary: 18,
  go: [4, 9],
  stay: [7, 16],
  carry: 0.5,
  idle: [0.8, -1.15],
};
const FOX_WAYS = {
  amble: 2,
  dash: 4.6,
  shy: 6,
  calm: 14,
  wary: 12,
  go: [7, 15],
  stay: [1.5, 4],
  carry: 0.3,
  idle: [0.55, 0.05],
};
// deer: the middle of its round (x, z), the round's radius, size, antlers. Four in the meadow (clear to 20 m
// round -4, 78), a doe and the stag in the two glades (clear to 9 m): world.js keeps trees out of all three.
const DEER_AT = [
  [-8, 74, 9, 0.98, 0],
  [2, 82, 8, 0.94, 0],
  [-6, 80, 6.5, 0.6, 0],
  [0, 76, 7, 0.56, 0],
  [34, -46, 5, 1, 0],
  [-58, 24, 5.2, 1.12, 1],
];
// where the legs hinge on the body (x across, y up, z forward, at size 1): front left, front right, hind left, hind right
const HIPS = [
  [-0.1, -0.05, 0.4],
  [0.1, -0.05, 0.4],
  [-0.1, -0.05, -0.44],
  [0.1, -0.05, -0.44],
];
// each leg's place in the stride: walking, diagonal pairs move together; bounding, the front pair then the hind
const STEP = [0, 3.14, 3.14, 0],
  BOUND = [0, 0.4, 2.7, 3.1];
const NDUCK = 5,
  NSQUIRREL = 5,
  NOWL = 2;

// add, ground, avoid, trunks and snags: see the call in scene.js. Returns the instance array, the draw groups
// and update(t, camX, camZ).
export function makeCreatures({ add, ground, avoid, trunks, snags }) {
  rseed(31);
  // mesh ids, in this order from M: body, leg, doe head, stag head, fox head, fox tail, squirrel, owl body, owl head, duck
  const M = add(
    meshBody(),
    meshLeg(),
    meshDeerHead(false),
    meshDeerHead(true),
    meshFoxHead(),
    meshFoxTail(),
    meshSquirrel(),
    meshOwlBody(),
    meshOwlHead(),
    meshDuck(),
  );

  // A closed walking path: a wobbly ellipse moved out of the trunks, then smoothed. xz: its points, tan: the
  // heading at each, cum: the metres walked up to each.
  const loop = (cx, cz, rx, rz, wob) => {
    const n = 96,
      xz = new Float32Array(n * 2),
      ph = rnd() * TAU,
      ph2 = rnd() * TAU;
    const clear = (pad) => {
      for (let k = 0; k < n; k++) {
        const p = avoid(xz[k * 2], xz[k * 2 + 1], pad);
        xz[k * 2] = p[0];
        xz[k * 2 + 1] = p[1];
      }
    };
    const smooth = () => {
      const c = xz.slice();
      for (let k = 0; k < n; k++) {
        const a = ((k + n - 1) % n) * 2,
          b = ((k + 1) % n) * 2;
        xz[k * 2] = c[a] * 0.25 + c[k * 2] * 0.5 + c[b] * 0.25;
        xz[k * 2 + 1] = c[a + 1] * 0.25 + c[k * 2 + 1] * 0.5 + c[b + 1] * 0.25;
      }
    };
    for (let k = 0; k < n; k++) {
      const a = (k / n) * TAU,
        r = 1 + wob * sin(3 * a + ph) + wob * 0.5 * sin(5 * a + ph2);
      xz[k * 2] = cx + cos(a) * rx * r;
      xz[k * 2 + 1] = cz + sin(a) * rz * r;
    }
    // smoothing pulls a point back toward a trunk, so it is cleared again with less room and smoothed once more
    clear(0.6);
    smooth();
    smooth();
    clear(0.35);
    smooth();
    const tan = new Float32Array(n * 2),
      cum = new Float32Array(n + 1);
    for (let k = 0; k < n; k++) {
      const a = ((k + n - 1) % n) * 2,
        b = ((k + 1) % n) * 2,
        tx = xz[b] - xz[a],
        tz = xz[b + 1] - xz[a + 1],
        l = hypot(tx, tz) || 1;
      tan[k * 2] = tx / l;
      tan[k * 2 + 1] = tz / l;
      cum[k + 1] = cum[k] + hypot(xz[b] - xz[k * 2], xz[b + 1] - xz[k * 2 + 1]);
    }
    return { n, xz, tan, cum, len: max(cum[n], 1e-3) };
  };
  // P = the point `dist` metres along a path (x, z) and the unit heading there (x, z)
  const P = new Float64Array(4);
  const along = (lp, dist) => {
    const d = ((dist % lp.len) + lp.len) % lp.len;
    let lo = 0,
      hi = lp.n;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (lp.cum[mid] <= d) lo = mid;
      else hi = mid;
    }
    const a = lo * 2,
      b = ((lo + 1) % lp.n) * 2,
      f = clamp(
        (d - lp.cum[lo]) / max(lp.cum[lo + 1] - lp.cum[lo], 1e-6),
        0,
        1,
      );
    P[0] = lp.xz[a] + (lp.xz[b] - lp.xz[a]) * f;
    P[1] = lp.xz[a + 1] + (lp.xz[b + 1] - lp.xz[a + 1]) * f;
    const tx = lp.tan[a] + (lp.tan[b] - lp.tan[a]) * f,
      tz = lp.tan[a + 1] + (lp.tan[b + 1] - lp.tan[a + 1]) * f,
      l = hypot(tx, tz);
    if (l < 1e-4) {
      P[2] = 1;
      P[3] = 0;
    } else {
      P[2] = tx / l;
      P[3] = tz / l;
    }
  };

  // walkers: the deer and the fox share a rig (body, neck and head, four legs; the fox a tail as well).
  // size: of the body; leg, head, tail: of those parts; stand: how high the body's axis rides, so that a
  // straight leg (0.76 of its size long, hinged 0.05 under the axis) ends on the ground.
  const walkers = [];
  const walker = (ways, species, lp, size, leg, head, tail, stag) => {
    const w = {
      ways,
      lp,
      size,
      leg,
      head,
      tail,
      stag,
      seed: species + rnd() * 0.98,
      stand: 0.74 * leg + 0.06 * size,
      stride: 1.5 * leg,
      s: rnd() * lp.len,
      x: 0,
      z: 0,
      v: 0,
      phase: rnd() * TAU,
      gait: 0,
      walk: rnd() < 0.5,
      timer: rr(2, 9),
      up: false,
      look: rr(2, 6),
      run: false,
      runT: 0,
      wind: 5,
      tired: 0,
      pitch: ways.idle[1],
      yaw: 0,
    };
    along(lp, w.s);
    w.x = P[0];
    w.z = P[1];
    walkers.push(w);
  };
  for (const d of DEER_AT)
    walker(
      DEER_WAYS,
      DEER,
      loop(d[0], d[1], d[2], d[2], 0.18),
      d[3],
      d[3],
      d[3],
      0,
      d[4],
    );
  walker(FOX_WAYS, FOX, loop(-40, 62, 26, 14, 0.12), 0.5, 0.4, 0.55, 0.6, 0);

  // squirrels: each on one of the trunks, spread over the list; h: metres up the trunk, a: the angle round it,
  // (ft, fy): its heading, round the trunk and up it
  const squirrels = [];
  for (let i = 0; i < (trunks.length ? NSQUIRREL : 0); i++) {
    const tree = trunks[floor((i * trunks.length) / NSQUIRREL)],
      top = max(1.2, min(7, tree.h * 0.5));
    squirrels.push({
      tree,
      top,
      seed: SQUIRREL + (i % 2 ? rr(0.6, 0.95) : rr(0.05, 0.4)),
      h: rr(0.7, top),
      a: rnd() * TAU,
      up: rnd() < 0.5 ? 1 : -1,
      spin: rr(0.5, 1.6),
      go: false,
      timer: rr(0.5, 3),
      ft: 0,
      fy: 1,
    });
  }
  // owls: on top of the first snags; look: the heading its head has turned to
  const owls = [];
  for (let i = 0; i < min(NOWL, snags.length); i++) {
    const s = snags[i];
    owls.push({
      x: s.x,
      y: s.y + s.h,
      z: s.z,
      size: rr(0.95, 1.15),
      yaw: rnd() * TAU,
      look: rnd() * TAU,
    });
  }
  // ducks: slow rounds on the lake, each shrunk until all of it is 6 m or more from the shore
  const ducks = [];
  for (let i = 0; i < NDUCK; i++) {
    const c = LAKE[i % LAKE.length];
    let x = c[0] + rr(-5, 5),
      z = c[1] + rr(-5, 5),
      r = rr(4, 9);
    const dry = () => {
      for (let k = 0; k < 16; k++)
        if (
          lakeD(
            x + cos((k / 16) * TAU) * r,
            z + sin((k / 16) * TAU) * r * 0.8,
          ) > -6
        )
          return true;
      return false;
    };
    for (let tries = 0; tries < 12 && dry(); tries++) {
      r *= 0.8;
      if (tries === 5) {
        x = c[0];
        z = c[1];
      }
    }
    ducks.push({
      x,
      z,
      r,
      a: rnd() * TAU,
      way: rnd() < 0.5 ? 1 : -1,
      v: rr(0.25, 0.45),
      size: rr(0.9, 1.1),
      seed: DUCK + rnd() * 0.98,
    });
  }

  // ---------------------------------------------------------------- instances, in draw groups by mesh
  const nWalk = walkers.length,
    nStag = walkers.filter((w) => w.stag).length,
    nFox = walkers.filter((w) => w.tail).length;
  const layout = [
    [M, nWalk],
    [M + 1, nWalk * 4],
    [M + 2, nWalk - nStag - nFox],
    [M + 3, nStag],
    [M + 4, nFox],
    [M + 5, nFox],
    [M + 6, squirrels.length],
    [M + 7, owls.length],
    [M + 8, owls.length],
    [M + 9, ducks.length],
  ];
  const all = [];
  let total = 0;
  // r: nothing is culled, there are under 100 instances
  for (const [mesh, count] of layout) {
    all.push({ mesh, first: total, count, x: 0, y: 0, z: 0, r: 1e9 });
    total += count;
  }
  const [
    gBody,
    gLeg,
    gDoe,
    gStag,
    gFoxHead,
    gTail,
    gSquirrel,
    gOwl,
    gOwlHead,
    gDuck,
  ] = all;
  const data = new Float32Array(total * 12);
  // every instance: a unit quaternion until it is posed, material, species + hue, texture scale
  const tag = (o, seed) => {
    data[o + 7] = 1;
    data[o + 8] = MAT;
    data[o + 9] = seed;
    data[o + 10] = 1;
  };
  const put = (o, x, y, z, size) => {
    data[o] = x;
    data[o + 1] = y;
    data[o + 2] = z;
    data[o + 3] = size;
  };
  // each walker's parts: where its body, head and tail instances start in `data` (its legs follow its body's index)
  {
    let doe = 0,
      stag = 0,
      fox = 0;
    walkers.forEach((w, i) => {
      w.body = (gBody.first + i) * 12;
      w.legs = (gLeg.first + i * 4) * 12;
      w.headAt =
        (w.tail
          ? gFoxHead.first + fox
          : w.stag
            ? gStag.first + stag++
            : gDoe.first + doe++) * 12;
      w.tailAt = w.tail ? (gTail.first + fox++) * 12 : -1;
      tag(w.body, w.seed);
      tag(w.headAt, w.seed);
      if (w.tailAt >= 0) tag(w.tailAt, w.seed);
      for (let j = 0; j < 4; j++) tag(w.legs + j * 12, w.seed);
    });
  }
  squirrels.forEach((q, i) => tag((gSquirrel.first + i) * 12, q.seed));
  owls.forEach((w, i) => {
    const o = (gOwl.first + i) * 12;
    tag(o, OWL + 0.5);
    tag((gOwlHead.first + i) * 12, OWL + 0.5);
    aim(data, o + 4, sin(w.yaw), 0, cos(w.yaw), 0); // the body never turns: only its head does
  });
  ducks.forEach((d, i) => tag((gDuck.first + i) * 12, d.seed));

  let last = 0;
  function update(t, camX, camZ) {
    const dt = clamp(t - last, 0, 0.1);
    last = t;
    // walkers: mood first (run, watch, or the idle round of moving and staying), then the pose
    for (const w of walkers) {
      const W = w.ways,
        dist = hypot(camX - w.x, camZ - w.z);
      if (w.tired > 0) w.tired -= dt;
      // it runs until the user is far enough or it is out of breath; winded, it only stands and watches for a while
      if (w.run) {
        w.runT += dt;
        if (dist > W.calm || w.runT > w.wind) {
          w.run = false;
          if (dist <= W.calm) w.tired = rr(6, 10);
        }
      } else if (dist < W.shy && w.tired <= 0) {
        w.run = true;
        w.runT = 0;
        w.wind = rr(4, 7);
      }
      const alert = !w.run && dist < W.wary;
      if ((w.timer -= dt) <= 0) {
        w.walk = !w.walk;
        w.timer = w.walk ? rr(W.go[0], W.go[1]) : rr(W.stay[0], W.stay[1]);
      }
      if ((w.look -= dt) <= 0) {
        w.up = !w.up;
        w.look = w.up ? rr(1.5, 3.5) : rr(4, 10);
      }
      w.v +=
        ((w.run ? W.dash : alert || !w.walk ? 0 : W.amble) - w.v) *
        (1 - exp(-dt * (w.run ? 3 : 2)));
      w.gait += ((w.run ? 1 : 0) - w.gait) * (1 - exp(-dt * 3));
      w.s += w.v * dt;
      w.phase += ((w.v * dt) / (w.stride * (1 + 1.5 * w.gait))) * TAU; // a bound covers more ground than a step
      along(w.lp, w.s);
      const x = (w.x = P[0]),
        z = (w.z = P[1]),
        tx = P[2],
        tz = P[3],
        size = w.size;
      // body: forward (f) along the path and the ground's slope, right (r) level, up (u) = f x r
      const e = 0.5 * size + 0.1;
      let fy =
        clamp(
          (ground(x + tx * e, z + tz * e) - ground(x - tx * e, z - tz * e)) /
            (2 * e),
          -0.6,
          0.6,
        ) +
        sin(w.phase) * 0.1 * w.gait;
      const fl = hypot(1, fy),
        fx = tx / fl,
        fz = tz / fl;
      fy /= fl;
      const rx = tz,
        rz = -tx,
        ux = fy * rz,
        uy = fz * rx - fx * rz,
        uz = -fy * rx;
      const by =
        ground(x, z) + w.stand + abs(sin(w.phase)) * 0.1 * w.gait * size;
      put(w.body, x, by, z, size);
      frame(data, w.body + 4, rx, 0, rz, ux, uy, uz, fx, fy, fz);
      // legs: each swings about its hip in the body's upright plane, more the faster it goes
      const swing = min(w.v / W.amble, 1) * (0.32 + 0.3 * w.gait);
      for (let j = 0; j < 4; j++) {
        const h = HIPS[j],
          o = w.legs + j * 12,
          angle =
            sin(w.phase + STEP[j] + (BOUND[j] - STEP[j]) * w.gait) * swing,
          c = cos(angle),
          s = sin(angle);
        const dx = fx * s - ux * c,
          dy = fy * s - uy * c,
          dz = fz * s - uz * c;
        put(
          o,
          x + (rx * h[0] + ux * h[1] + fx * h[2]) * size,
          by + (uy * h[1] + fy * h[2]) * size,
          z + (rz * h[0] + uz * h[1] + fz * h[2]) * size,
          w.leg,
        );
        frame(
          data,
          o + 4,
          rx,
          0,
          rz,
          dy * rz,
          dz * rx - dx * rz,
          -dy * rx,
          dx,
          dy,
          dz,
        ); // its up = its direction x r
      }
      // neck and head: pitched over the back, and turned to the user while it watches (1.2 rad at most)
      const pitchTo = w.run
        ? 0.35
        : alert
          ? 0.85
          : w.v > 0.15
            ? W.carry
            : W.idle[w.up ? 0 : 1];
      const yawTo = alert
        ? clamp(
            atan2(
              (camX - x) * rx + (camZ - z) * rz,
              (camX - x) * fx + (camZ - z) * fz,
            ),
            -1.2,
            1.2,
          )
        : 0;
      const ease = 1 - exp(-dt * (alert ? 5 : 2.2));
      w.pitch += (pitchTo - w.pitch) * ease;
      w.yaw += (yawTo - w.yaw) * ease;
      const pitch = w.pitch + sin(w.phase * 2) * 0.04 * min(w.v, 1),
        cp = cos(pitch),
        sp = sin(pitch),
        cw = cos(w.yaw),
        sw = sin(w.yaw);
      const hx = (fx * cw + rx * sw) * cp + ux * sp,
        hy = fy * cw * cp + uy * sp,
        hz = (fz * cw + rz * sw) * cp + uz * sp;
      let ax = uy * hz - uz * hy,
        ay = uz * hx - ux * hz,
        az = ux * hy - uy * hx;
      const al = hypot(ax, ay, az) || 1;
      ax /= al;
      ay /= al;
      az /= al; // its right = u x its direction
      put(
        w.headAt,
        x + (ux * 0.1 + fx * 0.5) * size,
        by + (uy * 0.1 + fy * 0.5) * size,
        z + (uz * 0.1 + fz * 0.5) * size,
        w.head,
      );
      frame(
        data,
        w.headAt + 4,
        ax,
        ay,
        az,
        hy * az - hz * ay,
        hz * ax - hx * az,
        hx * ay - hy * ax,
        hx,
        hy,
        hz,
      );
      if (w.tailAt < 0) continue;
      // the fox's brush: out behind and a little down, swaying with the trot
      const sway = 0.2 * sin(t * 2.1) + 0.15 * sin(w.phase),
        drop = -0.3 + 0.12 * sin(w.phase * 2);
      let qx = -fx + ux * drop + rx * sway,
        qy = -fy + uy * drop,
        qz = -fz + uz * drop + rz * sway;
      const ql = hypot(qx, qy, qz);
      qx /= ql;
      qy /= ql;
      qz /= ql;
      let bx = uy * qz - uz * qy,
        bz = ux * qy - uy * qx,
        bY = uz * qx - ux * qz;
      const bl = hypot(bx, bY, bz) || 1;
      bx /= bl;
      bY /= bl;
      bz /= bl;
      put(
        w.tailAt,
        x + (ux * 0.05 - fx * 0.56) * size,
        by + (uy * 0.05 - fy * 0.56) * size,
        z + (uz * 0.05 - fz * 0.56) * size,
        w.tail,
      );
      frame(
        data,
        w.tailAt + 4,
        bx,
        bY,
        bz,
        qy * bz - qz * bY,
        qz * bx - qx * bz,
        qx * bY - qy * bx,
        qx,
        qy,
        qz,
      );
    }
    // squirrels: bursts up or down the trunk in a spiral, with pauses; flat on the bark, their up pointing out of it
    for (let i = 0; i < squirrels.length; i++) {
      const q = squirrels[i],
        tree = q.tree,
        o = (gSquirrel.first + i) * 12,
        rad = tree.r + 0.04,
        climb = 1.5;
      if ((q.timer -= dt) <= 0) {
        q.go = !q.go;
        q.timer = q.go ? rr(0.5, 2.2) : rr(0.7, 4);
        if (q.go) {
          if (rnd() < 0.3) q.up = -q.up;
          q.spin = rr(0.5, 1.6) * (rnd() < 0.5 ? -1 : 1);
        }
      }
      if (q.go) {
        q.h += q.up * climb * dt;
        q.a += q.spin * dt;
        if (q.h > q.top) {
          q.h = q.top;
          q.up = -1;
        } else if (q.h < 0.6) {
          q.h = 0.6;
          q.up = 1;
        }
        const round = rad * q.spin,
          speed = hypot(round, climb);
        q.ft = round / speed;
        q.fy = (q.up * climb) / speed;
      }
      const ca = cos(q.a),
        sa = sin(q.a),
        fx = -sa * q.ft,
        fz = ca * q.ft;
      put(o, tree.x + ca * rad, tree.y + q.h, tree.z + sa * rad, 0.25);
      frame(data, o + 4, -sa * q.fy, -q.ft, ca * q.fy, ca, 0, sa, fx, q.fy, fz); // right = out x forward
    }
    // owls: a slow breath; the head eases round to the user and looks down at them
    for (let i = 0; i < owls.length; i++) {
      const w = owls[i],
        ob = (gOwl.first + i) * 12,
        oh = (gOwlHead.first + i) * 12,
        breath = sin(t * 1.3 + i * 2);
      const dx = camX - w.x,
        dz = camZ - w.z,
        dl = hypot(dx, dz) || 1,
        hy = w.y + 0.44 * w.size;
      let turn = atan2(dx, dz) - w.look;
      turn -= TAU * floor(turn / TAU + 0.5); // the short way round
      w.look += turn * (1 - exp(-dt * 2.5));
      const down = clamp((ground(camX, camZ) + 1.6 - hy) / dl, -0.7, 0.2),
        c = 1 / hypot(1, down);
      put(ob, w.x, w.y, w.z, w.size * (1 + 0.015 * breath));
      put(oh, w.x, hy + 0.006 * breath, w.z, w.size);
      aim(
        data,
        oh + 4,
        sin(w.look) * c,
        down * c,
        cos(w.look) * c,
        0.06 * sin(t * 0.4 + i),
      );
    }
    // ducks: round and round, bobbing on the water (y 0)
    for (let i = 0; i < ducks.length; i++) {
      const d = ducks[i],
        o = (gDuck.first + i) * 12;
      d.a += ((d.way * d.v) / d.r) * dt * (0.75 + 0.25 * sin(t * 0.13 + i * 2));
      const ca = cos(d.a),
        sa = sin(d.a),
        tx = -sa * d.way,
        tz = ca * 0.8 * d.way,
        tl = hypot(tx, tz);
      put(
        o,
        d.x + ca * d.r,
        0.005 + 0.012 * sin(t * 1.7 + i * 1.3),
        d.z + sa * d.r * 0.8,
        d.size,
      );
      aim(data, o + 4, tx / tl, 0, tz / tl, 0.05 * sin(t * 1.1 + i));
    }
  }
  update(0, 1e9, 1e9);
  return { data, groups: all.filter((g) => g.count), update };
}
