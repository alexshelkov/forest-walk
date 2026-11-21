import {
  AA,
  ATLAS,
  MEDIUM,
  NEAR_D,
  RAYD,
  RAYN,
  SHADOW,
  SPRIGS,
  TWIGQ,
  WATER,
} from './quality.js';
import { LAKE, NX, NY, NZ, OPEN, OX, OY, OZ, TDN, VS } from './math.js';
import { SN } from './water.js';
import { PICS, SLOTS, STEM_B, STEM_T, STEM_W } from './sprigs.js';

// ============================================================================
// WGSL sources
// ============================================================================
// a number as a WGSL float literal
const f = (v) => (Number.isInteger(v) ? v + '.' : String(v));
// the light volume (tV) and the ground map (tM) cover the whole grid of math.js
const VOL0 = `vec3f(${f(OX)}, ${f(OY)}, ${f(OZ)})`,
  VOLS = `vec3f(${f(NX * VS)}, ${f(NY * VS)}, ${f(NZ * VS)})`,
  MAPW = f(NX * VS);

export const W_NOISE = /*wgsl*/ `
fn ss(a: f32, b: f32, x: f32) -> f32 { let t = clamp((x - a) / (b - a), 0., 1.); return t * t * (3. - 2. * t); }
fn h31(p: vec3f) -> f32 { var q = fract(p * vec3f(.1031, .1030, .0973)); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
fn h33(p: vec3f) -> vec3f { var q = fract(p * vec3f(.1031, .1030, .0973)); q += dot(q, q.yxz + 33.33); return fract((q.xxy + q.yxx) * q.zyx); }
fn vn(p: vec3f) -> f32 {
  let i = floor(p); let f = fract(p); let u = f * f * (3. - 2. * f);
  return mix(mix(mix(h31(i), h31(i + vec3f(1., 0., 0.)), u.x), mix(h31(i + vec3f(0., 1., 0.)), h31(i + vec3f(1., 1., 0.)), u.x), u.y),
             mix(mix(h31(i + vec3f(0., 0., 1.)), h31(i + vec3f(1., 0., 1.)), u.x), mix(h31(i + vec3f(0., 1., 1.)), h31(i + vec3f(1., 1., 1.)), u.x), u.y), u.z);
}
fn fbm(p: vec3f, n: i32) -> f32 {
  var a = .5; var s = 0.; var q = p;
  for (var i = 0; i < n; i++) { s += a * vn(q); q = q * 2.03 + vec3f(17.1, 31.7, 5.3); a *= .5; }
  return s / (1. - 2. * a);
}
fn wor(p: vec3f) -> f32 {
  let i = floor(p); let f = fract(p); var d = 9.;
  for (var x = -1; x <= 1; x++) { for (var y = -1; y <= 1; y++) { for (var z = -1; z <= 1; z++) {
    let o = vec3f(f32(x), f32(y), f32(z)); let r = o + h33(i + o) - f; d = min(d, dot(r, r));
  } } }
  return sqrt(d);
}
`;

// ---------------------------------------------------------------- terrain density (compute)
// How deep a stream's bed lies under its surface, e metres from the water's edge (below 0 in the water): a hand
// at the edge, most of a metre in the middle of a wide pool. The terrain is cut by it and the water shaded by it
const BED = /*wgsl*/ `
fn bedDepth(e: f32) -> f32 { return .07 + .8 * ss(.1, -2., e); }
`;
// The ground before the running water cuts into it, shared by the two passes below.
// TDF: metres to the trail's middle line on a grid over the world (world.js trailField)
const W_TERR =
  W_NOISE +
  /*wgsl*/ `
@group(0) @binding(3) var<storage, read> TDF: array<f32>;
fn smax(a: f32, b: f32, k: f32) -> f32 { let h = max(k - abs(a - b), 0.) / k; return max(a, b) + h * h * k * .25; }
fn smin(a: f32, b: f32, k: f32) -> f32 { return -smax(-a, -b, k); }
fn seg2(p: vec2f, a: vec2f, b: vec2f) -> f32 { let pa = p - a; let ba = b - a; let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0., 1.); return length(pa - ba * h); }
// metres to the lake's shore, as lakeD in math.js
fn lakeD(p: vec2f) -> f32 { var d = 1e9; ${LAKE.map((c) => `d = smin(d, length(p - vec2f(${f(c[0])}, ${f(c[1])})) - ${f(c[2])}, 8.);`).join(' ')} return d; }
// metres to the trail's middle line, as trailD in world.js
fn trailD(p: vec2f) -> f32 {
  let q = clamp((p - vec2f(${f(OX)}, ${f(OZ)})) / ${f((NX * VS) / TDN)} - .5, vec2f(0.), vec2f(${TDN - 1.001}));
  let i = vec2u(q); let w = q - vec2f(i); let o = i.x + ${TDN}u * i.y;
  return mix(mix(TDF[o], TDF[o + 1u], w.x), mix(TDF[o + ${TDN}u], TDF[o + ${TDN + 1}u], w.x), w.y);
}
// g0: the ground's height at p (it depends a little on p.y too, through the warp w); dt, ld: metres to the trail
// and to the lake's shore; q: p warped
struct Base { g0: f32, dt: f32, ld: f32, w: vec3f, q: vec3f };
fn base(p: vec3f) -> Base {
  var o: Base;
  let w = vec3f(fbm(p * .04 + 11., 3), fbm(p * .04 + 47., 3), fbm(p * .04 + 83., 3)) - .5;
  let q = p + w * vec3f(15., 6., 15.);
  let ld = lakeD(p.xz); let dt = trailD(p.xz);
  let ring = ss(150., 178., length(p.xz) + w.x * 14.);
  // rolling ground that climbs away from the lake, and a ridge round the edge of the world
  var g0 = 6. + .045 * clamp(ld, 0., 150.) + 12. * (fbm(vec3f(q.xz * .009, 3.), 4) - .42) + 2.2 * (fbm(vec3f(q.xz * .05, 9.), 3) - .5)
    + ring * (15. + 9. * fbm(vec3f(q.xz * .03, 5.), 2));
  // Relief, because a forest floor is never level: mounds and hollows some 30 m across, humps a few metres across.
  // Both die away toward the trail, which so runs along the low ground between them, banks rising beside it
  g0 += ss(2.5, 16., dt) * (12. * (fbm(vec3f(q.xz * .033, 21.), 3) - .5) + 1.8 * (fbm(vec3f(p.xz * .13, 37.), 2) - .5));
  // the trail itself: worn a hand deep, with uneven raised shoulders along both edges
  g0 += .3 * ss(.9, 2., dt) * (1. - ss(2., 4.5, dt)) * (.4 + 1.2 * fbm(vec3f(p.xz * .4, 5.), 2)) - .15 * (1. - ss(.5, 1.6, dt));
  // the lake's bowl and its shore
  o.g0 = mix(clamp(ld * .16, -5., 6.), g0, ss(1., 31., ld)); o.dt = dt; o.ld = ld; o.w = w; o.q = q;
  return o;
}
`;
// The ground's height at the places of PT (x z), into HT: what water.js sets the streams' levels by. A height that
// depends on itself (base reads p.y) is found by trying it a few times, each try closer
export const W_LEVEL =
  W_TERR +
  /*wgsl*/ `
@group(0) @binding(0) var<storage, read> PT: array<vec2f>;
@group(0) @binding(1) var<storage, read_write> HT: array<f32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&PT)) { return; }
  let q = PT[id.x]; var y = 8.;
  for (var k = 0; k < 12; k++) { y = mix(y, base(vec3f(q.x, y, q.y)).g0, .75); }
  HT[id.x] = y;
}
`;
// P: two vec4 per rock outcrop (world.js MESAS). SF: the running water on a grid over the world (water.js bake):
// x metres to the nearest water's edge (below 0 in it), y its level there
export const W_DENS =
  W_TERR +
  BED +
  /*wgsl*/ `
struct U { n: vec4u, o: vec4f, c: vec4u };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read_write> D: array<f32>;
@group(0) @binding(2) var<storage, read> P: array<vec4f>;
@group(0) @binding(4) var<storage, read> SF: array<vec2f>;
fn streamAt(p: vec2f) -> vec2f {
  let q = clamp((p - vec2f(${f(OX)}, ${f(OZ)})) / ${f((NX * VS) / SN)} - .5, vec2f(0.), vec2f(${SN - 1.001}));
  let i = vec2u(q); let w = q - vec2f(i); let o = i.x + ${SN}u * i.y;
  // (the level of the nearest cell: beside a cell out of the field's reach an average would mean nothing)
  let near = o + u32(step(.5, w.x)) + ${SN}u * u32(step(.5, w.y));
  return vec2f(mix(mix(SF[o].x, SF[o + 1u].x, w.x), mix(SF[o + ${SN}u].x, SF[o + ${SN + 1}u].x, w.x), w.y), SF[near].y);
}
fn dens(p: vec3f) -> f32 {
  let bs = base(p); let w = bs.w; let q = bs.q; let dt = bs.dt;
  var g0 = bs.g0;
  // The running water. In it the bed, by bedDepth. Beside it a bank of uneven height, forced for a metre; from
  // there the ground is only held between a levee that falls away (where the land lies lower than the water) and
  // a valley side that climbs (where it lies higher). All of it lets go 20 m out, and where the lake takes over
  let sf = streamAt(p.xz); let se = sf.x;
  // (the bank: cut steep, 20 to 50 cm high, lower where the trail comes down to a bridge)
  let bank = -.07 + (.26 + .3 * fbm(vec3f(p.xz * .23, 3.), 2)) * mix(.15, 1., ss(3., 9., dt)) * ss(.1, .6, se);
  let prof = sf.y + select(bank, -bedDepth(se), se < .1);
  let lo = prof - .5 * max(se - 2.2, 0.); let hi = prof + (.14 + .2 * fbm(vec3f(p.xz * .09, 8.), 2)) * max(se - 1., 0.);
  g0 = mix(clamp(g0, lo, hi), g0, max(ss(19., 25., se), ss(1.5, -1.5, bs.ld)));
  // rock outcrops
  let tn = 3. * (fbm(vec3f(q.xz * .09, 2.), 3) - .5);
  var dm = -1e3; var de = 1e3;
  var k = 0u;
  for (var i = 0u; i < u.c.x; i++) {
    let a = P[k]; let b = P[k + 1u]; k += 2u;
    let yr = clamp((p.y - g0) / max(b.y - g0, 1.), 0., 1.3);
    var e = seg2(q.xz, a.xy, a.zw) - b.x;
    e -= b.z * ss(.3, .92, yr) + 3. * (1. - yr) * (1. - yr) - b.w * ss(.0, .5, yr) * (1. - ss(.5, 1., yr));
    dm = smax(dm, smin(-e, b.y + tn - p.y, 3.), 2.5);
    de = min(de, e);
  }
  var d = smax(g0 + 3.5 * ss(9., 0., de) - p.y, dm, 3.);
  // rock detail: strong on the outcrops, a little of it on the forest floor (lumps underfoot), least on the trail
  // and in and beside the water, where the bed and the bank are shaped already
  let rk = mix(.16, 1., ss(.8, 5., p.y - g0)) * mix(.08, 1., ss(1., 4., dt)) * mix(.3, 1., ss(.3, 3., se));
  d += rk * ((.5 - wor(p * .17 + w * 2.)) * 3.4 + (.5 - wor(p * .41 + 7.)) * 1.3 + (fbm(p * .3, 3) - .5) * 2.2);
  d += rk * 2.2 * (abs(fract(p.y * .21 + w.y * 2.2) - .5) - .25);
  return min(d, ${f(OY + NY * VS - 2)} - p.y);
}
// one slab of z slices from u.n.w (see scene.js); D holds just the slab
@compute @workgroup_size(4, 4, 4) fn main(@builtin(global_invocation_id) sid: vec3u) {
  let id = sid + vec3u(0u, 0u, u.n.w);
  if (any(id >= u.n.xyz)) { return; }
  var d = dens(u.o.xyz + vec3f(id) * u.o.w);
  if (id.x == 0u || id.z == 0u || id.x == u.n.x - 1u || id.z == u.n.z - 1u || id.y == u.n.y - 1u) { d = -1.; }
  D[sid.x + u.n.x * (sid.y + u.n.y * sid.z)] = d;
}
`;

// ---------------------------------------------------------------- fullscreen helpers
export const W_FS = /*wgsl*/ `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return vec4f(f32(i32(i & 1u) * 4 - 1), f32(i32(i >> 1u) * 4 - 1), 0., 1.); }
`;

// detail texture (tileable), used for rock, soil, bark and as plain noise: rg = slope, b = height, a = mottling
export const W_DETAIL =
  W_NOISE +
  W_FS +
  /*wgsl*/ `
fn hp(p: vec2f, per: f32) -> f32 { return h31(vec3f(p - per * floor(p / per), per)); }
fn tn(p: vec2f, per: f32) -> f32 {
  let i = floor(p); let f = fract(p); let u = f * f * (3. - 2. * f);
  return mix(mix(hp(i, per), hp(i + vec2f(1., 0.), per), u.x), mix(hp(i + vec2f(0., 1.), per), hp(i + vec2f(1., 1.), per), u.x), u.y);
}
fn tf(uv: vec2f, per: f32, n: i32) -> f32 { var a = .5; var s = 0.; var pr = per; for (var i = 0; i < n; i++) { s += a * tn(uv * pr + f32(i) * 7.3, pr); pr *= 2.; a *= .5; } return s / (1. - 2. * a); }
fn tw(p: vec2f, per: f32) -> vec3f {
  let i = floor(p); let f = fract(p); var d = vec2f(9.); var id = 0.;
  for (var x = -1; x <= 1; x++) { for (var y = -1; y <= 1; y++) {
    let o = vec2f(f32(x), f32(y)); let c = i + o; let cw = c - per * floor(c / per);
    let hh = h33(vec3f(cw, per)); let r = o + hh.xy - f; let l = dot(r, r);
    if (l < d.x) { d.y = d.x; d.x = l; id = hh.z; } else if (l < d.y) { d.y = l; }
  } }
  return vec3f(sqrt(d), id);
}
fn H(uv: vec2f) -> f32 {
  let wq = uv + .11 * (vec2f(tf(uv, 3., 4), tf(uv + .5, 3., 4)) - .5);
  let f = tf(wq, 3., 8);
  let r1 = 1. - abs(tf(wq + 1.7, 5., 6) * 2. - 1.);
  let cr = min(abs(tf(wq + 4.1, 4., 5) * 2. - 1.) * 7., 1.);
  let cr2 = min(abs(tf(wq.yx + 2.3, 9., 4) * 2. - 1.) * 9., 1.);
  let pt = tw(wq * 29., 29.);
  let pit = (1. - ss(.0, .34, pt.x)) * step(.62, pt.z);
  return f * .50 + r1 * r1 * .24 + cr * cr2 * .26 - pit * .07;
}
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = fc.xy / 1024.; let e = 1. / 1024.;
  let h = H(uv);
  let gx = H(uv + vec2f(e, 0.)) - H(uv - vec2f(e, 0.)); let gy = H(uv + vec2f(0., e)) - H(uv - vec2f(0., e));
  let s = clamp(vec2f(gx, gy) * 1024. * .5 * .075, vec2f(-1.), vec2f(1.));
  return vec4f(-s * .5 + .5, h, tf(uv + 3.7, 3., 5));
}
`;

// blit / mip / bloom chain
export const W_BLIT =
  W_FS +
  /*wgsl*/ `
@group(0) @binding(0) var t: texture_2d<f32>;
@group(0) @binding(1) var s: sampler;
fn uvOf(fc: vec4f, k: f32) -> vec2f { return fc.xy * k / vec2f(textureDimensions(t)); }
@fragment fn fsMip(@builtin(position) fc: vec4f) -> @location(0) vec4f { return textureSampleLevel(t, s, uvOf(fc, 2.), 0.); }
// (only what exceeds 1 blooms: a blur of the whole frame would lie over every shadow)
fn kar(c0: vec3f) -> vec4f { let c = max(c0 - vec3f(1.), vec3f(0.)); let w = 1. / (1. + max(c.r, max(c.g, c.b))); return vec4f(c * w, w); }
@fragment fn fsDown0(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = uvOf(fc, 2.); let e = 1. / vec2f(textureDimensions(t));
  let a = kar(min(textureSampleLevel(t, s, uv + e * vec2f(-1., -1.), 0.).rgb, vec3f(24.)));
  let b = kar(min(textureSampleLevel(t, s, uv + e * vec2f(1., -1.), 0.).rgb, vec3f(24.)));
  let c = kar(min(textureSampleLevel(t, s, uv + e * vec2f(-1., 1.), 0.).rgb, vec3f(24.)));
  let d = kar(min(textureSampleLevel(t, s, uv + e * vec2f(1., 1.), 0.).rgb, vec3f(24.)));
  let m = a + b + c + d;
  return vec4f(m.rgb / m.a, 1.);
}
@fragment fn fsDown(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = uvOf(fc, 2.); let e = 1. / vec2f(textureDimensions(t));
  return (textureSampleLevel(t, s, uv + e * vec2f(-1., -1.), 0.) + textureSampleLevel(t, s, uv + e * vec2f(1., -1.), 0.)
        + textureSampleLevel(t, s, uv + e * vec2f(-1., 1.), 0.) + textureSampleLevel(t, s, uv + e * vec2f(1., 1.), 0.)) * .25;
}
@fragment fn fsUp(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = uvOf(fc, .5); let e = .75 / vec2f(textureDimensions(t));
  return (textureSampleLevel(t, s, uv + e * vec2f(-1., -1.), 0.) + textureSampleLevel(t, s, uv + e * vec2f(1., -1.), 0.)
        + textureSampleLevel(t, s, uv + e * vec2f(-1., 1.), 0.) + textureSampleLevel(t, s, uv + e * vec2f(1., 1.), 0.)) * .25;
}
`;

// animated texture, tileable: rg = the light the canopy lets through (dapple), ba = the slope of the lake's ripples
// tm: x time, y wind
export const W_WATER =
  W_FS +
  /*wgsl*/ `
@group(0) @binding(0) var<uniform> tm: vec4f;
const WK = array<vec3f, 10>(vec3f(1., 2., 1.), vec3f(-2., 1., .9), vec3f(3., 1., .6), vec3f(1., -4., .5), vec3f(4., 3., .4),
  vec3f(-3., 5., .32), vec3f(6., -2., .28), vec3f(5., 7., .2), vec3f(-8., 3., .18), vec3f(2., 11., .14));
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = fc.xy / ${WATER}.; let t = tm.x;
  let wu = uv + .02 * vec2f(sin(6.2831853 * (uv.y * 2. + .1 * t)), cos(6.2831853 * (uv.x * 3. - .07 * t)));
  var s = vec2f(0.); var gap = 0.;
  for (var i = 0; i < 10; i++) {
    let k = WK[i]; let way = select(-1., 1., (i & 1) == 0);
    s += k.xy * k.z * cos(dot(k.xy, wu) * 6.2831853 + t * (.5 + .35 * sqrt(length(k.xy))) * way + f32(i) * 1.7);
    // the gaps between leaves: the same waves, slower, breathing with the wind
    gap += k.z * cos(dot(k.yx, uv) * 6.2831853 + t * (.1 + .05 * f32(i)) * (.4 + tm.y) * way + f32(i) * 2.4);
  }
  let c = clamp((gap + .35) / 1.4, 0., 1.);
  return vec4f(c, c, s * .06);
}
`;

// ---------------------------------------------------------------- shared scene code
// G.sun.w: how overcast it is (0 clear, 1 raining). G.mis: the old rule's exposure, light shafts, draw distance scale,
// debug.sprigs. G.wx: how wet things are, wind, rain falling, haze per metre
export const S_G = /*wgsl*/ `
// (fl: the way to the lightning in the sky and how bright it is now; st: storm, thick fog, the flash's kind, its
// seed; wy: how far the wind has blown things so far, how soaked the ground is, the walker's speed x and z;
// lt, ls: where the trees' and the shrubs' cards thin and end, lf.xy: where a far tree's picture comes in, lf.zw:
// where the fog closes (hazeT), all following the fog: W_LEAF thin and vsFar, scene.js lodNow; ex: the highlights'
// key H, 1 for the old exposure rule (W_POST), ex.z debug.isolate's part (1 the tree without its far picture, 2
// the far picture alone); ea: the frame's seconds, 1 to take its measure at once (W_METER); dbg: debug.isolate's
// place x, z and reach, 1 a white mask, 2 the tree shaded alone)
struct G { vp: mat4x4f, sm: mat4x4f, cam: vec4f, right: vec4f, up: vec4f, fwd: vec4f, sun: vec4f, res: vec4f, mis: vec4f, wx: vec4f, fl: vec4f, st: vec4f, wy: vec4f, lt: vec4f, ls: vec4f, lf: vec4f, ex: vec4f, ea: vec4f, dbg: vec4f };
const SUNC = vec3f(3.3, 1.9, .86);
const TAU = 6.2831853;
const LOW = ${!MEDIUM};
fn sat(x: f32) -> f32 { return clamp(x, 0., 1.); }
// debug.isolate: is a tree's card or a solid rooted at p left out, being away from the one place shown?
fn isoOut(p: vec3f) -> bool { return g.dbg.w > .5 && distance(p.xz, g.dbg.xy) > g.dbg.z; }
// and is it left out as the part not shown (far: of the far picture)?
fn isoSkip(far: bool) -> bool { return g.dbg.w > .5 && g.ex.z > .5 && (g.ex.z < 1.5) == far; }
fn ss(a: f32, b: f32, x: f32) -> f32 { let t = clamp((x - a) / (b - a), 0., 1.); return t * t * (3. - 2. * t); }
fn ign(p: vec2f) -> f32 { return fract(52.9829189 * fract(dot(p, vec2f(.06711056, .00583715)))); }
fn hs(x: f32) -> f32 { return fract(sin(x * 127.1) * 43758.5453); }
fn fin(c: vec3f) -> vec4f { return vec4f(min(max(c, vec3f(0.)), vec3f(40.)), 1.); }
// A flash of lightning's light in a direction: cold, most toward where it is in the sky. One term for the sky,
// the fog (through skyC) and the sky's light on things, so the forest stands dark against a lit sky and fog
// (wide: the whole cloud layer brightens, most round the flash and still clearly on the far side)
// (a bolt lifts the sky and the fog only a little: its glow is round its root, and it stands on a dark sky)
fn flashL(rd: vec3f) -> vec3f { return vec3f(.72, .8, 1.) * (g.fl.w * (.34 + .66 * pow(.5 + .5 * dot(rd, g.fl.xyz), 3.)) * mix(1., .14, step(1.5, g.st.z))); }
// the low sun's light, dimmed to almost nothing under rain clouds
fn sunE() -> vec3f { return SUNC * (1. - .94 * g.sun.w) * (1. - .9 * sat(g.wx.z * 3.)); }
// the sky in a direction: a blue zenith over a horizon that is warm only toward the sun, a glow round the low
// sun, grey when overcast
fn skyDay(rd: vec3f) -> vec3f {
  let y = max(rd.y, 0.); let mu = max(dot(rd, g.sun.xyz), 0.);
  let hs = pow(.5 + .5 * dot(normalize(rd.xz + vec2f(1e-4)), normalize(g.sun.xz)), 3.);
  var c = mix(mix(vec3f(.46, .52, .60), vec3f(1.25, .66, .30), hs), vec3f(.13, .27, .60), pow(y, .42));
  c += vec3f(1.9, .85, .25) * pow(mu, 5.) * .55 + vec3f(3., 1.7, .6) * pow(mu, 48.);
  // a misty day: mostly a pale grey, lighter toward the sun and toward the zenith; under rain a darker lid
  c = mix(c, vec3f(.62, .66, .70) * (.72 + .3 * y + .8 * pow(mu, 3.)), .72);
  return mix(c, vec3f(.34, .36, .39) * (.6 + .6 * y), sat(g.wx.z * 1.2) * .94);
}
// the sky as it is seen: under a storm a dark slate lid from just over the horizon up, and the lightning's light
fn skyC(rd: vec3f) -> vec3f {
  return skyDay(rd) * (1. - .8 * g.st.x * ss(.015, .16, rd.y)) + flashL(rd) * .36;
}
// What the fog adds along a view ray: toward the sun the sky's colour just over the horizon, paler; away from it
// cooler and greener, light that has come down through the trees. The two tints are what gives the fog depth
fn hazeC(rd: vec3f) -> vec3f {
  // (the fog holds the horizon's light: under a storm it stays paler than the cloud. A flash glows in it, cold)
  let low = normalize(vec3f(rd.x, .06 + max(rd.y, 0.) * .25, rd.z));
  let lum = dot(skyDay(low) + flashL(low) * .75, vec3f(.3));
  let toSun = .5 + .5 * dot(normalize(rd.xz + vec2f(1e-4)), normalize(g.sun.xz));
  // (in the rain cooler, and no warmer toward the sun)
  // (thick fog is an even cool grey, the sun hardly through it)
  return mix(mix(vec3f(.78, .9, .92), vec3f(.8, .88, .98), sat(g.wx.z * 2.)), vec3f(1.18, 1., .76), pow(toSun, 3.) * (1. - sat(g.wx.z * 3.)) * (1. - .8 * g.st.y)) * lum * (.78 - .2 * g.st.y) * (1. - .3 * g.st.x);
}
// How much light comes through d metres of fog along a ray that climbs ry a metre (the fog thins upward). Squared
// in the exponent: what is near stays clear, and it closes in fast around 1 / wx.w metres. oy is unused. Then the
// fog closes: by the ray's own length it takes what is left between lf.z and lf.w metres, so nothing is seen any
// more where drawing stops (scene.js lodNow)
fn hazeT(d: f32, ry: f32, oy: f32) -> f32 {
  let k = .03 * ry; let e = select((1. - exp(-k * d)) / k, d, abs(k) < 1e-4);
  // (a little steeper than a plain haze: near things stay clear, and the forest steps back in several tones
  // before it is gone)
  // (in thick fog the nearest trunks are soft already: less steep)
  return exp(-pow(g.wx.w * e, mix(1.7, 1.3, g.st.y))) * (1. - ss(g.lf.z, g.lf.w, d));
}
`;

export const S_B =
  S_G +
  BED +
  /*wgsl*/ `
@group(0) @binding(0) var<uniform> g: G;
@group(0) @binding(1) var sR: sampler;
@group(0) @binding(2) var sC: sampler;
@group(0) @binding(3) var sS: sampler_comparison;
@group(0) @binding(4) var tSh: texture_depth_2d;
@group(0) @binding(5) var tW: texture_2d<f32>;
@group(0) @binding(6) var tD: texture_2d<f32>;
@group(0) @binding(7) var tV: texture_3d<f32>;
@group(0) @binding(8) var tM: texture_2d<f32>;
@group(0) @binding(9) var tS: texture_2d<f32>;
@group(0) @binding(10) var tC: texture_2d<f32>;
@group(0) @binding(11) var tF: texture_2d_array<f32>; // the foliage atlas (atlas.js)
fn shUV(p: vec3f) -> vec3f { let s = g.sm * vec4f(p, 1.); return vec3f(s.x * .5 + .5, .5 - s.y * .5, s.z - .0006); }
fn shadow1(p: vec3f) -> f32 { let s = shUV(p); return textureSampleCompareLevel(tSh, sS, s.xy, s.z); }
// shadow1 for vertex shaders: a plain read and compare. Safari's Metal output fails to build a vertex shader
// that uses a comparison sampler ("Vertex library failed creation"). Clamped like the sampler's edge.
fn shadowV(p: vec3f) -> f32 {
  let s = shUV(p); let n = vec2f(textureDimensions(tSh));
  let d = textureLoad(tSh, vec2i(clamp(s.xy * n, vec2f(0.), n - 1.)), 0);
  return select(0., 1., s.z <= d);
}
fn shadow4(p: vec3f) -> f32 {
  let s = shUV(p); let e = 1.8 / ${SHADOW}.;
  return (textureSampleCompareLevel(tSh, sS, s.xy + vec2f(-e, -e), s.z) + textureSampleCompareLevel(tSh, sS, s.xy + vec2f(e, -e), s.z)
        + textureSampleCompareLevel(tSh, sS, s.xy + vec2f(-e, e), s.z) + textureSampleCompareLevel(tSh, sS, s.xy + vec2f(e, e), s.z)) * .25;
}
fn shadow9(p: vec3f) -> f32 {
  if (LOW) { return shadow4(p); }
  let s = shUV(p); let e = 2.1 / ${SHADOW}.; var a = 0.;
  for (var x = -1; x <= 1; x++) { for (var y = -1; y <= 1; y++) { a += textureSampleCompareLevel(tSh, sS, s.xy + vec2f(f32(x), f32(y)) * e, s.z); } }
  return a / 9.;
}
// where a point's sunlight crossed the plane y = 0: the dapple pattern is laid along the sun's rays
fn cuv(p: vec3f) -> vec2f { return p.xz - g.sun.xz * (p.y / g.sun.y); }
// dapple: the small gaps in the canopy, 0 to 1.5. Even light in the open (sky seen) and far away
fn dap(p: vec3f, d: f32, open: f32) -> f32 {
  let q = cuv(p);
  let c = ss(.25, .75, textureSample(tW, sR, q / 5.3).r * .65 + textureSample(tW, sR, q.yx / 13.7 + .37).r * .5) * 1.5;
  return mix(mix(c, .8, ss(30., 90., d)), 1., open * .45); // (in a clearing too the light comes through leaves)
}
// the light volume: r = how open the air is around a point, g = how much sky reaches it past rock and crowns
fn vol(p: vec3f) -> vec4f { return textureSampleLevel(tV, sC, (p - ${VOL0}) / ${VOLS}, 0.); }
// light from the sky (blue at this hour) and off the leaf-covered ground (warm), for a surface facing n
fn amb(n: vec3f, sky: f32) -> vec3f {
  let up = n.y * .5 + .5;
  let top = mix(vec3f(.40, .50, .74), vec3f(.52, .55, .60), g.sun.w) + flashL(vec3f(0., 1., 0.)) * .05;
  let low = mix(vec3f(.24, .23, .09), vec3f(.17, .17, .13), g.sun.w);
  // (and under the canopy a little warm light that has bounced about between the ground and the leaves)
  return (mix(low, top, up * up) * (.42 + .58 * sky) * .8 + vec3f(.085, .075, .05) * (1. - sky) * (1. - .6 * g.sun.w)) * (1. - .3 * g.st.x);
}
// The detail texture read smoothly where it is much enlarged: the mean of four taps half a texel apart, which has
// neither the creases of plain filtering nor flat squares
fn smoothD(uv: vec2f, lvl: f32) -> vec4f {
  let h = .5 * exp2(lvl) / 1024.;
  return (textureSampleLevel(tD, sR, uv + vec2f(h, h), lvl) + textureSampleLevel(tD, sR, uv + vec2f(-h, h), lvl)
        + textureSampleLevel(tD, sR, uv + vec2f(h, -h), lvl) + textureSampleLevel(tD, sR, uv - vec2f(h, h), lvl)) * .25;
}
// A dark puff of nearer cloud hanging in front of a bolt's root, a little to one side of it: 0 to 1 by the place
// in the bolt's plane (x to the side, y up from the root). fsB dims the cloud's glow by it, fsBolt the channels
fn puff(uv: vec2f) -> f32 {
  // (every bolt has its own, by its place in the sky: which side, how far off, how large, how tilted; one bolt in
  // three has none)
  let h = fract(sin(dot(g.fl.xz, vec2f(127.1, 311.7))) * vec3f(43758.5, 22578.1, 19642.3)); let h2 = fract(h * vec3f(7.3, 5.1, 9.7));
  if (h.y < .33) { return 0.; }
  let p = uv - vec2f(mix(.03, .08, h2.x) * select(-1., 1., h.x > .5), mix(-.035, .015, h2.y));
  let tilt = (h.z - .5) * 1.2;
  let q = vec2f(p.x * cos(tilt) + p.y * sin(tilt), p.y * cos(tilt) - p.x * sin(tilt)) / vec2f(mix(.035, .08, h2.z), mix(.018, .04, h.z));
  // (ragged and soft-edged: two sizes of noise decide where it ends)
  let n = smoothD(uv * 3.1 + g.fl.xz * 9., 2.).a * .65 + smoothD(uv * 8.3 + g.fl.zx * 5., 1.).b * .35;
  return ss(.5, .8, n * .75 + .62 * exp(-dot(q, q))) * ss(3.5, 1.5, dot(q, q));
}
// the glow of the open horizon on upright surfaces
fn side(n: vec3f, open: f32) -> vec3f { return mix(vec3f(.95, .52, .22), vec3f(.30, .31, .33), g.sun.w) * open * (1. - abs(n.y)) * .16; }
// The fog's colour as far as it goes in a direction: what a thing shows where the fog has closed over it, and the
// sky at and below the horizon, so the two meet without a line. Thick fog is uneven and drifting, both alike
fn fogC(rd: vec3f) -> vec3f {
  if (g.st.y <= 0.) { return hazeC(rd); }
  let fogU = textureSampleLevel(tD, sR, vec2f(atan2(rd.z, rd.x) / TAU * 2. + g.cam.w * .004, rd.y * .9 - g.cam.w * .002), 0.).a;
  return hazeC(rd) * (1. + (fogU - .5) * .22 * g.st.y);
}
// (with a ground mist on top: what lies within two metres of the ground fades sooner, and sooner still by the
// streams, where the mist gathers)
fn fog(c: vec3f, wp: vec3f) -> vec3f {
  let v = wp - g.cam.xyz; let d = length(v); let rd = v / d;
  let sg = textureSampleLevel(tS, sC, (wp.xz - ${VOL0}.xz) / ${MAPW}, 0.);
  let low = ss(2.2, .1, wp.y - sg.b) * (1. + 1.5 * ss(8., 1., sg.r));
  var T = hazeT(d, rd.y, g.cam.y) * exp(-low * max(d - 8., 0.) * .007);
  // (thick fog is uneven and drifts slowly: denser and thinner patches, taken part way along the ray)
  let un = textureSampleLevel(tD, sR, (g.cam.xz + v.xz * min(.6, 16. / d)) * .013 + g.cam.w * vec2f(.007, .003), 0.).a;
  T = pow(T, 1. + (un - .5) * 1.5 * g.st.y);
  // The fog between the trunks is lit by what sky reaches it (the light volume, part way along the ray): dimmer
  // and greener in the stand, bright along a gap. What is nearly gone takes the plain colour, as the sky does
  let lf = mix(mix(.5, 1., vol(g.cam.xyz + v * min(.55, 26. / d)).g), 1., ss(.45, .9, 1. - T));
  return c * T + fogC(rd) * mix(vec3f(.88, 1., .9), vec3f(1.), lf) * lf * (1. - T);
}
fn qrot(q: vec4f, v: vec3f) -> vec3f { return v + 2. * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
// The wind at a plant standing at p, h metres up it: a lean downwind that comes and goes as gusts roll over the
// forest, and a slower rocking on top. Trunks (W_SOLID) and leaves (W_LEAF) move by the same amount, so a tree
// bends as one; wx.y is the wind's strength
fn sway(p: vec2f, h: f32, t: f32) -> vec2f {
  let ph = dot(p, vec2f(.031, .017));
  let gust = .5 + .5 * sin(t * .45 - dot(p, vec2f(.045, .02)));
  let a = pow(max(h, 0.), 1.3) * (.002 + .016 * g.wx.y * (.35 + .65 * gust));
  // the way it pushes wanders from place to place, so neighbours do not all lean alike
  let way = .46 + 1.1 * sin(dot(p, vec2f(.13, .09))) + .5 * sin(dot(p, vec2f(-.07, .21)));
  return a * (vec2f(cos(way), sin(way)) * (.15 + .35 * gust) + .6 * vec2f(sin(t * .7 + ph * 9. + h * .09), cos(t * .53 + ph * 12. + h * .07)) + .2 * vec2f(sin(t * 1.9 + ph * 3. + h * .3), cos(t * 1.6 + ph * 2. + h * .23)));
}
// One layer of small pointed leaves, one to a cell of a grid, each turned its own way: x is 1 on a leaf, y and z
// are the leaf's own two random numbers (for its hue and shade), w how far from its midrib to its edge this is
fn leafAt(gq: vec2f) -> vec4f {
  let c = floor(gq);
  let h = fract(sin(vec2f(dot(c, vec2f(127.1, 311.7)), dot(c, vec2f(269.5, 183.3)))) * 43758.5453);
  let q0 = fract(gq) - .5 - (h - .5) * .2; let an = h.x * TAU;
  let q = vec2f(q0.x * cos(an) - q0.y * sin(an), q0.x * sin(an) + q0.y * cos(an));
  let wd = .3 * (1. - q.x * q.x * 4.9);
  return vec4f(step(abs(q.y), wd), h.y, h.x, sat(abs(q.y) / max(wd, 1e-3)));
}
// The running water at a place (water.js bake): x metres to the nearest water's edge (below 0 in it, 40 where there
// is none), y its level there
fn streamAt(p: vec3f) -> vec2f { return textureSampleLevel(tS, sC, (p.xz - ${VOL0}.xz) / ${MAPW}, 0.).rg; }
// how much white water gathers at a place in a fall: below a stone standing in it, at its foot (world.js foam)
fn foamAt(p: vec3f) -> f32 { return textureSampleLevel(tS, sC, (p.xz - ${VOL0}.xz) / ${MAPW}, 0.).a; }
// the ground's height at a place (the same texture's b: scene.js writes world.js's height map into it)
fn groundAt(p: vec3f) -> f32 { return textureSampleLevel(tS, sC, (p.xz - ${VOL0}.xz) / ${MAPW}, 0.).b; }
// Raindrops on standing water: in each cell of a grid a ring spreads from where a drop fell, one drop after
// another, each at its own place in the cell; two grids across each other, so the rings overlap. xy: the slope
// they give the surface, z: the splash at a ring's middle as the drop lands
fn rings1(p: vec2f, t: f32) -> vec3f {
  let ci = floor(p);
  let hh = fract(sin(vec2f(dot(ci, vec2f(127.1, 311.7)), dot(ci, vec2f(269.5, 183.3)))) * 43758.5453);
  let ph = t * (1.5 + hh.y) + hh.x * 7.; let n = floor(ph); let age = fract(ph);
  let off = fract(sin(vec2f(n * 12.9898 + hh.x * 78.233, n * 39.346 + hh.y * 11.135)) * 43758.5453) - .5;
  let rv = p - ci - .5 - off * .4; let r = length(rv); let rr = r - age * .28;
  return vec3f(rv / max(r, 1e-3) * (sin(rr * 46.) * exp(-rr * rr * 110.) * (1. - age) * (1. - age)), ss(.07, 0., r) * ss(.22, 0., age));
}
fn rings(p: vec2f, t: f32) -> vec3f { return rings1(p, t) + rings1(vec2f(p.x * .8 - p.y * .6, p.x * .6 + p.y * .8) * 1.37 + 3.1, t * 1.13 + 2.); }
// One layer of rounded stones, one to a cell of a grid, each of its own size, shape and turn: x is 1 on a stone and
// 0 in the gaps, y the stone's own random number (its shade), z how far in from its rim it is (0 to 1)
fn stoneAt(gq: vec2f) -> vec3f {
  let c = floor(gq);
  let h = fract(sin(vec2f(dot(c, vec2f(127.1, 311.7)), dot(c, vec2f(269.5, 183.3)))) * 43758.5453);
  let q0 = fract(gq) - .5 - (h - .5) * .3; let an = h.x * TAU;
  let q = vec2f(q0.x * cos(an) - q0.y * sin(an), q0.x * sin(an) + q0.y * cos(an)) * vec2f(1., 1.2 + h.y * .6);
  let r = length(q) / (.27 + .2 * h.x);
  return vec3f(1. - ss(.82, 1., r), h.y, sat(1. - r));
}
// A big fallen leaf with lobes (a maple's or an oak's), one to most cells of a grid, turned its own way; as leafAt
fn leafL(gq: vec2f) -> vec4f {
  let c = floor(gq);
  let h = fract(sin(vec2f(dot(c, vec2f(127.1, 311.7)), dot(c, vec2f(269.5, 183.3)))) * 43758.5453);
  let q = fract(gq) - .5 - (h - .5) * .25; let r = length(q); let th = atan2(q.y, q.x) + h.x * TAU;
  let rim = select(.2 + .12 * abs(cos(th * 2.5)), .17 + .05 * cos(th * 7.) + .1 * abs(cos(th)), h.y > .55);
  return vec4f(step(r, rim) * step(.3, h.x), h.y, h.x, sat(r / rim));
}
// a twig or a stick lying on the ground, in some cells of a grid: 1 on it
fn twigAt(gq: vec2f) -> f32 {
  let c = floor(gq);
  let h = fract(sin(vec2f(dot(c, vec2f(127.1, 311.7)), dot(c, vec2f(269.5, 183.3)))) * 43758.5453);
  let q0 = fract(gq) - .5 - (h - .5) * .3; let an = h.x * TAU;
  let q = vec2f(q0.x * cos(an) - q0.y * sin(an), q0.x * sin(an) + q0.y * cos(an));
  return step(abs(q.y + .03 * sin(q.x * 9.)), .014 + .01 * h.y) * step(abs(q.x), .2 + .22 * h.y) * step(.45, h.y);
}
// A tree's leaf colour by its kind and hue (0-1), j a shade inside it. Kinds 0 and 1 conifers (green, and a golden
// larch when the hue is high), 2 maple (yellow, orange, red, a few still green), 3 birch, 4 oak, 6 a pole (a conifer)
fn folC(kind: i32, h: f32, j: f32) -> vec3f {
  // kinds: 0 fir (dark blue-green), 1 cedar, 5 hemlock (lighter, yellower), 6 a pole; 2 maple, 3 birch, 4 oak
  var c = mix(mix(vec3f(.032, .09, .05), vec3f(.065, .15, .06), ss(.2, .8, h)), vec3f(.12, .22, .07), j * .6);
  if (kind == 1) { c = mix(mix(vec3f(.045, .10, .04), vec3f(.09, .17, .05), ss(.2, .8, h)), vec3f(.15, .24, .07), j * .6); }
  if (kind == 5) { c = mix(mix(vec3f(.09, .2, .05), vec3f(.17, .31, .07), ss(.2, .8, h)), vec3f(.26, .4, .09), j * .6); }
  if (kind == 2) {
    c = mix(vec3f(.70, .46, .04), vec3f(.80, .56, .06), j);
    if (h > .32) { c = mix(vec3f(.74, .26, .03), vec3f(.82, .36, .04), j); }
    if (h > .62) { c = mix(vec3f(.40, .06, .03), vec3f(.56, .13, .05), j); }
    if (h > .9) { c = mix(vec3f(.16, .26, .04), vec3f(.30, .34, .05), j); }
  }
  if (kind == 3) { c = mix(vec3f(.72, .52, .05), vec3f(.84, .68, .12), j); }
  if (kind == 4) { c = mix(vec3f(.36, .13, .04), vec3f(.54, .23, .05), j); }
  if (kind >= 2 && kind <= 4) { c *= .84; }
  return c;
}
`;

// ---------------------------------------------------------------- solid meshes (ground, rocks, trunks, logs, woodwork, mushrooms, animals)
// An instance: a = position + scale, b = quaternion, c = material, seed, texture scale (or where a small rock has
// faded out), bob. Materials: 0 ground, 1 rock, 2 bark, 3 planks, 4 mushroom, 6 animals
export const W_SOLID =
  S_B +
  /*wgsl*/ `
struct VI { @location(0) p: vec3f, @location(1) n: vec4f, @location(2) a: vec4f, @location(3) b: vec4f, @location(4) c: vec4f };
struct VO { @builtin(position) cp: vec4f, @location(0) wp: vec3f, @location(1) n: vec3f, @location(2) op: vec3f, @location(3) on: vec3f,
  @location(4) @interpolate(flat) m: vec4f, @location(5) @interpolate(flat) q: vec4f, @location(6) ao: f32,
  @location(7) @interpolate(flat) sh: f32 }; // sh: 1 on the bark's shell (vsShell)
// grow: metres the mesh is pushed out sideways from its axis (the bark's shell)
fn place(i: VI, grow: f32) -> VO {
  var o: VO;
  var sc = i.a.w; var lp = i.p;
  lp += normalize(vec3f(i.n.x, 0., i.n.z) + vec3f(1e-5, 0., 0.)) * (grow / max(sc, 1e-3));
  let cd = distance(i.a.xyz, g.cam.xyz);
  if (i.c.x < 1.5 && i.c.z > 1.5 && g.res.x > 0.) { sc *= 1. - ss(i.c.z * .7, i.c.z, cd / g.mis.z); }
  var w = i.a.xyz + qrot(i.b, lp * sc);
  // living trees (bark of kinds 0-4 and 6) bend in the wind; snags, logs and stumps stand still
  if (i.c.x > 1.5 && i.c.x < 2.5 && (i.c.y < 5. || (i.c.y >= 6. && i.c.y < 7.))) { let sw = sway(i.a.xz, lp.y * sc, g.cam.w); w.x += sw.x; w.z += sw.y; }
  w.y += sin(g.cam.w * .3 + i.c.y * 40.) * i.c.w;
  o.cp = g.vp * vec4f(w, 1.); o.wp = w; o.n = qrot(i.b, i.n.xyz); o.op = i.p * i.a.w + i.c.y * 37.; o.on = i.n.xyz;
  o.m = i.c; o.q = i.b; o.ao = i.n.w;
  if (isoOut(i.a.xyz) || isoSkip(false)) { o.cp = vec4f(0., 0., 2., 1.); }
  return o;
}
@vertex fn vs(i: VI) -> VO { return place(i, 0.); }
// The bark's relief near the walker: the trunk drawn a second time a few centimetres out (less on a thin trunk),
// of which fs keeps only the ridges between the furrows. Against the fog a trunk's outline is then broken by them
@vertex fn vsShell(i: VI) -> VO { var o = place(i, clamp(i.a.w * .0018, .006, .045)); o.sh = 1.; return o; }
struct TP { h: f32, c: f32, n: vec3f };
fn tri(p: vec3f, n: vec3f, s: f32) -> TP {
  var w = pow(abs(n), vec3f(4.)); w /= (w.x + w.y + w.z);
  let x = textureSample(tD, sR, p.zy * s); let y = textureSample(tD, sR, p.xz * s); let z = textureSample(tD, sR, p.xy * s);
  var o: TP;
  o.h = x.b * w.x + y.b * w.y + z.b * w.z;
  o.c = x.a * w.x + y.a * w.y + z.a * w.z;
  let a = x.rg * 2. - 1.; let b = y.rg * 2. - 1.; let c = z.rg * 2. - 1.;
  o.n = vec3f(0., a.y, a.x) * w.x + vec3f(b.x, 0., b.y) * w.y + vec3f(c.x, c.y, 0.) * w.z;
  return o;
}
@fragment fn fs(i: VO, @builtin(front_facing) ff: bool) -> @location(0) vec4f {
  let mat = i32(i.m.x + .5); let sd = i.m.y; let fl_ = select(-1., 1., ff);
  let on = normalize(i.on) * fl_; let n0 = normalize(i.n) * fl_;
  let dist = length(i.wp - g.cam.xyz);
  let ts = select(1., i.m.z, mat >= 2);
  // four scales of the detail texture; the finest (F) only shows within a few metres, on the ground, rock and bark
  let A = tri(i.op, on, .1 * ts); let B = tri(i.op, on, .43 * ts); let C = tri(i.op, on, 1.9 * ts); let F = tri(i.op, on, 6.7 * ts); let fk = ss(10., 1.5, dist) * f32(mat <= 2);
  // lp: the place on the mesh, scaled, without the seed's offset. Wd: streaks running along y (bark furrows, wood grain)
  let lp = i.op - sd * 37.;
  let Wd = textureSample(tD, sR, vec2f((lp.x + lp.z) * 1.3, lp.y * .09));
  let Wh = textureSample(tD, sR, vec2f((lp.x + lp.z) * .22, lp.y * 1.1)); // marks running round a trunk (birch)
  let big = textureSample(tD, sR, i.op.xz * .013 + i.op.y * .021).a;
  let big2 = textureSample(tD, sR, i.op.zx * .031 + i.op.y * .043 + .37).a;
  let gm = textureSample(tM, sC, i.wp.xz / ${MAPW} + .5);
  // The running water here: under: below its surface; damp: the wet line just over it, on the ground and on
  // whatever stands in the water; shore: the strip along the water's edge where stones and gravel lie bare
  let sw = streamAt(i.wp); let byWater = step(sw.x, 3.); let over = i.wp.y - sw.y;
  let under = ss(.03, -.05, over) * step(sw.x, .9); let damp = ss(.24, .02, over) * ss(2.2, .9, sw.x) * byWater;
  // (for timber, trunks and rocks the lookups are lifted off the ground by how upright the face is: a post's or a
  // plank's side would else read the ground it stands in, and come out black)
  let lift = vec3f(0., (1. - abs(n0.y)) * 1.2 * f32(mat >= 1), 0.);
  let v1 = vol(i.wp + n0 * 1.5 + lift); let v2 = vol(i.wp + n0 * 4.5 + lift);
  let dp = dap(i.wp, dist, ss(.6, .95, v1.g));
  let hgt = A.h * .5 + B.h * .35 + C.h * .15;
  // wet: the sheen, there as soon as it rains; soaked: the ground and bark darkening and the puddles filling,
  // slowly, and less under the crowns
  let wet = g.wx.x; let soaked = g.wy.y * mix(.6, 1., v1.g);
  var bump = 1.7; var gloss = .1; var alb = vec3f(0.); var vao = 1.; var sgro = 0.;
  var tl = 0.;                         // how much light passes through (a far crown, a mushroom's cap)
  var onPath = 0.;                     // how much this is the trail's trodden earth
  var pathMid = 0.;                    // and how much of that is its packed middle, where the feet go
  var puddle = 0.;                     // standing water on the dirt track
  var mud = 0.;                        // and how much of that is a muddy patch
  var film = 0.;                       // standing or running water over the ground: the creek, the shore, puddles
  var glw = vec3f(0.); var gk = 0.;    // animals: the glow of an owl's eyes, and how much of an eye this is
  var grain = 0.;                      // how deep the streaks of Wd cut: bark furrows, the grain of planks
  var sawn = 0.;                       // timber: how much this is a sawn end face
  let mossC = mix(vec3f(.08, .19, .02), vec3f(.21, .34, .04), C.h) * (.5 + .9 * B.h);
  if (mat <= 1) {
    // rock: grey beds, pale lichen, moss on what faces up
    let st = i.op.y * .55 + A.h * 1.6 + big * 5. + big2 * 3.;
    let bed = hs(floor(st)); let sf = fract(st);
    alb = mix(vec3f(.12, .12, .125), vec3f(.36, .34, .31), sat(A.c * 1.5 - .25));
    alb = mix(alb, mix(vec3f(.26, .21, .15), vec3f(.22, .22, .19), bed), ss(.42, .66, big) * .6);
    alb *= mix(.72, 1.15, bed) * (1. - .45 * ss(.12, .0, sf) * (1. - abs(on.y)));
    alb = mix(alb, vec3f(.50, .52, .40) * (.5 + .7 * C.h), ss(.60, .70, B.c * .6 + C.c * .5) * .45);
    alb *= (.3 + 1.2 * hgt) * mix(1., .62 + .76 * F.h, fk);
    sgro = -ss(.14, .0, sf) * (1. - abs(on.y)) * 1.2;
    // (on a stone only on its top and where the noise says so: its flanks stay bare rock, dark where wet)
    // A stone is dark grey rock, darker by the water where it stands wet, with moss only as a cap on its top, in
    // patches and darker than the ground's
    let rock = f32(mat == 1);
    // (a stepping stone, marked by a fade of .5: worn pale and dry on top, no moss there)
    let slab = rock * f32(abs(i.m.z - .5) < .01);
    alb *= 1. - rock * (.3 + .25 * byWater);
    let mossy = mix(ss(-.05, .55, n0.y) * ss(.28, .5, B.c * .55 + big * .5), ss(.6, .93, n0.y) * ss(.42, .6, B.c * .6 + C.c * .45), rock);
    alb = mix(alb, mossC * (1. - .45 * rock), mossy * .9 * (1. - gm.r) * ss(.3, .2, gm.b) * (1. - max(under, damp * .7)) * (1. - slab));
    alb = mix(alb, vec3f(.5, .49, .45) * (.75 + .35 * C.h), slab * ss(.5, .9, n0.y) * (1. - .6 * damp));
    if (mat == 0) {
      // The forest floor wherever the ground is not too steep, by the ground map (world.js): r trail, g fallen
      // leaves, b the lake's depth, a the make of the trail
      // grass: in the clearings (math.js OPEN) and along the lake's shore, in patches
      var glade = 0.; ${OPEN.map((c) => `glade = max(glade, ss(${f(c[2])}, ${f(c[2] - c[3])}, distance(i.wp.xz, vec2f(${f(c[0])}, ${f(c[1])}))));`).join(' ')}
      let grass = sat(max(glade, ss(.15, .22, gm.b) * .7) * (.4 + 1.2 * B.c));
      // ct: how close a trunk, post, log or stone stands (world.js stamps them into tC). The ground is dark there,
      // and litter gathers against them
      let ct = textureSampleLevel(tC, sC, i.wp.xz / ${MAPW} + .5, 0.).r;
      // The floor is a patchwork, by two slow noises: moss cushions, bare dark needle duff with rust needles on
      // it, and herbs, each in patches of its own
      let duff = ss(.5, .62, big * .7 + A.c * .4) * (1. - grass);
      let herbK = ss(.5, .62, big2 * .6 + A.c * .5) * (1. - grass) * (1. - duff);
      var gr = mix(vec3f(.085, .055, .035), vec3f(.20, .12, .06), A.c) * (.55 + .8 * B.h);
      gr = mix(gr, mossC * 1.1, ss(.3, .5, big * .55 + B.c * .5) * (1. - grass) * (1. - duff) * .9);
      // (mottled by two scales of the noise together, and its needles only near the walker: one scale alone,
      // cut to specks, shows its tile as a check pattern)
      var duffC = mix(vec3f(.06, .042, .03), vec3f(.15, .10, .06), ss(.35, .7, C.c * .55 + B.c * .45)) * (.7 + .5 * A.h);
      duffC = mix(duffC, vec3f(.30, .16, .07), ss(.6, .72, F.c * .5 + C.c * .5) * fk * .7);
      gr = mix(gr, duffC, duff);
      // Fallen leaves, in drifts: more under the broadleaf trees (the ground map) and against whatever stands on
      // the ground, with bare stretches between. Far off as specks of the finest noise
      let lk = sat((gm.g * 1.5 - .25 + (big2 - .5) * .7) * (.5 + 1.1 * ss(.35, .65, A.c)) + ct * .5);
      let lh = fract(F.c * 7. + C.h * 5.);
      var lc = mix(vec3f(.46, .33, .08), vec3f(.44, .22, .06), ss(.3, .4, lh));
      lc = mix(mix(lc, vec3f(.32, .10, .05), ss(.62, .7, lh)), vec3f(.22, .14, .07), ss(.8, .9, lh));
      gr = mix(gr, lc * (.5 + .7 * C.h), ss(.56 - .3 * lk, .64 - .3 * lk, F.c * .6 + C.c * .4) * sat(lk * 4.));
      // Near the walker the floor is drawn leaf by leaf, three sizes of them over each other: herbs over the moss
      // in their patches, darker in the gaps; and where the litter lies, fallen leaves with a midrib each, dark
      // and wet in the gaps between them
      let fa = leafAt(i.wp.xz * 6.); let fb = leafAt(vec2f(i.wp.x * .8 - i.wp.z * .6, i.wp.x * .6 + i.wp.z * .8) * 11. + 5.3);
      // (the litter: a few big lobed leaves over many small ones, not every cell filled, so the duff shows between)
      let fg = leafL(vec2f(i.wp.x * .6 + i.wp.z * .8, i.wp.z * .6 - i.wp.x * .8) * 3.3 + 9.1);
      let ft = select(select(fb, fa, fa.x > .5), fg, fg.x > .5);
      let leafy = max(fg.x, max(fa.x * step(.3, fa.z), fb.x * step(.35, fb.z))); let nearF = ss(15., 5., dist);
      let herbs = herbK * (1. - sat(lk * 3.)) * nearF; let herby = max(fa.x, fb.x);
      gr = mix(gr, mix(vec3f(.05, .14, .025), vec3f(.15, .28, .05), ft.z) * (.6 + .6 * C.h) * (.7 + .3 * ft.w), herbs * herby);
      gr *= 1. - .4 * herbs * (1. - herby);
      var fc = mix(vec3f(.50, .36, .08), vec3f(.48, .22, .05), ss(.3, .4, ft.y));
      fc = mix(mix(fc, vec3f(.36, .09, .04), ss(.6, .7, ft.y)), vec3f(.24, .15, .07), ss(.8, .9, ft.y)) * (.5 + .6 * ft.z) * (.65 + .35 * ft.w);
      let litter = sat(lk * 2.5) * nearF;
      gr = mix(gr, vec3f(.045, .032, .024), litter * (1. - leafy) * .75);
      gr = mix(gr, fc, litter * leafy * .95);
      let turf = mix(vec3f(.20, .22, .04), vec3f(.36, .30, .07), B.c) * (.5 + .8 * C.h);
      // (in patches near the walker, all of it further off: where the blades thin out and end, the ground under
      // them is already their colour, so no line shows)
      gr = mix(gr, turf, grass * mix(ss(.25, .5, A.c * .5 + C.c * .5 + grass * .3), 1., ss(8., 22., dist)));
      // Further off the same floor in coarser strokes: clumps of herb leaves and drifts of fallen ones, so it keeps
      // its grain to where the fog takes it
      let ca = leafAt(i.wp.xz * 2.6 + 3.1); let farF = ss(4., 12., dist) * ss(46., 26., dist);
      gr = mix(gr, gr * (.62 + .75 * ca.z), farF * ca.x * .8);
      // The trail, in four makes (the ground map's a, world.js PATHS; between two stretches the makes blend): 0
      // grey gravel, 1 packed brown earth, 2 earth buried in fallen leaves, 3 grass worn to earth in two ruts
      // (where one make gives way to the next, over some metres along the path, noise moves the change about)
      let mk0 = gm.a * 3.; let mk = clamp(mk0 + (big2 - .5 + (B.c - .5) * .5) * (1. - abs(fract(mk0) * 2. - 1.)) * 1.2, 0., 3.); let g3 = max(mk - 2., 0.);
      // The grass track's profile is wider (world.js): from it a verge of grass, two bare ruts either side of the
      // middle, and grass again between them
      let verge = ss(.1, .4, gm.r + (B.c - .5) * .25);
      let rut = ss(.6, .72, gm.r + (C.c - .5) * .12) * (1. - ss(.88, .96, gm.r + (C.c - .5) * .12));
      // its edge: a line that three scales of noise move in and out, not a fade (world.js stands plants on it)
      let tk = mix(ss(.47, .53, gm.r + (B.c - .5) * .45 + (C.c - .5) * .3 + (F.c - .5) * .1), verge, g3);
      let mid = ss(.6, .95, gm.r);
      let grit = ss(.38, .6, F.c * .3 + C.c * .4 + B.c * .3);
      let isDirt = max(1. - abs(mk - 1.), 0.); let isGravel = max(1. - mk, 0.);
      let root = ss(.034, .012, abs(B.c - .5)) * ss(.45, .6, A.c) * isDirt * (1. - mid * .6);
      let ga = stoneAt(i.wp.xz * 13.); let gb = stoneAt(vec2f(i.wp.x * .8 - i.wp.z * .6, i.wp.x * .6 + i.wp.z * .8) * 31. + 3.7);
      // (stones of two sizes scattered in pale tan fines, not edge to edge; two lines worn smoother and paler)
      let wornL = ss(.6, .7, gm.r) * (1. - ss(.8, .9, gm.r));
      let gk = ga.x * step(.62 + .2 * wornL, ga.y); let gs = select(gb, ga, gk > .5);
      let gravel = mix(vec3f(.50, .44, .33) * (.8 + .4 * C.h), mix(vec3f(.30, .28, .24), vec3f(.64, .59, .50), fract(gs.y * 7.3)) * (.85 + .2 * gs.z), max(gk, gb.x * step(.5 + .3 * wornL, gb.y)) * .9) * (.9 + .15 * B.h) * (1. + .1 * wornL);
      // dirt: packed and even where the feet go, darker and rougher toward the edges, a few stones set flush in
      // it and rust needles lying on it, roots across it as thin dark ridges
      var dirt = mix(vec3f(.25, .18, .11), vec3f(.45, .35, .23), grit * (1. - .5 * mid)) * (.85 + .25 * C.h) * mix(.8, 1., mid);
      let fl = stoneAt(i.wp.xz * 12. + 7.);
      dirt = mix(dirt, vec3f(.34, .32, .29) * (.7 + .4 * fl.z), fl.x * step(.9, fl.y));
      dirt = mix(dirt, vec3f(.34, .18, .07), ss(.62, .72, F.c * .5 + C.c * .5) * fk * .45);
      dirt = mix(dirt, vec3f(.09, .06, .04) * (.7 + .6 * C.h), root * .85);
      // the leaf-covered make: buried in leaves, the earth showing only in the gaps
      let leaves = mix(vec3f(.045, .032, .024), fc, mix(.75, leafy, nearF));
      let worn = mix(mix(vec3f(.15, .25, .045), vec3f(.33, .38, .08), B.c) * (.55 + .8 * C.h), dirt, rut * .9);
      var path = gravel * isGravel + dirt * isDirt + leaves * max(1. - abs(mk - 2.), 0.) + worn * g3;
      // on the dirt track: dark wet patches, in the middle of some a shallow puddle; moss creeping in from the
      // edges of all but the grass track; a few fallen leaves on every make
      // (as it rains the wet patches spread and the puddles fill, on the gravel and the leaf path too)
      let wetN = big * .6 + A.c * .5 + .08; let soft = mix(isDirt, 1. - g3, soaked * .8); let pb = ss(.74 - .3 * soaked, .82 - .3 * soaked, wetN) * soft;
      puddle = ss(.86 - .22 * soaked, .9 - .22 * soaked, wetN) * soft * mid * tk;
      path = mix(path, vec3f(.07, .052, .038) * (.7 + .5 * C.h), pb * .8); mud = pb * tk;
      path = mix(path, mossC, ss(.8, .5, gm.r + (C.c - .5) * .4) * ss(.42, .6, B.c) * .6 * (1. - g3));
      path = mix(path, fc, leafy * nearF * (.08 + .4 * sat(lk * 2.)) * step(mk, 1.5));
      gr = mix(gr, path, tk);
      // twigs and sticks lying on the forest floor (hardly any on a path)
      gr = mix(gr, vec3f(.13, .10, .075) * (.7 + .6 * C.h), twigAt(i.wp.xz * 2.7 + 4.4) * nearF * (1. - grass) * (1. - .85 * tk) * .8);
      gr *= 1. - .5 * ct * (1. - tk * .5);
      sgro = mix(sgro, root * 1.4, tk); onPath = tk * mix(1., rut, g3); pathMid = tk * mid * (1. - g3);
      // The lake's waterline: a wet dark band of mud and pebbles from the water to a hand over it (the water laps
      // on it), of uneven width; only there does the ground shine wet, not all over a flat shore
      let wk = ss(.2, .24, gm.b) * ss(.16, .05, i.wp.y + (B.c - .5) * .08);
      let pw = stoneAt(i.wp.xz * 9.); let pv = stoneAt(vec2f(i.wp.x * .8 - i.wp.z * .6, i.wp.x * .6 + i.wp.z * .8) * 23. + 1.7);
      let mudC = mix(vec3f(.06, .05, .038) * (.6 + .7 * C.h), mix(vec3f(.16, .15, .13), vec3f(.36, .33, .28), fract(pw.y * 5.3 + pv.y * 3.1)) * (.6 + .4 * max(pw.z, pv.z)), max(pw.x * step(.45, pw.y), pv.x * step(.4, pv.y)));
      gr = mix(gr, mudC * .7, wk * .9);
      film = max(max(wk * .3 * ss(.07, .0, i.wp.y), tk * ss(.46, .3, A.h + B.h * .3) * soaked), max(mud * .3, puddle));
      // A stream's bed and the bars along it: stones of two sizes, each of its own tan or grey, silt between
      // them; and its cut bank where that stands steep: dark bare earth (the leaf litter lies right to its top)
      // (seen through the water the bed's pattern is shifted by the slope of the surface over it: .25 of the depth
      // times the slope, for water's bending of light)
      let rs = textureSampleLevel(tW, sR, i.wp.xz * .4 + g.cam.w * vec2f(.11, .07), 0.).ba + textureSampleLevel(tW, sR, i.wp.zx * .85 - g.cam.w * vec2f(.19, .05), 0.).ba * .7;
      let bx = i.wp.xz + rs * (1.1 * max(-over, 0.) * under);
      let sa = stoneAt(bx * 3.3); let sb = stoneAt(vec2f(bx.x * .8 - bx.y * .6, bx.x * .6 + bx.y * .8) * 8.3 + 3.7);
      let sn = select(sb, sa, sa.x > .5); let stony = max(sa.x, sb.x);
      var bedC = mix(mix(vec3f(.30, .29, .27), vec3f(.48, .39, .26), ss(.3, .7, sn.y)), vec3f(.16, .19, .15), ss(.82, .9, sn.y)) * (.5 + .7 * sn.z) * (.7 + .5 * C.h);
      bedC = mix(vec3f(.07, .06, .045) * (.6 + .7 * F.h), bedC, stony);
      let shore = max(under, ss(.45, .1, sw.x + (B.c - .5) * .8) * byWater);
      let cutB = ss(1.2, .3, sw.x + (C.c - .5) * .6) * ss(.94, .72, n0.y) * byWater * (1. - shore);
      gr = mix(gr, vec3f(.075, .055, .038) * (.6 + .7 * C.h) * (.7 + .5 * B.h), cutB * .8);
      gr = mix(gr, bedC, shore);
      alb = mix(alb, gr, max(ss(.55, .8, n0.y), max(shore, cutB * .6)));
    }
  } else if (mat == 2) {
    // Bark by the tree's kind (the whole part of the seed): 0 fir, 1 cedar, 2 maple, 3 birch, 4 oak, 5 a dead
    // snag, 6 a pole, 8 a fallen log or branch, 9 a stump. Aux under .3 is cut wood
    let kind = i32(sd);
    let fur = ss(.3, .68, Wd.b);   // 0 down in a furrow, 1 on the ridge between two
    // (the shell: ridges only, fewer and fewer of them from 4.5 m, none by 8; none on a birch or a dead trunk)
    if (i.sh > .5 && (fur < mix(.74, 1.01, ss(4.5, 8., dist)) || kind == 3 || kind == 5 || kind > 6)) { discard; }
    var bk = mix(vec3f(.035, .028, .024), vec3f(.29, .23, .18), fur);
    if (kind == 1) { bk = mix(vec3f(.05, .035, .028), vec3f(.36, .25, .18), fur); }
    if (kind == 2 || kind == 4) { bk = mix(vec3f(.07, .065, .06), vec3f(.32, .30, .26), fur); }
    if (kind == 3) { bk = mix(vec3f(.80, .78, .72), vec3f(.08, .07, .065), ss(.60, .66, Wh.a) * .9) * (.85 + .25 * Wh.b); }
    if (kind == 5) { bk = mix(vec3f(.16, .15, .14), vec3f(.48, .46, .42), fur); }
    alb = bk * (.6 + .6 * B.h) * mix(1., .6 + .8 * F.h, fk);
    // a fallen log has shed its bark in plates: bare grey wood shows between them
    let isLog = f32(kind == 8);
    alb = mix(alb, vec3f(.42, .39, .34) * (.55 + .6 * Wd.b) * (.7 + .4 * C.h), ss(.44, .52, big2 * .55 + B.c * .5) * isLog);
    grain = 3.2 * f32(kind != 3);
    // Moss: on a standing trunk's foot, more on the side away from the sun and thinning out by 3 m up, in
    // patches; on whatever faces up (a log's back); none on birch. The bark shows everywhere else
    let shady = .3 + .7 * ss(.3, -.5, dot(normalize(n0.xz + vec2f(1e-4)), normalize(g.sun.xz)));
    let mk = max(ss(3., .2, lp.y) * shady * f32(kind < 8), ss(.45, .9, n0.y)) * ss(.44, .62, B.c * .5 + C.c * .25 + big2 * .35) * f32(kind != 3);
    // (a log wears a thick pad of it all along its back and down its shady side)
    let pad = max(ss(.1, .65, n0.y), shady * ss(-.4, .2, n0.y) * .4) * ss(.3, .44, B.c * .45 + C.c * .3 + big * .35) * isLog;
    alb = mix(alb, mix(mossC, vec3f(.10, .13, .04) * (.5 + .9 * C.h), .45 * isLog), max(mk * .85, pad * .92));
    // cut and broken wood (aux under .3) is pale; the inside of a hollow log or stump (aux near 0) dark and rotten
    alb = mix(alb, vec3f(.50, .40, .26) * (.6 + .5 * C.h), ss(.3, .2, abs(i.ao)));
    alb = mix(alb, vec3f(.05, .03, .02), ss(.11, .03, abs(i.ao)) * f32(kind >= 8));
    gloss = .12; bump = 1.2;
  } else if (mat == 3) {
    // Timber left out of doors (world.js woodwork): each piece carries in aux its own shade and the way its grain
    // runs. Silver grey where the sky sees it and browner where it is sheltered, split along the grain, its end
    // faces the palest; lichen in pale blotches, moss on tops and shady faces, a green film near the ground. A
    // root across the trail (seed 1 and over) stays brown
    let code = i32(abs(i.ao) * 127. + .5); let tone = f32(code / 16) / 7.; let dk = code % 16; let root = sd >= 1.;
    let da = (f32(dk) + .5) / 15. * TAU * .5; let dir = vec3f(cos(da), 0., sin(da)); let upr = dk == 15 || root;
    let along = select(dot(i.wp, dir), i.wp.y, upr);
    let across = select(dot(i.wp.xz, vec2f(-dir.z, dir.x)) + i.wp.y, i.wp.x + i.wp.z, upr);
    let wg = textureSampleLevel(tD, sR, vec2f(across * 6., along * .28 + tone * 5.), clamp(2. + log2(max(dist, .25)), 0., 7.));
    let endF = select(abs(dot(n0, dir)), abs(n0.y), upr) * f32(!root);
    let brown = mix(vec3f(.12, .085, .055), vec3f(.36, .27, .18), wg.b);
    let grey = mix(vec3f(.25, .245, .23), vec3f(.62, .61, .57), wg.b);
    let sky = ss(-.4, .5, n0.y);
    alb = mix(brown, grey, sat(.3 + .55 * sky + (tone - .5) * .7) * f32(!root)) * (.7 + .45 * tone) * (.7 + .5 * B.h);
    alb *= 1. - .6 * ss(.74, .8, wg.a) * ss(.35, .6, C.c);
    // (a painted boat, by its seed under -50: faded green on its planks, shade 5, worn back to the wood in
    // patches along the grain; its rail, shade 1, dark; its floor and thwarts, shade 3, bare)
    if (sd < -50.) {
      let paint = select(vec3f(.15, .27, .2), vec3f(.06, .07, .06), tone < .3);
      // (its planks are painted on the outside only: within, bare wood, darker and more weathered)
      let outside = max(step(0., fl_), step(tone, .3));
      alb = mix(alb * mix(.6, 1., outside), paint * (.75 + .5 * C.h), outside * (1. - .75 * ss(.5, .75, wg.b * .55 + B.c * .5)) * step(.1, abs(tone - .43)));
    }
    sawn = ss(.75, .95, endF);
    alb = mix(alb, vec3f(.56, .52, .44) * (.7 + .4 * C.h), sawn * .7);
    alb = mix(alb, vec3f(.60, .62, .54), ss(.68, .76, C.c * .55 + big * .55) * .4 * sky * f32(!root));
    let shadyT = ss(.2, -.6, dot(normalize(n0.xz + vec2f(1e-4)), normalize(g.sun.xz))) * (1. - abs(n0.y));
    alb = mix(alb, mossC, ss(.62, .8, B.c * .6 + big2 * .5) * max(ss(.3, .9, n0.y), shadyT * .7) * .55);
    alb = mix(alb, vec3f(.15, .2, .08) * (.6 + .6 * C.h), ss(.25, 0., i.wp.y - groundAt(i.wp)) * .3 * f32(!root) * (1. - sawn));
    gloss = .1; bump = .8;
  } else if (mat == 4) {
    // mushrooms: aux 1 on the cap, 0 on the stem; red with white dots, brown, orange or white by the seed
    let hue = fract(sd * 7.31);
    var cap = vec3f(.62, .06, .03);
    if (hue > .4) { cap = vec3f(.42, .24, .10); }
    if (hue > .7) { cap = vec3f(.85, .50, .08); }
    if (hue > .9) { cap = vec3f(.80, .78, .70); }
    cap = mix(cap, vec3f(.9), ss(.62, .7, C.c) * f32(hue <= .4));
    alb = mix(vec3f(.78, .74, .64), cap, ss(.3, .6, i.ao)) * (.6 + .5 * B.h);
    gloss = .35; bump = .6; tl = .3;
  } else {
    // Animals (creatures.js): sd = species + hue. Aux: 1 coat, .5 dark parts, 0 antler, hoof or bill, below 0 eyes.
    // Species: 0 deer, 1 fox, 2 squirrel (grey or red), 3 owl, 4 duck
    let sp = i32(sd); let hv = fract(sd); let ax = abs(i.ao);
    var back = mix(vec3f(.30, .18, .09), vec3f(.38, .24, .12), hv); var under = vec3f(.62, .54, .42);
    var dark = vec3f(.10, .07, .05); var bone = vec3f(.72, .66, .52);
    if (sp == 1) { back = vec3f(.62, .24, .05); under = vec3f(.85, .82, .76); dark = vec3f(.06, .04, .03); bone = vec3f(.88, .86, .80); }
    if (sp == 2) { back = mix(vec3f(.32, .28, .24), vec3f(.48, .22, .08), step(.5, hv)); under = vec3f(.70, .66, .58); }
    if (sp == 3) { back = vec3f(.34, .27, .19); under = vec3f(.62, .56, .46); bone = vec3f(.15, .12, .08); glw = vec3f(2.6, 1.5, .2); }
    if (sp == 4) { back = mix(vec3f(.30, .22, .14), vec3f(.36, .30, .22), hv); under = vec3f(.60, .56, .50); dark = vec3f(.03, .20, .10); bone = vec3f(.85, .60, .10); }
    alb = mix(back, under, ss(.15, -.55, on.y)) * (.6 + .7 * B.h) * (.75 + .4 * ss(.3, .7, C.c));
    alb = mix(alb, dark, ss(.75, .55, ax) * ss(.25, .45, ax));
    alb = mix(alb, bone, ss(.3, .05, ax));
    gk = ss(-.2, -.7, i.ao);
    alb = mix(alb, vec3f(.012), gk);
    gloss = .3 + .5 * gk; bump = .5;
  }
  // Where a trunk, a post, a log or a stone meets the ground (within a hand or two over it, on its upright faces):
  // darker, and a little of the ground's moss on it
  // (not a sawn end of timber: that stays pale)
  let foot = ss(.45, .0, i.wp.y - groundAt(i.wp)) * (1. - sat(n0.y)) * f32(mat >= 1 && mat <= 3) * (1. - sawn);
  alb = mix(alb, mossC * .6, foot * .3 * f32(mat != 3)) * (1. - .45 * foot);
  // rain darkens and polishes, and so does a stream what it wets: what lies under it, and a line just over it
  // (rock and planks are wet at once; soil and bark soak)
  let soak = max(mix(soaked, wet, f32(mat == 1 || mat == 3)), max(under, damp) * .9) * f32(mat <= 3);
  alb *= 1. - mix(.5, .36, f32(mat == 1)) * soak - .2 * damp * (1. - under) * f32(mat <= 3);
  // (the trodden path and timber take the most sheen)
  // (wet earth only a little glossier: its sheen is the soft sky light below, not a highlight on every lump)
  gloss = mix(mix(gloss, max(gloss, mix(.28, .6, f32(mat == 3))), soak), .95, film);
  bump *= (1. - .8 * film) * mix(1., .7, f32(mat == 0)); // soil lies softer than rock
  let rip = film * cos((i.wp.x * .8 + i.wp.z * .35) * 6. + A.c * 9. - g.cam.w * 2.5) * .25;
  // raindrops' rings on the standing water (near the walker: further off they are finer than a pixel)
  var rg = vec3f(0.);
  if (film * g.wx.z > .01 && dist < 14.) { rg = rings(i.wp.xz * 3.6, g.cam.w) * (film * sat(g.wx.z * 2.5) * ss(14., 6., dist)); }
  let N = normalize(qrot(i.q, normalize(on + (A.n * .85 * (1. - .85 * onPath) + B.n * .65 * (1. - .85 * pathMid) + C.n * .45 * (1. - .6 * pathMid) * ss(60., 12., dist) + F.n * (.5 + .3 * onPath) * fk) * bump + vec3f(.8, sgro, .35) * vec3f(rip, 1., rip) + vec3f(rg.x, 0., rg.y) * 1.6 + vec3f(Wd.r - .5, 0., Wd.g - .5) * grain)));
  let L = g.sun.xyz; let V = normalize(g.cam.xyz - i.wp);
  let ao = (sat((v1.r - .5) * 8.) * .55 + sat((v2.r - .5) * 2.7) * .45) * vao * ss(.12, .6, hgt);
  let E = sunE() * shadow9(i.wp + n0 * .1 + L * .12) * dp * mix(1., .78, f32(mat == 0));
  let ndl = sat(dot(N, L)); let ndv = sat(dot(N, V));
  let open = sat((v2.r - .5) * 2.7);
  let am = (amb(N, v1.g) + side(N, open)) * ao;
  var c = alb * (E * (ndl + tl * (.2 + .5 * sat(-dot(N, L)))) + am);
  let H = normalize(V + L); let R = reflect(-V, N);
  // (what lies under a stream has no highlights of its own: the water's surface over it has them)
  let dry = 1. - under;
  c += E * pow(sat(dot(N, H)), mix(10., 90., gloss)) * gloss * ndl * 1.6 * dry;
  c += (amb(R, v1.g) + side(R, open)) * ao * (.06 + gloss) * .7 * pow(1. - ndv, 2.5) * dry;
  // (a ring's faces catch more of the sky than the flat water round them)
  c += skyC(R) * film * (.05 + .65 * pow(1. - ndv, 3.5) + .5 * rg.z + 1.5 * length(rg.xy)) * (.3 + .7 * v1.g) * dry;
  // wet through, a thing mirrors a little of the sky at a low angle: the sheen of a wet path, trunk or plank
  // (taken off the smooth surface, not off every lump of the detail, so it is a soft sheen)
  let Rs = reflect(-V, normalize(mix(n0, N, .2))); let ndvs = sat(dot(normalize(mix(n0, N, .2)), V));
  c += skyC(Rs) * wet * f32(mat <= 3) * (1. - film) * (.012 + (.1 + .22 * max(onPath, f32(mat == 3))) * pow(1. - ndvs, 4.)) * (.3 + .7 * v1.g) * dry;
  c += glw * gk;
  // Under a stream: the water takes light on the way down and back up along the bent line of sight, blue most
  // and green least (clear water with a little brown in it), and a pool adds a faint green veil of its own
  let path = max(-over, 0.) * under * (1. / max(sqrt(1. - (1. - V.y * V.y) / 1.77), .3) + 1.15);
  c = c * exp(-vec3f(.55, .38, 1.0) * path) + vec3f(.30, .32, .18) * amb(vec3f(0., 1., 0.), v1.g) * (1. - exp(-.15 * path));
  if (g.dbg.w > .5 && g.dbg.w < 1.5) { return vec4f(-1., 0., 0., 1.); } // (debug.isolate's mask: W_POST)
  return fin(fog(c, i.wp));
}
`;

// ---------------------------------------------------------------- leaves (boughs, crowns, bushes, ferns, grass)
// A card: a = root + length, b = yaw, tilt from upright, width, height up its plant (for the sway),
// c = type, s1 (its tree's hue), s2 (its own seed), bend. A plant of the ground (fern, grass) and a bare limb are
// one curved strip (vs). A card of a tree or a shrub is two quads showing a picture of the foliage atlas (atlas.js:
// a bough, a limb's end), the same at every distance, and near the walker the branchlets or leaf clusters of its
// picture turn out of it (vsN). Nothing changes its shape with distance: cards only thin out by rank (thin), and where a tree's have
// thinned away one picture of its whole crown stands in (vsFar)
export const W_LEAF =
  S_B +
  /*wgsl*/ `
override ROWS: f32 = 7.;
// How a store thins with distance (thin): STORE 1 by the trees' distances, 2 by the shrubs' (g.lt, g.ls); 0 by its
// own, from PD1 to PD2 metres and ending within the last fifth of FAR. The share kept goes from K0 down to KMIN
override STORE: u32 = 0u;
override FAR: f32 = 150.;
override PD1: f32 = 16.;
override PD2: f32 = 44.;
override K0: f32 = 1.25;
override KMIN: f32 = .25;
const NEAR_D = ${NEAR_D.toFixed(1)}; // quality.js
// the sub-cards a card unfolds near the walker, SLOTS to a picture (sprigs.js slotTable), and the stems of a
// bough's and a branchlet's pictures (sprigs.js)
@group(0) @binding(12) var<uniform> lay: array<vec4f, ${PICS.length * SLOTS * 2}>;
const SLOTS = ${SLOTS}u;
const STEM_B = vec4f(${STEM_B.map(f).join(', ')}); const STEM_T = vec4f(${STEM_T.map(f).join(', ')}); const STEM_W = ${f(STEM_W)};
struct LI { @location(0) a: vec4f, @location(1) b: vec4f, @location(2) c: vec4f };
// pr: how much light passes through, the pattern cut out of the quad (fs: 7 a picture of the atlas), how often it
// repeats along it (for 7: the atlas's layer), the tree's kind
struct LO { @builtin(position) cp: vec4f, @location(0) wp: vec3f, @location(1) n: vec3f, @location(2) uv: vec2f,
  @location(3) @interpolate(flat) col: vec3f, @location(4) @interpolate(flat) pr: vec4f, @location(5) @interpolate(flat) sd: vec2f,
  // at: the picture of the foliage atlas a quad shows (its place and size there; its layer is pr.z); fx.y: seen
  // from above (vsN), z and w: a sub-card's own picture's layer (-1 none, 3 bare wood) and how far it has turned
  // out of its card, or a far picture's opacity (vsFar); ou: where its own picture is in the atlas
  @location(6) @interpolate(flat) at: vec4f, @location(7) @interpolate(flat) fx: vec4f, @location(8) ou: vec2f };
fn shape2(v: f32) -> f32 { return sin(3.14159 * sat(v)); }
fn h4(x: f32) -> vec4f { return fract(sin(vec4f(x, x + 1.7, x + 3.1, x + 5.3) * vec4f(127.1, 269.5, 419.2, 371.9)) * 43758.5453); }
// What a card's type says: colour, how much light passes through, outline (where it is widest, how blunt), how
// much it waves, flutters and twists, the pattern cut out of it far off (pat: 1 needle twigs, 2 a spread of small
// leaves, 3 a fern's leaflets; ser: how many along the card), the tree's kind (for leaf colours), crk: the crown
// normal it is lit by (how much that follows the card's own direction rather than its heading, how much it leans
// up), grow: 1 if it stands as quads (vsN) and gains sprays up close, rig: 1 if it is a sheet whose twist turns it
// whole (curve).
// Types: 0 a conifer bough, 1 hanging moss (casts no shadow), 2 a fern frond, 3 maple leaves (bushes and fallen
// leaves too), 4 grass and reeds, 5 birch leaves, 6 a hanging conifer spray, 7 oak leaves,
// 8 a bare limb or stem (a strip that tapers from its root), 9 a hemlock's bough, 10 a cedar's, 11 a bush's leaves
// (a vine maple's, lying level in tiers: lay), 13 a conifer's dead branch
struct TY { col: vec3f, tl: f32, shp: vec2f, wav: f32, fls: f32, twk: f32, pat: f32, ser: f32, kind: f32, crk: vec2f, grow: f32, lay: f32, rig: f32 };
fn typeOf(ty: i32, s1: f32, s2: f32) -> TY {
  var o: TY; o.col = vec3f(0.); o.tl = .9; o.shp = vec2f(.75, .7); o.wav = 1.; o.fls = 1.; o.twk = 1.; o.pat = 0.; o.ser = 0.; o.kind = 0.; o.crk = vec2f(1., .5); o.grow = 0.; o.lay = 0.; o.rig = 0.;
  switch ty {
    case 0 { o.col = folC(0, s1, s2); o.tl = .4; o.shp = vec2f(.42, .4); o.wav = .12; o.fls = .25; o.twk = .25; o.pat = 1.; o.ser = 8.; o.crk = vec2f(1., .6); o.grow = 1.; o.rig = 1.; }
    case 1 { o.col = mix(vec3f(.20, .26, .08), vec3f(.30, .34, .12), s2); o.tl = .8; o.shp = vec2f(.3, .25); o.wav = .8; o.fls = .8; o.crk = vec2f(0., 1.); }
    case 2 { o.col = mix(mix(vec3f(.10, .27, .04), vec3f(.22, .40, .06), s1), vec3f(.42, .28, .05), step(.92, s2)); o.shp = vec2f(.55, .6); o.wav = .25; o.fls = .5; o.twk = .3; o.pat = 3.; o.ser = 17.; o.crk = vec2f(.5, 1.2); }
    case 3 { o.col = folC(2, s1, s2); o.tl = 1.; o.shp = vec2f(.8, .4); o.wav = .5; o.fls = 1.2; o.pat = 2.; o.ser = 5.; o.kind = 2.; o.crk = vec2f(1., .3); o.grow = 1.; }
    case 4 { o.col = mix(mix(vec3f(.30, .28, .06), vec3f(.48, .40, .10), s1), vec3f(.16, .24, .05), step(.6, s2)); o.tl = .8; o.shp = vec2f(.35, .3); o.wav = .5; o.twk = .5; o.crk = vec2f(0., 2.); }
    case 5 { o.col = folC(3, s1, s2); o.tl = 1.; o.shp = vec2f(.8, .4); o.wav = .6; o.fls = 1.6; o.pat = 2.; o.ser = 16.; o.kind = 3.; o.crk = vec2f(1., .3); o.grow = 1.; }
    case 6 { o.col = folC(0, s1, s2) * .95; o.tl = .4; o.shp = vec2f(.4, .4); o.wav = .5; o.fls = .7; o.twk = .5; o.pat = 1.; o.ser = 7.; o.crk = vec2f(0., .5); o.grow = 1.; }
    case 9 { o.col = folC(5, s1, s2) * 1.3; o.tl = .55; o.shp = vec2f(.42, .4); o.wav = .14; o.fls = .3; o.twk = .25; o.pat = 1.; o.ser = 8.; o.kind = 5.; o.crk = vec2f(1., .6); o.grow = 1.; o.rig = 1.; }
    case 10 { o.col = folC(1, s1, s2); o.tl = .4; o.shp = vec2f(.42, .4); o.wav = .12; o.fls = .25; o.twk = .25; o.pat = 1.; o.ser = 8.; o.kind = 1.; o.crk = vec2f(1., .6); o.grow = 1.; o.rig = 1.; }
    case 11 { o.col = folC(2, s1, s2); o.tl = 1.; o.shp = vec2f(.8, .4); o.wav = .5; o.fls = 1.2; o.pat = 2.; o.ser = 5.; o.kind = 2.; o.crk = vec2f(1., .3); o.grow = 1.; o.lay = 1.; }
    case 13 { o.col = vec3f(.2, .18, .15); o.tl = 0.; o.shp = vec2f(.42, .4); o.wav = .04; o.fls = .1; o.twk = 0.; o.pat = 1.; o.kind = 7.; o.crk = vec2f(0., .6); o.grow = 1.; o.rig = 1.; }
    case 8 { o.col = vec3f(.21, .16, .11); o.tl = 0.; o.wav = .05; o.fls = .2; o.twk = 0.; o.crk = vec2f(0., .6); }
    default { o.col = folC(4, s1, s2); o.shp = vec2f(.8, .4); o.wav = .5; o.pat = 2.; o.ser = 12.; o.kind = 4.; o.crk = vec2f(1., .3); o.grow = 1.; }
  }
  return o;
}
// A card's middle line at v (0 its root, 1 its tip) and its frame there: T0 along it, S across it, N2 out of its
// face; d is the direction it leaves the root in, head the level direction it heads in
struct CV { c: vec3f, T0: vec3f, N2: vec3f, S: vec3f, d: vec3f, head: vec3f };
fn curve(i: LI, y: TY, v: f32, t: f32, len: f32) -> CV {
  var o: CV;
  let s2 = i.c.z; let hA = i.b.w;
  let cy = cos(i.b.x); let sy = sin(i.b.x); let ct = cos(i.b.y); let st = sin(i.b.y);
  let d = vec3f(st * cy, ct, st * sy); let pe = vec3f(ct * cy, -st, ct * sy); let sd = vec3f(-sy, 0., cy);
  let k = (i.c.w - .3) * 2.0 + sin(t * (.8 + s2) * y.fls + s2 * 40. + hA * .25) * .07 * y.fls * (.35 + g.wx.y);
  let wph = v * (3. + 5. * s2) + s2 * 30. + t * 1.1;
  let wv = sin(wph) * .12 * y.wav;
  let kq = k * 1.7; let ka = select(kq, .06, abs(kq) < .06);
  let sK = sin(ka * v); let cK = cos(ka * v);
  o.c = i.a.xyz + len * (d * (sK / ka) + pe * ((1. - cK) / ka + wv * v));
  let sl = sK + wv + cos(wph) * .10 * y.wav * v * (3. + 5. * s2);
  let N = normalize(pe * cK - d * sl); o.T0 = normalize(d * cK + pe * sl);
  // (a sheet, rig, keeps the twist of its middle all along it, so each of its halves is flat: vsN lays sub-cards
  // on them)
  let tw = ((hs(s2 * 7.7) - .5) * 2.4 + sin(t * .9 + s2 * 20.) * .25) * y.twk * select(v, .5, y.rig > .5);
  o.S = sd * cos(tw) + select(N, pe, y.rig > .5) * sin(tw); o.N2 = N * cos(tw) - sd * sin(tw);
  o.d = d; o.head = vec3f(cy, 0., sy);
  return o;
}
// The normal foliage is lit by: mostly the crown's, out the way the card heads from its trunk or its crown's middle
// (world.js lays the cards so) and up, straight up for what lies on the ground; a part is the surface's own. A crown
// then shades as one rounded mass, sunlit on one side, instead of every card catching the light its own way
fn litN(cv: CV, y: TY, hA: f32, own: vec3f, part: f32) -> vec3f {
  let crown = normalize(mix(normalize(mix(cv.head, cv.d, y.crk.x) + vec3f(0., y.crk.y, 0.)), vec3f(0., 1., 0.), step(hA, .01)));
  return normalize(crown * (1. - part) + own * (part * sign(dot(own, crown) + 1e-4)));
}
// A card's rank: its own fixed number, 0 to 1 (world.js splits the stores by the same one, rankOf there)
fn rankOf(i: LI) -> f32 { return fract(i.c.z * 7.13 + i.c.y * 3.71); }
// a store's distances: where its thinning begins and ends, and the band its survivors end in
fn thinD() -> vec4f {
  if (STORE == 1u) { return g.lt; }
  if (STORE == 2u) { return g.ls; }
  return vec4f(PD1, PD2, FAR * .64, FAR);
}
// How a store thins with distance: the cards of the highest ranks narrow away one by one, each at its own distance
// (K0 1.25: none before the thinning begins), then each that is left ends at its own distance within the band.
// Nothing grows, nothing drops out in blocks or at a line. This card's width times (scene.js thinW mirrors it)
fn thin(rank: f32, cd: f32) -> f32 {
  let d = thinD();
  let k = mix(K0, KMIN, ss(d.x, d.y, cd));
  let r = sqrt(d.z / d.w); let end = d.w * mix(r, 1., hs(rank * 31.7));
  return sat((k - rank) / (.2 * k)) * (1. - ss(end * r, end, cd));
}
// a cell of a quarter of an atlas layer, by its number (atlas.js)
fn cell4(n: i32) -> vec4f { return vec4f(f32(n % 4) * .25, f32(n / 4) * .25, .25, .25); }
// is this a card of a tree or a shrub, which stands as quads (vsN)? Not in the shadow pass: there all are strips
fn solidK(y: TY, hA: f32) -> f32 { return y.grow * step(.01, hA) * step(.5, g.res.x); }
@vertex fn vs(@builtin(vertex_index) vi: u32, i: LI) -> LO {
  var o: LO;
  if (isoOut(i.a.xyz) || isoSkip(false)) { o.cp = vec4f(0., 0., 2., 1.); return o; }
  let u = f32(vi & 1u) * 2. - 1.; let v = sin(f32(vi >> 1u) / (ROWS - 1.) * 1.5708);
  let ty = i32(i.c.x * 255. + .5); let s1 = i.c.y; let s2 = i.c.z;
  let t = g.cam.w; let hA = i.b.w;
  let y = typeOf(ty, s1, s2);
  let shp_ = g.res.x == 0.;
  // th: thinned by its rank at this distance; in the shadow pass every card stands whole
  let th = select(thin(rankOf(i), distance(i.a.xyz, g.cam.xyz)) * (1. - solidK(y, hA)), 1., shp_);
  let cv = curve(i, y, v, t, i.a.w);
  let shape = select(pow(max(sin(3.14159 * pow(v, y.shp.x)), 0.), y.shp.y), 1. - .75 * v, ty == 8);
  // (a bare limb or stem turns to face the walker, so it reads as round from every side)
  var S = cv.S; var own = normalize(cv.N2 + cv.S * u * .55);
  if (ty == 8 && !shp_) { S = normalize(cross(cv.T0, cv.c - g.cam.xyz)); own = normalize(S * u * .8 - cross(S, cv.T0)); }
  var p = cv.c + S * (u * select(i.b.z * .5 * shape * th, select(max(i.b.z * .5, .09) * shape, 0., ty == 1), shp_));
  // hA: how high up its tree the leaf is rooted, so it rides the trunk's bend (sway in S_B)
  let sw = sway(i.a.xz, hA + (p.y - i.a.y), t);
  p.x += sw.x; p.z += sw.y;
  o.cp = g.vp * vec4f(p, 1.); o.wp = p; o.n = litN(cv, y, hA, own, .35); o.uv = vec2f(u, v);
  // A fern's frond and a herb's leaves are pictures of the atlas (atlas.js): one of four fronds, a cluster of the
  // herb's kind of leaf
  var pat = 0.; let kd = i32(y.kind + .5);
  if (ty == 2) { pat = 7.; o.at = vec4f(.75 + floor(s2 * 3.99) * .0625, .5, .0625, .25); }
  else if (y.pat > 1.5) { pat = 7.; o.at = cell4(select(select(4, 6, kd == 3) + i32(step(.5, s2)), 8, kd == 4)); }
  o.col = y.col; o.pr = vec4f(y.tl, pat, 0., y.kind); o.sd = vec2f(s1, s2); o.fx = vec4f(0., 1., -1., 0.);
  return o;
}
// The flat part of a card a sub-card lies on (a half of a sheet, or one of a limb end's two quads), by its
// picture's units: o the picture's (0, 0), x and y a unit across and along, f its face's normal, nb and nt the
// normal it is lit by at the picture's y 0 and 1, fy its fx.y (seen from underneath), sd and cf its seed (o.sd.y)
// and colour times
struct PF { o: vec3f, x: vec3f, y: vec3f, f: vec3f, nb: vec3f, nt: vec3f, fy: f32, sd: f32, cf: f32 };
// half h of a conifer's sheet, wd half its width; yS: its v to one of its picture's y (a bough's picture is 2 long)
fn sheetPF(i: LI, y: TY, t: f32, len: f32, wd: f32, h: f32, yS: f32) -> PF {
  var o: PF;
  let v0 = h * .5; let a = curve(i, y, v0, t, len); let b = curve(i, y, v0 + .5, t, len);
  let along = (b.c - a.c) * 2.;
  o.x = a.S * (2. * wd); o.y = along * yS; o.o = a.c - along * v0 - a.S * wd;
  let na = litN(a, y, i.b.w, a.N2, .5); let nb = litN(b, y, i.b.w, b.N2, .5);
  o.nb = na - (nb - na) * (v0 * 2.); o.nt = na + (nb - na) * ((yS - v0) * 2.);
  o.f = normalize(cross(o.x, o.y)); o.f *= sign(dot(o.f, a.N2) + 1e-6);
  // (the whole half takes it from its first corner)
  var p = a.c - a.S * wd; let sw = sway(i.a.xz, i.b.w + (p.y - i.a.y), t); p.x += sw.x; p.z += sw.y;
  o.fy = ss(-.15, .15, dot(a.N2 * sign(a.N2.y + 1e-4), normalize(g.cam.xyz - p)));
  o.sd = i.c.z; o.cf = 1.;
  return o;
}
// quad kq of a limb's end: about the card's line, turned its own way, with a little flutter of its own; a bush's
// lie level, along the card, in tiers
fn limbPF(i: LI, y: TY, t: f32, len: f32, show: f32, kq: f32) -> PF {
  var o: PF;
  let s2 = i.c.z; let h = h4(s2 * 91.7 + kq * 17.31); let hb = h4(s2 * 53.1 + kq * 7.77);
  let cv = curve(i, y, (kq + .6) / 2.2, t, len);
  let r3 = normalize(h.yzw - .5 + vec3f(0., .15, 0.));
  var axis = normalize(r3 + cv.T0 * .5 + vec3f(0., .3, 0.));
  var L = clamp(len * 1.1, .5, 2.3);
  var wide = normalize(cross(axis, hb.yzw - .5 + vec3f(.013, .007, .011)));
  if (y.lay > .5) { axis = normalize(cv.T0 + r3 * .22); wide = normalize(cross(vec3f(0., 1., 0.) + (hb.yzw - .5) * .35, axis)); L *= .7; }
  axis = normalize(axis + wide * (sin(t * (1.3 + hb.z * 2.) + h.w * 40.) * .07 * (.4 + g.wx.y)));
  let W = L * .5 * show;
  o.x = wide * (2. * W); o.y = axis * L; o.o = cv.c - axis * (L * .3) - wide * W;
  o.f = normalize(cross(wide, axis)); o.nb = litN(cv, y, i.b.w, o.f, .5); o.nt = o.nb;
  o.fy = 1.; o.sd = fract(s2 + h.x * 7.31); o.cf = .8 + .4 * hb.w;
  return o;
}
// v turned by the least turn that takes the way a to the way b, then by r about b
fn turn(v: vec3f, a: vec3f, b: vec3f, r: f32) -> vec3f {
  let k = cross(a, b);
  let u = v * dot(a, b) + cross(k, v) + k * (dot(k, v) / (1. + dot(a, b)));
  return u * cos(r) + cross(b, u) * sin(r) + b * (dot(b, u) * (1. - cos(r)));
}
// A card of a tree or a shrub, as quads of six vertices, each showing a picture of the foliage atlas. The first
// two are the card itself and stay as they are at every distance: a bough is a sheet in two flat lengths along its
// curve with the picture of the whole bough; a limb's end and a hanging spray are two quads with the picture of a
// limb's end or of a branchlet. The others (scene.js draws SPRIGS quads within NEAR_D, two beyond) are sub-cards of
// the card's picture (sprigs.js: branchlets of a bough, sprays of a branchlet, clusters of a limb's end) and, on a
// bough or a branchlet, its stem in two quads. Each lies flat on the very part of the picture it repeats, showing
// the card's own pixels, and turns out into its own plane as the walker comes near (near): the card unfolds,
// nothing appears or vanishes. g.mis.w (debug.sprigs): 1 none drawn, 2 all held flat
@vertex fn vsN(@builtin(vertex_index) vi: u32, i: LI) -> LO {
  var o: LO;
  let ty = i32(i.c.x * 255. + .5); let s1 = i.c.y; let s2 = i.c.z;
  let t = g.cam.w; let len = i.a.w; let hA = i.b.w;
  let y = typeOf(ty, s1, s2);
  let show = solidK(y, hA) * thin(rankOf(i), distance(i.a.xyz, g.cam.xyz));
  // near: 0 beyond NEAR_D, 1 from 0.4 of it inward. Never for a card too high in its tree to come that near:
  // world.js files those apart by the same height, and they are only ever drawn as two quads
  let near = (1. - ss(NEAR_D * .4, NEAR_D * .95, distance(i.a.xz, g.cam.xz))) * step(hA, NEAR_D + 3.);
  let k = vi / 6u; var cn = vi % 6u; if (cn > 2u) { cn = select(5u - cn, 3u, cn == 5u); }
  let q = vec2f(f32(cn & 1u) * 2. - 1., f32(cn >> 1u));
  o.col = y.col; o.uv = q; o.sd = vec2f(s1, s2); o.pr = vec4f(0., 7., 0., y.kind);
  o.cp = vec4f(0., 0., 2., 1.); o.wp = i.a.xyz; o.n = vec3f(0., 1., 0.); o.fx = vec4f(0., 1., -1., 0.);
  if (show <= 0. || (k >= 2u && (g.mis.w == 1. || ty == 6)) || isoOut(i.a.xyz) || isoSkip(false)) { return o; }
  // Which pictures (atlas.js): a conifer's branchlet and bough by its kind (0 fir, 5 hemlock, 1 cedar; of a fir's
  // and a hemlock's there are two, taken by the card's seed); a broadleaf's limb's end (2 maple, 3 birch, 4 oak; a
  // bush's are a vine maple's); a dead branch's (7) are bare
  let conifer = y.pat < 1.5; let kd = i32(y.kind + .5); let alt = i32(step(.5, hs(s2 * 13.7)));
  let br = select(select(select(alt, 4, kd == 1), 2 + alt, kd == 5), 5, kd == 7);
  let bo = select(select(alt, 3, kd == 1), 2, kd == 5);
  let le = select(select(select(6 + alt, 8, kd == 3), 9, kd == 4), 10, y.lay > .5);
  // a bough (a young hemlock's short ones too: the bough's picture is the lacy one); any other short card of a
  // conifer is a branchlet itself. P: its picture in sprigs.js
  let isLong = len > 2.2 || ty == 9;
  let sheet = conifer && ty != 6;
  var layer = 1.; var P = u32(4 + le); var yS = 1.; o.at = cell4(le);
  if (sheet) { layer = select(1., 2., isLong); P = u32(select(4 + br, bo, isLong)); yS = select(1., .5, isLong); o.at = select(cell4(br), vec4f(f32(bo) * .25, 0., .25, .5), isLong); }
  else if (conifer) { o.at = cell4(br); }
  o.pr = vec4f(y.tl, 7., layer, y.kind);
  let wd = i.b.z * .5 * show;
  var p: vec3f; var ft = vec3f(0.);
  if (k < 2u) {
    if (sheet) {
      let pf = sheetPF(i, y, t, len, wd, f32(k), yS);
      let v = (f32(k) + q.y) * .5;
      p = pf.o + pf.x * ((q.x + 1.) * .5) + pf.y * (v / yS);
      o.uv = vec2f(q.x, v); o.n = mix(pf.nb, pf.nt, v / yS); o.fx.y = pf.fy;
    } else if (conifer) {
      // a hanging spray: two quads across each other down its line
      let h = h4(s2 * 91.7 + f32(k) * 17.31); let hb = h4(s2 * 53.1 + f32(k) * 7.77);
      let cv = curve(i, y, 0., t, len); let tip = curve(i, y, 1., t, len).c;
      let wide = normalize(cross(normalize(tip - cv.c), select(cv.S, cv.N2, k == 0u)));
      let axis = normalize(normalize(tip - cv.c) + wide * (sin(t * (1.3 + hb.z * 2.) + h.w * 40.) * .07 * (.4 + g.wx.y)));
      p = cv.c + axis * (q.y * length(tip - cv.c)) + wide * (q.x * wd);
      let own = normalize(cross(wide, axis)); o.n = litN(cv, y, hA, own, .5); ft = own;
      o.sd.y = fract(s2 + h.x * 7.31); o.col = y.col * (.8 + .4 * hb.w);
    } else {
      let pf = limbPF(i, y, t, len, show, f32(k));
      p = pf.o + pf.x * ((q.x + 1.) * .5) + pf.y * q.y;
      o.n = pf.nb; o.sd.y = pf.sd; o.col = y.col * pf.cf;
    }
  } else if (k < ${SPRIGS - TWIGQ}u) {
    // a sub-card: on its picture its foot, the way it heads (dir) and half its width across (acr)
    let e = lay[(P * SLOTS + k - 2u) * 2u]; let e2 = lay[(P * SLOTS + k - 2u) * 2u + 1u];
    if (e.w <= 0.) { return o; }
    let h = h4(s2 * 91.7 + f32(k) * 17.31); let hb = h4(s2 * 53.1 + f32(k) * 7.77);
    var pf: PF;
    if (sheet) { pf = sheetPF(i, y, t, len, wd, e2.z, yS); } else { pf = limbPF(i, y, t, len, show, e2.z); }
    let dir = vec2f(-sin(e.z), cos(e.z)); let acr = vec2f(dir.y, -dir.x) * (abs(e2.x) * .5);
    let pp = e.xy + dir * (q.y * e.w) + acr * q.x;
    let A = pf.x * (dir.x * e.w) + pf.y * (dir.y * e.w); let B = pf.x * acr.x + pf.y * acr.y;
    // How far it has turned out of the card (none at the edge of the near range), to where it stands near: a
    // conifer's raked a little up or down and hanging, a broadleaf's cluster out all round the limb, a bush's level
    let w = select(ss(h.w * .7, h.w * .7 + .3, near), 0., g.mis.w == 2.);
    let aF = normalize(A);
    var aT = normalize(aF + pf.f * (h.y * 2. - 1.) + vec3f(0., .3, 0.)); var roll = (hb.y - .5) * 3.14159;
    if (conifer) { aT = normalize(aF - pf.f * ((h.z - .5) * .5) + vec3f(0., -.25, 0.)); roll = atan((hb.x - .5) * .8); }
    else if (y.lay > .5) { aT = normalize(aF + pf.f * ((h.y - .5) * .8)); roll = atan((hb.y - .5) * .5); }
    let a1 = normalize(mix(aF, aT, w));
    p = pf.o + pf.x * e.x + pf.y * e.y + a1 * (length(A) * q.y) + turn(B, aF, a1, roll * w) * q.x;
    o.uv = vec2f(pp.x * 2. - 1., pp.y * yS);
    o.n = turn(mix(pf.nb, pf.nt, pp.y), aF, a1, roll * w); ft = turn(pf.f, aF, a1, roll * w);
    let c4 = cell4(i32(e2.y + .5)); o.ou = c4.xy + vec2f(.5 + q.x * .5 * sign(e2.x), q.y) * c4.zw;
    o.fx = vec4f(0., pf.fy, layer - 1., w); o.sd.y = pf.sd; o.col = y.col * pf.cf;
  } else {
    // The stem of a bough or a branchlet, in two lengths (one on each half of the sheet), as wide as the picture
    // paints it; it turns about its line to face the walker. Only a long card has one; a limb's lies in its leaves
    if (!sheet) { return o; }
    let j = f32(k - ${SPRIGS - TWIGQ}u);
    let pf = sheetPF(i, y, t, len, wd, j, yS);
    let st = select(STEM_T, STEM_B, isLong);
    let py = mix(select(st.y, .5 / yS, j > .5), select(.5 / yS, st.w, j > .5), q.y);
    let hw = STEM_W * (st.w - st.y) * (1. - .6 * (py - st.y) / (st.w - st.y)) * ss(1., 1.6, len);
    let w = select(ss(.1, .6, near), 0., g.mis.w == 2.);
    let mid = pf.o + pf.x * .5 + pf.y * py; let xs = normalize(pf.x);
    var across = normalize(cross(pf.y, mid - g.cam.xyz)); across *= sign(dot(across, xs) + 1e-6);
    let s1v = normalize(mix(xs, across, w));
    p = mid + s1v * (q.x * hw * length(pf.x));
    o.uv = vec2f(q.x * hw * 2., py * yS);
    o.n = turn(mix(pf.nb, pf.nt, py), xs, s1v, 0.); ft = turn(pf.f, xs, s1v, 0.);
    o.fx = vec4f(0., pf.fy, 3., w);
  }
  let sw = sway(i.a.xz, hA + (p.y - i.a.y), t);
  p.x += sw.x; p.z += sw.y;
  o.cp = g.vp * vec4f(p, 1.); o.wp = p;
  // (a conifer's spray seen from underneath shows its shaded side: fx.y 0, and 1 seen from above)
  let under = select(1., ss(-.15, .15, dot(ft * sign(ft.y + 1e-4), normalize(g.cam.xyz - p))), conifer);
  if (k >= 2u) {
    // flat on its card it must win the depth test against the same surface: a hair nearer along the line of sight
    o.cp.z *= 1.0002;
    o.fx.y = mix(o.fx.y, under, o.fx.w);
  } else if (!sheet) { o.fx.y = under; }
  return o;
}
// A whole tree's crown far off in the fog (world.js farT): one upright quad along the tree's lean that turns to
// face the walker, with the picture of a far tree (atlas.js; which one: c.w). It is all there always, blended in
// as its tree's cards thin out, from lf.x to lf.y metres (fx.w, fsFar)
const FARKIND = array<f32, 8>(0., 0., 0., 1., 6., 2., 3., 4.);
@vertex fn vsFar(@builtin(vertex_index) vi: u32, i: LI) -> LO {
  var o: LO;
  let q = vec2f(f32(vi & 1u) * 2. - 1., f32(vi >> 1u));
  let s1 = i.c.y; let s2 = i.c.z; let pic = floor(i.c.w * 8.);
  let inK = sat((distance(i.a.xz, g.cam.xz) - g.lf.x) / (g.lf.y - g.lf.x));
  o.cp = vec4f(0., 0., 2., 1.); o.wp = i.a.xyz; o.n = vec3f(0., 1., 0.); o.uv = q;
  if (inK <= 0. || isoOut(i.a.xyz) || isoSkip(true)) { return o; }
  let cy = cos(i.b.x); let sy = sin(i.b.x); let ct = cos(i.b.y); let st = sin(i.b.y);
  let axis = vec3f(st * cy, ct, st * sy);
  let side = normalize(cross(axis, g.cam.xyz - i.a.xyz)) * select(1., -1., s2 > .5); // (half of them mirrored)
  var p = i.a.xyz + axis * (q.y * i.a.w) + side * (q.x * i.b.z * .5);
  let sw = sway(i.a.xz, i.b.w + (p.y - i.a.y), g.cam.w);
  p.x += sw.x; p.z += sw.y;
  let kd = FARKIND[i32(pic)];
  o.col = folC(i32(kd), s1, s2) * .85; o.sd = vec2f(s1, s2);
  o.pr = vec4f(.3, 7., 2., kd); o.at = vec4f(pic * .125, .5, .125, .25); o.fx = vec4f(0., 1., -1., inK);
  o.cp = g.vp * vec4f(p, 1.); o.wp = p;
  o.n = normalize(vec3f(g.cam.x - i.a.x, 0., g.cam.z - i.a.z)) * .6 + vec3f(0., .8, 0.);
  return o;
}
// fireflies: a = place + height (for the sway), b = seed, colour, size
struct GO { @builtin(position) cp: vec4f, @location(0) uv: vec2f, @location(1) @interpolate(flat) col: vec3f };
@vertex fn vsGl(@builtin(vertex_index) vi: u32, @location(0) a: vec4f, @location(1) b: vec4f) -> GO {
  var o: GO; let q = vec2f(f32(vi & 1u), f32(vi >> 1u)) * 2. - 1.; let t = g.cam.w;
  let p = a.xyz + vec3f(sin(t * .31 + b.x * 50.), .5 * sin(t * .43 + b.x * 70.), cos(t * .37 + b.x * 90.)) * .9;
  let d = length(p - g.cam.xyz);
  if (d > 90. || dot(p - g.cam.xyz, g.fwd.xyz) < -1.) { o.cp = vec4f(0., 0., 2., 1.); o.uv = q; o.col = vec3f(0.); return o; }
  let tw = pow(.5 + .5 * sin(t * (.9 + 1.4 * hs(b.x)) + b.x * 100.), 6.);
  let sz = min(max(b.z, d * .0026), d * .0045);
  let w = p + (g.right.xyz * q.x + g.up.xyz * q.y) * sz;
  o.cp = g.vp * vec4f(w, 1.); o.uv = q;
  let e = b.z / sz;
  // brightest in the shade, out in the rain
  o.col = mix(vec3f(1., .78, .2), vec3f(.75, 1., .3), b.y) * (.05 + tw * 2.2) * e * e * hazeT(d, 0., p.y) * ss(.4, 1.5, d) * (14. - 9. * shadowV(p)) * (1. - .85 * g.wx.z);
  return o;
}
@fragment fn fsGl(i: GO) -> @location(0) vec4f {
  let r = dot(i.uv, i.uv);
  return vec4f(min(i.col * exp(-r * 7.) * (1. - ss(.7, 1., r)), vec3f(10.)), 0.);
}
// A card's colour (fs), or a far tree's picture blended in (fsFar: its whole outline a pixel soft, times fx.w)
@fragment fn fs(i: LO, @builtin(front_facing) ff: bool) -> @location(0) vec4f { return leafC(i, ff, false); }
@fragment fn fsFar(i: LO, @builtin(front_facing) ff: bool) -> @location(0) vec4f { return leafC(i, ff, true); }
fn leafC(i: LO, ff: bool, blended: bool) -> vec4f {
  let dist = length(i.wp - g.cam.xyz);
  let n = normalize(i.n); // lit by the crown's normal (litN): the same whichever face is seen
  let V = normalize(g.cam.xyz - i.wp); let L = g.sun.xyz;
  let lt = textureSample(tD, sR, vec2f(i.uv.x * .13 + i.sd.x * 3.7, i.uv.y * .8 + i.sd.y * 5.3));
  let vv = vol(i.wp + vec3f(0., .8, 0.));
  let E = sunE() * shadow1(i.wp + L * .3) * dap(i.wp, dist, ss(.6, .95, vv.g));
  let ndl = dot(n, L); let tl = i.pr.x;
  let ax = abs(i.uv.x); let pat = i32(i.pr.y + .5);
  var cut = 1.; var base = i.col; var under = 0.; // under: a conifer's spray seen from its shaded side
  // A card of a tree or a shrub shows a picture of the foliage atlas (atlas.js): rgb its shade, hue and blade,
  // a its outline as a distance field. alod: how many of the picture's texels fall on a pixel, as a level
  let auv = i.at.xy + vec2f(i.uv.x * .5 + .5, i.uv.y) * i.at.zw;
  var tx = textureSample(tF, sR, auv, clamp(i32(i.pr.z + .5), 0, 2));
  var alod = log2(max(max(fwidth(auv.x), fwidth(auv.y)) * ${ATLAS}., 1.));
  // A sub-card (vsN). Flat on its card it shows the card's own pixels, wherever its own picture has any; turning
  // out, its own picture (or bare wood), never more of it than the card's picture holds
  let odx = dpdx(i.ou); let ody = dpdy(i.ou);
  if (i.fx.z >= 0.) {
    var own = vec4f(.45, 0., 0., 1.); var olod = alod;
    if (i.fx.z < 2.5) {
      own = textureSampleGrad(tF, sR, i.ou, i32(i.fx.z + .5), odx, ody);
      olod = log2(max(max(abs(odx.x) + abs(ody.x), abs(odx.y) + abs(ody.y)) * ${ATLAS}., 1.));
    }
    let onCard = step(abs(i.uv.x), 1.) * step(0., i.uv.y) * step(i.uv.y, 1.);
    tx = vec4f(mix(tx.rgb, own.rgb, i.fx.w), mix(min(tx.a, own.a), own.a, i.fx.w) * onCard);
    alod = mix(alod, olod, i.fx.w);
  }
  let fwa = fwidth(tx.a);
  if (pat == 7) {
    // (far off, where its small levels are soft, the outline is drawn a little further out: a crown is clumps
    // with gaps, not a mist of specks)
    cut = step(mix(.5, .43, sat(alod / 3.)), tx.a);
    let kd = i32(i.pr.w + .5);
    if (kd >= 2 && kd <= 4) {
      // leaves: each of its own hue (on a maple yellow, orange, red and still green on one twig); seen from the
      // other side paler and duller
      base = folC(kd, fract(i.sd.x + (tx.g - .5) * .5 + 1.), i.sd.y) * (.45 + .75 * tx.r) * (i.col.g / max(folC(kd, i.sd.x, i.sd.y).g, 1e-3));
      if (!ff) { base = mix(base, vec3f(dot(base, vec3f(.36))), .35) * 1.12; }
    } else {
      // needles: paler and yellower toward the tips of the sprays; dark seen from right below against the sky
      base = mix(i.col, i.col * 1.5 + vec3f(.025, .045, 0.), tx.g * .7) * (.45 + .75 * tx.r) * mix(.4, 1.1, ss(-.75, .15, V.y));
      under = 1. - i.fx.y;
    }
    base = mix(select(vec3f(.15, .12, .085), vec3f(.21, .2, .18), kd == 7) * (.6 + .8 * tx.r), base, tx.b);
  }
  var alb = base * (.8 + .2 * ss(0., .25, ax)) * mix(.48, 1.15, i.uv.y) * (.55 + .9 * lt.b) * (.7 + .6 * lt.a);
  alb *= 1. - .25 * g.wx.x;
  // light through the leaf: warmer than the leaf itself, strongest seen against the sun
  let trc = alb * mix(vec3f(1.), vec3f(1.5, 1.25, .7), tl);
  let aov = sat((vv.r - .5) * 6.) * mix(.45, 1., i.uv.y);
  // (rich, not luminous: only a leaf with the sun right behind it glows)
  let am = (amb(n, vv.g) + amb(-n, vv.g) * tl * .25 + side(n, sat((vv.r - .5) * 4.)) * .6) * (.35 + .65 * aov);
  var c = E * (alb * max(ndl, 0.) + trc * (max(-ndl, 0.) * .4 + .04) * tl) * (1. - .75 * under) + alb * am * (1. - .4 * under);
  let H = normalize(V + L);
  c += E * (pow(sat(dot(n, H)), 40.) * (.2 + .6 * g.wx.x) + pow(sat(dot(n, H)), 9.) * .05) * step(.5, tl);
  c += E * trc * tl * pow(sat(dot(-V, L)), 5.) * .8;
  // wet leaves shine: where a blade mirrors the sky overhead, a pale glint
  c += skyC(vec3f(0., 1., 0.)) * (g.wx.x * .22 * pow(sat(reflect(-V, n).y), 5.) * vv.g * (.3 + lt.b));
  // (debug.isolate's white mask: W_POST shows where it is)
  let mask = g.dbg.w > .5 && g.dbg.w < 1.5;
  if (blended) {
    let a = i.fx.w * sat((tx.a - mix(.5, .43, sat(alod / 3.))) / max(fwa, 1e-4) + .5);
    if (mask) { if (a <= 0.) { discard; } return vec4f(-1., 0., 0., 1.); }
    return vec4f(fin(fog(c, i.wp)).rgb * a, a);
  }
  if (cut < .5) { discard; }
  if (mask) { return vec4f(-1., 0., 0., 1.); }
  return fin(fog(c, i.wp));
}
`;

// ---------------------------------------------------------------- flyers: butterflies and small birds in flocks, big birds soaring
// A flock member: a = the flock's centre + lap radius, b = its seed, turn rate, size, the flock's seed
export const W_ANIM =
  S_B +
  /*wgsl*/ `
struct VI { @location(0) p: vec3f, @location(1) n: vec4f, @location(2) a: vec4f, @location(3) b: vec4f };
struct VO { @builtin(position) cp: vec4f, @location(0) wp: vec3f, @location(1) n: vec3f, @location(2) op: vec3f, @location(3) @interpolate(flat) sd: f32, @location(4) lt: f32 };
@vertex fn vsFish(i: VI) -> VO {
  var o: VO;
  let s = i.b.x; let h = vec3f(hs(s), hs(s + .37), hs(s + .71));
  let R = i.a.w; let t = g.cam.w;
  let small = step(i.b.z, .2);   // butterflies; the larger ones are birds
  let ta = t * i.b.y + i.b.w * 6.3 + (h.x - .5) * (26. / R);
  let ph = i.b.w * 17.;
  let P = i.a.xyz + vec3f(R * cos(ta), .8 * sin(3. * ta + ph), R * .6 * sin(ta));
  let T = normalize(vec3f(-R * sin(ta), 2.4 * cos(3. * ta + ph), R * .6 * cos(ta))) * sign(i.b.y);
  let S = normalize(cross(vec3f(0., 1., 0.), T)); let Up = cross(T, S);
  let off = S * ((h.y - .5) * R * .9 + sin(t * .6 + s * 40.) * .5) + Up * ((h.z - .5) * mix(2.4, 1.2, small) + cos(t * .5 + s * 31.) * .4 + small * sin(t * 4.3 + s * 60.) * .25);
  var l = i.p * i.b.z * (.75 + .5 * h.z);
  // the wings (aux below .5) beat about the body's long axis
  let beat = sin(t * mix(13., 24., small) + s * 50.) * mix(.75, 1.1, small);
  if (i.n.w < .5) { l = vec3f(l.x, l.y + abs(l.z) * sin(beat), l.z * cos(beat)); }
  let w = P + off + T * l.x + Up * l.y + S * l.z;
  // sd: the colour set in the whole part, the member's own seed in the fraction. The set is the flock's (from its
  // seed), or with a seed of 1 or more each member's own. Butterflies use sets 0-3, birds 4-7
  let kind = select(floor(i.b.w * 12.), floor(fract(s * 7.31) * 12.), i.b.w >= 1.) % 4.;
  o.cp = g.vp * vec4f(w, 1.); o.wp = w; o.n = T * i.n.x + Up * i.n.y + S * i.n.z; o.op = i.p; o.sd = kind + 4. * (1. - small) + s * .999;
  o.lt = shadowV(w);
  return o;
}
@fragment fn fsFish(i: VO, @builtin(front_facing) ff: bool) -> @location(0) vec4f {
  let n = normalize(i.n) * select(-1., 1., ff); let L = g.sun.xyz;
  let vv = vol(i.wp);
  let kind = i32(i.sd); let own = fract(i.sd);
  // 0 orange, 1 white, 2 blue, 3 yellow butterflies; 4 a jay, 5 a robin, 6 and 7 chickadees
  var belly = vec3f(.85, .42, .05); var back = belly; var tip = vec3f(.03);
  if (kind == 1) { belly = vec3f(.90, .90, .84); back = belly; tip = vec3f(.3); }
  if (kind == 2) { belly = vec3f(.20, .42, .90); back = belly; }
  if (kind == 3) { belly = vec3f(.92, .80, .15); back = belly; tip = vec3f(.25, .15, .02); }
  if (kind == 4) { belly = vec3f(.12, .26, .60); back = vec3f(.05, .13, .42); }
  if (kind == 5) { belly = vec3f(.80, .30, .08); back = vec3f(.20, .15, .10); tip = back; }
  if (kind >= 6) { belly = vec3f(.70, .68, .62); back = vec3f(.22, .22, .24); }
  var alb = mix(mix(belly, back, ss(-.1, .5, n.y)), tip, ss(.30, .46, abs(i.op.z))) * (.85 + .3 * own);
  let E = sunE() * i.lt; let ndl = dot(n, L);
  let c = alb * (E * (.3 + .7 * sat(ndl) + .5 * sat(-ndl)) + amb(n, vv.g) * 1.3);
  return fin(fog(c, i.wp));
}
// A big bird: a = the centre of its lap + radius, b = where on the lap it starts, turn rate, size, seed.
// Its mesh spans x from -1 to 1 with the head at +z; a vertex's aux is how far out along the wing it is
@vertex fn vsManta(i: VI) -> VO {
  var o: VO;
  let t = g.cam.w; let R = i.a.w; let sz = i.b.z;
  let ta = t * i.b.y + i.b.x;
  let P = i.a.xyz + vec3f(R * cos(ta), 2.5 * sin(2. * ta + i.b.w), R * .75 * sin(ta));
  let T = normalize(vec3f(-R * sin(ta), 5. * cos(2. * ta + i.b.w), R * .75 * cos(ta))) * sign(i.b.y);
  var S = normalize(cross(vec3f(0., 1., 0.), T)); var Up = cross(T, S);
  let bank = -.28 * sign(i.b.y);
  let S2 = S * cos(bank) + Up * sin(bank); Up = Up * cos(bank) - S * sin(bank); S = S2;
  let u = i.n.w; let au = abs(u);
  // a few beats, then a glide
  let fp = t * 4.2 + i.b.w * 5. - au * 1.2;
  let amp = .36 * pow(au, 1.6) * (.2 + .8 * ss(-.2, .5, sin(t * .35 + i.b.w * 9.)));
  var l = i.p;
  l.y += amp * sin(fp);
  let sl = amp * 1.6 * cos(fp) * sign(u);
  let ln = normalize(vec3f(i.n.x - sl * i.n.y, i.n.y + sl * i.n.x, i.n.z));
  let w = P + (S * l.x + Up * l.y + T * l.z) * sz;
  o.cp = g.vp * vec4f(w, 1.); o.wp = w; o.n = S * ln.x + Up * ln.y + T * ln.z; o.op = i.p; o.sd = i.b.w;
  o.lt = 1.;
  return o;
}
// A bird of birds.js: a = where its feet are and its length, q = its turn, c = its species with its own seed in
// the fraction; the wings' phase; how far they are spread (2 more in the air); the head's turn (-1 to 1, packed
// into the fraction) with the tail's fan (fifteenths) in the whole part. The mesh (meshSongbird) has its nose
// at +z and its feet at the origin; a vertex's aux says what it is: over 0.15 a wing (how far out, signed by
// side), 0.06 to 0.13 the tail, -0.07 a leg, -0.12 an eye, 0 the body
const AXIS = .3; // the body's axis over the feet, in lengths (birds.js)
struct BI { @location(0) p: vec3f, @location(1) n: vec4f, @location(2) a: vec4f, @location(3) q: vec4f, @location(4) c: vec4f };
struct BV { @builtin(position) cp: vec4f, @location(0) wp: vec3f, @location(1) n: vec3f, @location(2) op: vec3f, @location(3) @interpolate(flat) sd: f32, @location(4) lt: f32, @location(5) aux: f32, @location(6) @interpolate(flat) fan: f32 };
@vertex fn vsBird(i: BI) -> BV {
  var o: BV; var l = i.p; var n = i.n.xyz; let aux = i.n.w;
  let air = step(1.5, i.c.z); let spread = i.c.z - 2. * air;
  let fan = floor(i.c.w) / 15.; let turn = (fract(i.c.w) - .5) / .45;
  if (abs(aux) > .15) {
    // A wing: its inner half swings about the shoulder, its outer half about the wrist a little behind it, so it
    // bends: bowed on the way down, folded on the way up, when it is also drawn in by a quarter. Shut, it is
    // drawn into the body (the folded wing is painted on the flank). Lit by the body's up, not its own face,
    // which would flicker with every beat
    let side = sign(aux); let out = (abs(aux) - .2) / .8; let ph = i.c.y;
    let a1 = (sin(ph) * .7 + .12) * spread; let a2 = (sin(ph - .9) + .05) * spread;
    let reach = (abs(l.x) - .07) * spread * (1. - .25 * max(cos(ph), 0.));
    let inner = reach * min(1., .45 / max(out, .001));
    l = vec3f(side * (.07 + inner * cos(a1) + (reach - inner) * cos(a2)), l.y + inner * sin(a1) + (reach - inner) * sin(a2), l.z - (1. - spread) * out * .3);
    n = vec3f(0., 1., 0.);
  } else if (aux > .04) { l.x *= 1. + 1.6 * fan; }                                        // the tail fans
  else if (aux < -.04 && aux > -.095) { l.y = mix(l.y, AXIS - .1, air); l.z = mix(l.z, -.08, air); }   // legs tucked up in the air
  // the head turns about the neck, the bill and the eyes with it
  let hk = -ss(.2, .3, i.p.z) * turn * 1.3; let hc = cos(hk); let hn = sin(hk); let hz = l.z - .24;
  l = vec3f(l.x * hc + hz * hn, l.y, .24 + hz * hc - l.x * hn);
  n = vec3f(n.x * hc + n.z * hn, n.y, n.z * hc - n.x * hn);
  let w = i.a.xyz + qrot(i.q, l * i.a.w);
  o.cp = g.vp * vec4f(w, 1.); o.wp = w; o.n = qrot(i.q, n); o.op = i.p; o.sd = i.c.x; o.aux = aux; o.fan = fan;
  o.lt = shadowV(w + vec3f(0., .04, 0.));
  return o;
}
@fragment fn fsBird(i: BV, @builtin(front_facing) ff: bool) -> @location(0) vec4f {
  let wing = step(.15, abs(i.aux));
  let n = normalize(i.n) * mix(select(-1., 1., ff), 1., wing);
  let p = i.op; let h = p.y - AXIS; let own = fract(i.sd); let sp = i32(i.sd);
  // By species (birds.js SPECIES): the body by where on it, then what differs: the folded wing's panel on the
  // flank and where it lies, the bill and where it begins, the open wing, the tail's middle and its outer
  // feathers, the legs
  var alb = vec3f(0.); var panel = vec3f(.14, .12, .11); var bill = vec3f(.78, .62, .56); var wingC = vec3f(.15, .13, .12);
  var tailC = vec3f(.07, .07, .08); var edgeC = tailC; var leg = vec3f(.42, .26, .24); var panelZ = vec2f(-.22, .1); var billZ = .415;
  if (sp == 0) {
    // A dark-eyed junco: a dark slate hood over head, neck and breast, cut off sharply against a pale belly; a
    // browner back, buff flanks, a pink bill; the tail's outer feathers white
    alb = mix(mix(vec3f(.34, .26, .17), vec3f(.62, .5, .38), ss(0., -.03, h)), vec3f(.86, .84, .8), ss(-.05, -.08, h));
    alb = mix(alb, vec3f(.1, .105, .12), ss(.075, .095, p.z - h * .25));
    edgeC = vec3f(.85, .85, .82);
  } else if (sp == 1) {
    // A chickadee: black cap and bib, the white cheek between them, grey back, pale below with buff flanks
    let under = ss(-.01, -.05, h);
    alb = mix(mix(vec3f(.3, .3, .31), vec3f(.84, .82, .76), under), vec3f(.7, .58, .42), under * ss(-.11, -.06, h) * ss(.12, .02, p.z));
    let head = ss(.2, .23, p.z);
    alb = mix(alb, vec3f(.9, .9, .87), head);
    alb = mix(alb, vec3f(.03), head * max(ss(.125, .145, h), ss(.085, .065, h) * ss(.27, .3, p.z)));
    panel = vec3f(.2, .2, .22); wingC = panel; tailC = vec3f(.17, .17, .19); edgeC = tailC; bill = vec3f(.04); leg = vec3f(.2, .23, .28);
  } else if (sp == 2) {
    // A varied thrush: slate back, orange below and on the throat, a black band across the breast, an orange brow
    // over a dark mask, two orange bars on the wing
    let orange = vec3f(.8, .38, .07); let head = ss(.21, .24, p.z);
    alb = mix(vec3f(.17, .2, .25), orange, ss(0., -.04, h));
    alb = mix(alb, vec3f(.03, .03, .04), ss(.11, .13, p.z) * ss(.21, .19, p.z) * ss(.07, .04, h));
    alb = mix(alb, orange, head * ss(.085, .065, h));
    alb = mix(alb, vec3f(.06, .07, .09), head * ss(.085, .1, h) * ss(.16, .145, h));
    alb = mix(alb, orange, head * ss(.15, .16, h) * ss(.2, .185, h) * ss(.38, .36, p.z));
    panel = mix(vec3f(.1, .11, .13), orange, max(ss(.014, .006, abs(p.z + .03)), ss(.014, .006, abs(p.z - .045))));
    wingC = vec3f(.12, .13, .16); tailC = vec3f(.13, .15, .19); edgeC = tailC; bill = vec3f(.1, .08, .07); leg = vec3f(.5, .38, .28);
  } else {
    // A Steller's jay: black head, crest and shoulders shading into deep blue, paler blue below; brighter blue
    // wings and tail, barred across with black
    let bar = .5 + .5 * step(.4, fract(p.z * 24.));
    alb = mix(vec3f(.05, .15, .58) * (1. + .5 * ss(0., -.1, h)), vec3f(.025, .025, .035), ss(.15, .27, p.z + h * .15));
    panel = vec3f(.07, .28, .9) * bar; wingC = vec3f(.07, .26, .85) * bar; tailC = vec3f(.07, .27, .88) * bar; edgeC = tailC;
    bill = vec3f(.03); leg = vec3f(.04); panelZ = vec2f(-.12, .16); billZ = .4;
  }
  alb = mix(alb, panel, ss(.075, .1, abs(p.x)) * ss(-.06, -.01, h) * ss(panelZ.y, panelZ.y - .06, p.z) * ss(panelZ.x - .02, panelZ.x + .02, p.z));
  alb = mix(alb, bill, ss(billZ, billZ + .015, p.z));
  // (shut, a tail is all its middle's colour; as it fans, in flight or in a flick, its outer feathers show)
  if (i.aux > .04 && i.aux < .15) { let edge = mix(.14, .09, ss(0., .5, i.fan)); alb = mix(tailC, edgeC, ss(edge, edge + .012, i.aux)); }
  if (i.aux < -.04) { alb = mix(leg, vec3f(.01), step(i.aux, -.095)); }
  if (wing > .5) { alb = wingC * mix(1., .7, ss(.3, .9, abs(i.aux))); }
  alb *= .9 + .2 * own;
  let E = sunE() * i.lt;
  let c = alb * (E * (.2 + .8 * sat(dot(n, g.sun.xyz))) + amb(n, vol(i.wp).g) * 1.3);
  return fin(fog(c, i.wp));
}
// The crow family's birds, the jay and the raven (birds.js meshCorvid): the instance as a bird's, with d = how far
// the crest is raised, how far the toes are closed, the body's pitch (the feet and shanks do not take it) and the
// head's own pitch. Each part moves in its own way, told by the vertex's aux (a whole number of 127ths); a
// feather's place across and along its vane rides in its normal
const JAX = .2; // a jay's axis over its feet, in lengths (birds.js meshCorvid)
const RAX = .28; // a raven's: its heavy body carried higher on longer legs (birds.js RAVEN.lift)
// Where a build's parts lie (birds.js JAY and RAVEN, kept the same): its axis over the feet, the shoulder (x, z of
// the wing's bones), the wing's length out from it and the wrist's, where the hand's last primary roots, how close
// the shut wing folds, the flank the shut wing lies on (its width at the front and over the tail, by how far back),
// the tail's root, how wide it fans (shut, and more as it opens), the foot's x and the top of the shank that keeps
// upright, the head's turning part (from z, to z) with its pivot (y over the axis, z); the wingbeat (the arm's swing,
// the hand's, how far the hand lags, the arm's mean lift), and a walk's stride (0: it hops, not walks)
struct Form { ax: f32, sh: vec2f, wl: f32, wr: f32, fe: f32, fold: f32, flank: vec4f, tr: f32, fan: vec2f, foot: f32, shank: f32, head: vec4f, beat: vec4f, stride: f32 };
fn formOf(raven: bool) -> Form {
  if (raven) { return Form(RAX, vec2f(.07, .19), 1.18, .48, .66, .74, vec4f(.128, .03, .2, .36), -.12, vec2f(.02, .14), .065, .14, vec4f(.215, .28, .09, .24), vec4f(.9, 1.1, .5, .05), .2); }
  return Form(JAX, vec2f(.07, .21), .62, .26, .36, 1., vec4f(.128, .03, .2, .42), -.14, vec2f(.012, .1), .055, .1, vec4f(.235, .3, .095, .26), vec4f(.7, 1., .9, .12), 0.);
}
struct JI { @location(0) p: vec3f, @location(1) n: vec4f, @location(2) a: vec4f, @location(3) q: vec4f, @location(4) c: vec4f, @location(5) d: vec4f };
struct JV { @builtin(position) cp: vec4f, @location(0) wp: vec3f, @location(1) n: vec3f, @location(2) op: vec3f, @location(3) @interpolate(flat) part: f32, @location(4) lt: f32, @location(5) fe: vec2f, @location(6) @interpolate(flat) open: f32, @location(7) @interpolate(flat) kind: f32 };
@vertex fn vsJay(i: JI) -> JV {
  var o: JV; var l = i.p; var n = i.n.xyz; let code = round(i.n.w * 127.);
  let raven = i.c.x >= 4.; let F = formOf(raven); // (birds.js SPECIES: the jay 3, the raven 4, each with its seed; a stick 3)
  let air = step(1.5, i.c.z); let spread = i.c.z - 2. * air; let ph = i.c.y;
  let fan = floor(i.c.w) / 15.; let turn = (fract(i.c.w) - .5) / .45; let pitch = i.d.z;
  // (d holds two to a number: birds.js write)
  let crest = floor(i.d.x) / 31.; let ruffle = (fract(i.d.x) - .05) / .9; let toes = floor(i.d.y) / 15.; let fwd = (fract(i.d.y) - .05) / .9;
  let hpitch = floor(i.d.w) / 40. - 2.; let cock = (fract(i.d.w) - .5) / .9;
  var fe = vec2f(0.); var part = 0.; // 0 body and bill, 1 wing, 2 tail, 3 crest, 4 leg and toes, 5 eye, 6 a perch's stick, 7 a hackle
  if (abs(code + 24.) < .5) { part = 6.; } // (only -24: a left wing's codes run on below it)
  else if (code < -19. && code > -21.) {
    // the crest stands swept back, or lies along the back of the head as a small point (it is built standing)
    part = 3.; fe = i.n.xy / max(i.n.z, .01);
    let th = (1. - crest) * .75; let k = mix(.6, 1., crest); let dy = (l.y - (JAX + .178)) * k; let dz = (l.z - .34) * k;
    l = vec3f(l.x * k, JAX + .178 + dy * cos(th) + dz * sin(th), .34 + dz * cos(th) - dy * sin(th));
    n = normalize(vec3f(sign(l.x) * .5, .7, -.5));
  } else if (abs(code) > 25.) {
    // The wing. A feather's root lies cx out along the bones: the arm to the wrist, then the short hand. Spread,
    // the secondaries stand straight back from the arm and the primaries fan out from the hand to the wingtip,
    // and the wing beats about the shoulder, the hand lagging, so it bends at the wrist. Shut, the arm is drawn up
    // to the shoulder and the hand lies back along the flank: the secondaries cover the flank, the primaries
    // reach back under them to cross over the tail's root. wp2: a place in the wing's own plane (out, back)
    part = 1.; fe = i.n.xy / max(i.n.z, .01);
    let side = sign(code); let cx = (abs(code) - 26.) / 101. * F.wl; let hand = step(F.wr + .005, cx); let s = spread;
    let dist = max(F.sh.y - l.z, 0.); let lat = abs(l.x) - F.sh.x - cx; let lift = l.y - (F.ax + .07);
    let aA = (1. - s) * .5; let aH = aA + (1. - s) * 1.05; let armK = mix(.22, 1., s);
    let armD = vec2f(cos(aA), sin(aA)); let handD = vec2f(cos(aH), sin(aH));
    let wrist = armD * (F.wr * armK);
    let bone = mix(armD * (cx * armK), wrist + handD * (cx - F.wr), hand);
    let aF = mix(1.5 + .06 * hand, mix(1.5, mix(1.5, .28, ss(F.wr + .005, F.fe, cx)), hand), s);
    let wp2 = bone + vec2f(cos(aF), sin(aF)) * dist + vec2f(sin(aF), -cos(aF)) * lat;
    let a1 = (sin(ph) * F.beat.x + F.beat.w) * s; let a2 = (sin(ph - F.beat.z) * F.beat.y + .05) * s;
    let reach = max(wp2.x, 0.); let inner = min(reach, wrist.x);
    let beat = vec2f(inner * cos(a1) + (reach - inner) * cos(a2), inner * sin(a1) + (reach - inner) * sin(a2));
    let openP = vec3f(side * (F.sh.x + beat.x), F.ax + .07 + lift + beat.y, F.sh.y - wp2.y);
    let bk = wp2.y * F.fold; // (a long wing folds closer: a raven's tips reach most of the way down its tail)
    let shutP = vec3f(side * (mix(F.flank.x, F.flank.y, ss(F.flank.z, F.flank.w, bk)) + .12 * reach + lift), F.ax + mix(.08, .085, ss(.1, .4, bk)) - .85 * reach * (1. - .85 * ss(.15, .4, bk)), F.sh.y - .01 - bk);
    l = mix(shutP, openP, s);
    n = normalize(mix(vec3f(side, .35, 0.), vec3f(-side * sin(a1) * .8, 1., 0.), s));
  } else if (abs(code) > 2. && abs(code) < 12.) {
    // a tail feather turns about the tail's root, the further out the more: hardly at all shut, wide when fanned
    part = 2.; fe = i.n.xy / max(i.n.z, .01);
    let phi = sign(code) * (abs(code) - 3.) * .5 * (F.fan.x + F.fan.y * fan); let rz = l.z - F.tr;
    l = vec3f(l.x * cos(phi) - rz * sin(phi), l.y, F.tr + l.x * sin(phi) + rz * cos(phi));
    n = vec3f(0., 1., 0.);
  } else if (code < -21. && code > -23.) {
    // a raven's throat hackle: it hangs as built, lit as the throat it lies over; ruffled, its tip stands out
    part = 7.; fe = i.n.xy / max(i.n.z, .01);
    l += normalize(vec3f(l.x * 6., -.2, .8)) * ruffle * .03 * sat(fe.y);
    n = normalize(vec3f(l.x * 9., -.55, .6));
  } else if (code < -13.) {
    part = select(4., 5., code < -17.);
    if (part < 4.5) {
      let fc = vec3f(sign(l.x) * F.foot, .012, 0.);
      if (code < -15.) {
        // the toes close down round what the foot stands on
        let off = l.xz - fc.xz; let r = length(off);
        l = vec3f(fc.x + off.x * (1. - .3 * toes), l.y - toes * r * r * 16., fc.z + off.y * (1. - .3 * toes));
      }
      // the foot and the shank stay as they stand while the body pitches up over them
      let un = pitch * (1. - ss(.03, F.shank, l.y)); let ry = l.y - fc.y; let rz = l.z - fc.z;
      l = vec3f(l.x, fc.y + ry * cos(un) - rz * sin(un), fc.z + ry * sin(un) + rz * cos(un));
      // A raven walks: each foot planted while it is down as the body goes on over it, then swung forward through
      // the air. c.y on the ground: the stride's share in tenths in the whole part, where in the walk's cycle in the
      // fraction (the left foot half a cycle on from the right)
      if (F.stride > 0. && air < .5 && spread < .01) {
        let S = floor(i.c.y) / 10. * F.stride; let t = fract(i.c.y + select(0., .5, l.x < 0.));
        let dz = select(S * (.5 - 2. * t), S * (ss(.5, 1., t) - .5), t >= .5);
        let up = select(0., sin((t - .5) * 6.2832) * .3 * S, t >= .5);
        let wgt = 1. - ss(.05, F.shank + .06, l.y);
        l = vec3f(l.x, l.y + up * wgt, l.z + dz * wgt);
      }
      // (in the air the legs are drawn up under the tail, till they reach forward to land)
      l = mix(l, vec3f(l.x, F.ax - .08 + l.y * .12, l.z * .5 - .09), air * (1. - fwd));
    }
  }
  // ruffled, the body's feathers stand out from it
  if (part < .5) { let rad = normalize(vec2f(l.x, l.y - (F.ax + .03)) + vec2f(1e-5, 0.)); let puff = ruffle * .016 * ss(.3, .2, i.p.z); l = vec3f(l.x + rad.x * puff, l.y + rad.y * puff, l.z); }
  // the head turns, nods and cocks on the neck: bill, eyes and crest with it
  let hw = ss(F.head.x, F.head.y, i.p.z) * select(step(part, 5.5), 1., part > 6.5); let pv = vec3f(0., F.ax + F.head.z, F.head.w);
  let hk = -hw * turn * 1.3; let hp2 = hw * hpitch; let hr = hw * cock;
  var r3 = l - pv;
  r3 = vec3f(r3.x * cos(hr) - r3.y * sin(hr), r3.x * sin(hr) + r3.y * cos(hr), r3.z);
  r3 = vec3f(r3.x, r3.y * cos(hp2) + r3.z * sin(hp2), r3.z * cos(hp2) - r3.y * sin(hp2));
  r3 = vec3f(r3.x * cos(hk) + r3.z * sin(hk), r3.y, r3.z * cos(hk) - r3.x * sin(hk));
  l = pv + r3;
  n = vec3f(n.x * cos(hk) + n.z * sin(hk), n.y, n.z * cos(hk) - n.x * sin(hk));
  let w = i.a.xyz + qrot(i.q, l * i.a.w);
  o.cp = g.vp * vec4f(w, 1.); o.wp = w; o.n = qrot(i.q, n); o.op = i.p; o.part = part; o.fe = fe; o.open = spread;
  o.kind = select(0., 1., raven);
  o.lt = shadowV(w + vec3f(0., .04, 0.));
  return o;
}
@fragment fn fsJay(i: JV, @builtin(front_facing) ff: bool) -> @location(0) vec4f {
  let part = i32(i.part + .5); let p = i.op; let h = p.y - JAX; let u = i.fe.x; let v = i.fe.y;
  let feathery = part == 1 || part == 2 || part == 3 || part == 7;
  var n = normalize(i.n); if (!feathery) { n = n * select(-1., 1., ff); }
  let V = normalize(g.cam.xyz - i.wp); let L = g.sun.xyz;
  if (i.kind > .5) { return ravenC(i.op, i.fe, i.wp, i.lt, ff, part, n, V); }
  // A Steller's jay: the whole front of it sooty charcoal with a brown cast (head, crest, neck, breast, shoulders,
  // upper back), melting into a dusky grey-blue on the belly and the rump; only the wings and the tail a deeper
  // blue, barred finely with black; short pale streaks on the forehead, a faint pale arc over the eye
  let coal = vec3f(.19, .168, .152); let dusk = vec3f(.13, .21, .42); let wingB = vec3f(.06, .15, .48);
  let fluff = textureSampleLevel(tD, sR, p.zy * 2.3 + p.x * 1.7, 0.);
  var alb = vec3f(.02, .018, .017); var gloss = .08; var occ = 1.;
  if (part == 0) {
    // (the charcoal ends at the shoulders and the middle of the breast; the rump is the clearest blue)
    let dark = ss(.1, .26, p.z + h * .2);
    alb = mix(mix(dusk, vec3f(.09, .2, .55), ss(0., -.12, p.z)) * (1. + .25 * ss(0., -.1, h)), coal, dark) * (.7 + .6 * fluff.a);
    alb = mix(alb, vec3f(.3, .42, .62), ss(.385, .395, p.z) * ss(.42, .41, p.z) * ss(.13, .15, h) * ss(.035, .025, abs(p.x)) * ss(.5, .8, fract(abs(p.x) * 110. + .25)) * .7);
    let ed = length(vec2f(p.z - .365, h - .125));
    alb = mix(alb, vec3f(.2, .22, .26), ss(.022, .027, ed) * ss(.038, .03, ed) * ss(0., .012, h - .125) * step(.05, abs(p.x)) * .6);
    let bill = ss(.412, .42, p.z); alb = mix(alb, vec3f(.018, .017, .016), bill); gloss = mix(.08, .35, bill);
    occ = mix(.65, 1., ss(-.14, -.02, h)); // (the belly's underside lies in the bird's own shade)
  } else if (part == 1 || part == 2) {
    // A flight feather: fine black bars close together across the vane, a dark shaft, the edge its neighbour
    // covers darker (laid like tiles), the tip dusky. The coverts (v under 0): charcoal at the shoulder, then a
    // panel of blue. From below, spread, all of it a dull grey
    let bars = 1. - .8 * ss(.5, .3, abs(fract(v * mix(13., 16., f32(part == 2))) - .5) * 2.) * ss(.1, .25, v);
    let web = mix(.5, 1., ss(-1., -.35, u)) * (1. - .5 * ss(.07, 0., abs(u)) * step(0., v));
    let quill = wingB * mix(1., .85, f32(part == 2)) * bars * web * mix(1., .55, ss(.8, 1., v));
    let covert = mix(coal, wingB * .8, ss(-.28, -.14, v)) * (.75 + .5 * fluff.a);
    alb = mix(quill, covert, step(v, -.05));
    alb = mix(alb, vec3f(.11, .12, .15), f32(!ff) * .8 * f32(part == 2 || i.open > .5));
    gloss = .3;
  } else if (part == 3) {
    alb = coal * (.75 + .5 * fluff.a) * (.75 + .25 * ss(1., .3, abs(u)));
  } else if (part == 5) { alb = vec3f(.004); gloss = 1.; }
  else if (part == 6) { alb = vec3f(.1, .085, .07) * (.7 + .6 * fluff.a); occ = mix(.4, 1., ss(.1, .5, abs(p.z))); } // (dark under the bird)
  // It takes the scene's light: the sun where it reaches it, the sky's by the way a face looks; a sheen only in
  // the sun, the sky's glint in the eye, and a thin rim of sky light along its upper outline
  let E = sunE() * i.lt; let sky = vol(i.wp).g; let up = vec3f(0., 1., 0.);
  var c = alb * (E * sat(dot(n, L)) + amb(n, sky) * occ * 1.5);
  c += E * pow(sat(dot(n, normalize(L + V))), mix(20., 90., f32(part == 5))) * gloss * .5;
  c += amb(up, sky) * f32(part == 5) * pow(sat(dot(n, normalize(up + V))), 40.) * 1.2;
  c += amb(up, sky) * alb * pow(1. - sat(dot(n, V)), 3.) * .45 * sat(n.y + .3);
  return fin(fog(c, i.wp));
}
// A common raven: black, never a hole. True black with a hint of blue whose form is read in its gloss: the sky
// mirrored grey in every plane, so each has its own tone even in shade; on the crown, the back, the coverts and the
// throat, where sun or open sky strikes them, a blue-violet sheen; the flight feathers and the underside matte, the
// folded wing's rows of feather edges faintly paler; a pale sheen along the bill's ridge, a glint in the eye, a
// thin rim of sky light. Lit, shadowed and fogged as all else is
fn ravenC(p: vec3f, fe: vec2f, wp: vec3f, lt: f32, ff: bool, part: i32, n0: vec3f, V: vec3f) -> vec4f {
  let h = p.y - RAX; let u = fe.x; let v = fe.y; let L = g.sun.xyz;
  let fluff = textureSampleLevel(tD, sR, p.zy * 2.3 + p.x * 1.7, 0.);
  let n = select(n0, -n0, !ff && (part == 1 || part == 2 || part == 7)); // (a feather seen from under is lit from under)
  var alb = vec3f(.024, .024, .026) * (.8 + .4 * fluff.a); var gl = .55; var occ = 1.;
  var tint = 0.; // (how much of the gloss is the blue-violet sheen)
  if (part == 0) {
    // (the crown, the back and the throat glossiest and tinted, the belly least; the bill dull, but for its ridge)
    gl = mix(.25, .75, ss(-.07, .06, h)); tint = ss(-.02, .08, h);
    let bill = ss(.372, .378, p.z); alb = mix(alb, vec3f(.022), bill);
    gl = mix(gl, mix(.2, 1.1, ss(.55, .9, n.y)), bill); tint *= 1. - bill;
    occ = mix(.55, 1., ss(-.16, -.02, h));
  } else if (part == 1 || part == 2) {
    // a flight feather matte, paler along the edge that lies over the next; the coverts glossy
    let edge = ss(.45, .95, abs(u)) * step(0., v); let covert = f32(v < -.05);
    alb = vec3f(.022, .022, .024) * (1. + 2.2 * edge) * mix(1., .75, ss(.8, 1., v));
    gl = mix(.25 + .35 * edge, .8, covert); tint = covert;
    if (part == 2) { gl = .45; tint = .3; }
    if (!ff) { alb = vec3f(.04, .04, .042); gl = .15; tint = 0.; }
  } else if (part == 7) { alb *= .8 + .4 * ss(.2, .9, v); gl = .75; tint = 1.; }
  else if (part == 4) { alb = vec3f(.028); gl = .25; }
  else if (part == 5) { alb = vec3f(.01, .007, .006); gl = 1.; }
  let E = sunE() * lt; let sky = vol(wp).g; let up = vec3f(0., 1., 0.);
  let nv = sat(dot(n, V)); let R = reflect(-V, n);
  // (the light on black near grey: only the tinted gloss takes the sky's blue, blue face on, violet at a glance)
  let a = amb(n, sky); let ag = mix(vec3f(dot(a, vec3f(.3, .5, .2))), a, .35);
  let m = amb(R, sky); let ml = dot(m, vec3f(.3, .5, .2)); let mg = mix(vec3f(ml), m, .2);
  let sheen = mix(vec3f(.62, .52, .92), vec3f(.52, .6, .92), nv);
  // (the sheen only where bright sky is mirrored: in deep shade the gloss is grey)
  let env = mix(mg, m * sheen * 1.25, tint * ss(.15, .45, ml)) * occ * (.16 + .84 * pow(1. - nv, 2.5));
  var c = alb * (E * sat(dot(n, L)) + ag * occ * 1.5);
  c += gl * (env * .27 + mix(vec3f(.8), sheen, tint) * E * pow(sat(dot(n, normalize(L + V))), 14.) * ss(0., .2, dot(n, L)) * .2);
  c += amb(up, sky) * f32(part == 5) * pow(sat(dot(n, normalize(up + V))), 40.) * 1.2;
  c += dot(amb(up, sky), vec3f(.3, .5, .2)) * vec3f(.06) * pow(1. - nv, 3.) * sat(n.y + .3);
  return fin(fog(c, wp));
}
@fragment fn fsManta(i: VO, @builtin(front_facing) ff: bool) -> @location(0) vec4f {
  let n = normalize(i.n) * select(-1., 1., ff); let L = g.sun.xyz;
  // dark above and browner below, black wing tips, and a white head and tail on those with a high seed (eagles)
  var alb = mix(vec3f(.16, .12, .09), vec3f(.05, .045, .04), ss(-.2, .25, n.y));
  alb = mix(alb, vec3f(.02), ss(.7, .95, abs(i.op.x)));
  alb = mix(alb, vec3f(.78, .75, .68), max(ss(.26, .32, i.op.z), ss(-.34, -.42, i.op.z)) * step(.5, i.sd) * step(abs(i.op.x), .12));
  let c = alb * (sunE() * (.3 + .7 * sat(dot(n, L))) + amb(n, 1.) * 1.4);
  return fin(fog(c, i.wp));
}
`;

// ---------------------------------------------------------------- the lake's surface, and the sky behind everything
export const W_SURF =
  S_B +
  /*wgsl*/ `
struct VO { @builtin(position) cp: vec4f, @location(0) wp: vec3f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  var o: VO;
  let p = vec2f(f32(i & 1u), f32(i >> 1u)) * 2. - 1.;
  o.wp = vec3f(g.cam.x + p.x * 900., 0., g.cam.z + p.y * 900.);
  o.cp = g.vp * vec4f(o.wp, 1.);
  return o;
}
// What stands over the water along a mirrored ray, read from the light volume at a few distances: x how much of
// the ray it stops (the bank and its trees, crowns hanging over the water), y how far off that is, in metres
fn mirror(p: vec3f, R: vec3f) -> vec2f {
  var clear = 1.; var far = 0.;
  for (var k = 0; k < ${MEDIUM ? 6 : 4}; k++) {
    let t = 2.2 * exp2(f32(k) * ${MEDIUM ? '.8' : '1.25'});
    let v = vol(p + R * t);
    let b = max(ss(.75, .3, v.g), ss(.52, .46, v.r)) * clear;
    far += b * t; clear -= b;
  }
  return vec2f(1. - clear, far / max(1. - clear, 1e-3));
}
// The water plane at y 0, blended over the lake's bed (premultiplied): clear at the shore, a mirror at a low angle.
// Calm glassy patches lie between lanes the wind ruffles; it mirrors the sky's gradient and what stands on the
// bank; it laps on the shore; fallen leaves float near the bank
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let v = i.wp - g.cam.xyz; let d = length(v); let V = v / d; let t = g.cam.w;
  // the lanes: long along the wind, drifting slowly
  let lane = textureSample(tW, sR, vec2f(i.wp.x * .021 + i.wp.z * .006, i.wp.z * .0065 - i.wp.x * .002) + t * vec2f(.003, .001)).r;
  // (in the rain it is ruffled all over)
  let ruf = max(ss(.38, .62, lane + (textureSample(tW, sR, i.wp.xz * .09).r - .5) * .25), sat(g.wx.z * 1.6) * .7);
  // (small wavelets, two sizes drifting across each other; all but still on a calm patch)
  var s = (textureSample(tW, sR, i.wp.xz / 3.7 + t * vec2f(.012, .008)).ba + textureSample(tW, sR, i.wp.zx / 1.3 + .2 - t * vec2f(.02, .006)).ba * .7 - .85) * ss(220., 40., d) * (.035 + .08 * g.wx.y) * (.12 + 1.3 * ruf);
  // rain: rings where the drops fall, near the walker; further off the whole surface is finely stippled
  var rg = vec3f(0.);
  if (g.wx.z > .01) {
    rg = rings(i.wp.xz * 3.2, t) * (sat(g.wx.z * 2.5) * ss(26., 6., d));
    let st = textureSample(tW, sR, i.wp.xz * .9 + t * vec2f(.13, .21)).ba + textureSample(tW, sR, i.wp.zx * 1.7 - t * vec2f(.17, .11)).ba - 1.;
    s += rg.xy * .3 + st * (.1 * sat(g.wx.z * 2.) * ss(120., 10., d));
  }
  let N = normalize(vec3f(-s.x, 1., -s.y));
  let R0 = reflect(V, N); let R = normalize(vec3f(R0.x, abs(R0.y) + .02, R0.z));
  // (a ruffled lane mirrors less than a calm patch: its small faces turn every way, and it shows darker)
  let fr = (.03 + .97 * pow(1. - sat(dot(-V, N)), 5.)) * (1. - .5 * ruf);
  // What it mirrors: the sky, paler toward the horizon as the sky pass draws it, and a faint band of forest over
  // the far shore; the sun's path where the sun reaches; and over all of that whatever stands on the bank near
  // by (mirror), dark, fading into the fog with its distance
  var refl = mix(skyC(R), hazeC(R), exp(-R.y * 1.6) * sat(g.wx.w * 60.)) * .85;
  let band = ss(.13, .05, R.y + (textureSampleLevel(tD, sR, vec2f(atan2(R.z, R.x) / TAU * 4., .3), 0.).a - .5) * .08);
  refl = mix(refl, vec3f(.10, .09, .07) * (.25 + .45 * (1. - g.sun.w)), band * .3);
  let mr = mirror(i.wp, R);
  refl = mix(refl, mix(hazeC(R), vec3f(.045, .055, .035) * (.6 + .5 * (1. - g.sun.w)), hazeT(mr.y, 0., 0.)), mr.x);
  let sd = max(dot(R, g.sun.xyz), 0.);
  refl += sunE() * shadow1(i.wp) * (pow(sd, 90.) * .5 + pow(sd, 900.) * 6.) * (1. - mr.x);
  // metres of water over the bed (the ground's height from the stream map: finer than the ground map's 8 bits),
  // a little more and less as it laps on the shore
  let gh = groundAt(i.wp);
  let lapN = textureSample(tW, sR, i.wp.xz * .23).r;
  let depth = -gh + .012 * sin(t * 1.3 + lapN * 12.);
  var a = sat(fr + ss(0., 1.6, depth) * .82) * ss(0., .02, depth);
  var c = mix(vec3f(.02, .05, .045) * (.35 + .65 * (1. - g.sun.w)), refl, fr);
  // a drop's splash: a pale dot for a moment
  c += hazeC(vec3f(0., 1., 0.)) * rg.z * .35;
  // the edge of the lapping water: a thin pale line
  c += hazeC(vec3f(0., 1., 0.)) * .25 * ss(.03, .012, depth);
  // Fallen leaves floating near the bank, in drifts, bare water between: each of its own dull brown or gold
  let near = ss(1.1, .15, depth) * ss(60., 20., d);
  let drift = ss(.42, .6, textureSample(tW, sR, i.wp.xz * .045 + 3.7).r) * near;
  let lq = i.wp.xz + t * vec2f(.006, .003);
  let la = leafAt(lq * 3.4 + 5.); let lb = leafAt(lq * 6.7 + 9.);
  let lf = select(lb, la, la.x * step(.62, la.y) > .5);
  let leaf = max(la.x * step(.62, la.y), lb.x * step(.55, lb.y)) * drift;
  let leafC = mix(mix(vec3f(.20, .12, .05), vec3f(.42, .29, .07), fract(lf.z * 5.3)), folC(2, fract(lf.z * 3.7), .5), step(.8, fract(lf.z * 9.1)));
  c = mix(c, leafC * (amb(vec3f(0., 1., 0.), 1.) + sunE() * shadow1(i.wp) * g.sun.y) * (.7 + .7 * lf.z), leaf * .9); a = max(a, leaf * .9 * ss(0., .02, depth));
  c = fog(c, i.wp);
  return vec4f(min(max(c * a, vec3f(0.)), vec3f(40.)), a);
}
// behind everything: the sky, its clouds and a far line of mountains
@vertex fn vsB(@builtin(vertex_index) i: u32) -> VO {
  var o: VO;
  let p = vec2f(f32(i & 1u), f32(i >> 1u)) * 2. - 1.;
  o.wp = g.cam.xyz + g.fwd.xyz + g.right.xyz * (p.x * g.right.w) + g.up.xyz * (p.y * g.up.w);
  o.cp = vec4f(p, 1e-7, 1.);
  return o;
}
@fragment fn fsB(i: VO) -> @location(0) vec4f {
  let rd = normalize(i.wp - g.cam.xyz); let o = g.sun.w; let t = g.cam.w;
  // (debug.isolate, shaded: behind its tree the fog's own colour, as if all else stood deep in it)
  if (g.dbg.w > 1.5) { return fin(fogC(rd)); }
  let mu = max(dot(rd, g.sun.xyz), 0.);
  var c = skyC(rd) + sunE() * ss(.9994, .9998, mu) * 6.;
  // clouds: two layers of noise drifting on a flat ceiling, lit from below by the low sun, a grey lid in the rain
  let cu = rd.xz / (max(rd.y, .02) + .12);
  let n1 = textureSampleLevel(tD, sR, cu * .06 + vec2f(t * .0016, 0.), 0.).a; let n2 = textureSampleLevel(tD, sR, cu * .17 - vec2f(0., t * .003), 0.).b;
  let cov = mix(.62, .18, o);
  let cl = ss(cov, cov + .22, n1 * .65 + n2 * .35) * ss(.0, .12, rd.y);
  let lit = mix(vec3f(1.1, .58, .34) + vec3f(1.2, .5, .1) * pow(mu, 3.), vec3f(.30, .31, .33), o);
  c = mix(c, mix(mix(vec3f(.42, .30, .34), vec3f(.20, .21, .23), o), lit, ss(.0, .5, n2)), cl * mix(.85, 1., o));
  // (in mist there are no separate clouds: the pale sky itself, mottled a little by them)
  let misty = sat(o * 3.) * (1. - sat(g.wx.z * 1.2));
  c = mix(c, skyC(rd) + sunE() * ss(.9994, .9998, mu) * 6., misty);
  // Under rain cloud the sky is in layers, long and level, darker and paler, drifting slowly; under a storm heavy
  // dark masses with paler rifts between them
  // (three reads of the noise, each turned its own way: one alone shows its square cells)
  let lq = cu * vec2f(.021, .075);
  let l1 = smoothD(vec2f(lq.x * .94 - lq.y * .34, lq.x * .34 + lq.y * .94) + vec2f(t * .0012, 0.), 3.).a;
  let l2 = smoothD(vec2f(lq.x * .5 + lq.y * .87, lq.y * .5 - lq.x * .87) * 1.7 + .37, 3.).a;
  let l3 = smoothD(vec2f(lq.x * .26 - lq.y * .97, lq.x * .97 + lq.y * .26) * 2.9 - vec2f(t * .002, .3), 2.).b;
  let lay = sat(.5 + (l1 + l2 + l3 - 1.5) * 1.5);
  c *= mix(1., mix(.55 + .9 * lay, .3 + 1.5 * lay * lay, g.st.x), sat(g.wx.z * 2.) * ss(.02, .2, rd.y));
  // Lightning, inside the cloud and never down by the horizon. fl: where it is and how bright now; st.z its kind:
  // 0 a blotch of cloud lit from within, 1 sheet lightning, 2 a bolt (its channels are drawn on top: vsBolt), the
  // cloud glowing warm round its root. The nearer cloud (lump) stands dark in front of the light
  if (g.fl.w > 0.) {
    let fd = g.fl.xyz; let sd = g.st.w; let lump = (.3 + 1.3 * lay) * (1. - .6 * ss(.5, .62, l2));
    let a2 = 1. - dot(rd, fd); // (about half the angle from it, squared)
    var lit = 0.;
    if (g.st.z < .5) { lit = (exp(-a2 / .02) * 1.2 + exp(-a2 / .14) * .4) * lump; }
    else if (g.st.z < 1.5) { lit = (exp(-a2 / .45) * .6 + exp(-a2 / .07) * .35) * lump; }
    else {
      // (round a bolt's root only: about a quarter of the frame across, and little beyond it)
      let e1 = normalize(cross(vec3f(0., 1., 0.), fd)); let e2 = cross(fd, e1);
      lit = (exp(-a2 / .007) * .9 + exp(-a2 / .035) * .3) * lump * (.3 + .7 * g.st.w) * (1. - .85 * puff(vec2f(dot(rd, e1), dot(rd, e2)) / max(dot(rd, fd), .05)));
    }
    // (pale violet-white, warm round a bolt's root; nothing of it under about five degrees up)
    let warm = exp(-a2 / .012) * step(1.5, g.st.z);
    c += mix(mix(vec3f(.74, .64, 1.), vec3f(.62, .45, 1.), step(1.5, g.st.z)), vec3f(1.3, .55, .3), warm) * lit * ss(0., .12, rd.y) * g.fl.w;
  }
  let az = atan2(rd.z, rd.x) / TAU;
  let ridge = .05 + .06 * textureSampleLevel(tD, sR, vec2f(az, .4), 0.).a + .03 * textureSampleLevel(tD, sR, vec2f(az * 3., .7), 0.).b;
  c = mix(c, mix(hazeC(rd), vec3f(.10, .12, .18), .35), ss(ridge, ridge - .012, rd.y));
  // nearer than the mountains, low over the far shore and all but lost in the fog: a line of trees, the conifers'
  // tops standing out of it
  let tn = textureSampleLevel(tD, sR, vec2f(az * 37., .23), 0.);
  let tops = .012 + .022 * tn.a + .02 * pow(1. - abs(fract(az * 310. + tn.b * 2.) - .5) * 2., 3.) * ss(.35, .7, tn.b);
  c = mix(c, mix(hazeC(rd), vec3f(.07, .09, .08), .22), ss(tops, tops - .004, rd.y));
  // the fog lies over the sky too, thickest toward the horizon (thick fog hides all of it: fogC)
  // (in the rain it thins sooner with height: the cloud's dark base shows over a pale band at the horizon)
  c = mix(c, fogC(rd), mix(exp(-max(rd.y, 0.) * mix(1.6, 5., sat(g.wx.z * 2.))) * sat(g.wx.w * 60.), 1., g.st.y * .94));
  c *= 1. + ((ss(.3, .7, n1 * .65 + n2 * .35) - .5) * .3 + .22 * rd.y) * ss(.05, .4, rd.y) * misty;
  return fin(c);
}
`;

// ---------------------------------------------------------------- running water: the surface of the creek and the brook
// One mesh at the water's level (water.js bake), blended over its bed. p: place, metres across from the middle;
// a: metres to the water's edge (below 0 in it), metres along from the head, how white it runs, its own slope;
// t: the way it runs (x z)
export const W_STREAM =
  S_B +
  /*wgsl*/ `
struct VI { @location(0) p: vec4f, @location(1) a: vec4f, @location(2) t: vec2f };
struct VO { @builtin(position) cp: vec4f, @location(0) wp: vec3f, @location(1) a: vec4f, @location(2) t: vec3f };
@vertex fn vs(i: VI) -> VO {
  var o: VO;
  o.cp = g.vp * vec4f(i.p.xyz, 1.); o.wp = i.p.xyz; o.a = i.a; o.t = vec3f(i.t, i.p.w);
  return o;
}
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let e = i.a.x; let steep = i.a.z; let t = g.cam.w;
  let T = normalize(vec3f(i.t.x, 0., i.t.y)); let B = vec3f(-T.z, 0., T.x);
  let v = i.wp - g.cam.xyz; let d = length(v); let V = v / d;
  let uv = vec2f(i.a.y, i.t.z);
  // how fast it runs: 0 on a pool, 1 down a fall and just below it (water.js carries it on downstream), uneven
  // across the stream so a fall has a ragged lip
  let lipN = textureSample(tD, sR, uv * vec2f(.9, 2.6));
  let fast = ss(.03, .3, steep * (.1 + 1.9 * lipN.a));
  // ripples: two layers running downstream at their own speeds, longer along the flow than across; small on a
  // pool, strong on a run
  let r1 = textureSample(tW, sR, uv * vec2f(.15, .4) - vec2f(t * .12, 0.)).ba;
  let r2 = textureSample(tW, sR, uv * vec2f(.36, .85) - vec2f(t * .3, .37)).ba;
  var sl = (r1 + r2 * .7) * mix(.5, 3.2, fast) * ss(70., 10., d);
  // raindrops' rings on the pools and the slow runs
  var rg = vec3f(0.);
  if (g.wx.z > .01 && d < 22.) { rg = rings(i.wp.xz * 4.2, t) * (sat(g.wx.z * 2.5) * (1. - sat(fast * 2.5)) * ss(22., 6., d)); sl += rg.xy * 1.2; }
  let fu = uv + vec2f(0., .05 * sin(uv.x * 1.9 + uv.y * 2.3) + .03 * sin(uv.x * 4.3 - uv.y * 1.1));
  let f1 = textureSample(tD, sR, fu * vec2f(.5, .9) - vec2f(t * .5, 0.));
  let f2 = textureSample(tD, sR, fu * vec2f(1.4, 2.3) - vec2f(t * 1.1, .2));
  // N0: the surface's own tilt (it leans downstream where it falls). N: with the ripples, for how much it
  // mirrors. Nr: with the ripples' tilt doubled, for what it mirrors, so the mirror's outline breaks up along them
  let N0 = normalize(vec3f(0., 1., 0.) + T * i.a.w);
  let N = normalize(N0 - T * sl.x - B * sl.y); let Nr = normalize(N0 - T * sl.x * 2.5 - B * sl.y * 2.5);
  let R0 = reflect(V, Nr); let R = normalize(vec3f(R0.x, abs(R0.y) + .03, R0.z));
  // how much it mirrors: by the angle it is seen at, never all of it (running water is no pane of glass), and
  // unevenly, in patches that travel with it
  let fr = min(.05 + .95 * pow(1. - sat(dot(-V, N)), 5.), .7) * (.45 + .9 * f1.b) * (1. - .9 * ss(.03, .2, i.a.w * (.2 + 1.8 * lipN.b))); // (water that falls is torn, and mirrors nothing)
  // What it mirrors: the dark mass of the trees over it, of uneven tone; sky only where the light volume says the
  // mirrored ray gets well out between the crowns; low over the water the pale fog between the trunks, in upright
  // streaks; darker along the banks. (What lies under it is the ground shader's work)
  let vv = vol(i.wp + vec3f(0., 2.5, 0.));
  let n1 = textureSampleLevel(tD, sR, vec2f(atan2(R.z, R.x) / TAU * 16., R.y * .5 + .1), 0.);
  let out = min(vol(i.wp + R * 3.).g, vol(i.wp + R * 9.).g);
  let dark = mix(vec3f(.014, .018, .010), vec3f(.085, .06, .022), n1.a) * (.6 + .8 * n1.b);
  var refl = mix(dark, mix(skyC(R), hazeC(R), .6) * .8, ss(.55, .82, out + (n1.b - .5) * .6));
  refl = mix(refl, hazeC(R) * .8, ss(.3, .06, R.y) * (1. - ss(.47, .54, n1.b * .6 + n1.a * .45)) * .6) * (1. - .5 * ss(-.7, -.05, e));
  let E = sunE() * shadow1(i.wp);
  let sd = max(dot(R, g.sun.xyz), 0.);
  refl += E * (pow(sd, 80.) * .06 + pow(sd, mix(700., 120., sat(d / 30.))) * 8.);
  let lit = amb(vec3f(0., 1., 0.), vv.g) + E * .25;
  var c = refl * fr;
  var a = fr;
  // white water: ragged patches carried along where it breaks over a fall and for a metre below it; never quite
  // opaque, and no whiter than the light under the trees makes it
  // (it breaks in tongues, between the stones, not right across: long patches that stay where they are, wider
  // on a fall than on a run)
  let ln = textureSample(tD, sR, vec2f(uv.x * .07, uv.y * 1.1) + 3.3).b;
  let lanes = mix(ss(.44, .6, ln), ss(.34, .46, ln), ss(.5, .95, fast));
  let foot = ss(.25, .6, steep) * (1. - ss(.18, .42, i.a.w)); // (just below a fall: more of it breaks white)
  let white = ss(.66 - .1 * fast - .12 * foot, .78 - .1 * fast - .12 * foot, f1.b * .55 + f2.a * .5 + (f1.a - .5) * .6) * ss(.06, .5, fast) * ss(.05, -.3, e + (f1.a - .5) * .7) * ss(-.02, -.22, e) * .85 * lanes; // (none of it at the very banks)
  // Down a fall no white sheet: dark water sliding over the slope. The white gathers below the stones that
  // stand in it and at its foot (foamAt): soft ragged patches a few hands wide, their outline from a noise at two
  // scales that churns in place. By the place itself, not the stream's own measure, and none at the banks
  let slopeK = ss(.18, .42, i.a.w);
  let slide = slopeK * (.3 + .25 * f1.b);
  c = mix(c, vec3f(.03, .04, .034) * lit, slide); a = max(a, slide);
  let fm = foamAt(i.wp);
  let churn = textureSample(tD, sR, i.wp.xz * 1.1 + vec2f(t * .3, 0.)).a * .55 + textureSample(tD, sR, i.wp.xz * 2.9 - vec2f(0., t * .45)).b * .45;
  let gathered = ss(.9 - .6 * fm, 1.1 - .6 * fm, churn) * ss(.22, .5, fm) * ss(-.02, -.22, e) * .8;
  let torn = max(white * (1. - slopeK), gathered);
  c = mix(c, vec3f(.72, .74, .70) * (amb(vec3f(0., 1., 0.), vv.g) + E * .5) * (.55 + .45 * f2.b), torn); a = max(a, torn);
  // What shows a clear shallow run to be water: the light on the faces of its ripples that tilt toward the
  // sky. Soft, of uneven width, mostly dim; bright only where the mirrored ray gets out between the crowns
  let tiltK = ss(.1, .34, r1.x + r2.x * .7) * ss(30., 6., d) * (1. - white) * ss(.1, -.2, e);
  let glow = tiltK * (.05 + .3 * ss(.5, .85, out)) * (.5 + .8 * f1.b) * (.3 + .7 * lanes) * (1. - .9 * slopeK);
  c += mix(skyC(R), hazeC(R), .6) * (glow + rg.z * .3); a = max(a, max(glow, rg.z * .3));
  // Fallen leaves lying on the pools: in drifts where a noise says the water idles, thickest along the banks,
  // bare water between; of two sizes, each leaf of its own dull brown or gold and a few still bright; none on
  // fast water. Each throws a little shadow to one side, onto the bed under it: it lies on a surface
  let drift = ss(.5, .62, textureSample(tD, sR, uv * vec2f(.11, .3) + 7.3).a + .16 * ss(-.5, -.05, e)) * (1. - sat(fast * 3.)) * (1. - white) * ss(40., 14., d);
  let lq = vec2f(uv.x - t * .04, uv.y);
  let la = leafAt(lq * 4.3 + 11.); let lb = leafAt(lq * 8.5 + 3.); let ls = leafAt(lq * 4.3 + 11. + vec2f(.2, .16));
  let lf = select(lb, la, la.x * step(.6, la.y) > .5);
  let leaf = max(la.x * step(.6, la.y), lb.x * step(.5, lb.y)) * drift;
  let shade = ls.x * step(.6, ls.y) * drift * (1. - leaf) * .45;
  c *= 1. - shade; a = max(a, shade);
  let leafC = mix(mix(vec3f(.20, .12, .05), vec3f(.42, .29, .07), fract(lf.z * 5.3)), folC(2, fract(lf.z * 3.7), .5), step(.8, fract(lf.z * 9.1)));
  c = mix(c, leafC * lit * (.7 + .7 * lf.z), leaf * .9); a = max(a, leaf * .9);
  // (its mesh reaches into the bank, so the ground cuts the waterline where it really rises; where a bank lies
  // too low for that, by a bridge, the mesh's own rim fades out raggedly)
  let k = ss(.36, .04, e + (f1.a - .5) * .5) * ss(.3, .25, textureSample(tM, sC, i.wp.xz / ${MAPW} + .5).b);
  let col = fog(c / max(a, 1e-3), i.wp);
  return vec4f(min(max(col * a * k, vec3f(0.)), vec3f(40.)), a * k);
}
`;

// ---------------------------------------------------------------- sprites: dust in the light, rain, falling leaves
// each is drawn from the same buffer of random vec4s, wrapped into a box that follows the camera
export const W_SPR =
  S_B +
  /*wgsl*/ `
struct VO { @builtin(position) cp: vec4f, @location(0) uv: vec2f, @location(1) @interpolate(flat) pr: vec4f, @location(2) wp: vec3f,
  @location(3) @interpolate(flat) col: vec3f };
// (What the wind carries goes by g.wy.x, the distance it has blown so far. Never by the wind's speed times the
// time: as the wind changes that product runs away)
fn quad(i: u32) -> vec2f { return vec2f(f32(i & 1u), f32(i >> 1u)) * 2. - 1.; }
@vertex fn vsSnow(@builtin(vertex_index) vi: u32, @location(0) a: vec4f) -> VO {
  var o: VO; let q = quad(vi); let t = g.cam.w;
  let B = 30.;
  var p = a.xyz * B + vec3f(.12, .03, .08) * (t + 2. * g.wy.x) + .5 * vec3f(sin(t * .3 + a.x * 60.), sin(t * .23 + a.y * 50.), cos(t * .27 + a.z * 70.));
  p = g.cam.xyz + (fract((p - g.cam.xyz) / B + .5) - .5) * B;
  let d = length(p - g.cam.xyz);
  let sz = (.006 + .02 * a.w * a.w * a.w);
  let w = p + (g.right.xyz * q.x + g.up.xyz * q.y) * max(sz, d * .0011);
  o.cp = g.vp * vec4f(w, 1.); o.uv = q; o.wp = p;
  let fade = ss(B * .5, B * .32, d) * ss(.6, 2.5, d) * min(1., sz / (d * .0011));
  let tw = .6 + .4 * sin(t * (1. + a.w * 2.) + a.x * 100.);
  o.pr = vec4f(fade * tw, shadowV(p), a.w, d);
  return o;
}
// dust and midges: they show only where the sun falls on them, and not in the rain or in thick fog
@fragment fn fsSnow(i: VO) -> @location(0) vec4f {
  let r = length(i.uv);
  let m = ss(1., .2, r);
  let c = sunE() * i.pr.y * mix(vec3f(1., .8, .5), vec3f(1., .95, .8), i.pr.z) * .45;
  return vec4f(min(max(c * m * m * i.pr.x * (1. - sat(g.wx.z * 4.)) * (1. - g.st.y), vec3f(0.)), vec3f(8.)), 0.);
}
// Rain. A drop shows the sky's light, so a streak is the fog's own colour blended over what is behind it: pale
// on dark trunks and shade, gone against the fog and the sky. A flash of lightning lights it up
// (a little paler than the fog, more so under a storm's dark fog: heavy rain is a pale hatch)
fn rainC() -> vec3f { return hazeC(vec3f(0., .7, 0.)) * (1.5 + 1.1 * g.st.x) + flashL(vec3f(0., 1., 0.)) * .1; }
// how much of the rain gets down to a place: all of it in the open, a quarter under the crowns
fn rainAt(p: vec3f) -> f32 { return mix(.25, 1., ss(.22, .62, vol(p).g)); }
// The streaks near the walker: drops in a box of 14 m round them, each drawn as long as it falls in a twentieth of
// a second, leaning a little with the wind, never thinner than a pixel (and fainter for it). In light rain only
// some of them fall: single long streaks; in a shower all, a hatch
@vertex fn vsRain(@builtin(vertex_index) vi: u32, @location(0) a: vec4f) -> VO {
  var o: VO; let q = quad(vi); let t = g.cam.w;
  let B = 14.;
  let fast = .85 + .3 * a.w;
  var p = a.xyz * B + vec3f(g.wy.x * 1.6, -9.5 * t, g.wy.x * .8) * fast;
  p = g.cam.xyz + (fract((p - g.cam.xyz) / B + .5) - .5) * B;
  // (drawn along the way it falls as the walker sees it: walking into the rain it leans toward them)
  let vd = normalize(vec3f(g.wx.y * 1.6, -9.5, g.wx.y * .8) * fast - vec3f(g.wy.z, 0., g.wy.w)); let d = length(p - g.cam.xyz);
  let across = normalize(cross(vd, p - g.cam.xyz));
  let wd = max(.0018, d * .0016);
  let w = p + vd * q.y * (.24 + .16 * a.w) + across * q.x * wd;
  o.cp = g.vp * vec4f(w, 1.); o.uv = q; o.wp = p;
  let falls = ss(a.w * .9, a.w * .9 + .12, g.wx.z);
  o.pr = vec4f(ss(B * .5, B * .34, d) * ss(.7, 2.2, d) * falls * rainAt(p) * min(1., .006 / wd), 0., a.w, d);
  o.col = rainC();
  return o;
}
@fragment fn fsRain(i: VO) -> @location(0) vec4f {
  let a = min((1. - abs(i.uv.x)) * (1. - i.uv.y * i.uv.y) * i.pr.x * (1. + .15 * g.fl.w), 1.);
  return vec4f(i.col * a, a);
}
// Drips under the crowns: big slow drops let go by the wet boughs, few, each a short bright dash. They fall where
// little sky is seen, while it rains and for as long as the leaves stay wet after
@vertex fn vsDrip(@builtin(vertex_index) vi: u32, @location(0) a: vec4f) -> VO {
  var o: VO; let q = quad(vi); let t = g.cam.w;
  let B = vec3f(13., 9., 13.);
  var p = a.xyz * B + vec3f(0., -t * (3.6 + 1.6 * a.w), 0.);
  let mid = g.cam.xyz + vec3f(0., 2.5, 0.);
  p = mid + (fract((p - mid) / B + .5) - .5) * B;
  let d = length(p - g.cam.xyz);
  let across = normalize(cross(vec3f(0., 1., 0.), p - g.cam.xyz));
  let w = p + vec3f(0., q.y * .07, 0.) + across * q.x * max(.006, d * .0016);
  o.cp = g.vp * vec4f(w, 1.); o.uv = q; o.wp = p;
  let under = ss(.55, .25, vol(p + vec3f(0., 1.5, 0.)).g) * step(groundAt(p), p.y);
  o.pr = vec4f(ss(B.x * .5, B.x * .36, d) * ss(.8, 2., d) * under * max(sat(g.wx.z * 2.5), g.wx.x * .7), 0., a.w, d);
  o.col = rainC() * 1.3;
  return o;
}
// The rain further off: two upright sheets round the walker, 8 and 19 m out, with streaks running down them in
// columns (each column its own speed, each streak there or not by the rain's strength). Their place is fixed by the
// compass, not by where the walker looks; what stands nearer hides them, and beyond them the fog is the veil
struct RO { @builtin(position) cp: vec4f, @location(0) wp: vec3f, @location(1) @interpolate(flat) lay: f32, @location(2) @interpolate(flat) col: vec3f };
@vertex fn vsVeil(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> RO {
  var o: RO;
  let a = f32(vi >> 1u) / 20. * TAU; let R = select(8., 19., ii == 1u);
  let p = vec3f(g.cam.x + cos(a) * R, g.cam.y + (f32(vi & 1u) * 2. - 1.) * 11., g.cam.z + sin(a) * R);
  o.cp = g.vp * vec4f(p, 1.); o.wp = p; o.lay = f32(ii); o.col = rainC();
  return o;
}
@fragment fn fsVeil(i: RO) -> @location(0) vec4f {
  let v = i.wp - g.cam.xyz; let t = g.cam.w; let far = i.lay > .5;
  let w = select(.04, .085, far); // a column's width in metres: about three pixels on a phone
  let u = (atan2(v.z, v.x) * length(v.xz) + v.y * g.wx.y * .16) / w; // (the columns lean with the wind)
  let c = floor(u); let h = hs(c * .37 + i.lay * 5.3); let h2 = hs(c * 1.31 + 7.7);
  let L = select(2., 2.6, far);
  let yy = (i.wp.y + t * (8. + 3. * h)) / L + h2 * 31.;
  let on = step(hs(floor(yy) * 3.7 + c * 1.9 + 2.3), g.wx.z * select(.55, .9, far));
  let along = sin(3.14159 * sat(fract(yy) / select(.26, .34, far)));
  let across = 1. - abs(fract(u) - .5) * 2.;
  let a = min(on * along * across * across * rainAt(i.wp) * ss(11., 5., abs(v.y)) * select(.8, .75, far) * sat(g.wx.z * 4.) * hazeT(length(v), 0., 0.) * (1. + .15 * g.fl.w), 1.);
  return vec4f(i.col * a, a);
}
// A bolt of lightning (scene.js growBolt): a quad to each segment of its channels, in the sky's plane round the
// flash's place. a: the segment's two ends (radians to the side and up); b: its thickness, where along the tree it
// lies (0 the root, 1 the furthest tip), its heat. The channels creep out from the root (st.w), then the whole tree
// flashes and flickers with fl.w, the thin branches dying first. Thick channels near the root are hot orange-white
// with a halo, the outer ones thin and cool white-violet, the last twigs faint
struct BO { @builtin(position) cp: vec4f, @location(0) q: vec2f, @location(1) @interpolate(flat) pr: vec4f, @location(2) uv: vec2f, @location(3) @interpolate(flat) even: f32 };
@vertex fn vsBolt(@builtin(vertex_index) vi: u32, @location(0) a: vec4f, @location(1) b: vec4f) -> BO {
  var o: BO; let q = quad(vi);
  let fd = g.fl.xyz; let e1 = normalize(cross(vec3f(0., 1., 0.), fd)); let e2 = cross(fd, e1);
  // w: the core's half width: a trunk channel's core two or three pixels on a phone, never under half a pixel's
  // worth (a thinner one is fainter instead). The quad reaches seven of them to each side and past each end, for
  // the halo and a round cap, and further round a thick channel: the cloud glows along it (gw: how widely)
  let w0 = .0018 * pow(b.x, .7); let w = max(w0, .001); let gw = .0015 + .0135 * b.x * b.x; let reach = w * 7. + gw * 2.2;
  let ax = a.zw - a.xy; let L = length(ax); let t = ax / max(L, 1e-5); let n = vec2f(-t.y, t.x);
  let al = (q.y * .5 + .5) * L + q.y * reach;
  let uv = a.xy + t * al + n * (q.x * reach);
  let rd = normalize(fd + e1 * uv.x + e2 * uv.y);
  let cp = g.vp * vec4f(g.cam.xyz + rd * 50., 1.);
  o.cp = vec4f(cp.xy, 4e-7 * cp.w, cp.w); // just in front of the sky, behind everything else
  o.q = vec2f(q.x * reach / w, al / w); o.uv = uv;
  let crawl = g.st.w; let at = b.y;
  // creeping out: dim, its tip bright; then the flash, a thin branch falling away sooner than a thick one
  let lead = (.12 + .9 * exp(-(crawl - at) * 22.)) * ss(crawl, crawl - .02, at) * step(crawl, .999);
  let stroke = pow(g.fl.w, mix(1.8, .75, b.x)) * step(.999, crawl);
  // (the fog between takes it low down: nothing of it shows by the horizon)
  let air = (1. - exp(-max(rd.y, 0.) * 5.)) * ss(.07, .17, rd.y);
  o.pr = vec4f((lead + stroke) * (.45 + .55 * b.x) * sqrt(w0 / w) * air, b.z, w / gw, L / w);
  o.even = 1. / (1. + 1.77 * gw / max(L, 1e-4)); // (each segment's glow lies over its neighbours': evened out)
  return o;
}
@fragment fn fsBolt(i: BO) -> @location(0) vec4f {
  // how far from the segment, in core widths
  let d = length(vec2f(i.q.x, max(max(-i.q.y, i.q.y - i.pr.w), 0.)));
  // By its heat: violet-white on the outer branches, white along the channels, orange-white on the thick ones by
  // the root; the halo and the glow violet, warmer by the root
  let heat = i.pr.y;
  let hot = ss(.2, .6, heat);
  let coreC = mix(mix(vec3f(.62, .52, 1.), vec3f(1., .95, .9), ss(.06, .22, heat)), vec3f(1., .45, .14), hot);
  let haloC = mix(vec3f(.45, .28, 1.), vec3f(1., .33, .14), hot);
  // Four layers: a white-hot line far over 1 (the tone curve clips it, the bloom spreads it), round it the
  // channel's own colour at a strength the tone curve keeps, the halo, and the wide faint glow in the cloud
  let far = d * i.pr.z;
  let c = vec3f(1., .95, .88) * exp(-d * d * 5.) * 8. + coreC * exp(-d * d * .35) * 1.1 + haloC * (exp(-d * mix(.5, .38, hot)) * mix(.45, 1.2, hot) + exp(-far * far) * i.even * mix(.2, .34, hot));
  return vec4f(c * i.pr.x * (1. - .93 * puff(i.uv)), 0.);
}
// falling leaves: small opaque quads that tumble as they come down, lit once per leaf
struct FO { @builtin(position) cp: vec4f, @location(0) uv: vec2f, @location(1) @interpolate(flat) col: vec3f, @location(2) wp: vec3f };
@vertex fn vsFall(@builtin(vertex_index) vi: u32, @location(0) a: vec4f) -> FO {
  var o: FO; let q = quad(vi); let t = g.cam.w;
  let B = vec3f(36., 22., 36.);
  var p = a.xyz * B + vec3f(g.wy.x * 1.4 + sin(t * .7 + a.w * 40.) * .8, -t * (.55 + .5 * a.w), g.wy.x * .7 + cos(t * .6 + a.x * 50.) * .8);
  let mid = g.cam.xyz + vec3f(0., 6., 0.);
  p = mid + (fract((p - mid) / B + .5) - .5) * B;
  let a1 = t * (1.3 + a.w * 2.) + a.x * 30.; let a2 = t * (.9 + a.y) + a.z * 20.;
  let ax = vec3f(cos(a1), sin(a1) * sin(a2), sin(a1) * cos(a2));
  let bx = normalize(cross(ax, vec3f(sin(a2), cos(a2), .3)));
  let d = length(p - g.cam.xyz);
  let sz = .06 * (.7 + .6 * a.y) * ss(B.x * .5, B.x * .4, d) * ss(1.2, 3., d);
  let w = p + (ax * q.x + bx * q.y) * sz;
  o.cp = g.vp * vec4f(w, 1.); o.uv = q; o.wp = p;
  o.col = folC(2, a.w, a.y) * (sunE() * shadowV(p) * .8 + amb(vec3f(0., 1., 0.), vol(p).g) * 1.4);
  return o;
}
@fragment fn fsFall(i: FO) -> @location(0) vec4f {
  if (abs(i.uv.x) > .62 * (1. - i.uv.y * i.uv.y)) { discard; }
  return fin(fog(i.col, i.wp));
}
`;

// ---------------------------------------------------------------- light shafts through the trees (half res)
export const W_RAYS =
  S_G +
  W_FS +
  /*wgsl*/ `
@group(0) @binding(0) var<uniform> g: G;
@group(0) @binding(1) var sR: sampler;
@group(0) @binding(2) var sS: sampler_comparison;
@group(0) @binding(3) var tSh: texture_depth_2d;
@group(0) @binding(4) var tW: texture_2d<f32>;
@group(0) @binding(5) var tDp: texture_depth${AA > 1 ? '_multisampled' : ''}_2d;
@group(0) @binding(6) var tV: texture_3d<f32>;
@group(0) @binding(7) var sC: sampler;
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let dp = textureLoad(tDp, vec2i(fc.xy) * ${RAYD}, 0);
  let uv = fc.xy * ${RAYD}. * g.res.zw;
  let nd = vec2f(uv.x * 2. - 1., 1. - uv.y * 2.);
  let rv = g.fwd.xyz + g.right.xyz * (nd.x * g.right.w) + g.up.xyz * (nd.y * g.up.w);
  let rl = length(rv); let rd = rv / rl;
  let zl = g.fwd.w / max(dp, 1e-6);
  let tm = min(zl * rl, 48.);
  let ro = g.cam.xyz; let sx = g.sun.xyz;
  let dt = tm / ${RAYN}.;
  let j = ign(fc.xy);
  var acc = 0.;
  for (var n = 0; n < ${RAYN}; n++) {
    let t = (f32(n) + j) * dt;
    let p = ro + rd * t;
    let s = g.sm * vec4f(p, 1.);
    let vis = textureSampleCompareLevel(tSh, sS, vec2f(s.x * .5 + .5, .5 - s.y * .5), s.z - .0006);
    // the canopy's small gaps streak the light; under the crowns (little sky) the air is stiller and hazier
    let q = p.xz - sx.xz * (p.y / sx.y);
    let pat = textureSampleLevel(tW, sR, q / 21., 1.5).r;
    let sky = textureSampleLevel(tV, sC, (p - ${VOL0}) / ${VOLS}, 0.).g;
    acc += vis * (.35 + pat * 1.3) * (1.3 - .6 * sky) * exp(-.02 * t);
  }
  let mu = max(dot(rd, sx), 0.);
  let ph = .03 + 2.6 * pow(mu, 4.) + .3 * pow(mu, 2.);
  let clear = (1. - g.sun.w) * (1. - g.sun.w);
  return vec4f(min(SUNC * (acc * dt * .016 * ph * g.mis.y * clear), vec3f(20.)), zl);
}
`;
// depth-aware 3x3 blur of the half-res shafts (hides the sampling dither)
export const W_RBLUR =
  W_FS +
  /*wgsl*/ `
@group(0) @binding(0) var tR: texture_2d<f32>;
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let p = vec2i(fc.xy); let mx = vec2i(textureDimensions(tR)) - 1;
  let c = textureLoad(tR, p, 0);
  var acc = vec3f(0.); var ws = 0.;
  for (var y = -1; y <= 1; y++) { for (var x = -1; x <= 1; x++) {
    let r = textureLoad(tR, clamp(p + vec2i(x, y) , vec2i(0), mx), 0);
    let w = 1. / (.03 + abs(r.a - c.a) / c.a);
    acc += r.rgb * w; ws += w;
  } }
  return vec4f(acc / ws, c.a);
}
`;

// ---------------------------------------------------------------- the eye's measure of the frame
// What exposure answers to (W_POST): the highlights of the frame in view, the power mean of its luminance with
// exponent 4, before exposure, sky, fog and light shafts in it, bloom not. fsGrid: 16 x 16 cells of 4 x 4 filtered
// taps of the scene and its shafts each; fsAdapt: over them all, eased into the value adapted to so far (the
// target written the frame before)
export const W_METER =
  S_G +
  W_FS +
  /*wgsl*/ `
@group(0) @binding(0) var<uniform> g: G;
@group(0) @binding(1) var sC: sampler;
@group(0) @binding(2) var tS: texture_2d<f32>;
@group(0) @binding(3) var tR: texture_2d<f32>;
@group(0) @binding(4) var tL: texture_2d<f32>;
@group(0) @binding(5) var tA: texture_2d<f32>;
@fragment fn fsGrid(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  var s = 0.;
  for (var j = 0; j < 4; j++) { for (var i = 0; i < 4; i++) {
    let uv = (floor(fc.xy) + (vec2f(f32(i), f32(j)) + .5) * .25) / 16.;
    let c = textureSampleLevel(tS, sC, uv, 0.).rgb + textureSampleLevel(tR, sC, uv, 0.).rgb;
    let l = dot(c, vec3f(.2126, .7152, .0722));
    s += l * l * l * l;
  } }
  return vec4f(s / 16., 0., 0., 1.);
}
// (the eye opens in 1.6 s and closes in 0.6; it holds while a lightning flash lights the frame, so a flash never
// makes it pump: fl.w over a fiftieth of a full one)
@fragment fn fsAdapt() -> @location(0) vec4f {
  var s = 0.;
  for (var j = 0; j < 16; j++) { for (var i = 0; i < 16; i++) { s += textureLoad(tL, vec2i(i, j), 0).r; } }
  let now = pow(s / 256., .25); let was = textureLoad(tA, vec2i(0), 0).r;
  if (g.ea.y > .5 || !(was > 0.)) { return vec4f(now, 0., 0., 1.); }
  if (g.fl.w > .02) { return vec4f(was, 0., 0., 1.); }
  return vec4f(was + (now - was) * (1. - exp(-g.ea.x / select(1.6, .6, now > was))), 0., 0., 1.);
}
`;

// ---------------------------------------------------------------- final composite
export const W_POST =
  S_G +
  W_FS +
  /*wgsl*/ `
@group(0) @binding(0) var<uniform> g: G;
@group(0) @binding(1) var sC: sampler;
@group(0) @binding(2) var tS: texture_2d<f32>;
@group(0) @binding(3) var tR: texture_2d<f32>;
@group(0) @binding(4) var tB: texture_2d<f32>;
@group(0) @binding(5) var tDp: texture_depth${AA > 1 ? '_multisampled' : ''}_2d;
@group(0) @binding(6) var tA: texture_2d<f32>; // the highlights adapted to (W_METER)
fn sat3(x: vec3f) -> vec3f { return clamp(x, vec3f(0.), vec3f(1.)); }
fn tmap(x: vec3f) -> vec3f { return sat3((x * (2.51 * x + .03)) / (x * (2.43 * x + .59) + .14)); }
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let px = vec2i(fc.xy);
  // (debug.isolate's mask: white where the one tree shown is, black elsewhere)
  if (g.dbg.w > .5 && g.dbg.w < 1.5) { return vec4f(vec3f(step(textureLoad(tS, px, 0).r, -.5)), 1.); }
  let uv = fc.xy * g.res.zw;
  let zf = g.fwd.w / max(textureLoad(tDp, px, 0), 1e-6);
  // depth-aware upsample of the shafts, drawn at 1/RAYD of the screen (scene.js resize)
  let h = fc.xy / ${RAYD}. - .5; let b = floor(h); let f = h - b; let bi = vec2i(b);
  let mx = vec2i(textureDimensions(tR)) - 1;
  var acc = vec3f(0.); var ws = 0.;
  for (var k = 0; k < 4; k++) {
    let o = vec2i(k & 1, k >> 1);
    let r = textureLoad(tR, clamp(bi + o, vec2i(0), mx), 0);
    let bw = mix(1. - f.x, f.x, f32(o.x)) * mix(1. - f.y, f.y, f32(o.y));
    let w = (bw + .02) / (.02 + abs(r.a - zf) / zf);
    acc += r.rgb * w; ws += w;
  }
  var c = textureLoad(tS, px, 0).rgb + acc / ws;
  let bl = textureSampleLevel(tB, sC, uv, 0.).rgb;
  c += bl * .12; // (the bloom chain holds only what is brighter than 1: fsDown0)
  // Exposure: the old rule's, by how much sky reaches the walker (mis.x), stopped down while the highlights in view
  // would go over H, to at most 2.5 times less (ex.y 1: the old rule alone)
  let hl = textureLoad(tA, vec2i(0), 0).r;
  c *= g.mis.x * select(clamp(g.ex.x / max(g.mis.x * hl, 1e-6), .4, 1.), 1., g.ex.y > .5);
  let q = uv - .5;
  c *= 1. - dot(q, q) * .45;
  c = tmap(c);
  let l0 = dot(c, vec3f(.2126, .7152, .0722));
  let l = mix(l0, l0 * l0 * (3. - 2. * l0), .45);
  c *= l / max(l0, 1e-4);
  c = mix(c, vec3f(l), ss(.55, 1., l) * .1);
  c = mix(vec3f(l), c, .96);
  c = pow(max(c, vec3f(0.)), vec3f(1. / 2.2));
  let n = ign(fc.xy) + ign(fc.xy + 37.) - 1.;
  return vec4f(c + n / 255., 1.);
}
`;

// ---------------------------------------------------------------- the signposts' boards
// A quad over the whole face of a finger board (world.js labels). a: its middle and half its length; b: the way
// it reads (x, z), half its height, its name's row of the label texture (16 more on the board's far face). It
// paints the face: a dark stain worn back to grey wood along the grain and at the edges, cut to the board's
// point; the name in old cream paint, raised: an edge of each stroke lit and the other dark by where the light
// comes from, and a short shadow on the board beside it that shifts a little with the eye. Wet, it darkens
export const W_SIGN =
  S_B +
  /*wgsl*/ `
@group(1) @binding(0) var tL: texture_2d<f32>;
@group(1) @binding(1) var sL: sampler;
struct SO { @builtin(position) cp: vec4f, @location(0) q: vec2f, @location(1) wp: vec3f, @location(2) @interpolate(flat) l: vec3f,
  @location(3) @interpolate(flat) rd: vec4f, @location(4) @interpolate(flat) sun: vec2f };
@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) a: vec4f, @location(1) b: vec4f) -> SO {
  var o: SO; let q = vec2f(f32(vi & 1u), f32(vi >> 1u)) * 2. - 1.;
  let p = a.xyz + vec3f(b.x, 0., b.y) * (q.x * a.w) + vec3f(0., q.y * b.z, 0.);
  let n = vec3f(-b.y, 0., b.x);
  let sunK = shadowV(a.xyz) * max(dot(n, g.sun.xyz), 0.) * (1. - g.sun.w);
  o.cp = g.vp * vec4f(p, 1.); o.wp = p; o.q = q;
  o.l = amb(n, vol(a.xyz).g) + sunE() * sunK;
  o.rd = vec4f(b.x, b.y, b.w, sunK);
  // the light's way across the face (along the reading, up): the sun's where it reaches the board, the sky's else
  o.sun = normalize(vec2f(dot(g.sun.xyz, vec3f(b.x, 0., b.y)), g.sun.y) * sunK * 3. + vec2f(-.3, .8));
  return o;
}
// the name's mask at a place of its band (0 outside it)
fn letter(uv: vec2f, row: f32, lod: f32) -> f32 {
  let k = step(0., uv.x) * step(uv.x, 1.) * step(0., uv.y) * step(uv.y, 1.);
  return textureSampleLevel(tL, sL, vec2f(uv.x, (row + uv.y) / 8.), lod).a * k;
}
@fragment fn fs(i: SO) -> @location(0) vec4f {
  let far = step(15.5, i.rd.z); let row = i.rd.z - 16. * far;
  let x = i.q.x * .5 + .5; let along = mix(x, 1. - x, far); // along the board from its post to its point
  // the board's outline: square for most of its length, then its point
  let lim = min(1., (1. - along) / .15);
  let inside = ss(lim, lim - .05, abs(i.q.y)) * ss(1., .985, along);
  // the name's band: clear of the post on either face, the middle of the board's height
  let uv = vec2f((x - mix(.18, .12, far)) / .7, (.9 - (i.q.y * .5 + .5)) / .8);
  let lod = clamp(log2(max(length(dpdx(uv) * vec2f(512., 128.)), length(dpdy(uv) * vec2f(512., 128.)))), 0., 5.);
  let e = vec2f(1.5 / 512., 1.5 / 128.) * exp2(lod);
  let m = letter(uv, row, lod);
  let grad = vec2f(letter(uv + vec2f(e.x, 0.), row, lod) - letter(uv - vec2f(e.x, 0.), row, lod), letter(uv - vec2f(0., e.y), row, lod) - letter(uv + vec2f(0., e.y), row, lod));
  let edge = -dot(grad, i.sun); // over 0: this edge of the stroke faces the light
  let V = normalize(g.cam.xyz - i.wp); let eye = vec2f(dot(V, vec3f(i.rd.x, 0., i.rd.y)), V.y);
  let shade = letter(uv + vec2f(i.sun.x * .007 - eye.x * .004, -i.sun.y * .028 + eye.y * .016), row, lod) * (1. - m);
  let wood = textureSample(tD, sR, vec2f(i.wp.y * 9., (i.wp.x + i.wp.z) * .7));
  let worn = ss(.55, .8, wood.a * .7 + wood.b * .4 + .35 * ss(.7, 1., abs(i.q.y)) + .3 * ss(.85, 1., along));
  let stain = mix(vec3f(.05, .044, .038), vec3f(.33, .32, .3), worn * .8) * (1. - .35 * g.wx.x);
  let cream = vec3f(.74, .71, .62) * (.8 + .2 * ss(.3, .6, wood.b));
  let alb = mix(stain * (1. - .55 * shade), cream, ss(.35, .6, m));
  let c = alb * i.l * (1. + clamp(edge * 3., -.6, .9)) + amb(vec3f(0., 1., 0.), 1.) * .02 * g.wx.x * (1. - m);
  return vec4f(fog(c, i.wp) * inside, inside);
}
`;

// ---------------------------------------------------------------- the blot under an animal on the ground
// A soft dark round patch that multiplies what is drawn under it (birds.js blots). a: where and its radius; b: how
// dark at its middle, then the ground's slope there (x, z), so it lies on the slope
export const W_BLOT =
  S_B +
  /*wgsl*/ `
struct BL { @builtin(position) cp: vec4f, @location(0) q: vec2f, @location(1) @interpolate(flat) k: f32 };
@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) a: vec4f, @location(1) b: vec4f) -> BL {
  var o: BL; let q = vec2f(f32(vi & 1u), f32(vi >> 1u)) * 2. - 1.;
  let p = a.xyz + vec3f(q.x, q.x * b.y + q.y * b.z, q.y) * a.w;
  o.cp = g.vp * vec4f(p, 1.); o.q = q; o.k = b.x * ss(45., 25., length(p - g.cam.xyz));
  return o;
}
@fragment fn fs(i: BL) -> @location(0) vec4f {
  return vec4f(vec3f(1. - i.k * (1. - ss(.15, 1., length(i.q)))), 1.);
}
`;
