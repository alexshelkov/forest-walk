// ============================================================================
// black-tailed deer: a few at rest in the deep woods and at the meadow's edge, and now and then one (or two)
// crossing a narrow path ahead of the walker in a leap
// ============================================================================
// Each deer is 18 rigid parts (body, neck, head, two ears, tail, three lengths to each leg), drawn as instances of
// the solid pipeline with material 6 and a species of 8 and over (the coat: DEER_WGSL, in W_SOLID). Feet that are
// down keep their place in the world; the joints between come from two-bone IK. scene.js uploads `data` and
// `blots` each frame and draws `groups`; update(dt, walker, weather) moves them all. (It imports nothing of the
// world: shaders.js takes DEER_WGSL from it, and world.js leads back to shaders.js)
import {
  abs,
  atan2,
  clamp,
  cos,
  exp,
  floor,
  hypot,
  lakeD,
  max,
  Mesh,
  min,
  OPEN,
  PI,
  sin,
  sqrt,
  TAU,
} from './math.js';

// ---------------------------------------------------------------- the coat (W_SOLID's animal branch calls it)
// part: 0 body, 1 neck, 2 head, 3 ear, 4 tail, 5-7 a fore leg's upper, middle and lower length, 8-10 a hind leg's;
// q: the place on the part
// at size 1; n: its normal there; ax: aux (1 coat, .5 dark, 0 hoof or antler, below 0 an eye); hv: the deer's own
// tint; dt: the detail texture's tone. Returns the albedo and the gloss
export const DEER_WGSL = /*wgsl*/ `
fn deerCoat(part: i32, q: vec3f, n: vec3f, ax: f32, hv: f32, dt: f32) -> vec4f {
  // grey-brown, darkest along the back (a shade darker than the forest floor), paler down the flanks to a pale
  // belly (a shade paler than it); the parts are built with their back up, all but the legs
  let back = mix(vec3f(.13, .12, .11), vec3f(.155, .14, .125), hv);
  let pale = vec3f(.52, .48, .42); let white = vec3f(.80, .78, .74); let black = vec3f(.03, .027, .025);
  let up = f32(part < 5);
  var c = mix(back * 1.25, back * .75, ss(.4, .92, n.y) * up);
  c = mix(c, pale, ss(-.2, -.75, n.y) * up);
  if (part == 0) {
    // a white patch round the tail's root, down to the thighs
    let rump = ss(-.4, -.47, q.z) * ss(.14, .1, abs(q.x)) * ss(-.15, -.09, q.y) * ss(.2, .14, q.y);
    c = mix(c, white, rump);
  } else if (part == 1) {
    // a pale throat under the jaw
    c = mix(c, white * .92, ss(-.2, -.7, n.y) * ss(.14, .26, q.z));
  } else if (part == 2) {
    // a dark forehead; a pale band behind the black nose; a pale chin; black eyes; a buck's antlers
    c = mix(c, back * .55, ss(.3, .75, n.y) * ss(-.03, .03, q.z) * ss(.2, .12, q.z));
    c = mix(c, white * .92, ss(.225, .245, q.z) * ss(.285, .27, q.z));
    c = mix(c, white * .9, ss(-.35, -.75, n.y) * ss(.14, .23, q.z));
    c = mix(c, black, ss(.75, .55, ax) * ss(.25, .45, ax));
    c = mix(c, vec3f(.48, .40, .30), ss(.3, .05, ax));
  } else if (part == 3) {
    // an ear: pale inside, a dark rim at its tip
    c = mix(back * 1.1, vec3f(.66, .61, .55), ss(-.1, .5, n.y));
    c = mix(c, black, ss(.75, .55, ax) * ss(.25, .45, ax));
  } else if (part == 4) {
    // the tail: black on top, white beneath and at its edges
    c = mix(white, black, ss(-.15, .35, n.y) * ss(.05, .028, abs(q.x)));
  } else {
    // the legs (5-7 a fore leg's three lengths, 8-10 a hind leg's): paler behind and down to the dark hooves; the
    // back of a thigh white, under the rump
    let low = f32(part == 7 || part == 10);
    c = back * 1.15;
    c = mix(c, vec3f(.44, .38, .31), low * .7 + f32(part == 6 || part == 9) * .3);
    c = mix(c, pale * .9, ss(-.2, -.7, n.y) * .6);
    c = mix(c, white * .95, f32(part == 8) * ss(-.1, -.6, n.y));
    c = mix(c, vec3f(.05, .04, .035), ss(.3, .05, ax));
  }
  // (fur: matte, with a fine grain of its own)
  return vec4f(c * (.78 + .38 * dt), .0);
}
`;

// ---------------------------------------------------------------- meshes (metres at size 1, nose at +z, up +y)
const COAT = 1,
  DARK = 0.5,
  HORN = 0,
  EYE = -1;
// a round limb through [x, y, z, radius, aux?] points, closed at its far end, squeezed sideways to `flat`
const limb = (m, pts, sides, flat = 1, squash = 1) => {
  const first = m.p.length / 3;
  m.tube(
    pts,
    (k) => pts[k][3],
    sides,
    true,
    (k) => pts[k][4] ?? COAT,
  );
  for (let k = first * 3; k < m.p.length; k += 3) {
    m.p[k] *= flat;
    m.p[k + 1] = pts[0][1] + (m.p[k + 1] - pts[0][1]) * squash;
  }
};
// an eye: an octahedron
const gem = (m, c, r) => {
  const b = m.p.length / 3;
  for (const d of [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ])
    m.v(c[0] + d[0] * r, c[1] + d[1] * r, c[2] + d[2] * r, EYE);
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
    m.tri(b + f[0], b + f[1], b + f[2]);
};
// A loft through [z, top, bottom, half width] rings along z (y up from the origin), each an ellipse of `sides`
// points; both ends closed
const loft = (m, rings, sides, aux = COAT) => {
  const rows = rings.map(([z, top, bot, w]) =>
    Array.from({ length: sides }, (_, k) => {
      const a = (k / sides) * TAU;
      return m.v(
        w * cos(a),
        (top + bot) / 2 + ((top - bot) / 2) * sin(a),
        z,
        aux,
      );
    }),
  );
  for (let r = 0; r < rows.length - 1; r++)
    for (let k = 0; k < sides; k++) {
      const k2 = (k + 1) % sides;
      m.quad(rows[r][k], rows[r + 1][k], rows[r + 1][k2], rows[r][k2]);
    }
  for (const [r, flip] of [
    [0, true],
    [rows.length - 1, false],
  ]) {
    const [z, top, bot] = rings[r],
      c = m.v(0, (top + bot) / 2, z, aux);
    for (let k = 0; k < sides; k++) {
      const a = rows[r][k],
        b = rows[r][(k + 1) % sides];
      if (flip) m.tri(a, c, b);
      else m.tri(a, b, c);
    }
  }
};
// The body (size 1: 0.9 m at the withers), its origin 0.69 m over the ground, chest at +z. To the withers' height:
// 1.3 long as the doe in refs6/deer01; 0.45 deep behind the forelegs (the leg below, 0.55) as the standing doe in
// refs6/deer08; 0.39 at the loin (0.86 of the chest, as in refs6/deer03). Each section is as wide for its depth as
// before (KC, KL): the withers over the back, a barrel deeper than wide, round haunches (the widest from behind)
function meshBody() {
  const m = new Mesh();
  loft(
    m,
    [
      [0.58, 0.1, -0.113, 0.053],
      [0.5, 0.17, -0.158, 0.091],
      [0.38, 0.215, -0.177, 0.114],
      [0.22, 0.2, -0.192, 0.126],
      [0.05, 0.18, -0.189, 0.131],
      [-0.12, 0.175, -0.178, 0.124],
      [-0.26, 0.185, -0.168, 0.128],
      [-0.38, 0.195, -0.15, 0.136],
      [-0.5, 0.18, -0.099, 0.116],
      [-0.575, 0.14, -0.023, 0.07],
      [-0.6, 0.09, 0.02, 0.027],
    ],
    12,
  );
  return m;
}
// the neck from its root in the chest along +z to the poll (0.38 m): thick where it grows out of the shoulders (its
// part inside the chest as deep as the chest's section, KC)
function meshNeck() {
  const m = new Mesh();
  loft(
    m,
    [
      [-0.14, 0.16, 0.16 - 0.33 * KC, 0.12 * KC],
      [0, 0.13, -0.13, 0.1],
      [0.14, 0.1, -0.1, 0.085],
      [0.27, 0.085, -0.085, 0.07],
      [0.38, 0.068, -0.06, 0.055],
    ],
    10,
  );
  return m;
}
// The head from the poll along +z (0.34 m, 0.38 of the withers' height as in refs6/deer01): a broad forehead between the ears, a wedge down to the black nose;
// large dark eyes on its sides; a buck's small forked antlers
function meshHead(antlers) {
  const m = new Mesh();
  loft(
    m,
    [
      [-0.04, 0.06, -0.05, 0.05],
      [0.02, 0.07, -0.078, 0.07],
      [0.09, 0.06, -0.085, 0.064],
      [0.165, 0.035, -0.085, 0.05],
      [0.235, 0.01, -0.085, 0.038],
      [0.285, -0.01, -0.082, 0.031],
    ],
    10,
  );
  // (the nose, black)
  loft(
    m,
    [
      [0.28, -0.008, -0.08, 0.031],
      [0.315, -0.02, -0.074, 0.027],
      [0.335, -0.035, -0.065, 0.016],
    ],
    8,
    DARK,
  );
  for (const s of [-1, 1]) {
    gem(m, [s * 0.058, 0.022, 0.08], 0.019);
    if (!antlers) continue;
    const beam = (pts, r) =>
      m.tube(
        pts,
        (k) => r * (1 - (0.6 * k) / (pts.length - 1)),
        4,
        true,
        () => HORN,
      );
    beam(
      [
        [s * 0.03, 0.06, 0.0],
        [s * 0.08, 0.16, -0.02],
        [s * 0.11, 0.26, 0.03],
        [s * 0.1, 0.33, 0.1],
      ],
      0.016,
    );
    beam(
      [
        [s * 0.11, 0.26, 0.03],
        [s * 0.16, 0.34, 0.02],
      ],
      0.01,
    );
  }
  return m;
}
// An ear: a broad blade along +z from its root (0.19 m long, 0.1 across), cupped toward +y (its opening), the rim
// dark round its tip
function meshEar() {
  const m = new Mesh(),
    rows = [
      [0, 0.022],
      [0.04, 0.047],
      [0.095, 0.052],
      [0.15, 0.038],
      [0.175, 0.02],
      [0.19, 0.003],
    ].map(([z, w], k, all) => {
      const cup = -0.028 * sin((PI * z) / 0.19),
        rim = k >= all.length - 3 ? DARK : COAT;
      return [
        m.v(-w, 0, z, rim),
        m.v(-w * 0.5, cup * 0.8, z, COAT),
        m.v(0, cup, z, COAT),
        m.v(w * 0.5, cup * 0.8, z, COAT),
        m.v(w, 0, z, rim),
      ];
    });
  for (let k = 0; k < rows.length - 1; k++)
    for (let c = 0; c < 4; c++)
      m.quad(rows[k][c], rows[k][c + 1], rows[k + 1][c + 1], rows[k + 1][c]);
  return m;
}
// the tail, from its root along +z (0.2 m): broad and flat, black on its top face (+y), white beneath and at its edges
function meshTail() {
  const m = new Mesh();
  loft(
    m,
    [
      [-0.02, 0.018, -0.018, 0.035],
      [0.05, 0.022, -0.022, 0.055],
      [0.13, 0.02, -0.02, 0.055],
      [0.2, 0.008, -0.008, 0.015],
    ],
    6,
  );
  return m;
}
// A length of leg from its upper joint along +z through [z, radius] rings (radius .5 below: what aux to give it)
const segment = (rings, flat = 1) => {
  const m = new Mesh();
  limb(
    m,
    rings.map(([z, r, aux]) => [0, 0, z, r, aux]),
    5,
    flat,
  );
  return m;
};
// where the legs hinge on the body (x across, y up, z forward): left fore, right fore, left hind, right hind;
// where a foot stands under it at rest (the body's corners, the near and far legs a little apart); the upper
// lengths' angles under the body (fore: back to the elbow; hind: forward to the stifle); the neck's and the
// tail's roots; the ears' on the head. (Each where deer01's was in the body's section)
const HIPS = [
    [-0.057, 0.025, 0.36],
    [0.057, 0.025, 0.36],
    [-0.066, 0.067, -0.36],
    [0.066, 0.067, -0.36],
  ],
  REST = [
    [-0.057, 0.3],
    [0.057, 0.26],
    [-0.066, -0.473],
    [0.066, -0.513],
  ],
  UPPER = [-2.013, -1.254],
  NECK = [0, 0.071, 0.5],
  TAIL = [0, 0.122, -0.58],
  EARS = [
    [-0.042, 0.06, -0.005],
    [0.042, 0.06, -0.005],
  ],
  STAND = 0.69, // the body's origin over the ground
  NECK_L = 0.38;
// how much the chest's and the loin's sections shrank from deer01's (across too: the legs' spread and thickness)
const KC = 0.762,
  KL = 0.776;
// The legs' lengths (size 1): fore upper arm, forearm, cannon to hoof; hind thigh, gaskin, cannon to hoof. The
// foreleg below the chest 0.55 of the withers' height: forearm and cannon (as 0.2 to 0.24) a column from the
// elbow to the foot at rest, straight but for 4 degrees at the knee. The hind's gaskin at its old slant and its
// cannon upright, both as much longer as the stifle is higher
const FORE = (() => {
    const up = 0.187,
      ey = HIPS[0][1] + up * sin(UPPER[0]),
      ez = HIPS[0][2] + up * cos(UPPER[0]),
      d = hypot(STAND + ey, REST[0][1] - ez),
      r = 0.2 / 0.44,
      t = (4 * PI) / 180,
      T = d / sqrt(r * r + (1 - r) * (1 - r) + 2 * r * (1 - r) * cos(t));
    return [up, r * T, (1 - r) * T];
  })(),
  HIND = [0.257, 0.264, 0.352];
// how far the two lower lengths of a leg reach at most (2 degrees short of straight), and how far its upper length
// may turn from UPPER to bring them to a foot
const MAXR = [FORE, FORE, HIND, HIND].map(([, a, b]) =>
    sqrt(a * a + b * b + 2 * a * b * cos(0.035)),
  ),
  SWING = 0.7;

// ---------------------------------------------------------------- small helpers
// the quaternion of the frame with right r, up u, forward f (r x u = f)
const quat = (out, o, r, u, f) => {
  const tr = r[0] + u[1] + f[2];
  let x, y, z, w;
  if (tr > 0) {
    const s = sqrt(tr + 1) * 2;
    w = s / 4;
    x = (u[2] - f[1]) / s;
    y = (f[0] - r[2]) / s;
    z = (r[1] - u[0]) / s;
  } else if (r[0] > u[1] && r[0] > f[2]) {
    const s = sqrt(max(1 + r[0] - u[1] - f[2], 1e-9)) * 2;
    w = (u[2] - f[1]) / s;
    x = s / 4;
    y = (u[0] + r[1]) / s;
    z = (f[0] + r[2]) / s;
  } else if (u[1] > f[2]) {
    const s = sqrt(max(1 + u[1] - r[0] - f[2], 1e-9)) * 2;
    w = (f[0] - r[2]) / s;
    x = (u[0] + r[1]) / s;
    y = s / 4;
    z = (f[1] + u[2]) / s;
  } else {
    const s = sqrt(max(1 + f[2] - r[0] - u[1], 1e-9)) * 2;
    w = (r[1] - u[0]) / s;
    x = (f[0] + r[2]) / s;
    y = (f[1] + u[2]) / s;
    z = s / 4;
  }
  const l = hypot(x, y, z, w) || 1;
  out[o] = x / l;
  out[o + 1] = y / l;
  out[o + 2] = z / l;
  out[o + 3] = w / l;
};
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit = (a) => {
  const l = hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
// the frame whose forward is f and whose right is as near r as f allows
const along = (f, r) => {
  const u = unit(cross(f, r));
  return [unit(cross(u, f)), u, f];
};
const smooth = (s) => s * s * (3 - 2 * s);
// a wait of `mean` seconds, never twice the same: spread round it, a third to three times it
const gauss = () => {
  let s = 0;
  for (let k = 0; k < 4; k++) s += Math.random();
  return (s - 2) * 1.7;
};
const wait = (mean) => clamp(mean * exp(0.6 * gauss()), mean / 3, mean * 3);
// eased toward a goal at `rate` per second
const ease = (v, to, rate, dt) => v + (to - v) * (1 - exp(-rate * dt));

// ---------------------------------------------------------------- gaits
// each leg's place in the stride (left fore, right fore, left hind, right hind) and its share of it on the ground:
// a walk in four beats with two or three feet always down; a bound, the hind pair then the fore pair, then all off
// (lift: a foot's height in its swing, as long as the leg below the body)
const GAITS = {
  walk: { off: [0.25, 0.75, 0, 0.5], down: 0.62, lift: 0.088, swing: 0.17 },
  bound: { off: [0.45, 0.55, 0, 0.1], down: 0.28, lift: 0.2, swing: 0.5 },
};
const BOUND_AT = 2.4; // m/s: faster than this it bounds
// how far a deer notices the walker (alert), moves off, and bolts (as 7 to 12 before: a walker passing on the path
// by a deer at rest gets its head up, not its back)
const NOTICE = 25,
  MOVE_OFF = 8,
  BOLT = 4.7;
// the crossing: the odds each time the walker comes up to a stretch where it may happen; never sooner than GAP s
// after the last, never in the first half minute
const CHANCE = 0.8,
  GAP = 120,
  FIRST = 30;

// add, ground, avoid, hidden, fogT: see the call in scene.js. paths: the loop's and the side paths' points, as
// trailK counts them; trailD, trailHalf, trailK, creekAt: world.js's and water.js's; woodwork: x, z of every built
// thing (bridges, the boardwalk, fences, signs); canopy(x, z): how closed the crowns over a place are (1: closed)
export function makeDeer({
  add,
  ground,
  avoid,
  hidden,
  fogT,
  paths,
  woodwork,
  canopy,
  trailD,
  trailHalf,
  trailK,
  creekAt,
}) {
  const M = add(
    meshBody(),
    meshNeck(),
    meshHead(false),
    meshHead(true),
    meshEar(),
    meshTail(),
    // (the upper lengths, inside the body, shrink with its section; the lower ones only across)
    segment(
      [
        [-0.04, 0.085 * KC],
        [FORE[0] * 0.6, 0.075 * KC],
        [FORE[0], 0.06 * KC],
      ],
      KC,
    ),
    segment(
      [
        [-0.03, 0.062],
        [0.05, 0.055],
        [FORE[1] * 0.75, 0.034],
        [FORE[1], 0.031],
      ],
      KC,
    ),
    segment(
      [
        [-0.02, 0.034],
        [0.04, 0.023],
        [FORE[2] * 0.72, 0.021],
        [FORE[2] * 0.8, 0.025],
        [FORE[2] * 0.9, 0.02, 0],
        [FORE[2], 0.016, 0],
      ],
      KC,
    ),
    segment(
      [
        [-0.06, 0.12 * KL],
        [HIND[0] * 0.6, 0.105 * KL],
        [HIND[0], 0.08 * KL],
      ],
      0.75 * KL,
    ),
    segment(
      [
        [-0.04, 0.08],
        [0.05, 0.065],
        [HIND[1] * 0.8, 0.036],
        [HIND[1], 0.034],
      ],
      KL,
    ),
    segment(
      [
        [-0.03, 0.037],
        [0.05, 0.024],
        [HIND[2] * 0.74, 0.021],
        [HIND[2] * 0.82, 0.025],
        [HIND[2] * 0.91, 0.02, 0],
        [HIND[2], 0.016, 0],
      ],
      KL,
    ),
  );
  // draw groups: mesh, parts of it to a deer, species (8 + part, deer.js DEER_WGSL)
  const KINDS = [
    [0, 1, 8],
    [1, 1, 9],
    [2, 1, 10],
    [3, 1, 10],
    [4, 2, 11],
    [5, 1, 12],
    [6, 2, 13],
    [7, 2, 14],
    [8, 2, 15],
    [9, 2, 13],
    [10, 2, 14],
    [11, 2, 15],
  ];
  const MAXN = 5; // three at rest and two crossing
  let first = 0;
  const groups = KINDS.map(([k, per]) => {
    const g = { mesh: M + k, first, count: 0, per };
    first += per * MAXN;
    return g;
  });
  const data = new Float32Array(first * 12),
    blots = new Float32Array(MAXN * 3 * 8);
  const tris = (m) => m.ib.length / 3;

  // ---------------------------------------------------------------- where they live and where they cross
  const nearWood = (x, z, d) =>
    woodwork.some(
      (w) =>
        abs(w[0] - x) < d && abs(w[1] - z) < d && hypot(w[0] - x, w[1] - z) < d,
    );
  const openNear = (x, z, d) =>
    OPEN.some((o) => hypot(x - o[0], z - o[1]) < o[2] + d);
  const wet = (x, z, d) => creekAt(x, z)[0] < d || lakeD(x, z) < d;
  // A place a deer may rest, facing yaw: dry, clear of trunks, the ground under its four hooves within TILT of
  // level (12 cm; walking and bounding it crosses anything)
  const TILT = 0.12;
  const unevenAt = (x, z, yaw) => {
    let lo = 1e9,
      hi = -1e9;
    for (const [rx, rz] of REST) {
      const g = ground(
        x + sin(yaw) * rz + cos(yaw) * rx,
        z + cos(yaw) * rz - sin(yaw) * rx,
      );
      lo = min(lo, g);
      hi = max(hi, g);
    }
    return hi - lo;
  };
  const standable = (x, z, yaw = 0) => {
    if (wet(x, z, 1.2) || unevenAt(x, z, yaw) > TILT) return false;
    const [ax, az] = avoid(x, z, 0.5);
    return hypot(ax - x, az - z) < 0.01;
  };
  // The stretches where a deer may cross: narrow path (a side path, or the narrower half of the loop) deep in the
  // woods: no opening, water or anything built within 20 m (25 leaves two such places in this small world) under
  // closed crowns (six of eight lines of sight up veiled), 6 m long at the least; and with a way across at its middle
  // from one side or both (checked at `routes`)
  const stretches = [];
  {
    const halves = paths[0].map((_, k) => trailHalf(k)).sort((a, b) => a - b),
      narrow = halves[floor(halves.length * 0.5)];
    let k0 = 0;
    paths.forEach((pts, b) => {
      const ok = pts.map(([x, z], j) => {
        const half = trailHalf(k0 + j);
        return (
          (b > 0 || half <= narrow) &&
          !openNear(x, z, 20) &&
          !wet(x, z, 20) &&
          !nearWood(x, z, 20) &&
          canopy(x, z) >= 0.75
        );
      });
      k0 += pts.length;
      let run = -1;
      for (let j = 0; j <= pts.length; j++) {
        if (j < pts.length && ok[j]) {
          if (run < 0) run = j;
          continue;
        }
        if (run >= 0 && j - run >= 6)
          stretches.push({ path: b, from: run, to: j - 1 });
        run = -1;
      }
    });
  }
  // the path's points by global index (as trailK counts them: the loop's, then each side path's in turn)
  // (onStretch: which stretch a point is on, 0 none: marked once the stretches are checked, at `routes`)
  const flat = paths.flat(),
    onStretch = new Uint8Array(flat.length),
    base = [];
  {
    let k0 = 0;
    for (const p of paths) {
      base.push(k0);
      k0 += p.length;
    }
    for (const s of stretches) s.base = base[s.path];
  }

  // Homes, one for each deer at rest, where a walker on a path meets them: 10 to 18 m from the nearest path, dry,
  // level enough, clear of anything built, and seen from the path: from its points within 35 m, at the walker's
  // eye, a clear line to the deer that goes on clear 5 m past it (no trunk right behind it), from points 10 m apart
  // along it at least (the walker meets it, not a glimpse). The first at the meadow's edge (within 4 m of it, in or
  // out) and within 13 m of the path, the others 12 m from the rest at least; each the one seen best (its size on
  // screen summed over the points it is seen from), facing across the line it is seen nearest along
  const homes = [],
    homesFrom = performance.now();
  {
    const EYE = 1.65,
      halves = paths[0].map((_, k) => trailHalf(k)).sort((a, b) => a - b),
      narrow = halves[floor(halves.length * 0.5)],
      look = flat.filter((_, k) => k % 3 === 0),
      [cx, cz, cr] = OPEN[0],
      found = [];
    for (let x = -150; x <= 150; x += 2.5)
      for (let z = -150; z <= 150; z += 2.5) {
        const pd = trailD(x, z);
        if (pd < 10 || pd > 18 || wet(x, z, 3) || nearWood(x, z, 12)) continue;
        const gy = ground(x, z) + 0.7;
        let seen = 0,
          near = null;
        const from = [];
        for (const [px, pz] of look) {
          const dist = hypot(px - x, pz - z);
          if (dist > 35) continue;
          const ey = ground(px, pz) + EYE,
            fx = x + ((x - px) / dist) * 5,
            fz = z + ((z - pz) / dist) * 5;
          if (
            hidden(px, ey, pz, x, gy, z) ||
            hidden(px, ey, pz, fx, gy + ((gy - ey) / dist) * 5, fz)
          )
            continue;
          seen += 1 / dist;
          from.push([px, pz, +dist.toFixed(1)]);
          if (!near || dist < near[2]) near = [px, pz, dist];
        }
        if (!near) continue;
        const across = atan2(x - near[0], z - near[1]) + PI / 2,
          yaw = [across, across + PI].find((a) => standable(x, z, a));
        if (yaw === undefined) continue;
        const k = trailK(x, z),
          b = base.findLastIndex((b0) => k >= b0),
          edge = abs(hypot(x - cx, z - cz) - cr) <= 4,
          quiet = b > 0 || trailHalf(k) <= narrow;
        if (edge || quiet)
          found.push({ x, z, yaw, edge, seen, pathD: pd, view: near, from });
      }
    const met = found.filter((h) =>
      h.from.some((p) =>
        h.from.some((q) => hypot(p[0] - q[0], p[1] - q[1]) >= 10),
      ),
    );
    met.sort((a, b) => b.seen - a.seen);
    // (and the third not in a row with the first two: 6 m off the line through them at least)
    const apart = (h) =>
      homes.every((o) => hypot(o.x - h.x, o.z - h.z) >= 12) &&
      (homes.length < 2 ||
        abs(
          (homes[1].x - homes[0].x) * (h.z - homes[0].z) -
            (homes[1].z - homes[0].z) * (h.x - homes[0].x),
        ) /
          hypot(homes[1].x - homes[0].x, homes[1].z - homes[0].z) >=
          6);
    const edge =
      met.find((h) => h.edge && h.pathD <= 13) ||
      met.find((h) => h.pathD <= 13);
    if (edge) homes.push(edge);
    for (const h of met) if (homes.length < 3 && apart(h)) homes.push(h);
  }
  const homesMs = performance.now() - homesFrom;

  // ---------------------------------------------------------------- the deer
  const make = (size, buck, hue) => ({
    size,
    buck,
    hue,
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    pitch: 0,
    v: 0,
    phase: 0,
    feet: [0, 1, 2, 3].map(() => ({
      p: [0, 0, 0],
      from: [0, 0, 0],
      to: [0, 0, 0],
      down: true,
    })),
    neck: 0.8,
    head: -0.35,
    look: 0,
    ears: [0, 0],
    earKick: [0, 0],
    tail: -1.2,
    lift: 0,
    awake: false,
    on: false,
    held: null,
    state: 'graze',
    until: 0,
    goal: null,
    clock: 0,
    leap: null,
    run: null,
    hoof: [0, 0, 0, 0], // each hoof's height over the ground, last posed (debug)
    bend: [0, 0, 0, 0], // and each leg's bend at knee or hock, degrees
  });
  const herd = [
      make(1, false, 0.3),
      make(0.94, false, 0.7),
      make(1.08, true, 0.5),
    ],
    runners = [make(1.02, false, 0.45), make(0.96, false, 0.8)];
  herd.forEach((d, i) => (d.home = homes[i]));
  let count = 3,
    clock = 0,
    lastCross = -1e9;

  // the body's frame: right, up, forward (yaw from +z toward +x, pitch nose up)
  const bodyFrame = (d) => {
    const cp = cos(d.pitch),
      F = [sin(d.yaw) * cp, sin(d.pitch), cos(d.yaw) * cp],
      R = [cos(d.yaw), 0, -sin(d.yaw)];
    return [R, cross(F, R), F];
  };
  const at = (d, B, q) => {
    const s = d.size;
    return [
      d.x + (B[0][0] * q[0] + B[1][0] * q[1] + B[2][0] * q[2]) * s,
      d.y + (B[0][1] * q[0] + B[1][1] * q[1] + B[2][1] * q[2]) * s,
      d.z + (B[0][2] * q[0] + B[1][2] * q[1] + B[2][2] * q[2]) * s,
    ];
  };
  // The angle of leg k's upper length from its hip, turned from `a` as far as the two lower lengths need to reach
  // the foot from its end (m: as far as they reach; exact: to stand that far from it, no nearer), at most SWING from
  // UPPER
  const upperAngle = (B, hip, foot, k, a, s, m, exact) => {
    const l = (k < 2 ? FORE : HIND)[0] * s,
      v = [foot[0] - hip[0], foot[1] - hip[1], foot[2] - hip[2]],
      fz = v[0] * B[2][0] + v[1] * B[2][1] + v[2] * B[2][2],
      fy = v[0] * B[1][0] + v[1] * B[1][1] + v[2] * B[1][2],
      q =
        (v[0] * v[0] + v[1] * v[1] + v[2] * v[2] + l * l - m * m) /
        (2 * l * hypot(fz, fy)),
      e = ((((a - atan2(fy, fz) + PI) % TAU) + TAU) % TAU) - PI;
    if (!exact && cos(e) >= q) return a;
    const rest = UPPER[k < 2 ? 0 : 1],
      to = q >= 1 ? 0 : (e < 0 ? -1 : 1) * (q <= -1 ? PI : Math.acos(q));
    return clamp(a + to - e, rest - SWING, rest + SWING);
  };
  // A leg's upper joint end (R: elbow or stifle) for a body frame B at height y = 0 over its origin
  const upperEnd = (d, B, k) => {
    const len = k < 2 ? FORE : HIND,
      a0 = UPPER[k < 2 ? 0 : 1],
      y0 = d.y;
    d.y = 0;
    const hip = at(d, B, HIPS[k]);
    d.y = y0;
    return [0, 1, 2].map(
      (c) => hip[c] + (B[2][c] * cos(a0) + B[1][c] * sin(a0)) * len[0] * d.size,
    );
  };
  // each leg's standing reach (size 1): from its upper joint's end to its hoof as the rig stands on level ground
  // (a foreleg straight but for 4 degrees at the knee; a hind leg with its cannon upright under the hock)
  const REACH = [0, 1, 2, 3].map((k) => {
    const R = upperEnd(
      { x: 0, y: 0, z: 0, size: 1 },
      [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      k,
    );
    return hypot(R[0] - REST[k][0], R[1] + STAND, R[2] - REST[k][1]);
  });
  // Stands a deer at x, z facing yaw, its feet down where they rest. The body takes 60% of the ground's slope
  // from its hind hooves to its fore hooves, 8 degrees at most, and is carried as high as its legs allow: the
  // leg that needs it lowest stands at its full standing reach (REACH), the others bend at knee or hock by what
  // the ground asks
  const place = (d, x, z, yaw) => {
    d.x = x;
    d.z = z;
    d.yaw = yaw;
    d.pitch = 0;
    d.v = 0;
    d.y = ground(x, z) + STAND * d.size;
    const B0 = bodyFrame(d);
    d.feet.forEach((f, k) => {
      const p = at(d, B0, [REST[k][0], 0, REST[k][1]]);
      p[1] = ground(p[0], p[2]);
      f.p = p;
      f.from = p.slice();
      f.to = p.slice();
      f.down = true;
    });
    const [pitch, y] = stance(d);
    d.pitch = pitch;
    d.y = y;
  };
  // the body's pitch and height over the four feet where they are (place's rule)
  const stance = (d) => {
    const g = d.feet.map((f) => f.p[1]),
      span = (REST[0][1] - REST[2][1]) * d.size,
      pitch0 = d.pitch;
    d.pitch = clamp(
      0.6 * atan2((g[0] + g[1] - g[2] - g[3]) / 2, span),
      -0.14,
      0.14,
    );
    const B = bodyFrame(d),
      pitch = d.pitch;
    d.pitch = pitch0;
    let y = 1e9;
    for (let k = 0; k < 4; k++) {
      const R = upperEnd(d, B, k),
        f = d.feet[k].p,
        h = hypot(f[0] - R[0], f[2] - R[2]),
        r = REACH[k] * d.size;
      y = min(y, f[1] - R[1] + sqrt(max(r * r - h * h, 0)));
    }
    return [pitch, y];
  };
  // Walking, each foot's stance is centred where its leg reaches as far forward as back (under its hinge), and the
  // stride is as long as the shortest such reach allows with the foot at most WALK_OFF off the ground, the body at
  // its standing height (size 1): WALK_C, the centre's offset from where the foot rests; WALK_L, the longest stride
  const WALK_OFF = 0.03, // (with the bob, at most 5 cm off on slopes to 1 in 5: measured)
    WALK_C = [],
    WALK_L = (() => {
      const d = { x: 0, y: STAND, z: 0, size: 1, yaw: 0, pitch: 0 },
        B = bodyFrame(d);
      let w = 1;
      for (let k = 0; k < 4; k++) {
        const reach = [-1, 1].map((side) => {
          let lo = 0,
            hi = 1;
          for (let i = 0; i < 20; i++) {
            const o = (lo + hi) / 2,
              foot = [REST[k][0], WALK_OFF, REST[k][1] + side * o],
              hip = at(d, B, HIPS[k]),
              a = upperAngle(B, hip, foot, k, UPPER[k < 2 ? 0 : 1], 1, MAXR[k]),
              l = (k < 2 ? FORE : HIND)[0],
              R = [0, 1, 2].map(
                (c) => hip[c] + (B[2][c] * cos(a) + B[1][c] * sin(a)) * l,
              );
            if (
              hypot(foot[0] - R[0], foot[1] - R[1], foot[2] - R[2]) <=
              MAXR[k] + 1e-6
            )
              lo = o;
            else hi = o;
          }
          return lo;
        });
        WALK_C[k] = (reach[1] - reach[0]) / 2;
        w = min(w, (reach[0] + reach[1]) / 2);
      }
      return (2 * w) / GAITS.walk.down;
    })();
  // where a foot comes down next: under its hip at mid-stance, ahead by what the body covers meanwhile
  const printAhead = (d, k, ahead) => {
    const s = d.size,
      dx = sin(d.yaw),
      dz = cos(d.yaw),
      rx = REST[k][0] * s,
      rz = REST[k][1] * s,
      x = d.x + dx * (rz + ahead) + dz * rx,
      z = d.z + dz * (rz + ahead) - dx * rx;
    return [x, ground(x, z), z];
  };
  // Moves a deer's body by its speed and heading and steps its feet: a foot that is down stays where it is; one
  // that lifts goes on an arc to where it will be under its hip
  const stride = (d, dt) => {
    const g = d.v > BOUND_AT ? GAITS.bound : GAITS.walk,
      L =
        (d.v > BOUND_AT ? 0.9 + 0.35 * d.v : min(0.9 + 0.35 * d.v, WALK_L)) *
        d.size;
    d.x += sin(d.yaw) * d.v * dt;
    d.z += cos(d.yaw) * d.v * dt;
    d.phase += (d.v * dt) / L;
    d.feet.forEach((f, k) => {
      const phi = (((d.phase + g.off[k]) % 1) + 1) % 1;
      if (phi < g.down) {
        if (!f.down) {
          f.p = f.to.slice();
          f.down = true;
        }
      } else {
        if (f.down) {
          f.from = f.p.slice();
          f.to = printAhead(
            d,
            k,
            (1 - phi + g.down / 2) * L +
              (g === GAITS.walk ? WALK_C[k] * d.size : 0),
          );
          f.down = false;
        }
        const s = smooth((phi - g.down) / (1 - g.down)),
          h = g.lift * d.size * sin(PI * s);
        for (let c = 0; c < 3; c++)
          f.p[c] = f.from[c] + (f.to[c] - f.from[c]) * s;
        f.p[1] += h;
      }
    });
    // the body rides over the ground under it (walking, the lowest of it under its shoulders, middle and hips:
    // the downhill legs reach); bounding, it rises between the hind and the fore pair's pushes (standing still,
    // stance() carries it instead)
    if (d.v < 0.05) return;
    const fy = ground(
        d.x + sin(d.yaw) * 0.35 * d.size,
        d.z + cos(d.yaw) * 0.35 * d.size,
      ),
      hy = ground(
        d.x - sin(d.yaw) * 0.38 * d.size,
        d.z - cos(d.yaw) * 0.38 * d.size,
      ),
      gy = d.v > BOUND_AT ? ground(d.x, d.z) : min(ground(d.x, d.z), fy, hy),
      bob =
        d.v > BOUND_AT
          ? 0.11 * d.size * sin(PI * (((d.phase % 1) + 1) % 1)) ** 2
          : 0.012 * d.size * sin(TAU * 2 * d.phase);
    d.y = ease(d.y, gy + STAND * d.size + bob - d.lift * 0.08 * d.size, 18, dt);
    d.pitch = ease(
      d.pitch,
      clamp(0.6 * atan2(fy - hy, 0.73 * d.size), -0.14, 0.14) -
        (d.v > BOUND_AT ? 0.12 * sin(TAU * d.phase) : 0) -
        d.lift * 0.1,
      10,
      dt,
    );
  };

  // ---------------------------------------------------------------- posing the parts
  let nOut = 0;
  const put = (gi, slot, o, frameV, d, species) => {
    const g = groups[gi],
      i = (g.first + slot) * 12;
    data[i] = o[0];
    data[i + 1] = o[1];
    data[i + 2] = o[2];
    data[i + 3] = d.size;
    quat(data, i + 4, frameV[0], frameV[1], frameV[2]);
    data[i + 8] = 6;
    data[i + 9] = species + d.hue * 0.99;
    data[i + 10] = d.size;
    data[i + 11] = 0;
  };
  // a leg: its upper length swung from the hip, then the two lower lengths by IK to the foot, the middle joint
  // bending forward on a fore leg (the knee) and backward on a hind leg (the hock)
  const leg = (d, B, k, slot, swing, foot) => {
    const fore = k < 2,
      len = fore ? FORE : HIND,
      s = d.size,
      hip = at(d, B, HIPS[k]),
      // (a foreleg that bears weight is a column: its knee as at rest, the shoulder takes up the ground)
      down = fore && d.feet[k].down,
      a0 = upperAngle(
        B,
        hip,
        foot,
        k,
        UPPER[fore ? 0 : 1] + swing,
        s,
        (down ? REACH[k] : MAXR[k]) * s,
        down,
      ),
      ud = [
        B[2][0] * cos(a0) + B[1][0] * sin(a0),
        B[2][1] * cos(a0) + B[1][1] * sin(a0),
        B[2][2] * cos(a0) + B[1][2] * sin(a0),
      ],
      R = [
        hip[0] + ud[0] * len[0] * s,
        hip[1] + ud[1] * len[0] * s,
        hip[2] + ud[2] * len[0] * s,
      ];
    const a = len[1] * s,
      b = len[2] * s,
      v = [foot[0] - R[0], foot[1] - R[1], foot[2] - R[2]],
      d0 = hypot(v[0], v[1], v[2]) || 1e-3,
      dd = clamp(d0, abs(a - b) + 0.01 * s, MAXR[k] * s),
      dir = [v[0] / d0, v[1] / d0, v[2] / d0],
      bendTo = fore ? B[2] : [-B[2][0], -B[2][1], -B[2][2]],
      dot = bendTo[0] * dir[0] + bendTo[1] * dir[1] + bendTo[2] * dir[2],
      bend = unit([
        bendTo[0] - dir[0] * dot,
        bendTo[1] - dir[1] * dot,
        bendTo[2] - dir[2] * dot,
      ]),
      cA = clamp((a * a + dd * dd - b * b) / (2 * a * dd), -1, 1),
      sA = sqrt(1 - cA * cA),
      J = [0, 1, 2].map((c) => R[c] + a * (dir[c] * cA + bend[c] * sA)),
      F = [0, 1, 2].map((c) => R[c] + dir[c] * dd),
      gi = fore ? 6 : 9;
    const sp = fore ? 13 : 16;
    d.hoof[k] = F[1] - ground(F[0], F[2]);
    {
      const u = unit([J[0] - R[0], J[1] - R[1], J[2] - R[2]]),
        v2 = unit([F[0] - J[0], F[1] - J[1], F[2] - J[2]]);
      d.bend[k] =
        (Math.acos(clamp(u[0] * v2[0] + u[1] * v2[1] + u[2] * v2[2], -1, 1)) *
          180) /
        PI;
    }
    put(gi, slot * 2 + (k % 2), hip, along(ud, B[0]), d, sp);
    put(
      gi + 1,
      slot * 2 + (k % 2),
      R,
      along(unit([J[0] - R[0], J[1] - R[1], J[2] - R[2]]), B[0]),
      d,
      sp + 1,
    );
    put(
      gi + 2,
      slot * 2 + (k % 2),
      J,
      along(unit([F[0] - J[0], F[1] - J[1], F[2] - J[2]]), B[0]),
      d,
      sp + 2,
    );
  };
  // poses deer d into draw slot `slot` (its head into slot `hs` of the does' or the bucks' heads)
  const pose = (d, slot, hs) => {
    const B = bodyFrame(d),
      s = d.size;
    put(0, slot, [d.x, d.y, d.z], B, d, 8);
    // neck and head: pitched over the body, turned (look) toward where the deer attends, the neck taking a third
    const ny = d.look * 0.35,
      Fy = [
        B[2][0] * cos(ny) + B[0][0] * sin(ny),
        B[2][1] * cos(ny) + B[0][1] * sin(ny),
        B[2][2] * cos(ny) + B[0][2] * sin(ny),
      ],
      Ry = cross(B[1], Fy),
      root = at(d, B, NECK),
      nd = unit(
        [0, 1, 2].map((c) => Fy[c] * cos(d.neck) + B[1][c] * sin(d.neck)),
      ),
      poll = [0, 1, 2].map((c) => root[c] + nd[c] * NECK_L * s);
    put(1, slot, root, along(nd, Ry), d, 9);
    const hy = d.look * 0.65,
      Fh = [
        Fy[0] * cos(hy) + Ry[0] * sin(hy),
        Fy[1] * cos(hy) + Ry[1] * sin(hy),
        Fy[2] * cos(hy) + Ry[2] * sin(hy),
      ],
      Rh = unit(cross(B[1], Fh)),
      hd = unit(
        [0, 1, 2].map((c) => Fh[c] * cos(d.head) + B[1][c] * sin(d.head)),
      ),
      H = along(hd, Rh);
    put(d.buck ? 3 : 2, hs, poll, H, d, 10);
    // the ears: up and out from the poll, turned forward (alert, 1) or back (laid flat, -1), each its own way
    for (let e = 0; e < 2; e++) {
      const side = e ? 1 : -1,
        turn = d.ears[e] + d.earKick[e],
        q = EARS[e],
        base = [0, 1, 2].map(
          (c) =>
            poll[c] + (H[0][c] * q[0] + H[1][c] * q[1] + H[2][c] * q[2]) * s,
        ),
        // (out about 45 degrees and a little back at rest, upright and turned forward when alert, laid back in
        // flight; the opening facing forward and out)
        out = 0.66 - 0.1 * turn,
        up = 0.7 + 0.1 * turn,
        back = -0.22 + 0.32 * turn,
        dir = unit(
          [0, 1, 2].map(
            (c) => H[0][c] * side * out + H[1][c] * up + H[2][c] * back,
          ),
        ),
        face = unit(
          [0, 1, 2].map(
            (c) =>
              H[2][c] * (0.55 + 0.35 * turn) +
              H[0][c] * side * (0.65 - 0.2 * turn) +
              H[1][c] * 0.05,
          ),
        ),
        r = unit(cross(face, dir)),
        u = cross(dir, r);
      put(4, slot * 2 + e, base, [r, u, dir], d, 11);
    }
    // the tail: hanging, or up and fanned showing its white underside
    {
      const t = d.tail,
        f = unit([0, 1, 2].map((c) => -B[2][c] * cos(t) + B[1][c] * sin(t))),
        u = unit([0, 1, 2].map((c) => B[2][c] * sin(t) + B[1][c] * cos(t))),
        r = cross(u, f);
      put(5, slot, at(d, B, TAIL), [r, u, f], d, 12);
    }
    // the legs: their feet where stride or a leap put them
    const g = d.v > BOUND_AT || d.leap ? GAITS.bound : GAITS.walk;
    for (let k = 0; k < 4; k++) {
      const phi = (((d.phase + g.off[k]) % 1) + 1) % 1,
        sw = g.swing * cos(TAU * (phi - g.down / 2)) * min(d.v / 1.2, 1);
      leg(
        d,
        B,
        k,
        slot,
        sw * (1 - d.lift) + d.lift * (k < 2 ? 0.5 : -0.35),
        d.feet[k].p,
      );
    }
    // its blot on the ground: three soft patches along it, fading as it leaves the ground
    const lift = clamp(1 - (d.y - ground(d.x, d.z) - STAND * s) / 0.8, 0, 1);
    for (let j = 0; j < 3; j++) {
      const p = at(d, B, [0, 0, 0.35 - j * 0.35]),
        gx = ground(p[0], p[2]),
        o = (slot * 3 + j) * 8;
      blots[o] = p[0];
      blots[o + 1] = gx + 0.02;
      blots[o + 2] = p[2];
      blots[o + 3] = 0.42 * s;
      blots[o + 4] = 0.5 * lift;
      blots[o + 5] = ground(p[0] + 0.5, p[2]) - gx;
      blots[o + 6] = ground(p[0], p[2] + 0.5) - gx;
      blots[o + 7] = 0;
    }
  };

  // ---------------------------------------------------------------- behaviour at rest
  // goals of the head: neck pitch, head pitch, ears (1 forward)
  const HEADS = {
    graze: [-1.15, -1.75, 0.1],
    look: [0.9, -0.3, 0.45],
    stand: [0.785, -0.45, 0.2],
    alert: [1.0, -0.2, 1],
    walk: [0.3, -0.6, 0],
    run: [0.35, -0.25, -0.4],
  };
  // A deer comes back to rest at its home only out of the walker's sight (far, or hidden from it); till then it is
  // away (not drawn). Its heading is drawn anew each time: one it can stand at, 45 degrees from any other resting
  // deer's at least (its home's own, should twelve draws find none)
  const settleAt = (d, w) => {
    const h = d.home;
    d.away =
      !h ||
      (hypot(h.x - w.x, h.z - w.z) < 60 &&
        !hidden(w.x, w.y, w.z, h.x, ground(h.x, h.z) + 0.7, h.z));
    if (d.away) return;
    let yaw = h.yaw;
    for (let k = 0; k < 12; k++) {
      const a = Math.random() * TAU;
      if (
        standable(h.x, h.z, a) &&
        herd.every(
          (o) =>
            o === d ||
            !o.awake ||
            o.away ||
            abs(((((a - o.yaw + PI) % TAU) + TAU) % TAU) - PI) >= PI / 4,
        )
      ) {
        yaw = a;
        break;
      }
    }
    place(d, h.x, h.z, yaw);
    d.state = 'graze';
    d.until = clock + wait(6);
  };
  const toward = (d, x, z) => atan2(x - d.x, z - d.z);
  // a heading to graze on: anywhere ahead within `spread`, or back toward its home once 3 m from it (less where the
  // home is near a path: never nearer it than a metre past MOVE_OFF)
  const roam = (d, spread) =>
    d.home &&
    hypot(d.x - d.home.x, d.z - d.home.z) >
      clamp(d.home.pathD - MOVE_OFF - 1, 1, 3) * d.size
      ? toward(d, d.home.x, d.home.z) + (Math.random() - 0.5) * 0.6
      : d.yaw + (Math.random() - 0.5) * spread;
  const turnTo = (d, yaw, rate, dt) => {
    let e = ((((yaw - d.yaw + PI) % TAU) + TAU) % TAU) - PI;
    d.yaw += clamp(e, -rate * dt, rate * dt);
    return abs(e);
  };
  // a step of the body, kept clear of trunks, fences and water, and of the walker
  const move = (d, dt, w) => {
    const x0 = d.x,
      z0 = d.z;
    stride(d, dt);
    let [x, z] = avoid(d.x, d.z, 0.45 * d.size);
    const dw = hypot(x - w.x, z - w.z);
    if (dw < 1.2) {
      x = w.x + ((x - w.x) / dw) * 1.2;
      z = w.z + ((z - w.z) / dw) * 1.2;
    }
    if (wet(x, z, 0.6)) {
      x = x0;
      z = z0;
      d.yaw += PI * 0.5 * dt;
    }
    d.x = x;
    d.z = z;
  };
  const rest = (d, dt, w) => {
    const dw = hypot(w.x - d.x, w.z - d.z),
      seen = w.speed > 0.3 && dw < NOTICE && !(clock < d.calm),
      faceW = toward(d, w.x, w.z);
    // what it attends to: the walker, while it is near and moving (alert), else its own business
    if (d.state === 'bound' || d.state === 'moveoff') {
      if (d.state === 'moveoff' && (dw < BOLT || clock > d.until)) {
        d.state = 'bound';
        d.until = clock + wait(5);
      }
      turnTo(d, d.goalYaw, d.state === 'bound' ? 3 : 1.5, dt);
      d.v = ease(d.v, d.state === 'bound' ? 7.5 : 1.3, 3, dt);
      move(d, dt, w);
      if (
        d.state === 'bound' &&
        (dw > 45 ||
          (dw > 18 && hidden(w.x, w.y, w.z, d.x, d.y, d.z)) ||
          clock > d.until + 6)
      )
        settleAt(d, w);
      return d.state === 'bound' ? HEADS.run : HEADS.walk;
    }
    if (dw < MOVE_OFF && w.speed > 0.2) {
      d.state = 'moveoff';
      d.goalYaw = faceW + PI + (Math.random() - 0.5) * 0.8;
      d.until = clock + wait(2);
      return HEADS.walk;
    }
    // (one at a time watches the walker: the others go on with their own business)
    if (
      seen &&
      d.state !== 'alert' &&
      !herd.some((o) => o !== d && o.state === 'alert')
    ) {
      d.state = 'alert';
      d.until = clock + wait(8);
    }
    if (d.state === 'alert') {
      d.v = ease(d.v, 0, 4, dt);
      stride(d, dt);
      let rel = ((((faceW - d.yaw + PI) % TAU) + TAU) % TAU) - PI;
      d.look = ease(d.look, clamp(rel, -1.4, 1.4), 6, dt);
      if (w.still > 5 || dw > NOTICE + 5) {
        d.state = 'look';
        d.until = clock + wait(4);
      } else if (clock > d.until) {
        // (watched long enough, the walker no nearer than MOVE_OFF: back to grazing, and it lets the walker be a
        // while)
        d.state = 'graze';
        d.until = clock + wait(6);
        d.calm = clock + wait(20);
      }
      return HEADS.alert;
    }
    d.look = ease(d.look, d.state === 'look' ? d.lookTo || 0 : 0, 3, dt);
    if (clock > d.until) {
      const r = Math.random();
      if (d.state === 'graze') {
        if (r < 0.35) {
          d.state = 'look';
          d.lookTo = (Math.random() - 0.5) * 1.6;
          d.until = clock + wait(3.5);
        } else if (r < 0.55) {
          // to another bite a few metres on
          d.state = 'walkto';
          d.goalYaw = roam(d, 2);
          d.until = clock + wait(3);
        } else {
          d.state = 'step';
          d.goalYaw = roam(d, 0.8);
          d.until = clock + 0.9 + Math.random();
        }
      } else if (unevenAt(d.x, d.z, d.yaw) > TILT) {
        // (not here: too steep to rest on; a few steps on)
        d.state = 'walkto';
        d.goalYaw = roam(d, 1.5);
        d.until = clock + 1.5;
      } else {
        d.state = 'graze';
        d.until = clock + wait(6);
      }
    }
    if (d.state === 'step' || d.state === 'walkto') {
      turnTo(d, d.goalYaw, 0.8, dt);
      d.v = ease(d.v, d.state === 'step' ? 0.45 : 1.0, 2, dt);
    } else d.v = ease(d.v, 0, 3, dt);
    move(d, dt, w);
    // (still, it stands by place's rule over its feet)
    if (d.v < 0.05 && d.feet.every((f) => f.down)) {
      const [pitch, y] = stance(d);
      d.pitch = ease(d.pitch, pitch, 4, dt);
      d.y = ease(d.y, y, 4, dt);
    }
    return d.state === 'walkto'
      ? HEADS.walk
      : d.state === 'look'
        ? HEADS.look
        : HEADS.graze;
  };
  // the ears flick now and then, each on its own; the tail now and then
  const fidget = (d, dt) => {
    for (let e = 0; e < 2; e++) {
      d.earKick[e] = ease(d.earKick[e], 0, 6, dt);
      if (Math.random() < dt / 2.2)
        d.earKick[e] = (Math.random() < 0.5 ? -1 : 1) * (0.5 + Math.random());
    }
    if (d.tailFlick > 0) d.tailFlick -= dt;
    else if (Math.random() < dt / 9) d.tailFlick = 0.35;
  };

  // ---------------------------------------------------------------- the crossing
  // A plan for a crossing at the point P of a path (heading along it: tx, tz), from side `side`: where the deer
  // breaks cover and where it is lost again, both hidden from the eye, the line between clear of trunks and water
  // (and, where it runs on the ground, nowhere rising or falling more than 1 in 2 over a metre: no rock, bank or
  // gully on the way, seen or not; flyA, flyB: metres at either end that the leap passes over, fences and all)
  const corridor = (ax, az, bx, bz, flyA, flyB) => {
    const len = hypot(bx - ax, bz - az),
      n = Math.ceil(len / 0.5),
      g = [];
    for (let k = 0; k <= n; k++) {
      const x = ax + ((bx - ax) * k) / n,
        z = az + ((bz - az) * k) / n,
        at = (len * k) / n;
      g[k] = ground(x, z);
      if (at < flyA || at > len - flyB) continue;
      const [sx, sz] = avoid(x, z, 0.2);
      if (hypot(sx - x, sz - z) > 0.02 || wet(x, z, 0.8)) return false;
      if (
        k >= 2 &&
        at - flyA >= (2 * len) / n &&
        abs(g[k] - g[k - 2]) > len / n
      )
        return false;
    }
    return true;
  };
  // The slants a crossing tries, the first that serves taken (slanted so that the deer runs on away from the eye: it
  // stays in a narrow view longer); the way across at slant t0 from side `side` of a path heading tx, tz
  const TILTS = [0.35, 0.55, 0.15, 0, 0.75, -0.3];
  const across = (tx, tz, side, t0) => {
    const c = cos(t0 * side),
      s = sin(t0 * side);
    return [(-tz * c - tx * s) * side, (tx * c - tz * s) * side];
  };
  // (nor a leap from or down to ground more than 1 in 2 above or below where it takes off)
  const leapLevel = (px, pz, nx, nz) =>
    abs(
      ground(px + nx * LEAP.before, pz + nz * LEAP.before) -
        ground(px - nx * LEAP.after, pz - nz * LEAP.after),
    ) <=
    (LEAP.before + LEAP.after) / 2;
  // whether a crossing at P from `side` has a way at some slant, clear 6 m on either side (plan's checks, the eye's
  // aside)
  const wayAt = (px, pz, tx, tz, side) =>
    TILTS.some((t0) => {
      const [nx, nz] = across(tx, tz, side, t0);
      return (
        leapLevel(px, pz, nx, nz) &&
        corridor(px + nx * 6, pz + nz * 6, px, pz, 0, LEAP.before) &&
        corridor(px, pz, px - nx * 6, pz - nz * 6, LEAP.after, 0)
      );
    });
  const plan = (eye, px, pz, tx, tz, side, force) => {
    let fallback = null;
    for (const t0 of TILTS) {
      const [nx, nz] = across(tx, tz, side, t0);
      if (!leapLevel(px, pz, nx, nz)) continue;
      let S = null,
        E = null,
        sFar = 0,
        eFar = 0;
      for (let d = 6; d <= 22 && !S; d += 1) {
        const x = px + nx * d,
          z = pz + nz * d;
        if (!corridor(x, z, px, pz, 0, LEAP.before)) break;
        sFar = d;
        if (
          hidden(eye.x, eye.y, eye.z, x, ground(x, z) + 0.75, z) ||
          fogT(hypot(x - eye.x, z - eye.z)) < 0.06
        )
          S = [x, z];
      }
      for (let d = 6; d <= 24 && !E; d += 1) {
        const x = px - nx * d,
          z = pz - nz * d;
        if (!corridor(px, pz, x, z, LEAP.after, 0)) break;
        eFar = d;
        if (
          hidden(eye.x, eye.y, eye.z, x, ground(x, z) + 0.75, z) ||
          fogT(hypot(x - eye.x, z - eye.z)) < 0.06
        )
          E = [x, z];
      }
      if (S && E) return { S, E, P: [px, pz] };
      // (asked for: as far as the way is clear, hidden or not; none where it is not clear 6 m either side)
      if (force && !fallback && sFar && eFar)
        fallback = {
          S: S || [px + nx * sFar, pz + nz * sFar],
          E: E || [px - nx * eFar, pz - nz * eFar],
          P: [px, pz],
        };
    }
    return fallback;
  };
  // the path's point `ahead` metres on from global point k, the way the walker faces, and its heading
  const ahead = (k, fx, fz, dist) => {
    let left = dist;
    const pathOf = (i) => {
      let b = 0,
        k0 = 0;
      while (b < paths.length && i >= k0 + paths[b].length)
        k0 += paths[b++].length;
      return [b, k0];
    };
    const [b, k0] = pathOf(k),
      pts = paths[b],
      i0 = k - k0,
      nxt = pts[min(i0 + 1, pts.length - 1)],
      prv = pts[max(i0 - 1, 0)],
      dirSign = (nxt[0] - prv[0]) * fx + (nxt[1] - prv[1]) * fz >= 0 ? 1 : -1;
    let i = i0;
    while (left > 0) {
      const n = i + dirSign;
      if (n < 0 || n >= pts.length) return null;
      left -= hypot(pts[n][0] - pts[i][0], pts[n][1] - pts[i][1]);
      i = n;
    }
    const j = i,
      a = pts[max(j - 1, 0)],
      c = pts[min(j + 1, pts.length - 1)],
      l = hypot(c[0] - a[0], c[1] - a[1]) || 1;
    return {
      k: k0 + j,
      x: pts[j][0],
      z: pts[j][1],
      tx: ((c[0] - a[0]) / l) * dirSign,
      tz: ((c[1] - a[1]) / l) * dirSign,
    };
  };
  // starts the crossing of plan p: one deer, now and then a second one a second behind on a line beside it
  // (the second only where its own line is as clear as the first's)
  const startCrossing = (p, two) => {
    [p, two ? p : null].forEach((q, n) => {
      if (!q) return;
      const d = runners[n],
        ox = n
          ? ((q.E[1] - q.S[1]) / hypot(q.E[0] - q.S[0], q.E[1] - q.S[1])) * 0.9
          : 0,
        oz = n
          ? (-(q.E[0] - q.S[0]) / hypot(q.E[0] - q.S[0], q.E[1] - q.S[1])) * 0.9
          : 0,
        run = {
          S: [q.S[0] + ox, q.S[1] + oz],
          P: [q.P[0] + ox, q.P[1] + oz],
          E: [q.E[0] + ox, q.E[1] + oz],
          delay: n * 1.0,
        };
      if (
        n &&
        !(
          corridor(...run.S, ...run.P, 0, LEAP.before) &&
          corridor(...run.P, ...run.E, LEAP.after, 0)
        )
      )
        return;
      d.run = run;
      place(d, d.run.S[0], d.run.S[1], atan2(q.P[0] - q.S[0], q.P[1] - q.S[1]));
      d.on = true;
      d.v = RUN;
      d.leap = null;
      d.lift = 0;
      d.tail = 1.1; // (up and white from the first bound)
    });
  };
  // a crossing deer's frame: bounds to the path, one long leap over it, bounds on to where it is lost
  // The leap over the path (refs7/deerleap): from LEAP.before metres short of its middle to LEAP.after beyond, the
  // body on an arc HIGH over its standing height (the belly then about a body's depth off the ground). Going up,
  // the forequarters rise and the hind legs drive back at full stretch; at the top the back is level, the forelegs
  // tucked under the chest, the hind legs trailing; coming down the forequarters dip, the forelegs reach forward
  // and take the ground first, the hindquarters swing under. Keyframes by the leap's share s: pitch, and each
  // pair's foot in the body's frame (y, z), where it is from the elbow or the stifle as long as the leg below it
  // (bounding at RUN m/s on either side: slow enough that a narrow view holds it two seconds and more)
  const LEAP = { before: 2.3, after: 2.5, high: 0.5, speed: 6.2 },
    RUN = 4.2,
    LEAP_KEYS = [
      // s, pitch, fore foot, hind foot
      [0, 0.32, [-0.39, 0.62], [-0.6, -0.87]],
      [0.22, 0.2, [-0.3, 0.21], [-0.51, -1.08]],
      [0.5, 0.02, [-0.28, 0.18], [-0.41, -1.12]],
      [0.75, -0.3, [-0.55, 0.62], [-0.45, -0.68]],
      [1, -0.22, [-0.69, 0.49], [-0.58, -0.18]],
    ];
  const leapKey = (s) => {
    let k = 0;
    while (k < LEAP_KEYS.length - 2 && s > LEAP_KEYS[k + 1][0]) k++;
    const a = LEAP_KEYS[k],
      b = LEAP_KEYS[k + 1],
      t = smooth(clamp((s - a[0]) / (b[0] - a[0]), 0, 1)),
      m = (u, v) => u + (v - u) * t;
    return [
      m(a[1], b[1]),
      [m(a[2][0], b[2][0]), m(a[2][1], b[2][1])],
      [m(a[3][0], b[3][0]), m(a[3][1], b[3][1])],
    ];
  };
  const runOn = (d, dt) => {
    const r = d.run;
    if (r.delay > 0) {
      r.delay -= dt;
      return false;
    }
    const [px, pz] = r.P,
      [ex, ez] = r.E,
      ux = (ex - r.S[0]) / hypot(ex - r.S[0], ez - r.S[1]),
      uz = (ez - r.S[1]) / hypot(ex - r.S[0], ez - r.S[1]),
      along0 = (d.x - px) * ux + (d.z - pz) * uz;
    if (!d.leap && along0 > -LEAP.before - 0.4 && along0 < 0) {
      const x0 = d.x,
        z0 = d.z,
        T = (LEAP.after - along0) / LEAP.speed;
      d.leap = {
        t: 0,
        T,
        x0,
        z0,
        y0: d.y,
        x1: px + ux * LEAP.after,
        z1: pz + uz * LEAP.after,
      };
      d.leap.y1 = ground(d.leap.x1, d.leap.z1) + STAND * d.size;
    }
    d.yaw = atan2(ux, uz);
    if (d.leap) {
      const L = d.leap;
      L.t += dt;
      const s = min(L.t / L.T, 1),
        [pitch, fore, hind] = leapKey(s);
      d.x = L.x0 + (L.x1 - L.x0) * s;
      d.z = L.z0 + (L.z1 - L.z0) * s;
      d.y = L.y0 + (L.y1 - L.y0) * s + 4 * LEAP.high * d.size * s * (1 - s);
      d.pitch = pitch;
      d.lift = 1;
      // the feet where the keyframes have them (the legs' IK bends the rest)
      const B = bodyFrame(d);
      d.feet.forEach((f, k) => {
        const q = k < 2 ? fore : hind,
          p = at(d, B, [REST[k][0], q[0], q[1] + (k % 2 ? -0.03 : 0.03)]);
        for (let c = 0; c < 3; c++) f.p[c] = p[c];
        f.down = false;
        f.to = printAhead(d, k, 0.5);
      });
      if (s >= 1) {
        d.leap = null;
        d.lift = 0;
        d.phase = 0.5; // (landing on the fore pair: the bound's next beat is theirs)
      }
    } else {
      d.v = ease(d.v, RUN, 3, dt);
      stride(d, dt);
    }
    d.tail = 1.1;
    // lost: past its end and out of sight, or far
    return along0 > hypot(ex - px, ez - pz);
  };

  // a stretch's middle point and the path's heading there
  const middleOf = (s) => {
    const pts = paths[s.path],
      mid = (s.from + s.to) >> 1,
      a = pts[max(mid - 1, 0)],
      c = pts[min(mid + 1, pts.length - 1)];
    return { mid, P: pts[mid], t: unit([c[0] - a[0], 0, c[1] - a[1]]) };
  };
  // Each stretch's ways across at its middle (wayAt, from either side): a stretch with none is dropped, and with it
  // its points (onStretch); routes: [stretch, side] of every way left, for the crossings the menu asks for
  const routes = [];
  {
    const kept = stretches.filter((s) => {
      const { P, t } = middleOf(s);
      s.sides = [1, -1].filter((side) => wayAt(P[0], P[1], t[0], t[2], side));
      return s.sides.length > 0;
    });
    stretches.splice(0, stretches.length, ...kept);
    stretches.forEach((s, i) => {
      for (let j = s.from; j <= s.to; j++) onStretch[s.base + j] = i + 1;
      for (const side of s.sides) routes.push([i, side]);
    });
  }

  // ---------------------------------------------------------------- each frame
  let chance = CHANCE,
    rolls = 0,
    pending = null, // a crossing asked for (debug), fired when its time comes
    rolled = 0,
    rolledAt = -1e9;
  // A crossing by itself: walking a narrow path toward a stretch where it may happen, 8.5 to 9.5 m short of it, in
  // fair weather; each time the walker comes up to a stretch the odds are rolled once (CHANCE; a third of it on the
  // loop: the side paths go deeper into the forest). True if one began
  const maybeCross = (w, wx) => {
    const k = trailK(w.x, w.z);
    if (
      pending != null ||
      runners[0].on ||
      trailD(w.x, w.z) > trailHalf(k) + 0.6 ||
      clock < FIRST ||
      clock - lastCross < GAP ||
      w.speed < 0.5 ||
      wx.rain > 0.5 ||
      wx.storm > 0.3
    )
      return false;
    const a = ahead(k, w.fx, w.fz, 8.5 + Math.random()),
      s = a ? onStretch[a.k] : 0;
    if (!s || (s === rolled && clock - rolledAt < 60)) return false;
    rolled = s;
    rolledAt = clock;
    rolls++;
    // (from either side, whichever has a way: a random one first)
    const side = Math.random() < 0.5 ? 1 : -1,
      p =
        Math.random() < chance * (stretches[s - 1].path ? 1 : 1 / 3) &&
        (plan(w, a.x, a.z, a.tx, a.tz, side, false) ||
          plan(w, a.x, a.z, a.tx, a.tz, -side, false));
    if (!p) return false;
    startCrossing(p, Math.random() < 0.3);
    lastCross = clock;
    return true;
  };
  function update(dt, w, wx) {
    clock += dt;
    maybeCross(w, wx);
    if (pending && clock >= pending.at) {
      const a = pending;
      pending = null;
      startCrossing(
        plan(w, a.x, a.z, a.tx, a.tz, a.side, true),
        Math.random() < 0.3,
      );
      lastCross = clock;
    }
    // draw what is awake: the herd within sight of the fog, the runners while they run
    nOut = 0;
    let doe = 0,
      buck = 0;
    const show = (d) => {
      if (nOut >= MAXN) return;
      pose(d, nOut, d.buck ? buck++ : doe++);
      nOut++;
    };
    herd.forEach((d, i) => {
      if (i >= count) return;
      if (!d.awake || d.away) settleAt(d, w);
      d.awake = true;
      if (d.away && !d.held) return;
      const dw = hypot(w.x - d.x, w.z - d.z);
      if (d.held) {
        show(d);
        return;
      }
      if (dw > 28 && fogT(dw) < 0.02) return; // asleep beyond the fog
      const head = rest(d, dt, w);
      fidget(d, dt);
      d.neck = ease(d.neck, head[0], 3, dt);
      d.head = ease(d.head, head[1], 3.5, dt);
      for (let e = 0; e < 2; e++) d.ears[e] = ease(d.ears[e], head[2], 5, dt);
      d.tail = ease(
        d.tail,
        d.state === 'bound' ? 1.0 : d.tailFlick > 0 ? -0.3 : -1.25,
        6,
        dt,
      );
      show(d);
    });
    for (const d of runners) {
      if (!d.on) continue;
      if (runOn(d, dt)) {
        d.on = false;
        continue;
      }
      d.neck = ease(d.neck, d.leap ? 0.5 : 0.45, 6, dt);
      d.head = ease(d.head, d.leap ? -0.05 : -0.2, 6, dt);
      d.ears[0] = d.ears[1] = ease(d.ears[0], -0.9, 6, dt);
      if (d.run.delay <= 0) show(d);
    }
    // the draw groups: as many of each part as deer shown (heads: does and bucks apart)
    groups.forEach((g, i) => {
      g.count = i === 2 ? doe : i === 3 ? buck : g.per * nOut;
    });
  }

  return {
    data,
    blots,
    groups,
    update,
    stretches,
    // the homes at rest: x, z, yaw, metres to the nearest path, the path point it is seen nearest from (x, z) and
    // how far that is, whether it is the meadow's edge's, and every path point it is seen from (x, z, metres); and
    // the milliseconds it took to find them
    homeList: () => ({
      ms: +homesMs.toFixed(1),
      homes: homes.map((h) => [
        +h.x.toFixed(1),
        +h.z.toFixed(1),
        +h.yaw.toFixed(3),
        +h.pathD.toFixed(1),
        +h.view[0].toFixed(1),
        +h.view[1].toFixed(1),
        +h.view[2].toFixed(1),
        h.edge ? 1 : 0,
        h.from,
      ]),
    }),
    // how many live in the world (0, 1 or 3)
    count(n) {
      if (n !== undefined) {
        count = clamp(n | 0, 0, 3);
        herd.forEach((d, i) => {
          if (i >= count) d.awake = false;
        });
      }
      return count;
    },
    // the triangles of the deer drawn last frame
    tris(meshes) {
      let t = 0;
      for (const g of groups) t += tris(meshes[g.mesh]) * g.count;
      return t;
    },
    // Sets up a crossing at stretch i (of `stretches`): where the walker is to stand (x, z) and look (tx, tz), and
    // fires it `delay` seconds on whatever the weather and the timers. Returns the place and the side it comes from
    crossAt(i, delay, side) {
      const s =
          stretches[
            ((i % stretches.length) + stretches.length) % stretches.length
          ],
        { mid, P, t } = middleOf(s),
        // the walker 9 m along the path from the crossing's place: back the way it came, or on where there is no
        // room behind (where a side path leaves the loop)
        stand =
          ahead(s.base + mid, -t[0], -t[2], 9) ||
          ahead(s.base + mid, t[0], t[2], 9);
      pending = {
        at: clock + delay,
        x: P[0],
        z: P[1],
        tx: t[0],
        tz: t[2],
        side,
      };
      return {
        stand: stand
          ? [stand.x, stand.z]
          : [P[0] - t[0] * 10, P[1] - t[2] * 10],
        at: [P[0], P[1]],
        side,
      };
    },
    // every way across the menu may ask for: [stretch, side]
    routes: () => routes,
    pendingIn: () => (pending ? max(pending.at - clock, 0) : -1),
    // what each deer is doing: state, x, z, neck pitch, whether it is shown (the herd, then the runners); each
    // hoof's height over the ground, each leg's bend (degrees), the body's pitch (degrees), which feet are down
    state: () =>
      [...herd, ...runners].map((d) => [
        d.state,
        +d.x.toFixed(1),
        +d.z.toFixed(1),
        +d.neck.toFixed(2),
        d.on || (d.awake && !d.away) ? 1 : 0,
        d.hoof.map((v) => +v.toFixed(3)),
        d.bend.map((v) => +v.toFixed(1)),
        +((d.pitch * 180) / PI).toFixed(1),
        d.feet.map((f) => (f.down ? 1 : 0)),
      ]),
    // sets herd deer i about something now: graze, look (the head up), alert, moveoff; looking away from x, z
    force(i, what, x, z) {
      const d = herd[i];
      d.held = null;
      d.state = what;
      d.until = clock + (what === 'moveoff' ? 2 : 8);
      d.lookTo = 0.5;
      if (x !== undefined) d.goalYaw = atan2(d.x - x, d.z - z);
      return d.state;
    },
    // A walk of `seconds` along the side paths (each out and back in turn, at 1.4 m/s, in fair weather), the
    // crossings it would set off counted and none run; the deer's own clock is put back after
    walkTest(seconds, odds = CHANCE) {
      const keep = [clock, lastCross, rolled, rolledAt],
        route = [];
      for (let b = 1; b < paths.length; b++)
        route.push(...paths[b], ...paths[b].slice().reverse());
      let n = 0,
        i = 0,
        pos = 0;
      clock = FIRST + 1;
      lastCross = -1e9;
      rolls = 0;
      chance = odds;
      for (let t = 0; t < seconds; t += 0.25) {
        clock += 0.25;
        pos += 1.4 * 0.25;
        while (pos >= 1 && i < route.length * 50) {
          pos -= 1;
          i++;
        }
        const a = route[i % route.length],
          b = route[(i + 1) % route.length],
          l = hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const w = {
          x: a[0],
          y: ground(a[0], a[1]) + 1.65,
          z: a[1],
          fx: (b[0] - a[0]) / l,
          fz: (b[1] - a[1]) / l,
          speed: 1.4,
        };
        if (maybeCross(w, { rain: 0, storm: 0 })) {
          n++;
          for (const d of runners) d.on = false;
        }
      }
      [clock, lastCross, rolled, rolledAt] = keep;
      chance = CHANCE;
      return [n, rolls];
    },
    // what decides where they live and cross, at x, z: the crowns' cover, metres to water, to anything built, to an
    // opening, the path's half width there; and how many homes they have
    probe: (x, z) => [
      canopy(x, z),
      min(creekAt(x, z)[0], lakeD(x, z)),
      woodwork.reduce((m, w) => min(m, hypot(w[0] - x, w[1] - z)), 1e9),
      OPEN.reduce((m, o) => min(m, hypot(x - o[0], z - o[1]) - o[2]), 1e9),
      trailHalf(trailK(x, z)),
      homes.length,
    ],
    // a still: herd deer i at x, z facing yaw in a held pose (stand, graze, alert, walk); none: let it go again
    hold(i, poseName, x, z, yaw) {
      const d = herd[i];
      if (!poseName) {
        d.held = null;
        return null;
      }
      d.held = poseName;
      d.awake = true;
      d.away = false;
      count = max(count, i + 1);
      place(d, x, z, yaw);
      const h =
        HEADS[
          poseName === 'alert'
            ? 'alert'
            : poseName === 'graze'
              ? 'graze'
              : poseName === 'walk'
                ? 'walk'
                : 'stand'
        ];
      d.neck = h[0];
      d.head = h[1];
      d.ears = [h[2], h[2]];
      d.earKick = [0, 0];
      d.look = 0;
      d.tail = -1.25;
      return [d.x, d.y, d.z];
    },
  };
}
