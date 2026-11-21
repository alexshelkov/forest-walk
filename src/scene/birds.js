// ============================================================================
// birds: a small mind on the CPU, the pose in the vertex shader (W_ANIM vsBird)
// ============================================================================
// A bird is one instance of 12 floats: where its feet are and its length; a quaternion; its species with its own
// seed in the fraction; the wings' phase; how far they are spread (2 more while it is in the air); the head's
// turn with the tail's fan in the whole part. update() moves the birds by the scene's clock and writes the
// instances of those awake, sorted by mesh, and a dark blot for each one on or just over the ground.
// Nothing here runs on a clock: every wait and every choice is drawn anew.
import {
  abs,
  atan2,
  clamp,
  cos,
  exp,
  floor,
  hypot,
  max,
  Mesh,
  min,
  mix,
  PI,
  qAxis,
  qMul,
  sin,
  sqrt,
  TAU,
} from './math.js';

// the body's axis over the feet, in lengths (vsBird and fsBird know it too)
const AXIS = 0.3;
// What a bird is, by species (the index is what fsBird paints by). shape: 0 the songbird's mesh, 1 the jay's. len:
// metres. notice, leave: how near the walker comes before it stops what it does, and before it goes. speed: on the
// wing. beat: the wingbeats a second it is shown at (a real small bird's would strobe). wing: how it flies: in
// bounds (a burst of beats, then shut), steadily, or a few beats and a glide. high: how far over the ground it
// perches. sits: about how long between two things it does on a branch; hops, flits: how often that thing is a
// hop along the branch, or a flight to another
const SPECIES = [
  {
    name: 'junco',
    shape: 0,
    len: 0.15,
    notice: 8,
    leave: 4.6,
    speed: 7,
    beat: 12,
    wing: 'bound',
    high: [2.5, 7],
    sits: 6,
    hops: 0,
    flits: 0,
  },
  {
    name: 'chickadee',
    shape: 0,
    len: 0.13,
    notice: 5,
    leave: 2.6,
    speed: 6,
    beat: 12,
    wing: 'bound',
    high: [2.5, 9],
    sits: 1.4,
    hops: 0.3,
    flits: 0.45,
  },
  {
    name: 'thrush',
    shape: 0,
    len: 0.24,
    notice: 9,
    leave: 5.5,
    speed: 8,
    beat: 9,
    wing: 'steady',
    high: [2.5, 5.5],
    sits: 9,
    hops: 0.05,
    flits: 0.03,
  },
  {
    name: 'jay',
    rest: 0.5,
    restGround: 0.22,
    shape: 1,
    len: 0.42,
    notice: 9,
    leave: 4.2,
    speed: 9,
    beat: 6,
    wing: 'glide',
    high: [0.8, 8],
    sits: 2.4,
    hops: 0.25,
    flits: 0.025,
    picks: 0.12, // how often the next thing it does on a perch is to bend and pick at it
    ruffles: 0.05, // or to fluff its feathers and shake
  },
  {
    // (1.2 times life: a common raven of 0.6 m; its mesh 0.98 of its length from bill tip to tail tip)
    name: 'raven',
    rest: 0.65,
    restGround: 0.38,
    shape: 2,
    len: 0.73,
    notice: 16,
    leave: 9, // (about 9 m: its boldness spreads it from 7.4 to 10.6)
    speed: 10,
    beat: 3.5,
    beatUp: 1.1, // (its beats off the perch and to land, against its own: deep and slow still)
    beatDown: 1.3,
    wing: 'glide',
    glide: 0.35, // the wingbeat's phase it glides at (vsJay's Form: the arms a little raised, the hands level)
    bursts: [1, 2.4, 0.9, 1.7], // seconds of glide, then of beating (each from, to)
    fanFly: 0.65, // its tail in flight: a spread wedge
    climb: 0.3, // off the ground low, then climbing
    crouch: 0.25,
    high: [1, 12],
    sits: 4,
    hops: 0.1,
    flits: 0.01,
    picks: 0.08,
    ruffles: 0.04,
  },
];
// How many jays there are and how seldom they fly, to turn without reading the code. JAYS: how many in the world
// (the debug menu sets it too), of which so many on the side paths and the rest along the loop; the least metres
// of path between two of them on the loop; how many metres into the walk the first one lives; the seconds of
// walking between two flights across the path ahead (about, and at the least)
export const JAYS = 6,
  JAYS_ON_SIDE_PATHS = 1,
  JAY_SPACING = 60,
  FIRST_JAY_AT = 20,
  CROSSING_EVERY = 105,
  CROSSING_LEAST = 40;
// The ravens: a pair, each at home by two snags in the open (the meadow's edge, the lake's shore), and kept where a
// walker's eye is: on low perches beside the path near them (rail, fence and sign posts; the high snags only a
// refuge) and on the path itself. RAVEN_REACH: metres from its snags such a perch or a walk may lie
export const RAVENS = 2,
  RAVEN_REACH = 26;
// AWAY_LEG: metres of each further leg a raven flies on while still seen when its way out of sight ends; AWAY_LEGS:
// at most so many
const AWAY_LEG = 25,
  AWAY_LEGS = 6,
  OPEN_SKY = 40, // a place has open sky over it where less crown than this lies straight up (scene.js veil)
  // PATH_LEAVE: how near a walker who keeps to the path may come before a raven goes (off the path, the species'
  // leave); DOWN: how often the next thing a raven on a low perch does is to come down and walk the path, the
  // meadow's and the lake's
  PATH_LEAVE = 4,
  DOWN = [0.4, 0.1],
  RAIL_TOP = 2, // metres over the ground above which a raven on the wing minds no rail (clearWay)
  // a flyover counts a place seen inside a level view's frame: across and up from the eye, as tangents (a little
  // inside scene.js TANW and TANH0)
  FRAME_W = 0.45,
  FRAME_UP = 0.5;
const MOST = 24; // the most birds there may be at once: the instance buffers are made once
const STRIDE = 0.2; // a raven's step, in its lengths (vsJay's Form.stride)
const NEAR = 9; // metres: beyond it the far mesh
const SLEEP = 70; // metres from its group's home: beyond it a group neither moves nor is drawn

// A bird's mesh, nose at +z, a length of 1 from bill to tail tip, its feet at the origin. A vertex's aux says what it
// is: 0 the body, 0.06 to 0.13 the tail (outward), -0.07 a leg, -0.12 an eye, over 0.15 a wing (how far out along
// it, signed by side). far: fewer sides, no legs or eyes. rings: bill tip to tail root, each z, radius, height over
// the axis; wing: its shoulder's x, its span, its leading edge at the root, its chord at root and tip; tail: rows
// from root to tip, each z, half its width, half its depth; eye: x, height over the axis, z; crest: a jay's
function meshOf({ rings, wing, tail, eye, crest }, far) {
  const m = new Mesh();
  m.tube(
    rings.map((ring) => [0, AXIS + ring[2], ring[0]]),
    (k) => rings[k][1],
    far ? 4 : 6,
    true,
    () => 0,
  );
  // the wings: flat, from the shoulder out; shut, the shader draws them into the body
  const stations = far ? [0, 0.45, 1] : [0, 0.22, 0.45, 0.72, 1];
  for (const side of [-1, 1]) {
    const edge = stations.map((out) => {
      const x = side * (wing[0] + wing[1] * out),
        lead = wing[2] - 0.1 * out * out,
        aux = side * (0.2 + 0.8 * out);
      return [
        m.v(x, AXIS + 0.05, lead, aux),
        m.v(x, AXIS + 0.05, lead - mix(wing[3], wing[4], out * out), aux),
      ];
    });
    for (let k = 0; k < edge.length - 1; k++)
      m.quad(edge[k][0], edge[k + 1][0], edge[k + 1][1], edge[k][1]);
  }
  // The tail: a flat wedge of feathers, which the shader fans. Its two edges (aux 0.13) are the outer feathers,
  // white on a junco; its middle (aux 0.06) is dark
  const rows = (far ? [tail[0], tail[tail.length - 1]] : tail).map(
    ([z, wide, deep]) => {
      const y = AXIS - 0.01 + (z - tail[0][0]) * 0.1;
      return [
        m.v(0, y + deep, z, 0.06),
        m.v(wide, y, z, 0.13),
        m.v(0, y - deep, z, 0.06),
        m.v(-wide, y, z, 0.13),
      ];
    },
  );
  for (let k = 0; k < rows.length - 1; k++)
    for (let side = 0; side < 4; side++)
      m.quad(
        rows[k][side],
        rows[k][(side + 1) % 4],
        rows[k + 1][(side + 1) % 4],
        rows[k + 1][side],
      );
  m.quad(...rows[rows.length - 1]);
  if (far) return m;
  if (crest) {
    // a jay's crest: a small pyramid on the crown, its point up and back
    const [front, back, tip] = crest.map((p) => m.v(0, AXIS + p[0], p[1], 0)),
      mid = [(crest[0][0] + crest[1][0]) / 2, (crest[0][1] + crest[1][1]) / 2],
      left = m.v(-0.035, AXIS + mid[0], mid[1], 0),
      right = m.v(0.035, AXIS + mid[0], mid[1], 0);
    m.tri(front, left, tip);
    m.tri(left, back, tip);
    m.tri(back, right, tip);
    m.tri(right, front, tip);
  }
  for (const side of [-1, 1]) {
    // two legs a little apart, one a step ahead of the other, each with its toes
    const z = side * 0.05;
    m.tube(
      [
        [side * 0.065, AXIS - 0.1, z - 0.03],
        [side * 0.07, 0, z],
      ],
      () => 0.012,
      3,
      true,
      () => -0.07,
    );
    m.tri(
      m.v(side * 0.07, 0.004, z - 0.015, -0.07),
      m.v(side * 0.11, 0.004, z + 0.08, -0.07),
      m.v(side * 0.035, 0.004, z + 0.08, -0.07),
    );
    // an eye: an octahedron
    const r = 0.02,
      corners = [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 1, 0],
        [0, -1, 0],
        [0, 0, 1],
        [0, 0, -1],
      ].map((d) =>
        m.v(
          side * eye[0] + d[0] * r,
          AXIS + eye[1] + d[1] * r,
          eye[2] + d[2] * r,
          -0.12,
        ),
      );
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
      m.tri(corners[f[0]], corners[f[1]], corners[f[2]]);
  }
  return m;
}
// the songbird (junco, chickadee, thrush): plump, the head carried high, a short bill
export const meshSongbird = (far) =>
  meshOf(
    {
      rings: far
        ? [
            [0.5, 0.004, 0.09],
            [0.36, 0.11, 0.11],
            [0.1, 0.17, 0],
            [-0.08, 0.155, -0.02],
            [-0.25, 0.03, 0],
          ]
        : [
            [0.5, 0.004, 0.09],
            [0.43, 0.036, 0.1],
            [0.39, 0.085, 0.115],
            [0.32, 0.118, 0.115],
            [0.23, 0.115, 0.075],
            [0.1, 0.17, 0],
            [-0.06, 0.16, -0.02],
            [-0.19, 0.085, -0.015],
            [-0.25, 0.03, 0],
          ],
      wing: [0.07, 0.6, 0.18, 0.3, 0.1],
      tail: [
        [-0.19, 0.022, 0.03],
        [-0.36, 0.045, 0.024],
        [-0.5, 0.055, 0.016],
      ],
      eye: [0.1, 0.135, 0.345],
    },
    far,
  );
// the jay: longer in the tail and the bill, a crest on the crown, broad wings
export const meshJay = (far) =>
  meshOf(
    {
      rings: far
        ? [
            [0.5, 0.004, 0.1],
            [0.33, 0.095, 0.125],
            [0.14, 0.125, 0.02],
            [0.0, 0.12, -0.01],
            [-0.14, 0.03, 0],
          ]
        : [
            [0.5, 0.004, 0.1],
            [0.41, 0.04, 0.11],
            [0.375, 0.075, 0.125],
            [0.31, 0.1, 0.125],
            [0.25, 0.09, 0.09],
            [0.14, 0.125, 0.02],
            [0.02, 0.125, -0.01],
            [-0.08, 0.07, -0.01],
            [-0.14, 0.03, 0],
          ],
      wing: [0.07, 0.62, 0.21, 0.3, 0.14],
      tail: [
        [-0.1, 0.03, 0.028],
        [-0.3, 0.05, 0.022],
        [-0.5, 0.06, 0.014],
      ],
      eye: [0.085, 0.14, 0.335],
      crest: [
        [0.215, 0.375],
        [0.2, 0.3],
        [0.37, 0.3],
      ],
    },
    far,
  );

// The crow family's birds (the jay, the raven): one build of parts that vsJay moves each in its own way, from a form
// of numbers. A vertex's aux is a whole number of 127ths that says which part it is: 0 the body and the bill; 3 to
// 11 (signed by side) a tail feather, the further out the higher; -14 a leg, -16 a toe, -18 an eye, -20 a crest
// feather, -22 a throat hackle; 26 and over (signed by side) the wing, by how far out along its bones the feather's
// root lies. A feather's vertex keeps in its normal where it is across the vane (-1 to 1) and along it (0 to 1;
// under 0 the wing's coverts): a feather is lit by where it sits, not by its own face. Built level, the wings
// spread, the tail shut, the crest raised. far: the same parts, fewer of each, so the one hands over to the other
// without a jump. (vsJay's Form holds the wing's, tail's, foot's and head's numbers of each: kept the same)
function meshCorvid(form, far) {
  // (a jay carries its body lower over its feet than the songbird: vsJay's JAX; a raven higher, on long legs: RAX)
  const AX = AXIS - 0.1 + (form.lift || 0),
    m = new Mesh(),
    vane = new Map(),
    fv = (x, y, z, code, across, along) => {
      vane.set(`${x},${y},${z}`, [across, along]);
      return m.v(x, y, z, code / 127);
    };
  // A feather from `root` along `way`, its width along `wide` (both unit, as x y z): broad, a little narrower at
  // its root, rounded to a point at its tip (or, `fingered`, narrowed over its outer part). Laid close, feathers
  // overlap like tiles into one surface
  const feather = (root, way, wide, len, half, code, fingered) => {
    const at = (along, across) =>
      fv(
        root[0] + way[0] * len * along + wide[0] * half * across,
        root[1] + way[1] * len * along + wide[1] * half * across,
        root[2] + way[2] * len * along + wide[2] * half * across,
        code,
        across,
        along,
      );
    const edges = (
      far
        ? [
            [0, 0.85],
            [0.9, fingered ? 0.45 : 0.9],
          ]
        : fingered
          ? [
              [0, 0.85],
              [0.45, 1],
              [0.65, 0.55],
              [0.93, 0.42],
            ]
          : [
              [0, 0.85],
              [0.55, 1],
              [0.9, 0.8],
            ]
    ).map(([along, share]) => [at(along, -share), at(along, share)]);
    for (let k = 0; k < edges.length - 1; k++)
      m.quad(edges[k][0], edges[k + 1][0], edges[k + 1][1], edges[k][1]);
    const last = edges[edges.length - 1];
    m.tri(last[0], at(1, 0), last[1]);
  };
  // A loft of rings, each z, its middle over the axis, its half width, its reach up and its reach down, closed at
  // both ends (by `ends`: how far past the first and the last ring)
  const loft = (all, sides, ends) => {
    const rings = far
        ? all.filter((_, k) => k % 2 === 0 || k === all.length - 1)
        : all,
      rows = rings.map(([z, y, wide, up, down]) =>
        Array.from({ length: sides }, (_, s) => {
          const a = (s / sides) * TAU;
          return m.v(
            wide * sin(a),
            AX + y + (cos(a) > 0 ? up : down) * cos(a),
            z,
            0,
          );
        }),
      );
    for (let k = 0; k < rows.length - 1; k++)
      for (let s = 0; s < sides; s++) {
        const t = (s + 1) % sides;
        m.quad(rows[k][s], rows[k][t], rows[k + 1][t], rows[k + 1][s]);
      }
    for (const [row, ring, by] of [
      [rows[0], rings[0], ends[0]],
      [rows[rows.length - 1], rings[rings.length - 1], ends[1]],
    ]) {
      const end = m.v(0, AX + ring[1], ring[0] + by, 0);
      for (let s = 0; s < sides; s++) m.tri(row[s], row[(s + 1) % sides], end);
    }
  };
  // the body from the face to the tail's root
  loft(form.body, far ? 6 : 12, [0.008, -0.025]);
  // The bill, set into the face: tubes (the jay's upper half hooked down a little at its tip, a shorter lower
  // half), or rings of its own (the raven's deep one)
  if (form.bill.rings) loft(form.bill.rings, far ? 4 : 8, [0.004, 0.004]);
  else
    for (const [y0, y1, y2, reach, thick] of far
      ? form.bill.far
      : form.bill.near)
      m.tube(
        [
          [0, AX + y0, 0.39],
          [0, AX + y1, 0.45],
          [0, AX + y2, reach],
        ],
        (k) => [thick, thick * 0.65, 0.003][k],
        far ? 3 : 5,
        true,
        () => 0,
      );
  // The jay's crest: a short tuft swept back off the crown. Its feathers rise from along the crown and all but meet
  // at one point up and behind it (each a little short of it or past it: a ragged tip), so they lie over one
  // another into one pointed shape; each of two narrow blades (one across the head, one along it), so the tuft
  // has body from the side and from the front
  if (form.crest)
    for (let k = 0; k < (far ? 2 : 5); k++) {
      const kk = far ? k * 3 : k,
        root = [0, AX + 0.178 - 0.003 * kk, 0.375 - 0.017 * kk],
        rise = AX + 0.275 - root[1],
        back = root[2] - 0.235,
        len = hypot(rise, back),
        way = [0, rise / len, -back / len];
      for (const wide of far
        ? [[1, 0, 0]]
        : [
            [1, 0, 0],
            [0, back / len, rise / len],
          ])
        feather(root, way, wide, len * (0.86 + 0.07 * (kk % 3)), 0.014, -20);
    }
  // The raven's hackles: narrow pointed feathers hanging from the throat in rows, splayed a little, shaggy
  if (form.hackles) {
    // (each row on the throat's surface: its middle over the axis, its half width, its reach down, from the body's
    // rings either side of its z)
    const { rows: rowsAt, n, len, half, way: hang } = form.hackles,
      ringAt = (z) => {
        const k = form.body.findIndex((ring) => ring[0] <= z),
          [a, b] = [form.body[k - 1], form.body[k]],
          t = (z - b[0]) / (a[0] - b[0]);
        return [z, mix(b[1], a[1], t), mix(b[2], a[2], t), mix(b[4], a[4], t)];
      };
    for (const [z, y, wide, down] of (far ? rowsAt.slice(1, 2) : rowsAt).map(
      ringAt,
    ))
      for (let k = 0; k < (far ? 3 : n); k++) {
        const a = ((far ? k / 2 : k / (n - 1)) - 0.5) * 2.2,
          root = [sin(a) * wide * 0.95, AX + y - cos(a) * down * 0.97, z],
          way = [sin(a) * hang[0], hang[1], hang[2]],
          wl = hypot(...way);
        // (its vane along the throat's surface there)
        const across = [cos(a) * wide, sin(a) * down, 0],
          al = hypot(...across);
        feather(
          root,
          way.map((c) => c / wl),
          across.map((c) => c / al),
          len * (0.85 + 0.3 * ((k * 7) % 3) * 0.5),
          far ? half * 1.6 : half,
          -22,
        );
      }
  }
  // The tail: feathers stacked into one long blade, the middle pair on top, the outer ones shorter; a raven's
  // outer ones lower and tilted, a shallow keel that has some depth seen from the side
  const tail = form.tail;
  for (let k = -4; k <= 4; k += far ? 2 : 1)
    feather(
      [k * 0.006, AX + tail.y - abs(k) * tail.drop, tail.root],
      [0, -0.03, -0.9995],
      [cos(abs(k) * tail.keel), -sin(k * tail.keel), 0],
      tail.len - abs(k) * tail.short,
      far ? tail.farHalf : tail.half,
      (k < 0 ? -1 : 1) * (3 + 2 * abs(k)),
    );
  // The wings, spread: the bones run out along z `wing.z` from the shoulder (x `wing.x`): the arm to the wrist,
  // then the hand. Coverts over the bones, secondaries on the arm, primaries crowded on the hand (vsJay fans them out
  // to the wingtip, and folds the whole wing onto the flank). A raven's outer primaries are narrowed: fingers
  const wing = form.wing,
    { arm, hand } = wing;
  for (const side of [-1, 1]) {
    const code = (out) => side * (26 + Math.round((out / wing.len) * 101)),
      x = (out) => side * (wing.x + out),
      lead = (far ? wing.farCoverts : wing.coverts).map((out) => [
        fv(x(out), AX + 0.074, wing.z + 0.004, code(out), 0, -0.3),
        fv(x(out), AX + 0.072, wing.covert, code(out), 0, -0.1),
      ]);
    for (let k = 0; k < lead.length - 1; k++)
      m.quad(lead[k][0], lead[k + 1][0], lead[k + 1][1], lead[k][1]);
    const nArm = far ? arm.farN : arm.n;
    for (let k = 0; k < nArm; k++) {
      const out = far
        ? arm.farFirst + k * arm.farStep
        : arm.first + k * arm.step;
      feather(
        [x(out), AX + 0.07 - 0.0012 * k, arm.z],
        [0, 0, -1],
        [side, 0, 0],
        arm.len,
        far ? arm.farHalf : arm.half,
        code(out),
      );
    }
    const nHand = far ? hand.farN : hand.n;
    for (let k = 0; k < nHand; k++) {
      const out = hand.first + k * (far ? hand.farStep : hand.step);
      feather(
        [x(out), AX + 0.061 - 0.0012 * k, hand.z],
        [0, 0, -1],
        [side, 0, 0],
        hand.len + (far ? hand.farGrow : hand.grow) * k,
        far ? hand.farHalf : hand.half,
        code(out),
        hand.fingers > 0 &&
          k >= nHand - (far ? hand.fingers / 2 : hand.fingers),
      );
    }
    // A leg: from under the belly's feathers back to the heel, then the shank forward and down to the foot; three
    // toes forward and one back, a little arched
    const leg = form.leg,
      foot = [side * leg.foot[0], leg.foot[1], leg.foot[2]],
      hip = [side * leg.hip[0], AX + leg.hip[1], leg.hip[2]],
      heel = [side * leg.heel[0], leg.heel[1], leg.heel[2]];
    m.tube(
      [hip, heel, foot],
      (k) => leg.thick[k],
      far ? 3 : 4,
      true,
      () => -14 / 127,
    );
    // (a raven's thigh, feathered: body, down the first half of the leg)
    if (leg.thigh)
      m.tube(
        [0, 0.3, 0.6].map((along) => hip.map((c, k) => mix(c, heel[k], along))),
        (k) => leg.thigh[k],
        far ? 4 : 6,
        true,
        () => 0,
      );
    if (far) continue;
    for (const [turn, len] of leg.toes)
      m.tube(
        [0, 0.5, 1].map((along) => [
          foot[0] + sin(turn) * len * along,
          foot[1] + 0.007 * sin(along * PI) - 0.006 * along,
          foot[2] + cos(turn) * len * along,
        ]),
        (k) => leg.toeThick[k],
        3,
        true,
        () => -16 / 127,
      );
    // an eye: a bead that stands a little proud of the head
    const [ex, ey, ez, r] = form.eye,
      corners = [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 1, 0],
        [0, -1, 0],
        [0, 0, 1],
        [0, 0, -1],
      ].map((d) =>
        m.v(side * ex + d[0] * r, AX + ey + d[1] * r, ez + d[2] * r, -18 / 127),
      );
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
      m.tri(corners[f[0]], corners[f[1]], corners[f[2]]);
  }
  return {
    build: () =>
      m.build((x, y, z, nx, ny, nz) => {
        const at = vane.get(`${x},${y},${z}`);
        return at ? [at[0] * 0.7, at[1] * 0.7, 0.7] : [nx, ny, nz];
      }),
  };
}
// The Steller's jay: a skull with a flat crown, a short thick neck, a full breast, the belly's feathers hanging
// over the tops of the legs, the back sloping away to the tail; a crest; the wing's bones 0.62 long, the wrist 0.26
// out. About 830 triangles near, 200 far
const JAY = {
  body: [
    [0.415, 0.105, 0.03, 0.03, 0.028],
    [0.395, 0.108, 0.058, 0.05, 0.045],
    [0.365, 0.112, 0.074, 0.066, 0.062],
    [0.33, 0.115, 0.08, 0.07, 0.072],
    [0.295, 0.113, 0.078, 0.068, 0.074],
    [0.26, 0.1, 0.076, 0.066, 0.08],
    [0.22, 0.08, 0.088, 0.075, 0.1],
    [0.17, 0.05, 0.108, 0.09, 0.125],
    [0.11, 0.025, 0.122, 0.1, 0.14],
    [0.04, 0.01, 0.122, 0.1, 0.135],
    [-0.03, 0.005, 0.11, 0.09, 0.115],
    [-0.09, 0.01, 0.085, 0.07, 0.08],
    [-0.14, 0.02, 0.05, 0.04, 0.04],
  ],
  bill: {
    near: [
      [0.11, 0.106, 0.094, 0.5, 0.02],
      [0.089, 0.089, 0.091, 0.49, 0.015],
    ],
    far: [[0.1, 0.098, 0.094, 0.5, 0.022]],
  },
  crest: true,
  tail: {
    root: -0.14,
    y: 0.03,
    len: 0.4,
    short: 0.012,
    half: 0.03,
    farHalf: 0.05,
    drop: 0.0025,
    keel: 0,
  },
  wing: {
    x: 0.07,
    z: 0.21,
    len: 0.62,
    covert: 0.125,
    coverts: [0, 0.09, 0.18, 0.26, 0.31, 0.36],
    farCoverts: [0, 0.18, 0.36],
    arm: {
      n: 7,
      first: 0.03,
      step: 0.034,
      farN: 3,
      farFirst: 0.05,
      farStep: 0.08,
      z: 0.16,
      len: 0.2,
      half: 0.034,
      farHalf: 0.06,
    },
    hand: {
      n: 8,
      first: 0.27,
      step: 0.0125,
      farN: 4,
      farStep: 0.029,
      z: 0.16,
      len: 0.2,
      grow: 0.009,
      farGrow: 0.02,
      half: 0.034,
      farHalf: 0.05,
      fingers: 0,
    },
  },
  leg: {
    hip: [0.05, -0.055, 0.05],
    heel: [0.058, 0.078, -0.04],
    foot: [0.055, 0.012, 0],
    thick: [0.02, 0.011, 0.009],
    toes: [
      [-0.5, 0.08],
      [0, 0.09],
      [0.5, 0.08],
      [PI, 0.06],
    ],
    toeThick: [0.009, 0.007, 0.002],
  },
  eye: [0.066, 0.125, 0.365, 0.014],
};
// The common raven: a deep bill as long as the head with an arched ridge, a flat crown, a thick neck with shaggy
// hackles standing out under the bill, a heavy chest and belly, a broad blunt wedge of a tail about as long as the
// body without the head, stout legs feathered to the heel; the wings one and a half times its length across (the
// bones 1.18 long, the wrist 0.48 out), the outer six primaries fingers
const RAVEN = {
  lift: 0.1,
  body: [
    [0.372, 0.101, 0.03, 0.033, 0.03],
    [0.358, 0.105, 0.052, 0.047, 0.046],
    [0.335, 0.109, 0.068, 0.058, 0.063],
    [0.305, 0.111, 0.078, 0.063, 0.079],
    [0.275, 0.104, 0.09, 0.068, 0.108],
    [0.24, 0.088, 0.102, 0.075, 0.136],
    [0.2, 0.068, 0.114, 0.085, 0.163],
    [0.15, 0.045, 0.124, 0.098, 0.205],
    [0.085, 0.028, 0.13, 0.105, 0.238],
    [0.015, 0.018, 0.126, 0.103, 0.222],
    [-0.045, 0.016, 0.108, 0.092, 0.181],
    [-0.09, 0.018, 0.082, 0.071, 0.114],
    [-0.12, 0.024, 0.052, 0.045, 0.053],
  ],
  bill: {
    rings: [
      [0.37, 0.1, 0.031, 0.037, 0.032],
      [0.4, 0.099, 0.025, 0.033, 0.027],
      [0.43, 0.098, 0.02, 0.029, 0.022],
      [0.46, 0.095, 0.015, 0.023, 0.016],
      [0.485, 0.089, 0.01, 0.015, 0.01],
      [0.5, 0.079, 0.003, 0.004, 0.003],
    ],
  },
  hackles: {
    rows: [0.352, 0.325, 0.295, 0.262, 0.225], // (each z: a row round the throat, on the body's surface there)
    n: 7,
    len: 0.1,
    half: 0.02,
    way: [0.35, -0.75, -0.45],
  },
  tail: {
    root: -0.12,
    y: 0.03,
    len: 0.36,
    short: 0.008,
    half: 0.058,
    farHalf: 0.088,
    drop: 0.009,
    keel: 0.1,
  },
  wing: {
    x: 0.07,
    z: 0.19,
    len: 1.18,
    covert: 0.09,
    coverts: [0, 0.12, 0.24, 0.36, 0.46, 0.56, 0.66],
    farCoverts: [0, 0.24, 0.46, 0.66],
    arm: {
      n: 11,
      first: 0.03,
      step: 0.04,
      farN: 4,
      farFirst: 0.05,
      farStep: 0.13,
      z: 0.13,
      len: 0.27,
      half: 0.03,
      farHalf: 0.07,
    },
    hand: {
      n: 10,
      first: 0.48,
      step: 0.02,
      farN: 5,
      farStep: 0.045,
      z: 0.13,
      len: 0.27,
      grow: 0.028,
      farGrow: 0.06,
      half: 0.032,
      farHalf: 0.05,
      fingers: 6,
    },
  },
  leg: {
    hip: [0.055, -0.06, 0.045],
    heel: [0.066, 0.12, -0.05],
    foot: [0.065, 0.012, 0],
    thick: [0.04, 0.026, 0.023],
    thigh: [0.072, 0.066, 0.042], // (feathered: the belly's feathers down over the top of the leg)
    toes: [
      [-0.45, 0.12],
      [0, 0.13],
      [0.45, 0.11],
      [PI, 0.09],
    ],
    toeThick: [0.018, 0.013, 0.005],
  },
  eye: [0.058, 0.124, 0.338, 0.013],
};
export const meshJayNear = (far) => meshCorvid(JAY, far);
export const meshRaven = (far) => meshCorvid(RAVEN, far);
// how far a bird's body is pitched up at rest: a jay sits upright on a perch, less so on the ground
const restOf = (bird) =>
  bird.mode === 'perch'
    ? (bird.kind.rest ?? 0.12)
    : (bird.kind.restGround ?? 0.12);

// a thin round stick for under a bird on a dead branch (the branch itself is a flat card): along z from -1 to 1,
// pointed at both ends; aux -24 (vsJay leaves it as built, fsJay paints it as bark, darker under the bird)
export function meshPerchStick() {
  const m = new Mesh(),
    wide = [0.004, 0.028, 0.03, 0.03, 0.028, 0.004];
  m.tube(
    [-1, -0.7, -0.2, 0.2, 0.7, 1].map((z) => [0, 0, z]),
    (k) => wide[k],
    5,
    true,
    () => -24 / 127,
  );
  return m;
}
const chance = () => Math.random();
const between = (a, b) => a + (b - a) * chance();
// a bell-shaped draw about 0
const gauss = () => sqrt(-2 * Math.log(1 - chance())) * cos(TAU * chance());
// a wait of about `mean` seconds, never the same twice: from a third of it to three times it
const wait = (mean) => mean * clamp(exp(0.6 * gauss()), 1 / 3, 3);
const smooth = (s) => s * s * (3 - 2 * s);
// the smaller angle from a to b
const turnTo = (a, b) => {
  const d = (b - a) % TAU;
  return d > PI ? d - TAU : d < -PI ? d + TAU : d;
};

// makeBirds: ground(x, z) the height stood on; avoid(x, z, pad) a place moved out of trunks, rocks and rails; dry(x,
// z) is it land a bird may stand on; perches: the dead branches to sit on, 8 numbers each (world.js: root x y z,
// length, bearing, tilt, bend, 0); groups: who lives where: x, z of its home, r its range, n how many, species,
// and lives 'ground' (a flock that feeds on the ground and flies up to branches) or 'tree'
export function makeBirds({
  ground,
  avoid,
  standing, // standing(x, z, pad): is a trunk, boulder, log or post within pad of a place (rails not counted)?
  dry,
  perches,
  tops,
  homes,
  count,
  open, // open(x, z): is a place on open ground or by water (no jay crosses there)?
  paths, // every path as its points (x, z) a metre apart, the loop first: what a jay crosses
  pale, // pale(x, z): is the ground there a path's (a bird seen against it stands out)?
  ravenTops, // where the ravens stand on their snags (x, y z each): the first two the meadow's, then the lake's
  ravenLows, // the ravens' low perches (x, y z each): post tops a metre to three high beside a path
  openGround, // openGround(x, z): may a raven walk there (the meadow's grass, the shore, a path)?
  veil, // veil(x, y, z, dx, dy, dz, far): how much crown lies along a ray (scene.js; under 30 the sky shows clear)
}) {
  let groups = []; // who lives where (homes(n), scene.js): populate fills it
  const birds = [],
    nBranch = perches.length / 8,
    // (the branches first, then the tops of posts, then the ravens' snags and low perches: theirs alone)
    allTops = [...tops, ...ravenTops.flat(), ...ravenLows.flat()],
    nShared = nBranch + tops.length / 3,
    nLow = nShared + ravenTops.length,
    nPerch = nLow + ravenLows.length,
    taken = new Array(nPerch).fill(null);
  let ravenCount = RAVENS;
  let on = true,
    heed = true, // do they mind the walker? (off for stills from close by)
    lastFlight = -1e3, // when a bird last took wing
    clock = 0;
  // where a branch is, `along` of the way out it (world.js onLeaf: the leaf shader's own curve)
  const branch = (k, along, out) => {
    if (k >= nBranch) {
      // (a post's top: one place)
      const t = (k - nBranch) * 3;
      out[0] = allTops[t];
      out[1] = allTops[t + 1];
      out[2] = allTops[t + 2];
      return out;
    }
    const o = k * 8,
      len = perches[o + 3],
      yaw = perches[o + 4],
      tilt = perches[o + 5],
      ka = (perches[o + 6] - 0.3) * 3.4 || 0.06,
      a = (sin(ka * along) / ka) * len,
      b = ((1 - cos(ka * along)) / ka) * len,
      reach = sin(tilt) * a + cos(tilt) * b;
    out[0] = perches[o] + reach * cos(yaw);
    out[1] = perches[o + 1] + cos(tilt) * a - sin(tilt) * b;
    out[2] = perches[o + 2] + reach * sin(yaw);
    return out;
  };
  // each branch's sitting place (0.6 of the way out) and its height over the ground
  const seat = new Float32Array(nPerch * 4);
  for (let k = 0; k < nPerch; k++) {
    const p = branch(k, 0.6, [0, 0, 0]);
    seat.set([p[0], p[1], p[2], p[1] - ground(p[0], p[2])], k * 4);
  }
  // the way a branch runs (a post's top: any way)
  const stickYaw = (k) => (k < nBranch ? perches[k * 8 + 4] : 0);
  // where a bird's feet are on its branch (a little over the stick's middle line) or on a post's top
  const feet = (bird, k, along) => {
    const p = branch(k, along, [0, 0, 0]);
    p[1] += k < nBranch ? 0.03 * bird.len : 0.005;
    return p;
  };
  const groundSpot = (group, walker, least) => {
    for (let tries = 0; tries < 12; tries++) {
      const a = chance() * TAU,
        r = group.r * sqrt(chance()),
        p = avoid(group.x + cos(a) * r, group.z + sin(a) * r, 0.2);
      if (dry(p[0], p[1]) && hypot(p[0] - walker.x, p[1] - walker.z) > least)
        return p;
    }
    return null;
  };
  // The perches a bird might fly to, the best first: free, within its height, between `from` and `to` metres of
  // it, in its group's range (unless `wide`), not close to the walker; nearer `by` (a place) the better, if
  // given. away: only those not toward the walker. Low ones and the tops of posts first: where the walker looks.
  // (Not the low branches by the paths: those are kept for a jay crossing the path to land on)
  const perchesFor = (bird, walker, from, to, by, away, wide) => {
    const found = [],
      group = groups[bird.group],
      [low, high] = bird.kind.high,
      awayX = bird.x - walker.x,
      awayZ = bird.z - walker.z,
      off = hypot(awayX, awayZ) || 1;
    for (let k = 0; k < nShared; k++) {
      if (taken[k] || (k < nBranch && perches[k * 8 + 7])) continue;
      const px = seat[k * 4],
        pz = seat[k * 4 + 2],
        up = seat[k * 4 + 3],
        d = hypot(px - bird.x, pz - bird.z);
      if (d < from || d > to || up < low || up > high) continue;
      if (
        group.lives === 'tree' &&
        !wide &&
        hypot(px - group.x, pz - group.z) > group.r
      )
        continue;
      if (heed && hypot(px - walker.x, pz - walker.z) < 6) continue;
      const toward = ((px - bird.x) * awayX + (pz - bird.z) * awayZ) / d / off;
      if (away && toward < -0.3) continue;
      found.push([
        (by
          ? hypot(px - by[0], seat[k * 4 + 1] - by[1], pz - by[2]) * 1.5
          : abs(d - (from + to) / 2)) +
          (away ? (1 - toward) * 4 : 0) +
          chance() * (by ? 1 : 4) +
          max(0, up - 2.2) * (away ? 0 : 1.5) -
          (k >= nBranch ? 3 : 0),
        k,
      ]);
    }
    return found
      .sort((a, b) => a[0] - b[0])
      .slice(0, 5)
      .map((entry) => entry[1]);
  };
  const fresh = (group, kind) => ({
    group,
    kind,
    seed: chance(),
    len: kind.len * between(0.93, 1.07),
    bold: between(0.82, 1.18), // how near it lets the walker come, against its kind's
    x: 0,
    y: 0,
    z: 0,
    yaw: chance() * TAU,
    pitch: 0.12,
    roll: 0,
    mode: 'ground',
    act: 'still',
    actT: 0,
    next: wait(1.5),
    run: 0,
    pecks: 0,
    hop: null,
    head: 0,
    headTo: 0,
    headNext: wait(1.2),
    lookUntil: -1,
    lookAway: -1,
    fan: 0,
    flick: -1,
    flickNext: wait(2),
    phase: chance() * TAU,
    spread: 0,
    air: 0,
    flight: null,
    flushIn: -1,
    perch: -1,
    along: 0.6,
    calm: 0,
    comeDown: 0,
    left: null,
    held: false,
    crest: 0.3, // how far its crest is raised
    alertUntil: -1, // wary till then (just landed): crest up
    cock: 0, // the head cocked to one side
    cockTo: 0,
    nod: 0, // the head's own pitch, on top of keeping level
    ruffle: 0, // feathers fluffed
    fwd: 0, // legs reaching forward to land
    rollTo: 0, // a lean as its weight shifts
    swayNext: wait(3),
  });
  const sitOn = (bird, k, along) => {
    const p = feet(bird, k, along);
    if (bird.perch >= 0) taken[bird.perch] = null;
    taken[k] = bird;
    Object.assign(bird, {
      perch: k,
      along,
      x: p[0],
      y: p[1],
      z: p[2],
      mode: 'perch',
      alongNow: undefined,
      pitch: bird.kind.rest ?? 0.12,
      yaw: stickYaw(k) + (chance() < 0.5 ? 1 : -1) * between(1.1, 2),
    });
  };
  // a raven on a low perch stands across the path, so a walker coming along it sees it side on
  const acrossPath = (x, z) => {
    let best = 1e9,
      j = 0;
    const loop = paths[0];
    loop.forEach((p, i) => {
      const d = hypot(p[0] - x, p[1] - z);
      if (d < best) [best, j] = [d, i];
    });
    const a = loop[max(j - 2, 0)],
      b = loop[min(j + 2, loop.length - 1)];
    return (
      atan2(b[1] - a[1], b[0] - a[0]) +
      (chance() < 0.5 ? PI / 2 : -PI / 2) +
      between(-0.35, 0.35)
    );
  };
  const ravenSits = (bird, k) => {
    sitOn(bird, k, 0);
    bird.yaw = k < nLow ? chance() * TAU : acrossPath(bird.x, bird.z);
  };
  // populate(n): the world's birds afresh, n of them
  let jayCount = 0;
  const populate = (n) => {
    jayCount = n;
    birds.length = 0;
    taken.fill(null);
    groups = homes(min(n, MOST - RAVENS));
    // (a raven to each home: the meadow's two snags, the lake's two, with the low perches nearer them than the
    // other home's)
    const nHome = ravenTops.length / 2,
      near = (k, r) =>
        min(
          ...[0, 1].map((j) =>
            hypot(
              seat[k * 4] - ravenTops[2 * r + j][0],
              seat[k * 4 + 2] - ravenTops[2 * r + j][2],
            ),
          ),
        );
    for (let r = 0; r < min(ravenCount, nHome); r++) {
      const snags = [nShared + 2 * r, nShared + 2 * r + 1],
        lows = [];
      for (let k = nLow; k < nPerch; k++)
        if (
          near(k, r) < RAVEN_REACH &&
          Array.from({ length: nHome }, (_, o) => near(k, o)).every(
            (d, o) => o === r || d > near(k, r),
          )
        )
          lows.push(k);
      groups.push({
        x: (seat[snags[0] * 4] + seat[snags[1] * 4]) / 2,
        z: (seat[snags[0] * 4 + 2] + seat[snags[1] * 4 + 2]) / 2,
        r: RAVEN_REACH,
        n: 1,
        species: SPECIES.findIndex((kind) => kind.name === 'raven'),
        lives: 'raven',
        home: r,
        snags,
        lows,
        walks: null, // (ravenSpot finds them when first asked)
      });
    }
    groups.forEach((group, g) => {
      group.off = -9; // when one of it last took wing
      group.wave = 0; // how many have left in this flush
      group.waveAt = -99;
      group.moveIn = wait(30);
      const kind = SPECIES[group.species];
      for (let k = 0; k < group.n; k++) {
        const bird = fresh(g, kind);
        if (group.lives === 'raven') {
          const low = group.lows[floor(chance() * group.lows.length)];
          ravenSits(bird, low ?? group.snags[0]);
          birds.push(bird);
          continue;
        }
        if (group.lives === 'ground') {
          const spot = groundSpot(group, { x: 1e6, z: 1e6 }, 0) || [
            group.x,
            group.z,
          ];
          bird.x = spot[0];
          bird.z = spot[1];
          bird.y = ground(spot[0], spot[1]);
        } else {
          // (a tree bird starts on a branch of its range: the first near the others of its group; none free, no bird)
          bird.x = group.x;
          bird.z = group.z;
          bird.y = ground(group.x, group.z);
          const k0 = perchesFor(
            bird,
            { x: 1e6, z: 1e6 },
            0,
            group.r,
            group.at,
            false,
          )[0];
          if (k0 === undefined) continue;
          sitOn(bird, k0, 0.6);
          if (!group.at) group.at = [bird.x, bird.y, bird.z];
        }
        birds.push(bird);
      }
    });
  };
  populate(count);

  // ---- flight: a curve from where it is to a perch or a place on the ground, clear of trunks and of the walker
  const curveAt = (c, s, out) => {
    const r = 1 - s,
      a = r * r * r,
      b = 3 * r * r * s,
      d = 3 * r * s * s,
      e = s * s * s;
    for (let k = 0; k < 3; k++)
      out[k] = a * c[k] + b * c[3 + k] + d * c[6 + k] + e * c[9 + k];
    return out;
  };
  const P = [0, 0, 0],
    Q = [0, 0, 0];
  const clearWay = (c, walker, fromAir, raven) => {
    // (a place every 1.2 m of the way; near either end a trunk may be close: the perch is a branch of it. One
    // brought in on the wing has no tree at its start. The walker is kept clear of from head to foot. A raven over
    // RAIL_TOP minds no rail: its low perches stand by them)
    const far = hypot(c[9] - c[0], c[11] - c[2]),
      n = max(8, Math.ceil(far / 1.2));
    for (let k = 1; k < n; k++) {
      curveAt(c, k / n, P);
      const p = avoid(P[0], P[2], 0.1),
        fromEnd = (min(fromAir ? n : k, n - k) * far) / n,
        blocked =
          raven && P[1] > ground(P[0], P[2]) + RAIL_TOP
            ? standing(P[0], P[2], 0.1)
            : hypot(p[0] - P[0], p[1] - P[2]) > 0.02;
      if (blocked && fromEnd > 1.5) return false;
      if (P[1] < ground(P[0], P[2]) + 0.12) return false;
      if (hypot(P[0] - walker.x, P[2] - walker.z) < 1 && P[1] < walker.y + 1)
        return false;
    }
    return true;
  };
  // (off the ground it climbs out steeply, off a branch it drops a little; it comes up to a branch from just under
  // it, and down to the ground from over it. Where the straight way is blocked it bows to one side or the other.
  // crossing: a flight across the path, its way taken only if crossing.fits(curve, seconds), lifted by less (it
  // must keep low), through crossing.via (x y z) when given; fromAir: on the wing)
  const flyTo = (bird, to, perch, walker, crossing) => {
    const dx = to[0] - bird.x,
      dz = to[2] - bird.z,
      dist = hypot(dx, dz) || 1,
      ux = dx / dist,
      uz = dz / dist,
      out = min(1, dist * 0.22),
      into = min(1.4, dist * 0.3),
      rise = bird.mode === 'ground' ? (bird.kind.climb ?? 1) : -0.3 * out,
      fall = perch >= 0 ? -0.25 * min(1, dist * 0.3) : 0.9,
      T = hypot(dist, to[1] - bird.y) / bird.kind.speed + 0.35;
    // The straight way first; where a trunk stands in it, bowed to one side or the other; where the ground rises
    // into it, lifted over
    let curve = null;
    for (const bow of [0, 0.7, -0.7, 1.4, -1.4, 2.2, -2.2, 3, -3, 4, -4]) {
      for (const lift of crossing ? [0, 0.35, 0.7] : [0, 1.5, 3, 5]) {
        const c = [
          bird.x,
          bird.y,
          bird.z,
          bird.x + ux * out - uz * bow,
          bird.y + rise + abs(bow) * 0.2 + lift,
          bird.z + uz * out + ux * bow,
          to[0] - ux * into - uz * bow,
          to[1] + fall + abs(bow) * 0.2 + lift,
          to[2] - uz * into + ux * bow,
          to[0],
          to[1],
          to[2],
        ];
        // (through a place: both middle points where the curve's own middle then falls on it)
        if (crossing && crossing.via)
          for (let k = 0; k < 3; k++)
            c[3 + k] = c[6 + k] =
              (8 * crossing.via[k] - c[k] - c[9 + k]) / 6 +
              (k === 1
                ? abs(bow) * 0.2 + lift
                : k === 0
                  ? -uz * bow
                  : ux * bow);
        if (
          (!crossing || crossing.fits(c, T)) &&
          clearWay(
            c,
            walker,
            crossing && crossing.fromAir,
            bird.kind.name === 'raven',
          )
        ) {
          curve = c;
          break;
        }
      }
      if (curve) break;
    }
    if (!curve) return false;
    if (bird.perch >= 0) taken[bird.perch] = null;
    bird.perch = perch;
    if (perch >= 0) taken[perch] = bird;
    bird.mode = 'fly';
    bird.act = 'crouch';
    bird.actT = 0;
    bird.flight = {
      curve,
      t: 0,
      T,
      burst: 0.3, // seconds of beating left before the wings shut or glide, or (below 0) of that before they beat
      perch,
    };
    bird.air = 1;
    bird.fan = 0.4;
    groups[bird.group].off = clock;
    lastFlight = clock;
    return true;
  };
  const flyToPerch = (bird, list, walker) => {
    for (const k of list)
      if (flyTo(bird, feet(bird, k, 0.6), k, walker)) return true;
    return false;
  };
  // one of a ground flock takes wing for a branch; where there is none free, for the ground further from the walker
  const takeOff = (bird, walker, by) => {
    if (flyToPerch(bird, perchesFor(bird, walker, 4, 24, by, true), walker))
      return true;
    const group = groups[bird.group],
      spot = groundSpot({ ...group, r: group.r + 10 }, walker, 12);
    return (
      !!spot &&
      flyTo(bird, [spot[0], ground(spot[0], spot[1]), spot[1]], -1, walker)
    );
  };
  // The flock leaves in a ripple: one has had enough and sets all within a few metres of it going, the nearest
  // to the walker first. left: its place in the ripple and how far off the walker was
  const flush = (first, walker) => {
    const group = groups[first.group];
    if (clock - group.waveAt > 12) {
      group.wave = 0;
      group.flushes = (group.flushes || 0) + 1;
    }
    group.waveAt = clock;
    birds
      .filter(
        (b) =>
          b.group === first.group &&
          b.mode === 'ground' &&
          b.flushIn < 0 &&
          (b === first || hypot(b.x - first.x, b.z - first.z) < 4),
      )
      .sort(
        (a, b) =>
          hypot(a.x - walker.x, a.z - walker.z) -
          hypot(b.x - walker.x, b.z - walker.z),
      )
      .forEach((b, k) => {
        b.flushIn = k ? 0.08 * k + between(0, 0.12) : 0;
      });
  };

  // ---- one bird, `h` seconds on
  const lookers = (group) =>
    birds.filter((b) => b.group === group && b.lookUntil > clock).length;
  const headAndTail = (bird, h, walker, near) => {
    // The head turns in jumps: to a new angle in two or three frames, then held; now and then it is cocked to one
    // side. Sometimes, and never more than one bird in three of a group at a time, it is the walker it looks at,
    // for a second or three
    bird.headNext -= h;
    if (bird.headNext <= 0) {
      bird.headNext = wait(bird.act === 'still' ? 1.2 : 2.5);
      const bearing = turnTo(
        bird.yaw,
        atan2(walker.z - bird.z, walker.x - bird.x),
      );
      if (
        near &&
        clock > bird.lookAway &&
        abs(bearing) < 1.25 &&
        lookers(bird.group) < max(1, floor(groups[bird.group].n / 3)) &&
        chance() < 0.5
      ) {
        const stay = between(1, 3);
        bird.lookUntil = clock + stay;
        bird.lookAway = clock + stay + between(stay, stay * 3);
        bird.headTo = clamp(bearing / 1.3, -1, 1);
        bird.cockTo = 0;
        bird.headNext = stay;
      } else {
        bird.headTo =
          chance() < 0.25 ? 0 : between(0.3, 1) * (chance() < 0.5 ? -1 : 1);
        bird.cockTo =
          chance() < 0.35 ? between(0.25, 0.5) * (chance() < 0.5 ? -1 : 1) : 0;
      }
    }
    bird.head += (bird.headTo - bird.head) * min(1, h / 0.04);
    bird.cock += (bird.cockTo - bird.cock) * min(1, h / 0.05);
    // the crest stands while it is wary (the walker near, or just landed) and sinks again when all is quiet
    const wary = near || clock < bird.alertUntil;
    bird.crest +=
      ((wary ? 1 : 0.2) - bird.crest) * min(1, h / (wary ? 0.12 : 0.7));
    // the tail flicks open and shut (a junco's shows its white)
    bird.flickNext -= h;
    if (bird.flickNext <= 0 && bird.mode !== 'fly') {
      bird.flickNext = wait(2.2);
      bird.flick = 0;
    }
    if (bird.flick >= 0) {
      bird.flick += h;
      bird.fan = bird.flick < 0.08 ? 0.6 * sin((bird.flick / 0.08) * PI) : 0;
      if (bird.flick >= 0.08) bird.flick = -1;
    }
    // its weight shifts from foot to foot now and then: a small lean that comes and stays a while
    bird.swayNext -= h;
    if (bird.swayNext <= 0) {
      bird.swayNext = wait(3.5);
      bird.rollTo = between(-0.07, 0.07);
    }
    if (bird.act === 'still')
      bird.roll += (bird.rollTo - bird.roll) * min(1, h / 0.3);
  };
  const onGround = (bird, h, walker) => {
    const kind = bird.kind,
      group = groups[bird.group],
      dist = heed ? hypot(bird.x - walker.x, bird.z - walker.z) : 1e3,
      // (the walker counts for more coming fast, for less standing still or in thick fog)
      wary =
        (walker.still > 3 ? 0.6 : walker.speed > 4.5 ? 1.3 : 1) *
        (walker.fog > 0.6 ? 0.6 : 1),
      near = dist < kind.notice * wary;
    if (bird.flushIn >= 0) {
      bird.flushIn -= h;
      if (bird.flushIn < 0 && bird.act !== 'hop') {
        if (takeOff(bird, walker, group.lead)) {
          if (bird.flush !== group.flushes) bird.left = [++group.wave, dist];
          bird.flush = group.flushes;
          if (group.wave === 1 && bird.perch >= 0)
            group.lead = feet(bird, bird.perch, 0.6);
        } else bird.flushIn = between(0.3, 0.6); // (no way out just now: it tries again in a moment)
      } else if (bird.flushIn < 0) bird.flushIn = 0;
    } else if (
      dist < kind.leave * bird.bold * wary ||
      (walker.rain > 0.35 && chance() < h / 4)
    ) {
      group.lead = null;
      flush(bird, walker);
    }
    if (bird.mode !== 'ground') return;
    bird.actT += h;
    if (bird.act === 'hop') {
      // a hop: an arc of a few centimetres in an eighth of a second, the bird turning as it goes
      const hop = bird.hop,
        s = min(bird.actT / hop.T, 1);
      bird.x = mix(hop.x0, hop.x1, s);
      bird.z = mix(hop.z0, hop.z1, s);
      bird.y = mix(hop.y0, hop.y1, s) + 4 * hop.high * s * (1 - s);
      bird.yaw = hop.yaw0 + hop.turn * smooth(s);
      bird.pitch = restOf(bird) + 0.2 * sin(s * PI);
      if (s >= 1) {
        bird.y = hop.y1;
        bird.act = 'still';
        bird.actT = 0;
        bird.next = bird.run > 0 ? between(0.05, 0.16) : wait(near ? 2.5 : 1.3);
      }
    } else if (bird.act === 'peck') {
      // a peck: down in a seventh of a second, up in a tenth, a few times over
      const beat = bird.actT % 0.3,
        down =
          beat < 0.15
            ? smooth(beat / 0.15)
            : beat < 0.25
              ? 1 - smooth((beat - 0.15) / 0.1)
              : 0;
      bird.pitch = restOf(bird) - 0.85 * down;
      if (bird.actT >= bird.pecks * 0.3 || (near && beat > 0.25)) {
        bird.pitch = restOf(bird);
        bird.act = 'still';
        bird.actT = 0;
        bird.next = wait(near ? 2 : 0.8);
      }
    } else {
      bird.next -= h;
      if (bird.next <= 0) {
        const pick = chance();
        if (bird.run > 0 || pick < (near ? 0.25 : 0.5)) {
          // a run of hops: the first may turn it, toward the middle of the flock's ground when it has strayed
          if (bird.run <= 0) {
            bird.run = 2 + floor(chance() * 4);
            const home = atan2(group.z - bird.z, group.x - bird.x),
              strayed =
                hypot(group.x - bird.x, group.z - bird.z) > group.r * 0.8;
            bird.turn = strayed
              ? turnTo(bird.yaw, home + between(-0.5, 0.5))
              : chance() < 0.55
                ? 0
                : between(0.5, 2.1) * (chance() < 0.5 ? -1 : 1);
          } else bird.turn = between(-0.25, 0.25);
          bird.run--;
          const yaw = bird.yaw + bird.turn,
            far = between(0.06, 0.1) * (bird.len / 0.15),
            to = avoid(bird.x + cos(yaw) * far, bird.z + sin(yaw) * far, 0.15),
            fits =
              hypot(to[0] - bird.x, to[1] - bird.z) > far * 0.6 &&
              dry(to[0], to[1]);
          if (fits) {
            bird.hop = {
              x0: bird.x,
              y0: bird.y,
              z0: bird.z,
              x1: to[0],
              y1: ground(to[0], to[1]),
              z1: to[1],
              yaw0: bird.yaw,
              turn: bird.turn,
              high: between(0.022, 0.036),
              T: between(0.11, 0.14),
            };
            bird.act = 'hop';
            bird.actT = 0;
          } else {
            // (something is in the way: it turns round where it stands and tries again)
            bird.yaw += between(1.6, 3.1);
            bird.next = between(0.2, 0.6);
          }
        } else if (!near && pick < 0.9) {
          bird.act = 'peck';
          bird.actT = 0;
          bird.pecks = 2 + floor(chance() * 3);
        } else bird.next = wait(near ? 2 : 1);
      }
    }
    headAndTail(bird, h, walker, near);
  };
  const onWing = (bird, h, walker) => {
    const kind = bird.kind,
      flight = bird.flight,
      c = flight.curve;
    bird.actT += h;
    if (bird.act === 'crouch') {
      // it crouches, turning to where it will go, its crest up; then pushes off
      const s = min(bird.actT / (kind.crouch ?? 0.12), 1);
      bird.pitch = restOf(bird) - 0.3 * s;
      bird.yaw +=
        turnTo(bird.yaw, atan2(c[5] - c[2], c[3] - c[0])) * min(1, h / 0.05);
      bird.crest += (1 - bird.crest) * min(1, h / 0.1);
      if (s < 1) return;
      bird.act = 'fly';
      bird.actT = 0;
    }
    flight.t += h;
    // How far along its way: it is up to speed a third of a second off the perch (at once, brought in on the
    // wing) and slows over the last half second, at an even pace between
    const t = clamp(flight.t, 0, flight.T), // (under 0: it waits at its way's start, out of sight)
      s = t / flight.T,
      up = flight.cruise ? 0 : min(0.3, flight.T / 3),
      // (a raven going away keeps its pace to the end: it flies on, or is out of sight)
      down = flight.perch === -2 ? 0 : min(0.45, flight.T / 3),
      pace = 1 / (flight.T - (up + down) / 2),
      e =
        t < up
          ? (pace * t * t) / (2 * up)
          : t > flight.T - down
            ? 1 - (pace * (flight.T - t) ** 2) / (2 * down)
            : pace * (t - up / 2);
    curveAt(c, e, P);
    curveAt(c, min(e + 0.02, 1), Q);
    const tx = Q[0] - P[0],
      ty = Q[1] - P[1],
      tz = Q[2] - P[2],
      level = hypot(tx, tz);
    // the last seventh of the way it flares: nose up, wings and tail wide, beating twice as fast, legs reaching
    // forward for the perch
    const flare = flight.perch === -2 ? 0 : clamp((s - 0.84) / 0.12, 0, 1),
      first = flight.t < 0.3;
    bird.x = P[0];
    bird.y = P[1];
    bird.z = P[2];
    if (level > 1e-4) {
      // (it banks into its turns, and its tail opens to steer)
      const yaw = atan2(tz, tx),
        turning = clamp(turnTo(bird.yaw, yaw) / h, -3, 3);
      bird.yaw = yaw;
      bird.roll +=
        (turning * 0.17 * (1 - flare) - bird.roll) * min(1, h / 0.15);
      flight.steer = min(0.4, abs(turning) * 0.25);
    }
    bird.pitch =
      clamp(atan2(ty, level || 1e-4), -0.9, 0.9) * (1 - flare) + 0.7 * flare;
    bird.fwd = flare;
    // Small birds bound: a burst of beats, then the wings shut for a moment. A jay beats a few times, then glides
    // on spread wings. A thrush beats steadily. Leaving and landing all of them beat throughout
    const glides = kind.wing === 'glide';
    flight.burst -= h * (flight.burst > 0 ? 1 : -1);
    if (flight.burst > 0 && flight.burst < h)
      flight.burst = -(glides
        ? between(...(kind.bursts || [0.4, 0.9]))
        : between(0.09, 0.15));
    else if (flight.burst < 0 && flight.burst > -h)
      flight.burst = glides
        ? between(...(kind.bursts || [0, 0, 0.6, 0.95]).slice(2))
        : between(0.16, 0.26);
    const beating =
      first || flare > 0 || flight.burst > 0 || kind.wing === 'steady';
    bird.spread +=
      ((beating || glides ? 1 : 0) - bird.spread) *
      min(1, h / (first ? 0.07 : 0.035));
    if (beating)
      bird.phase +=
        TAU *
        kind.beat *
        (first ? (kind.beatUp ?? 1.5) : flare > 0 ? (kind.beatDown ?? 2) : 1) *
        h;
    // (gliding, the wings come level and stay there)
    else if (glides)
      bird.phase += turnTo(bird.phase, kind.glide ?? -0.15) * min(1, h / 0.1);
    bird.fan +=
      ((flare > 0 || first ? 1 : (kind.fanFly ?? 0.3) + (flight.steer || 0)) -
        bird.fan) *
      min(1, h / 0.06);
    bird.head *= 1 - min(1, h / 0.1);
    bird.cock *= 1 - min(1, h / 0.1);
    if (s >= 1 && flight.perch === -2) {
      // (a raven gone over or away: still seen, it flies on the way it goes; out of sight, it is back at a snag of
      // its own once unseen)
      if (walker && seenFrom(walker, bird.x, bird.y, bird.z) && onward(bird))
        return;
      Object.assign(bird, { mode: 'gone', flight: null, air: 0, spread: 0 });
      bird.next = between(8, 20);
      return;
    }
    if (s >= 1) {
      bird.mode = flight.perch >= 0 ? 'perch' : 'ground';
      bird.act = 'settle';
      bird.actT = 0;
      bird.air = 0;
      bird.flight = null;
      bird.landed = bird.pitch;
      bird.alertUntil = clock + between(2, 4);
      bird.next = wait(flight.perch >= 0 ? kind.sits : 1.5);
      bird.calm = 0;
      bird.comeDown = between(20, 40);
      bird.along = 0.6;
      bird.alongNow = undefined;
      // (on a branch it sits across it, turned the lesser way; on a raven's low perch across the path; on a post's
      // top as it came)
      bird.yawTo = bird.yaw;
      if (flight.perch >= nLow) bird.yawTo = acrossPath(bird.x, bird.z);
      else if (flight.perch >= 0 && flight.perch < nBranch) {
        const across = stickYaw(flight.perch) + PI / 2,
          off = turnTo(bird.yaw, across);
        bird.yawTo =
          bird.yaw +
          (abs(off) < PI / 2 ? off : turnTo(bird.yaw, across + PI)) +
          between(-0.4, 0.4);
      }
    }
  };
  // After landing the wings fold and the tail shuts in a seventh of a second, the bird turning to how it will
  // sit; it comes down nose up, dips forward as its weight arrives and rocks back upright: a settling bob
  const settle = (bird, h) => {
    bird.actT += h;
    const rest = restOf(bird),
      t = bird.actT;
    bird.spread = max(0, bird.spread - h / 0.15);
    bird.fan = max(0, bird.fan - h / 0.2);
    bird.fwd = 0;
    bird.roll *= 1 - min(1, h / 0.1);
    bird.pitch =
      rest +
      (bird.landed - rest) * exp(-t / 0.1) -
      (bird.kind.rest ? 0.3 * sin(min(t / 0.32, 1) * PI) : 0);
    bird.yaw += turnTo(bird.yaw, bird.yawTo) * min(1, h / 0.1);
    if (t > 0.34 && bird.spread <= 0) {
      bird.pitch = rest;
      bird.act = 'still';
      bird.actT = 0;
    }
  };
  // a hop along its branch: it turns to face the way it goes; the stick's ends are left alone
  const branchHop = (bird) => {
    if (bird.perch >= nBranch) return false;
    const stick = perches[bird.perch * 8 + 3],
      way =
        bird.along < 0.4
          ? 1
          : bird.along > 0.75
            ? -1
            : bird.hop && bird.run > 0
              ? bird.hop.way
              : chance() < 0.5
                ? 1
                : -1,
      to = clamp(
        bird.along + (way * between(0.35, 0.6) * bird.len) / stick,
        0.3,
        0.85,
      ),
      from = feet(bird, bird.perch, bird.along),
      end = feet(bird, bird.perch, to);
    if (abs(to - bird.along) * stick < 0.2 * bird.len) return false;
    bird.hop = {
      way,
      from,
      end,
      to,
      yaw0: bird.yaw,
      turn: turnTo(
        bird.yaw,
        atan2(end[2] - from[2], end[0] - from[0]) + between(-0.5, 0.5),
      ),
      high: between(0.1, 0.16) * bird.len,
      T: between(0.13, 0.18),
    };
    bird.act = 'hop';
    bird.actT = 0;
    return true;
  };
  // a flight to another branch: a chickadee keeps to where its party is, the others cross to another tree
  const flit = (bird, walker) => {
    const group = groups[bird.group],
      party = bird.kind.name === 'chickadee';
    return flyToPerch(
      bird,
      party
        ? perchesFor(bird, walker, 0.7, 30, group.at, false).filter(
            (k) =>
              hypot(
                seat[k * 4] - group.at[0],
                seat[k * 4 + 1] - group.at[1],
                seat[k * 4 + 2] - group.at[2],
              ) < 5.5,
          )
        : perchesFor(bird, walker, 6, 24, null, false),
      walker,
    );
  };
  // a hop about on the spot: on a branch to face the other way across it, on a post's top any way
  const turnAbout = (bird) => {
    bird.turn0 = bird.yaw;
    bird.turnBy =
      bird.perch < nBranch
        ? PI + between(-0.5, 0.5)
        : between(0.7, 2.4) * (chance() < 0.5 ? -1 : 1);
    bird.perchY = bird.y;
    bird.act = 'turn';
    bird.actT = 0;
  };
  const onPerch = (bird, h, walker) => {
    const kind = bird.kind,
      group = groups[bird.group],
      dist = heed ? hypot(bird.x - walker.x, bird.z - walker.z) : 1e3,
      close = hypot(dist, bird.y - walker.y),
      rain = walker.rain > 0.3,
      rest = restOf(bird);
    bird.actT += h;
    if (bird.act === 'hop') {
      const hop = bird.hop,
        s = min(bird.actT / hop.T, 1);
      bird.x = mix(hop.from[0], hop.end[0], s);
      bird.y = mix(hop.from[1], hop.end[1], s) + 4 * hop.high * s * (1 - s);
      bird.z = mix(hop.from[2], hop.end[2], s);
      bird.yaw = hop.yaw0 + hop.turn * smooth(s);
      bird.pitch = rest + 0.2 * sin(s * PI);
      bird.alongNow = mix(bird.along, hop.to, s);
      if (s >= 1) {
        bird.along = hop.to;
        bird.act = 'still';
        bird.actT = 0;
        bird.next = bird.run > 0 ? between(0.12, 0.4) : wait(kind.sits);
      }
      return;
    }
    if (bird.act === 'turn') {
      const s = min(bird.actT / 0.16, 1);
      bird.yaw = bird.turn0 + bird.turnBy * smooth(s);
      bird.y = bird.perchY + 0.2 * bird.len * s * (1 - s);
      bird.pitch = rest + 0.12 * sin(s * PI);
      if (s >= 1) {
        bird.y = bird.perchY;
        bird.act = 'still';
        bird.actT = 0;
      }
      return;
    }
    if (bird.act === 'pick') {
      // it bends to pick at what it stands on: down in a fifth of a second, a moment there, up again; a few times
      const beat = bird.actT % 0.55,
        down =
          beat < 0.2
            ? smooth(beat / 0.2)
            : beat < 0.3
              ? 1
              : beat < 0.45
                ? 1 - smooth((beat - 0.3) / 0.15)
                : 0;
      bird.pitch = rest - 0.95 * down;
      bird.nod = -0.5 * down;
      if (bird.actT >= bird.pecks * 0.55) {
        bird.pitch = rest;
        bird.nod = 0;
        bird.act = 'still';
        bird.actT = 0;
      }
      return;
    }
    if (bird.act === 'ruffle') {
      // it fluffs its feathers and shakes: up in a sixth of a second, a quick shiver, down again
      const t = bird.actT;
      bird.ruffle =
        t < 0.15 ? t / 0.15 : t < 0.55 ? 1 : max(0, 1 - (t - 0.55) / 0.3);
      bird.roll = t > 0.12 && t < 0.55 ? 0.1 * sin(t * 60) : 0;
      if (t > 0.85) {
        bird.ruffle = bird.spread = bird.roll = 0;
        bird.act = 'still';
        bird.actT = 0;
      }
      return;
    }
    if (group.lives === 'ground') {
      // One of a ground flock comes down again when the walker has stood still a while, or has gone from the
      // flock's ground: each by its own count, and not while another of the flock is on the wing
      const home = hypot(group.x - walker.x, group.z - walker.z);
      bird.calm += rain
        ? 0
        : walker.still > 3
          ? h
          : home > 14 || !heed
            ? h * 2.5
            : -bird.calm;
      if (bird.calm > bird.comeDown && clock - group.off > between(1.2, 3)) {
        const spot = groundSpot(group, walker, walker.still > 3 ? 3.4 : 9);
        if (
          !spot ||
          !flyTo(bird, [spot[0], ground(spot[0], spot[1]), spot[1]], -1, walker)
        )
          bird.calm = bird.comeDown - between(2, 6);
        return;
      }
    }
    // The walker too close: off to another perch. While they walk, to one further on the way they are going
    // (from a rail to the next post along it); standing, away from them
    if (close < (group.lives === 'ground' ? 2.2 : kind.leave * bird.bold)) {
      const by =
        walker.speed > 0.5
          ? [
              walker.x + (walker.vx / walker.speed) * 11,
              bird.y,
              walker.z + (walker.vz / walker.speed) * 11,
            ]
          : null;
      if (
        flyToPerch(
          bird,
          perchesFor(bird, walker, 4, 24, by, true, true),
          walker,
        )
      )
        return;
    }
    // What it does next on its perch: a hop or a few along it, a flight to another, a bend to pick at it, a
    // ruffle, a turn about. In the rain it mostly sits
    bird.next -= h * (rain ? 0.15 : 1);
    if (bird.next <= 0) {
      bird.next = wait(kind.sits);
      const pick = chance(),
        flits = kind.hops + kind.flits,
        picks = flits + (kind.picks || 0),
        ruffles = picks + (kind.ruffles || 0);
      if (bird.run > 0 || pick < kind.hops) {
        if (bird.run <= 0) bird.run = 1 + floor(chance() * 3);
        bird.run--;
        if (!branchHop(bird)) {
          bird.run = 0;
          turnAbout(bird);
        }
      } else if (
        pick < flits &&
        !rain &&
        (kind.name !== 'jay' || clock - lastFlight > CROSSING_LEAST)
      )
        flit(bird, walker);
      else if (pick < picks) {
        bird.act = 'pick';
        bird.actT = 0;
        bird.pecks = 1 + floor(chance() * 3);
      } else if (pick < ruffles) {
        bird.act = 'ruffle';
        bird.actT = 0;
      } else if (chance() < 0.4) turnAbout(bird);
    }
    if (bird.mode === 'perch') headAndTail(bird, h, walker, dist < kind.notice);
  };
  // a path from its point `at` on, the way (fx, fz) points: where it runs d metres on, or null past its end
  const alongPath = (way, at, loop, fx, fz) => {
    const n = way.length,
      pt = (i) => (loop ? way[((i % n) + n) % n] : way[i] || null),
      a = pt(at - 1) || way[at],
      b = pt(at + 1) || way[at],
      dir = (b[0] - a[0]) * fx + (b[1] - a[1]) * fz < 0 ? -1 : 1;
    return (d) => {
      let p = way[at];
      for (let i = at, left = d; ; i += dir) {
        const q = pt(i + dir);
        if (!q) return null;
        const seg = hypot(q[0] - p[0], q[1] - p[1]);
        if (seg >= left) {
          const s = seg > 1e-6 ? left / seg : 0;
          return [mix(p[0], q[0], s), mix(p[1], q[1], s)];
        }
        left -= seg;
        p = q;
      }
    };
  };
  // The path the walker is on, as where it runs d metres on the way they face: [x, z], or null past a side path's
  // end. Of those passing within 4 m (at a fork, more than one), the one that runs nearest the middle of the
  // frame; off every path, the line they face
  const pathAhead = (walker, fx, fz) => {
    let best = (d) => [walker.x + fx * d, walker.z + fz * d],
      most = 1e9;
    for (const way of paths) {
      let at = -1,
        least = 16;
      for (let i = 0; i < way.length; i++) {
        const d = (way[i][0] - walker.x) ** 2 + (way[i][1] - walker.z) ** 2;
        if (d < least) {
          least = d;
          at = i;
        }
      }
      if (at < 0) continue;
      const along = alongPath(way, at, way === paths[0], fx, fz),
        p = along(9);
      if (!p) continue;
      const a = (p[0] - walker.x) * fx + (p[1] - walker.z) * fz,
        off =
          abs((p[1] - walker.z) * fx - (p[0] - walker.x) * fz) / max(a, 0.1);
      if (a > 0 && off < most) {
        most = off;
        best = along;
      }
    }
    return best;
  };
  // can the walker see a place, no trunk between (within 1.5 m of it: its own tree, not counted)?
  const seen = (walker, x, z) => {
    const d = hypot(x - walker.x, z - walker.z),
      n = Math.ceil(d / 0.5);
    for (let i = 1; i < n && d * (1 - i / n) > 1.5; i++) {
      const px = mix(walker.x, x, i / n),
        pz = mix(walker.z, z, i / n),
        p = avoid(px, pz, 0.05);
      if (hypot(p[0] - px, p[1] - pz) > 0.01) return false;
    }
    return true;
  };
  // Is a place seen against fog, sky or the pale path? Along the walker's line of sight past it: no trunk within 30
  // m, or where the line comes down to the ground, a path
  const backdrop = (walker, x, y, z) => {
    const d = hypot(x - walker.x, y - walker.y, z - walker.z) || 1,
      dx = (x - walker.x) / d,
      dy = (y - walker.y) / d,
      dz = (z - walker.z) / d;
    for (let t = 1.5; t < 30; t += 1.5) {
      const px = x + dx * t,
        pz = z + dz * t;
      if (y + dy * t < ground(px, pz)) return pale(px, pz);
      const p = avoid(px, pz, 0.05);
      if (hypot(p[0] - px, p[1] - pz) > 0.01) return false;
    }
    return true;
  };
  // the seconds into a flight of T seconds at which it is `e` of the way along its curve (onWing's pace, undone)
  const timeAt = (e, T, cruise) => {
    const up = cruise ? 0 : min(0.3, T / 3),
      down = min(0.45, T / 3),
      pace = 1 / (T - (up + down) / 2);
    return e < (pace * up) / 2
      ? sqrt((2 * up * e) / pace)
      : e > 1 - (pace * down) / 2
        ? T - sqrt((2 * down * (1 - e)) / pace)
        : e / pace + up / 2;
  };
  // A jay flies across the path ahead of the walker, 5 to 7 m ahead of where they are by then and 1.4 to 2.6 m
  // up (near enough to be seen), and lands on a perch in the frame on the other side. One that sits out to one side of the path goes from
  // where it sits; else the nearest out of sight is brought in on the wing from beyond the side of the frame.
  // Returns [the bird, how], or [null, why not]: on open ground or by water there is none (a jay keeps to the woods)
  let crossIn = between(CROSSING_LEAST, CROSSING_EVERY), // seconds of walking till the next
    lastCross = -1e3;
  const cross = (walker) => {
    const fl = hypot(walker.fx, walker.fz) || 1,
      fx = walker.fx / fl,
      fz = walker.fz / fl,
      // a place by how far ahead of the walker it lies and how far to their right
      ahead = (x, z) => (x - walker.x) * fx + (z - walker.z) * fz,
      right = (x, z) => (z - walker.z) * fx - (x - walker.x) * fz,
      // (a level view's frame reaches 0.48 of the way ahead to each side: TANW in scene.js; margin narrows it)
      framed = (x, y, z, margin) => {
        const a = ahead(x, z);
        return (
          a > 1 &&
          abs(right(x, z)) < (0.48 - margin) * a &&
          abs(y - walker.y) < 0.75 * a
        );
      },
      off = (b) => hypot(b.x - walker.x, b.z - walker.z),
      hidden = (b) => !framed(b.x, b.y, b.z, -0.1) || off(b) > 38,
      pace = max(0, walker.vx * fx + walker.vz * fz), // (walking, they come on while it flies)
      along = pathAhead(walker, fx, fz);
    if (open(walker.x, walker.z)) return [null, 'open ground or water'];
    const jays = birds
      .filter((b) => !b.held && b.kind.name === 'jay' && b.mode === 'perch')
      .sort((a, b) => off(a) - off(b));
    if (!jays.length) return [null, 'no jay is free'];
    // Where it crosses: the path's middle some 6 m on, in the frame. Where it lands: a perch in the frame a few
    // metres off the path on either side, low, the walker's sight of it clear and fog, sky or the path behind it
    // the best
    const ways = [];
    let woods = false; // (does the path ahead run through the woods at all?)
    for (const d of [6, 5.5, 6.5, 5, 7]) {
      const mid = along(d + pace * 0.8),
        before = along(d + pace * 0.8 - 1.5),
        after = along(d + pace * 0.8 + 1.5);
      if (!mid || !before || !after || open(mid[0], mid[1])) continue;
      woods = true;
      const tl = hypot(after[0] - before[0], after[1] - before[1]) || 1,
        tx = (after[0] - before[0]) / tl,
        tz = (after[1] - before[1]) / tl,
        over = ground(mid[0], mid[1]) + 2;
      if (!framed(mid[0], over, mid[1], 0.18)) continue;
      // a place by how far on along this stretch of path it lies, and how far to its right
      const on = (x, z) => (x - mid[0]) * tx + (z - mid[1]) * tz,
        side = (x, z) => (z - mid[1]) * tx - (x - mid[0]) * tz;
      const ends = [];
      for (let k = 0; k < nShared; k++) {
        const x = seat[k * 4],
          y = seat[k * 4 + 1],
          z = seat[k * 4 + 2],
          up = seat[k * 4 + 3],
          a = ahead(x, z),
          s = side(x, z),
          o = on(x, z);
        // (a post's top may be low and at the path's very edge)
        const post = k >= nBranch;
        if (taken[k] || up < (post ? 0.8 : 1.2) || up > 6.5) continue;
        if (a < 6.5 + pace || a > 24 + pace || o < -3 || o > 12) continue;
        if (abs(s) < (post ? 0.8 : 1.2) || abs(s) > 9) continue;
        if (!framed(x, y, z, 0.05)) continue;
        ends.push([
          abs(abs(s) - 3) * 0.5 +
            abs(up - 2.6) +
            abs(a - pace - 9) * 0.3 -
            (post ? 1 : 0) +
            chance() * 1.5 +
            (seen(walker, x, z) ? 0 : 6) +
            (backdrop(walker, x, y + 0.15, z) ? 0 : 3),
          k,
          s,
        ]);
      }
      ends.sort((p, q) => p[0] - q[0]);
      // does a way cross this stretch once, near its middle, 5 to 7 m from where the walker is by then, 1.4 to
      // 2.6 m over the ground and inside the frame? cruise: brought in on the wing (else a crouch first)
      const fits = (cruise) => (c, T) => {
        let was = side(c[0], c[2]),
          hit = -1;
        for (let i = 1; i <= 48; i++) {
          curveAt(c, i / 48, P);
          const now = side(P[0], P[2]);
          if (now * was < 0) {
            if (hit >= 0) return false;
            hit = (i - 1 + was / (was - now)) / 48;
          }
          was = now;
        }
        if (hit < 0) return false;
        curveAt(c, hit, P);
        const t = (cruise ? 0 : 0.12) + timeAt(hit, T, cruise),
          wx = walker.x + walker.vx * t,
          wz = walker.z + walker.vz * t,
          a = (P[0] - wx) * fx + (P[2] - wz) * fz,
          dist = hypot(P[0] - wx, P[2] - wz),
          high = P[1] - ground(P[0], P[2]);
        return (
          abs(on(P[0], P[2])) < 4 &&
          dist > 5.1 &&
          dist < 6.9 &&
          high > 1.45 &&
          high < 2.55 &&
          abs((P[2] - wz) * fx - (P[0] - wx) * fz) < 0.36 * a
        );
      };
      for (const [, k, s] of ends.slice(0, 8))
        ways.push({ mid, tx, tz, over, on, side, fits, k, s });
    }
    if (!ways.length)
      return [
        null,
        woods
          ? 'no perch in view across the path ahead'
          : 'open ground or water',
      ];
    const took = (bird, k, brought) => {
      const group = groups[bird.group],
        c = bird.flight.curve;
      bird.flight.crossing = true;
      bird.away =
        brought ||
        hypot(seat[k * 4] - group.x, seat[k * 4 + 2] - group.z) > group.r;
      if (brought) {
        // (already on the wing and up to speed: no crouch on a perch first)
        bird.flight.cruise = true;
        bird.act = 'fly';
        bird.actT = 0;
        bird.yaw = atan2(c[5] - c[2], c[3] - c[0]);
        bird.spread = 1;
      }
      lastCross = clock;
      return [
        bird,
        brought ? 'from out of sight in the woods' : 'from its perch',
      ];
    };
    // from its perch: one sitting still on the other side of the path, not far from where it lands
    for (const { side, fits, k, s } of ways)
      for (const bird of jays) {
        const bs = side(bird.x, bird.z);
        if (bird.act !== 'still' || bs * s > 0 || abs(bs) < 2 || abs(bs) > 14)
          continue;
        if (ahead(bird.x, bird.z) < 3 || bird.y - ground(bird.x, bird.z) > 5.5)
          continue;
        if (hypot(bird.x - seat[k * 4], bird.z - seat[k * 4 + 2]) > 26)
          continue;
        if (flyTo(bird, feet(bird, k, 0.6), k, walker, { fits: fits(false) }))
          return took(bird, k, false);
      }
    // brought in: the nearest out of sight, from just beyond the side of the frame on the far side of the path, on
    // the line from its perch through the path's middle; from further out if the trunks leave no way
    const bird = jays.find(hidden);
    if (!bird) return [null, 'no jay out of sight'];
    const was = [bird.x, bird.y, bird.z];
    for (const { mid, tx, tz, over, on, fits, k, s } of ways) {
      const to = feet(bird, k, 0.6),
        o = on(to[0], to[2]),
        from = s > 0 ? -1 : 1,
        // (wide: metres out from the path's middle on that side)
        start = (wide) => {
          const back = clamp((-o * wide) / abs(s), -0.6 * wide, 0.6 * wide);
          return [
            mid[0] + tx * back - tz * from * wide,
            over + ((over - to[1]) * wide) / abs(s),
            mid[1] + tz * back + tx * from * wide,
          ];
        };
      let edge = 2;
      while (edge < 20 && framed(...start(edge), -0.14)) edge += 0.5;
      for (const wide of [
        edge,
        edge + 1,
        edge + 2.5,
        edge + 4,
        edge + 6,
        edge + 9,
      ]) {
        const [x0, y0, z0] = start(wide),
          at = avoid(x0, z0, 0.4),
          under = ground(at[0], at[1]),
          y = clamp(y0, under + 1.5, under + 5);
        if (framed(at[0], y, at[1], -0.14)) continue;
        bird.x = at[0];
        bird.y = y;
        bird.z = at[1];
        if (
          flyTo(bird, to, k, walker, {
            fits: fits(true),
            fromAir: true,
            via: [mid[0], over, mid[1]],
          })
        )
          return took(bird, k, true);
        [bird.x, bird.y, bird.z] = was;
      }
    }
    return [null, 'no clear way between the trunks'];
  };
  // ---- the ravens: a pair, each at home by its two snags in the open (the meadow's edge, the lake's shore)
  // could the walker see a place: ahead of them, within the sides of a wide frame and 60 m?
  const inSight = (x, z, walker) => {
    const fl = hypot(walker.fx, walker.fz) || 1,
      a = ((x - walker.x) * walker.fx + (z - walker.z) * walker.fz) / fl,
      r = ((z - walker.z) * walker.fx - (x - walker.x) * walker.fz) / fl;
    return (
      a > -1 && abs(r) < 0.7 * a + 2 && hypot(x - walker.x, z - walker.z) < 60
    );
  };
  // and with no crowns between: the sky shows clear along the ray (veil under 30)
  const seenFrom = (walker, x, y, z) => {
    if (!inSight(x, z, walker)) return false;
    const d = hypot(x - walker.x, y - walker.y, z - walker.z) || 1;
    return (
      veil(
        walker.x,
        walker.y,
        walker.z,
        (x - walker.x) / d,
        (y - walker.y) / d,
        (z - walker.z) / d,
        d,
      ) < 30
    );
  };
  // The next leg of a raven's way out of sight: on along the way it flies, a little higher, turned round a trunk
  const onward = (bird) => {
    const flight = bird.flight,
      fx = cos(bird.yaw),
      fz = sin(bird.yaw);
    flight.legs = (flight.legs || 0) + 1;
    if (flight.legs > AWAY_LEGS) return false;
    for (const turn of [0, 0.35, -0.35, 0.7, -0.7]) {
      const x = bird.x + cos(bird.yaw + turn) * AWAY_LEG,
        z = bird.z + sin(bird.yaw + turn) * AWAY_LEG,
        y = max(bird.y + 2, ground(x, z) + 10),
        c = [
          bird.x,
          bird.y,
          bird.z,
          bird.x + (fx * AWAY_LEG) / 3,
          bird.y + (y - bird.y) / 3,
          bird.z + (fz * AWAY_LEG) / 3,
          x - (cos(bird.yaw + turn) * AWAY_LEG) / 3,
          y,
          z - (sin(bird.yaw + turn) * AWAY_LEG) / 3,
          x,
          y,
          z,
        ];
      let clear = true;
      for (let k = 1; k <= AWAY_LEG / 1.5 && clear; k++) {
        curveAt(c, k / (AWAY_LEG / 1.5), P);
        const p = avoid(P[0], P[2], 0.2);
        clear =
          hypot(p[0] - P[0], p[1] - P[2]) < 0.01 &&
          P[1] > ground(P[0], P[2]) + 6;
      }
      if (!clear) continue;
      Object.assign(flight, {
        curve: c,
        t: 0,
        T: AWAY_LEG / bird.kind.speed,
        cruise: true,
      });
      return true;
    }
    return false;
  };
  // A raven's head turns slowly from one bearing to another, now and then to the walker; its weight shifts
  const ravenHead = (bird, h, walker, near) => {
    bird.headNext -= h;
    if (bird.headNext <= 0) {
      bird.headNext = wait(2.6);
      const bearing = turnTo(
        bird.yaw,
        atan2(walker.z - bird.z, walker.x - bird.x),
      );
      bird.headTo =
        near && abs(bearing) < 1.3 && chance() < 0.4
          ? clamp(bearing / 1.3, -1, 1)
          : chance() < 0.3
            ? 0
            : between(-0.8, 0.8);
      bird.cockTo = chance() < 0.25 ? between(-0.3, 0.3) : 0;
    }
    bird.head += (bird.headTo - bird.head) * min(1, h / 0.45);
    bird.cock += (bird.cockTo - bird.cock) * min(1, h / 0.5);
    bird.crest = 0;
    bird.swayNext -= h;
    if (bird.swayNext <= 0) {
      bird.swayNext = wait(4);
      bird.rollTo = between(-0.06, 0.06);
    }
    bird.roll += (bird.rollTo - bird.roll) * min(1, h / 0.5);
  };
  // A walk of a few strides to a place near: each step STRIDE of its length, the feet planted while down (vsJay);
  // `scale` under 1 for a short shuffle where it stands (`still`: the body stays, on a snag's top)
  const startWalk = (bird, to, scale = 1, still = false) => {
    bird.walk = {
      to,
      scale,
      still,
      cyc: between(0.9, 1.1),
      left: to ? 6 : 0.5,
    };
    bird.step = 0;
    bird.act = 'walk';
    bird.actT = 0;
  };
  const walkOn = (bird, h) => {
    const walk = bird.walk,
      // (the last half cycle the stride eases down to nothing, so the feet come together)
      ending = walk.left <= 0.5,
      scale = walk.scale * (ending ? clamp(walk.left * 2, 0, 1) : 1),
      speed = walk.still ? 0 : (2 * STRIDE * scale * bird.len) / walk.cyc,
      dt = h / walk.cyc;
    bird.step = (bird.step + dt) % 1;
    walk.left -= dt;
    bird.stride = scale;
    if (walk.to) {
      const d = hypot(walk.to[0] - bird.x, walk.to[1] - bird.z);
      if (d < 0.25 && !ending) walk.left = min(walk.left, 0.5);
      bird.yaw +=
        clamp(
          turnTo(bird.yaw, atan2(walk.to[1] - bird.z, walk.to[0] - bird.x)),
          -1,
          1,
        ) * min(1, h * 1.4);
    }
    if (speed > 0) {
      const nx = bird.x + cos(bird.yaw) * speed * h,
        nz = bird.z + sin(bird.yaw) * speed * h,
        p = avoid(nx, nz, 0.15);
      if (
        hypot(p[0] - nx, p[1] - nz) > 0.01 ||
        !openGround(nx, nz) ||
        !dry(nx, nz)
      )
        walk.left = min(walk.left, 0.5);
      else {
        bird.x = nx;
        bird.z = nz;
        bird.y = ground(nx, nz);
      }
    }
    // (the head nods a little with each step)
    bird.nod = -0.05 + 0.07 * sin(bird.step * TAU * 2) * scale;
    if (walk.left <= 0) {
      bird.walk = null;
      bird.stride = 0;
      bird.step = 0;
      bird.nod = 0;
      bird.act = 'still';
      bird.actT = 0;
      bird.next = wait(1.6);
    }
  };
  // a place on the path near its home for it to walk to or come down on, between `from` and `to` metres from it and
  // `least` from the walker or more
  const ravenSpot = (bird, walker, from, to, least) => {
    const group = groups[bird.group];
    // (the loop's points near its perches it may walk: clear of trunks and rails, under open sky)
    group.walks ??= paths[0].filter(([x, z]) => {
      const p = avoid(x, z, 0.3);
      return (
        [...group.snags, ...group.lows].some(
          (k) => hypot(x - seat[k * 4], z - seat[k * 4 + 2]) < RAVEN_REACH,
        ) &&
        hypot(p[0] - x, p[1] - z) < 0.01 &&
        openGround(x, z) &&
        dry(x, z) &&
        veil(x, ground(x, z) + 1, z, 0, 1, 0, 40) < OPEN_SKY
      );
    });
    const fits = group.walks.filter(([x, z]) => {
      const d = hypot(x - bird.x, z - bird.z);
      return d >= from && d <= to && hypot(x - walker.x, z - walker.z) > least;
    });
    for (let tries = 0; tries < 4 && fits.length; tries++) {
      const [x0, z0] = fits[floor(chance() * fits.length)],
        x = x0 + between(-0.3, 0.3),
        z = z0 + between(-0.3, 0.3);
      if (openGround(x, z) && dry(x, z)) return [x, z];
    }
    return null;
  };
  // up to a free low perch of its home, `least` m from the walker or more
  const toLow = (bird, walker, least) => {
    const free = groups[bird.group].lows.filter(
      (k) =>
        !taken[k] &&
        k !== bird.perch &&
        hypot(seat[k * 4] - walker.x, seat[k * 4 + 2] - walker.z) > least,
    );
    for (let tries = 0; tries < 3 && free.length; tries++) {
      const k = free.splice(floor(chance() * free.length), 1)[0];
      if (flyTo(bird, feet(bird, k, 0), k, walker)) return true;
    }
    return false;
  };
  // down to walk the path near its home
  const toPath = (bird, walker, from, to, least) => {
    const spot = ravenSpot(bird, walker, from, to, least);
    return (
      !!spot &&
      flyTo(bird, [spot[0], ground(spot[0], spot[1]), spot[1]], -1, walker)
    );
  };
  // Approached: a crouch, a jump, and off with deep slow beats, low and then climbing, to a snag of its home if one
  // lies out of the walker's way, or a low perch far from them; else away over the open, up and out of sight
  const ravenFlee = (bird, walker) => {
    const group = groups[bird.group];
    bird.fleeIn = 0.5; // (no way out just now: it tries again in a moment)
    for (const k of group.snags) {
      if (taken[k] || k === bird.perch) continue;
      const x = seat[k * 4],
        z = seat[k * 4 + 2];
      if (hypot(x - walker.x, z - walker.z) < 12) continue;
      if (flyTo(bird, feet(bird, k, 0), k, walker)) return true;
    }
    if (toLow(bird, walker, 18)) return true;
    const away = atan2(bird.z - walker.z, bird.x - walker.x);
    for (const far of [38, 27, 18])
      for (const turn of [0, 0.5, -0.5, 1, -1, 1.5, -1.5, 2, -2]) {
        const a = away + turn,
          x = bird.x + cos(a) * far,
          z = bird.z + sin(a) * far;
        if (flyTo(bird, [x, ground(x, z) + between(10, 15), z], -2, walker)) {
          bird.away = true;
          return true;
        }
      }
    return false;
  };
  const onRaven = (bird, h, walker) => {
    const kind = bird.kind,
      group = groups[bird.group],
      dist = heed ? hypot(bird.x - walker.x, bird.z - walker.z) : 1e3,
      rain = walker.rain > 0.3,
      rest = restOf(bird);
    bird.actT += h;
    bird.fleeIn = (bird.fleeIn || 0) - h;
    // (a walker who keeps to the path it lets come nearer)
    if (
      dist < (pale(walker.x, walker.z) ? PATH_LEAVE : kind.leave) * bird.bold &&
      bird.fleeIn <= 0 &&
      ravenFlee(bird, walker)
    ) {
      bird.walk = null;
      bird.stride = 0;
      return;
    }
    if (bird.act === 'walk') return walkOn(bird, h);
    if (bird.act === 'peck') {
      // it bends to the ground, a stab or two, and up again
      const beat = bird.actT % 0.7,
        down =
          beat < 0.25
            ? smooth(beat / 0.25)
            : beat < 0.4
              ? 1
              : beat < 0.6
                ? 1 - smooth((beat - 0.4) / 0.2)
                : 0;
      bird.pitch = rest - 0.9 * down;
      bird.nod = -0.4 * down;
      if (bird.actT >= bird.pecks * 0.7) {
        Object.assign(bird, { pitch: rest, nod: 0, act: 'still', actT: 0 });
        bird.next = wait(2);
      }
      return;
    }
    if (bird.act === 'preen') {
      // its head turned back and down into the feathers of its shoulder, working at them
      const t = bird.actT,
        k = min(t / 0.4, 1, (bird.preenT - t) / 0.4);
      bird.head = bird.headTo * k + 0.08 * sin(t * 9) * k;
      bird.nod = -0.55 * k + 0.08 * sin(t * 13) * k;
      bird.ruffle = 0.35 * k;
      if (t >= bird.preenT) {
        Object.assign(bird, {
          head: 0,
          headTo: 0,
          nod: 0,
          ruffle: 0,
          act: 'still',
          actT: 0,
        });
        bird.next = wait(3);
      }
      return;
    }
    if (bird.act === 'hackles') {
      // the throat's feathers ruffled out into a beard, and smoothed again
      const t = bird.actT;
      bird.ruffle =
        t < 0.3 ? t / 0.3 : t < 1.1 ? 1 : max(0, 1 - (t - 1.1) / 0.5);
      if (t > 1.6) {
        Object.assign(bird, { ruffle: 0, act: 'still', actT: 0 });
        bird.next = wait(3);
      }
      return;
    }
    if (rain) {
      // in the rain: on a perch, hunched (its feathers out, its head drawn in), still
      bird.ruffle += (0.55 - bird.ruffle) * min(1, h / 2);
      bird.nod += (-0.3 - bird.nod) * min(1, h / 2);
      bird.head *= 1 - min(1, h / 2);
      if (bird.mode === 'ground' && !toLow(bird, walker, PATH_LEAVE * 2))
        for (const k of group.snags)
          if (!taken[k] && flyTo(bird, feet(bird, k, 0), k, walker)) return;
      return;
    }
    bird.ruffle *= 1 - min(1, h / 1.5);
    bird.nod *= 1 - min(1, h / 0.6);
    ravenHead(bird, h, walker, dist < kind.notice);
    bird.next -= h;
    if (bird.next > 0) return;
    bird.next = wait(kind.sits);
    const pick = chance(),
      calm = dist > 25;
    if (bird.mode === 'perch') {
      // Fled up to its snag, it comes back down to a low perch or the path once the walker is well away. On a low
      // perch: now and then down to walk the path (the meadow's raven often), or across to another perch; else a
      // preen, its hackles, a shift of its feet
      if (group.snags.includes(bird.perch)) {
        if (
          calm &&
          chance() < 0.3 &&
          (toLow(bird, walker, 20) || toPath(bird, walker, 3, 30, 20))
        )
          return;
      } else if (chance() < DOWN[group.home]) {
        if (toPath(bird, walker, 1.5, 14, PATH_LEAVE * 2)) return;
      } else if (chance() < 0.08 && toLow(bird, walker, PATH_LEAVE * 2)) return;
      if (pick < 0.3) {
        bird.act = 'preen';
        bird.headTo = chance() < 0.5 ? 1 : -1;
        bird.preenT = between(1.5, 3.2);
      } else if (pick < 0.45) bird.act = 'hackles';
      else if (pick < 0.65) {
        bird.yaw += between(-0.5, 0.5);
        startWalk(bird, null, 0.3, true);
        return;
      } else return;
      bird.actT = 0;
      return;
    }
    // on the ground: a walk, a peck, a preen; up to a low perch again after a while
    bird.walked = (bird.walked || 0) + 1;
    if (pick < 0.1 || bird.walked > 14) {
      bird.walked = 0;
      if (toLow(bird, walker, PATH_LEAVE * 2)) return;
    }
    if (pick < 0.55) {
      const spot = ravenSpot(bird, walker, 1.5, 5, 10);
      if (spot) return startWalk(bird, spot);
    }
    if (pick < 0.8) {
      bird.act = 'peck';
      bird.pecks = 1 + floor(chance() * 3);
    } else if (pick < 0.9) {
      bird.act = 'preen';
      bird.headTo = chance() < 0.5 ? 1 : -1;
      bird.preenT = between(1.2, 2.5);
    } else return;
    bird.actT = 0;
  };
  // gone over or away and out of sight: back on a free perch of its home (a low one first) once the walker would
  // not see it come
  const ravenBack = (bird, h, walker) => {
    bird.next -= h;
    if (bird.next > 0) return;
    bird.next = between(3, 6);
    const group = groups[bird.group];
    for (const k of [...group.lows, ...group.snags])
      if (
        !taken[k] &&
        !inSight(seat[k * 4], seat[k * 4 + 2], walker) &&
        hypot(seat[k * 4] - walker.x, seat[k * 4 + 2] - walker.z) > 12
      ) {
        bird.perch = -1;
        ravenSits(bird, k);
        Object.assign(bird, {
          act: 'still',
          actT: 0,
          away: false,
          flight: null,
          stride: 0,
          walk: null,
        });
        return;
      }
  };
  // Over the open sky: a raven (one behind the other, at times a pair) passes high across the walker's view, 8 to 20
  // m up, from beyond one side of the frame to beyond the other, seen against the sky through a gap in the crowns.
  // The ravens of the world fly it: any not in the walker's sight. forced: from the debug menu, wherever the walker is
  let overIn = between(60, 150), // seconds of walking till the next
    skyCheck = 0,
    skyOpen = false;
  const overhead = (walker) =>
    veil(walker.x, walker.y, walker.z, 0, 1, 0, 40) < OPEN_SKY;
  const flyover = (walker, forced) => {
    if (!forced && !overhead(walker))
      return [null, 'no open sky over the walker'];
    const free = birds.filter(
      (b) =>
        b.kind.name === 'raven' &&
        !b.held &&
        b.mode !== 'fly' &&
        (b.mode === 'gone' ||
          groups[b.group].asleep ||
          !inSight(b.x, b.z, walker)),
    );
    if (!free.length) return [null, 'no raven out of sight'];
    const fl = hypot(walker.fx, walker.fz) || 1,
      fx = walker.fx / fl,
      fz = walker.fz / fl;
    for (let tries = 0; tries < 40; tries++) {
      const a = between(12, 22),
        tilt = between(-0.6, 0.6),
        side = chance() < 0.5 ? 1 : -1,
        // (across the view, turned a little toward or away from the walker)
        dx = (-fz * cos(tilt) + fx * sin(tilt)) * side,
        dz = (fx * cos(tilt) + fz * sin(tilt)) * side,
        half = 0.55 * a + between(5, 12),
        // (walking, the walker comes on while it flies: the line is laid ahead of where they will be at its middle)
        span = (2 * half * 1.05) / free[0].kind.speed,
        cx = walker.x + fx * a + walker.vx * (span / 2),
        cz = walker.z + fz * a + walker.vz * (span / 2),
        hy = ground(cx, cz) + between(8, 13),
        rise = between(-2, 2),
        bow = between(-4, 4),
        curve = [
          cx - dx * half,
          hy - rise,
          cz - dz * half,
          cx - (dx * half) / 3 - dz * bow,
          hy - rise / 3,
          cz - (dz * half) / 3 + dx * bow,
          cx + (dx * half) / 3 - dz * bow,
          hy + rise / 3,
          cz + (dz * half) / 3 + dx * bow,
          cx + dx * half,
          hy + rise,
          cz + dz * half,
        ];
      // (every 2 m: well over the ground; where the walker would see it, against the sky through the crowns, clear of
      // the trunks; at both ends unseen: out of the frame, or behind the crowns)
      let seen = 0,
        clear = true;
      const n = Math.ceil(half),
        ends = max(2, floor(n / 8));
      for (let k = 0; k <= n && clear; k++) {
        curveAt(curve, k / n, P);
        if (P[1] < ground(P[0], P[2]) + 7) clear = false;
        // (the walker where they will be when it gets there)
        const at = {
          ...walker,
          x: walker.x + (walker.vx * (span * k)) / n,
          z: walker.z + (walker.vz * (span * k)) / n,
        };
        if (!clear || !inSight(P[0], P[2], at)) continue;
        // (behind the crowns it is unseen; in the open, never through a trunk, and not over the top of a level view)
        const d = hypot(P[0] - at.x, P[1] - walker.y, P[2] - at.z),
          ahead = (P[0] - at.x) * fx + (P[2] - at.z) * fz,
          across = (P[2] - at.z) * fx - (P[0] - at.x) * fz;
        if (
          veil(
            at.x,
            walker.y,
            at.z,
            (P[0] - at.x) / d,
            (P[1] - walker.y) / d,
            (P[2] - at.z) / d,
            d,
          ) >= 30
        )
          continue;
        const q = avoid(P[0], P[2], 0.2);
        if (hypot(q[0] - P[0], q[1] - P[2]) > 0.01) {
          clear = false;
          continue;
        }
        if (P[1] - walker.y > 0.55 * ahead) continue;
        if (k < ends || k > n - ends) clear = false;
        else if (
          abs(across) < FRAME_W * ahead &&
          P[1] - walker.y < FRAME_UP * ahead
        )
          seen++;
      }
      if (!clear || seen < 5) continue;
      const pair = free.length > 1 && chance() < 0.4,
        T = span;
      (pair ? free.slice(0, 2) : free.slice(0, 1)).forEach((bird, k) => {
        // (the second a little behind and to one side of the first)
        const lag = k ? between(0.8, 1.6) : 0,
          off = k ? between(1.5, 3) * (chance() < 0.5 ? 1 : -1) : 0,
          c = curve.map(
            (v, i) =>
              v + (i % 3 === 0 ? -dz * off : i % 3 === 2 ? dx * off : 0),
          );
        if (bird.perch >= 0) taken[bird.perch] = null;
        Object.assign(bird, {
          perch: -1,
          mode: 'fly',
          act: 'fly',
          actT: 0,
          x: c[0],
          y: c[1],
          z: c[2],
          yaw: atan2(dz, dx),
          air: 1,
          spread: 1,
          fan: 0.65,
          stride: 0,
          walk: null,
          away: true,
          flight: {
            curve: c,
            t: -lag,
            T,
            burst: 0.4,
            perch: -2,
            cruise: true,
            over: true,
          },
        });
      });
      return [free[0], pair ? 'a pair' : 'one'];
    }
    return [null, 'no clear way over the open'];
  };
  const step = (h, walker) => {
    clock += h;
    // About once in three or four minutes of walking a raven goes over, where the walker has open sky over them
    // (never on a clock: a wait drawn anew)
    if (heed && walker.speed > 1.5 && (overIn -= h) <= 0) {
      skyCheck -= h;
      if (skyCheck <= 0) {
        skyCheck = 0.5;
        skyOpen = overhead(walker);
      }
      if (skyOpen) overIn = flyover(walker)[0] ? wait(210) : between(3, 6);
    }
    // While the walker walks, about every CROSSING_EVERY seconds and never within CROSSING_LEAST of the last, a jay
    // crosses the path ahead
    if (heed && walker.speed > 1.5) {
      crossIn -= h;
      if (crossIn <= 0)
        crossIn =
          clock - lastCross > CROSSING_LEAST && cross(walker)[0]
            ? max(CROSSING_LEAST, wait(CROSSING_EVERY))
            : between(3, 6);
    }
    // a party of chickadees moves on through the trees: its place shifts, and the birds follow one by one
    for (const group of groups) {
      if (group.asleep || group.species !== 1 || !group.at) continue;
      group.moveIn -= h * (walker.rain > 0.3 ? 0.2 : 1);
      if (group.moveIn > 0) continue;
      group.moveIn = wait(30);
      const lead = birds.find((b) => b.group === groups.indexOf(group));
      if (!lead) continue;
      const k = perchesFor(
        { ...lead, x: group.at[0], z: group.at[2] },
        walker,
        6,
        15,
        null,
        false,
      )[0];
      if (k !== undefined)
        group.at = [seat[k * 4], seat[k * 4 + 1], seat[k * 4 + 2]];
    }
    for (const bird of birds) {
      if (bird.held || groups[bird.group].asleep) continue;
      if (bird.mode === 'gone') ravenBack(bird, h, walker);
      else if (bird.act === 'settle') settle(bird, h);
      else if (bird.mode !== 'fly' && bird.kind.name === 'raven')
        onRaven(bird, h, walker);
      else if (bird.mode === 'ground') onGround(bird, h, walker);
      else if (bird.mode === 'fly') onWing(bird, h, walker);
      else onPerch(bird, h, walker);
    }
  };

  // ---- the instances: by mesh (the songbird's near and far, the jay's, the raven's), and the blots
  const data = new Float32Array(MOST * 32), // (a bird, and a stick under it, each 16)
    blots = new Float32Array(MOST * 8),
    // songbirds near and far, jays near and far, ravens near and far, blots, sticks (scene.js draws them so)
    counts = [0, 0, 0, 0, 0, 0, 0, 0];
  const order = [];
  const write = (walker) => {
    order.length = 0;
    counts.fill(0);
    for (const bird of birds)
      if (!groups[bird.group].asleep && bird.mode !== 'gone') {
        bird.far = hypot(
          bird.x - walker.x,
          bird.y - walker.y,
          bird.z - walker.z,
        );
        bird.slot = bird.kind.shape * 2 + (bird.far < NEAR ? 0 : 1);
        order.push(bird);
      }
    order.sort((a, b) => a.slot - b.slot);
    order.forEach((bird, k) => {
      const q = qMul(
          qAxis(0, 1, 0, PI / 2 - bird.yaw),
          qMul(qAxis(1, 0, 0, -bird.pitch), qAxis(0, 0, 1, bird.roll)),
        ),
        o = k * 16;
      data[o] = bird.x;
      data[o + 1] = bird.y;
      data[o + 2] = bird.z;
      data[o + 3] = bird.len;
      data.set(q, o + 4);
      data[o + 8] = SPECIES.indexOf(bird.kind) + bird.seed * 0.99;
      // (a raven on the ground with its wings shut: its walk instead, the stride in tenths and the cycle: vsJay)
      data[o + 9] =
        bird.kind.name === 'raven' && bird.air < 0.5 && bird.spread < 0.01
          ? floor(clamp(bird.stride || 0, 0, 1) * 10 + 0.5) + (bird.step || 0)
          : ((bird.phase % TAU) + TAU) % TAU;
      data[o + 10] = bird.spread + 2 * bird.air;
      data[o + 11] =
        floor(clamp(bird.fan, 0, 1) * 15 + 0.5) +
        clamp(bird.head, -1, 1) * 0.45 +
        0.5;
      // The fourth four, two to a number: the crest raised (in 31sts) with the feathers' ruffle in the fraction;
      // the toes closed (in 15ths) with the legs' reach forward; the body's pitch; the head's own pitch (in 40ths
      // of a radian, from -2) with its cock to one side. The head keeps level while the body is pitched up
      data[o + 12] =
        floor(clamp(bird.crest, 0, 1) * 31 + 0.5) +
        clamp(bird.ruffle, 0, 1) * 0.9 +
        0.05;
      data[o + 13] =
        floor(
          (bird.mode === 'perch' ? (bird.perch < nBranch ? 1 : 0.3) : 0) * 15 +
            0.5,
        ) +
        clamp(bird.fwd, 0, 1) * 0.9 +
        0.05;
      data[o + 14] = bird.pitch;
      data[o + 15] =
        floor(
          (clamp(-0.85 * max(bird.pitch - 0.1, 0) + bird.nod, -1.9, 1.9) + 2) *
            40 +
            0.5,
        ) +
        clamp(bird.cock, -0.5, 0.5) * 0.9 +
        0.5;
      counts[bird.slot]++;
      // the blot under it: on the ground's own slope, fainter and wider the higher the bird is over it
      const under = ground(bird.x, bird.z),
        high = bird.y - under;
      if (high < 0.4) {
        const b = counts[6]++ * 8;
        blots[b] = bird.x;
        blots[b + 1] = under + 0.012;
        blots[b + 2] = bird.z;
        blots[b + 3] = bird.len * (0.55 + high * 1.2);
        blots[b + 4] = 0.5 * (1 - high / 0.4);
        blots[b + 5] =
          (ground(bird.x + 0.1, bird.z) - ground(bird.x - 0.1, bird.z)) / 0.2;
        blots[b + 6] =
          (ground(bird.x, bird.z + 0.1) - ground(bird.x, bird.z - 0.1)) / 0.2;
        blots[b + 7] = 0;
      } else if (bird.mode === 'perch' && bird.perch >= nBranch) {
        // (on a post's top: a small one under its feet and belly)
        blots.set(
          [bird.x, bird.y + 0.004, bird.z, 0.18 * bird.len, 0.45, 0, 0, 0],
          counts[6]++ * 8,
        );
      }
    });
    // a round stick under each one that sits on a dead branch near the walker: the branch is a flat card
    let at = order.length;
    for (const bird of order) {
      if (bird.mode !== 'perch' || bird.perch >= nBranch || bird.far > 14)
        continue;
      const along = clamp(bird.alongNow ?? bird.along, 0.12, 0.95),
        a = branch(bird.perch, along - 0.04, [0, 0, 0]),
        b = branch(bird.perch, along + 0.04, [0, 0, 0]),
        mid = branch(bird.perch, along, [0, 0, 0]),
        q = qMul(
          qAxis(0, 1, 0, PI / 2 - atan2(b[2] - a[2], b[0] - a[0])),
          qAxis(1, 0, 0, -atan2(b[1] - a[1], hypot(b[0] - a[0], b[2] - a[2]))),
        );
      data.set(
        [mid[0], mid[1], mid[2], 0.3, ...q, 3, 0, 0, 0.5, 0.05, 0.05, 0, 80.5],
        at++ * 16,
      );
      counts[7]++;
    }
  };

  const stateOf = (bird) =>
    bird.mode === 'fly'
      ? 'flying'
      : bird.mode === 'perch'
        ? bird.act === 'hop'
          ? 'branch hop'
          : 'perched'
        : bird.act;
  return {
    data,
    blots,
    counts,
    // update(dt, walker): dt by the scene's clock; walker: x y z (the eye), speed, still (seconds stood still),
    // rain and fog (0 to 1)
    update(dt, walker) {
      // (a group whose bird has been brought away to cross a path stays awake; out of the walker's sight again,
      // the bird is back where it lives)
      groups.forEach((group, g) => {
        group.asleep =
          !on ||
          // (a raven's by where it is: its two snags may lie far apart)
          ((group.lives === 'raven'
            ? birds.every(
                (b) =>
                  b.group !== g ||
                  hypot(b.x - walker.x, b.z - walker.z) > SLEEP,
              )
            : hypot(group.x - walker.x, group.z - walker.z) > SLEEP) &&
            !birds.some((b) => b.group === g && (b.away || b.held)));
      });
      for (const bird of birds) {
        if (!bird.away || bird.held || bird.mode !== 'perch') continue;
        if (bird.kind.name === 'raven') continue; // (ravens come back by ravenBack)
        if (hypot(bird.x - walker.x, bird.z - walker.z) < 45) continue;
        const group = groups[bird.group],
          k = perchesFor(
            { ...bird, x: group.x, z: group.z },
            { x: 1e6, z: 1e6 },
            0,
            group.r,
            group.at,
            false,
          )[0];
        if (k !== undefined) sitOn(bird, k, 0.6);
        bird.act = 'still';
        bird.away = false;
      }
      for (let left = min(dt, 2); left > 1e-6; left -= 1 / 60)
        step(min(left, 1 / 60), walker);
      write(walker);
    },
    // list(): every bird's species, place, bearing and what it is doing; to: where it is flying to; left: its place
    // in the last flush and how far off the walker was when it went
    list: () =>
      birds.map((bird) => ({
        species: bird.kind.name,
        home: [groups[bird.group].x, groups[bird.group].z],
        at: [bird.x, bird.y, bird.z],
        facing: bird.yaw,
        state: stateOf(bird),
        to: bird.flight ? bird.flight.curve.slice(9) : null,
        eta: bird.flight ? bird.flight.T - bird.flight.t : 0,
        crossing: !!(bird.flight && bird.flight.crossing),
        over: !!(bird.flight && bird.flight.over),
        left: bird.left,
      })),
    on(to) {
      if (to !== undefined) on = !!to;
      return on;
    },
    heed(to) {
      if (to !== undefined) heed = !!to;
      return heed;
    },
    perches: () => nPerch,
    // count(n): how many jays there are; given a number, the world's birds are made afresh, that many jays
    count(n) {
      if (n !== undefined) populate(n);
      return birds.filter((bird) => bird.kind.name === 'jay').length;
    },
    // hold(k, pose, s, x, z, yaw): bird k held for a still, at a place facing a way. On the ground: 'stand' (its
    // crest raised by s), 'peck' (s of the way down), 'hop' (s of the way through it), 'wing' (in the air a metre
    // up, s of the way through a beat). On the post's top nearest the place: 'post' (crest by s), 'cock' (its head
    // cocked, to the left under a half), 'pick' (bent s of the way down to pick), 'ruffle' (fluffed by s). 'branch':
    // on the nearest branch. Without a pose it is let go
    hold(k, pose, s = 0.5, x, z, yaw) {
      const bird = birds[k];
      if (!bird) return;
      bird.held = !!pose;
      bird.left = null;
      groups[bird.group].waveAt = -99;
      if (!pose) {
        // (let go, it is at rest as it stands: nothing of the pose is left on it)
        Object.assign(bird, { ruffle: 0, nod: 0, cock: 0, cockTo: 0 });
        if (bird.mode !== 'fly')
          Object.assign(bird, {
            spread: 0,
            air: 0,
            fan: 0,
            pitch: restOf(bird),
          });
        return;
      }
      if (bird.perch >= 0) taken[bird.perch] = null;
      Object.assign(bird, {
        perch: -1,
        mode: 'ground',
        act: 'still',
        flight: null,
        air: 0,
        spread: 0,
        fan: 0,
        head: 0,
        headTo: 0,
        cock: 0,
        cockTo: 0,
        nod: 0,
        ruffle: 0,
        fwd: 0,
        roll: 0,
        crest: 0.3,
        flushIn: -1,
      });
      if (x !== undefined) {
        bird.x = x;
        bird.z = z;
      }
      if (yaw !== undefined) bird.yaw = yaw;
      bird.y = ground(bird.x, bird.z);
      bird.pitch = restOf(bird);
      if (!['stand', 'peck', 'hop', 'wing'].includes(pose)) {
        const branches = pose === 'branch';
        let best = -1,
          least = 1e9;
        for (
          let p = branches ? 0 : nBranch;
          p < (branches ? nBranch : nPerch);
          p++
        ) {
          const far =
            hypot(seat[p * 4] - bird.x, seat[p * 4 + 2] - bird.z) +
            (branches ? abs(seat[p * 4 + 3] - 3) : 0);
          if (far < least && !taken[p] && seat[p * 4 + 3] > 0.6) {
            least = far;
            best = p;
          }
        }
        if (best >= 0) {
          sitOn(bird, best, 0.6);
          if (yaw !== undefined) bird.yaw = yaw;
        }
      }
      if (pose === 'stand' || pose === 'post' || pose === 'branch')
        bird.crest = s;
      if (pose === 'cock') {
        bird.crest = 0.7;
        bird.head = 0.5;
        bird.cock = s < 0.5 ? -0.45 : 0.45;
      }
      if (pose === 'pick') {
        bird.pitch = restOf(bird) - 0.95 * s;
        bird.nod = -0.5 * s;
      }
      if (pose === 'ruffle') {
        bird.ruffle = s;
      }
      if (pose === 'peck') bird.pitch = restOf(bird) - 0.85 * s;
      if (pose === 'hop') {
        bird.y += 4 * 0.03 * s * (1 - s);
        bird.pitch = restOf(bird) + 0.2 * sin(s * PI);
      }
      if (pose === 'wing') {
        bird.y += bird.kind.name === 'raven' ? 2 : 1; // (a raven's wings would all but reach the ground at 1 m)
        bird.air = 1;
        bird.spread = 1;
        bird.fan = bird.kind.name === 'raven' ? 1 : 0.5;
        bird.phase = s * TAU;
        bird.pitch = 0.1;
      }
    },
    // act(k, what): bird k does it now: 'hop' (a run of hops, on the ground or along its branch), 'peck', 'fly' (a
    // tree bird to another perch), 'pick', 'ruffle', 'turn' (on its perch), 'flush' (its flock leaves the ground,
    // it first), 'return' (the perched ones of its flock come down as soon as they may)
    act(k, what, walker) {
      const bird = birds[k];
      if (!bird) return;
      const still = bird.act === 'still',
        perched = bird.mode === 'perch' && still;
      if (what === 'flush' && bird.mode === 'ground') {
        groups[bird.group].lead = null;
        flush(bird, walker);
      } else if (what === 'return') {
        for (const b of birds)
          if (b.group === bird.group && b.mode === 'perch')
            b.calm = b.comeDown + 1;
      } else if (
        what === 'walk' &&
        bird.kind.name === 'raven' &&
        bird.mode === 'ground'
      )
        startWalk(bird, [
          bird.x + cos(bird.yaw) * 3,
          bird.z + sin(bird.yaw) * 3,
        ]);
      else if (what === 'fly' && perched) flit(bird, walker);
      else if (what === 'hop' && perched) {
        bird.run = 2;
        if (!branchHop(bird)) turnAbout(bird);
      } else if (what === 'turn' && perched) turnAbout(bird);
      else if ((what === 'pick' || what === 'ruffle') && perched) {
        bird.act = what;
        bird.actT = 0;
        bird.pecks = 2;
      } else if (bird.mode === 'ground' && still) {
        if (what === 'peck') {
          bird.act = 'peck';
          bird.actT = 0;
          bird.pecks = 3;
        } else if (what === 'hop') {
          bird.run = 4;
          bird.next = 0;
        }
      }
    },
    // ravens(n): how many ravens there are; given a number (0 to RAVENS), the world's birds are made afresh with so many
    ravens(n) {
      if (n !== undefined) {
        ravenCount = clamp(floor(n), 0, RAVENS);
        populate(jayCount);
      }
      return birds.filter((bird) => bird.kind.name === 'raven').length;
    },
    // flyover(walker): a raven goes over the open sky ahead of the walker now: [which bird, how], or [-1, why not]
    flyover(walker) {
      const [bird, how] = flyover(walker, true);
      return [bird ? birds.indexOf(bird) : -1, how];
    },
    // cross(walker): a jay flies across the path ahead of the walker now: [which bird, how], or [-1, why not]
    cross(walker) {
      const [bird, how] = cross(walker);
      return [bird ? birds.indexOf(bird) : -1, how];
    },
  };
}
