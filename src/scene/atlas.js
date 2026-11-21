// The foliage atlas: pictures of sprays, leaf clusters, branchlets, limb ends, boughs and far trees, drawn once at
// load into the three layers of one texture (scene.js bakes it, W_LEAF cuts its cards out of it). Each layer is
// drawn from the one below, so a bough far off is a picture of the very branchlets that stand on it near the walker
// (made: by the layout of sprigs.js, the one W_LEAF vsN unfolds them from):
//   layer 0: a spray of each conifer, a cluster of leaves of each broadleaf (16 cells, a quarter of the layer
//            each; the twelfth holds four fern fronds side by side)
//   layer 1: a branchlet (a twig carrying sprays), a limb end (twigs carrying clusters) (16 cells of a quarter)
//   layer 2: whole boughs (4 cells, a quarter by a half), whole far trees (8 cells, an eighth by a quarter)
// rgb: shade, hue (a leaf's own, or how pale a needle is), 1 on a blade and 0 on wood; all three are kept beyond the
// outline too, so the small levels do not darken at the edges. a: the outline as a distance field, .5 on it. With
// its small levels a picture far off is clumps and gaps, never a stipple
import { ATLAS } from './quality.js';
import { W_FS } from './shaders.js';
import { SUB_WGSL } from './sprigs.js';

export const W_ATLAS =
  W_FS +
  /*wgsl*/ `
@group(0) @binding(0) var t: texture_2d<f32>; // the layer below
@group(0) @binding(1) var s: sampler;
const TAU = 6.2831853; const PI = 3.14159265;
const NPX = ${ATLAS}.;
// how many texels each side of an outline a layer's alpha holds; RT: the far trees'
const R0 = 12.; const R1 = 5.; const R2 = 3.; const RT = 6.;
${SUB_WGSL}
fn h1(x: f32) -> f32 { var q = fract(x * .1031 + .137); q *= q + 33.33; q *= q + q; return fract(q); }
fn ss(a: f32, b: f32, x: f32) -> f32 { let k = clamp((x - a) / (b - a), 0., 1.); return k * k * (3. - 2. * k); }
fn h2(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }
fn vn(p: vec2f) -> f32 {
  let i = floor(p); let f = fract(p); let u = f * f * (3. - 2. * f);
  return mix(mix(h2(i), h2(i + vec2f(1., 0.)), u.x), mix(h2(i + vec2f(0., 1.)), h2(i + vec2f(1., 1.)), u.x), u.y);
}
fn rot(v: vec2f, a: f32) -> vec2f { let c = cos(a); let sn = sin(a); return vec2f(v.x * c - v.y * sn, v.x * sn + v.y * c); }
// What a pixel shows. d: how far inside the nearest shape it is, in the picture's own units (below 0: outside);
// c: that shape's shade, hue, blade
struct Px { d: f32, c: vec3f };
fn put(a: Px, d: f32, c: vec3f) -> Px { if (d > a.d) { return Px(d, c); } return a; }
const WOOD = vec3f(.45, 0., 0.);
// a bare length of wood from a to b, w half as wide at a, thinner at b
fn stick(px: Px, p: vec2f, a: vec2f, b: vec2f, w: f32) -> Px {
  let ab = b - a; let k = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-6), 0., 1.);
  return put(px, w * (1. - .6 * k) - length(p - a - ab * k), WOOD);
}
// A twig from a to b with needles down both sides: nl long, sp apart, nw half as wide, raked forward by the angle
// whose cos and sin are cs; pale: how pale they are at its tip
fn twig(px: Px, p: vec2f, a: vec2f, b: vec2f, w: f32, nl: f32, sp: f32, nw: f32, cs: vec2f, id: f32, pale: f32) -> Px {
  var o = stick(px, p, a, b, w);
  if (nl <= 0.) { return o; }
  let ab = b - a; let len = max(length(ab), 1e-4); let ex = ab / len;
  let lp = vec2f(dot(p - a, ex), dot(p - a, vec2f(-ex.y, ex.x)));
  let ay = abs(lp.y);
  // the needle whose foot is nearest to where one through this point would leave the twig
  let qi = clamp(round((lp.x - ay * cs.x / cs.y) / sp), 1., max(floor(len / sp), 1.)); let qf = qi * sp;
  let h = h1(qi + id * 31.7 + step(0., lp.y) * 7.3);
  let nlen = nl * (.6 + .5 * h) * (1. - .55 * pow(qf / len, 3.));
  let r = (lp.x - qf) * cs.x + ay * cs.y;
  let perp = (lp.x - qf) * cs.y - ay * cs.x;
  // (the needles close up toward the twig: a solid band, only their outer part standing free at its edge)
  let xr = clamp(lp.x / len, 0., 1.);
  let band = min(nl * .85 * (1. - .55 * xr * xr * xr) * cs.y * .6 - ay, min(lp.x, len - lp.x) + nw);
  return put(o, max(nw - length(vec2f(perp, r - clamp(r, 0., nlen))), band), vec3f(.6 + .45 * h, pale * (.35 + .65 * qf / len), 1.));
}
// A conifer's spray, its foot at the middle of the picture's near edge: a twig with side twigs down both sides,
// all of them carrying needles. kind: 0 fir, 1 hemlock (finer, widest low down), 2 cedar (flat scales), 3 dead
fn spray(p0: vec2f, kind: i32, sd: f32) -> Px {
  var px = Px(-1., vec3f(.7, .3, 1.));
  var n = 13; var rake = .87; var wd = .40; var nl = .055; var sp = .0125; var nw = .0042; var nr = 1.05; var w0 = .009;
  if (kind == 1) { n = 20; rake = 1.05; wd = .36; nl = .034; sp = .0105; nw = .0036; nr = 1.3; w0 = .007; }
  if (kind == 2) { n = 14; rake = .7; wd = .36; nl = .055; sp = .03; nw = .0075; nr = .6; w0 = .009; }
  if (kind == 3) { n = 7; rake = .8; wd = .34; nl = 0.; w0 = .008; }
  let p = vec2f(p0.x - .05 * sin(p0.y * 2.6 + sd * 6.) * p0.y, p0.y); // (the twig bends a little)
  let cs = vec2f(cos(nr), sin(nr));
  let a0 = vec2f(.5, .045); let b0 = vec2f(.5, .955);
  px = twig(px, p, a0, b0, w0, nl * .8, sp, nw, cs, sd, .9);
  for (var k = 0; k < n; k++) {
    let v = .1 + .82 * (f32(k) + .5) / f32(n); let side = f32(k % 2) * 2. - 1.;
    let hk = h1(f32(k) * 3.7 + sd * 17.);
    var shp = pow(sin(PI * pow(v, .75)), .8);
    if (kind == 1) { shp = pow(sin(PI * pow(v, .5)), .9); }
    let a = mix(a0, b0, v);
    let dir = rot(vec2f(0., 1.), -side * (rake + (hk - .5) * .3));
    px = twig(px, p, a, a + dir * (wd * shp * (.7 + .4 * hk)), w0 * .6, nl, sp, nw, cs, f32(k) + sd * 9., .3 + .7 * v);
  }
  // (its inner part is closed: twigs and needles show along its edge, the middle is a mass)
  if (kind < 3) {
    let v = clamp((p.y - .1) / .86, 0., 1.);
    px = put(px, wd * sin(rake) * .24 * pow(sin(PI * pow(v, select(.75, .5, kind == 1))), .8) * (.5 + vn(p * 31.)) - abs(p.x - .5), vec3f(.55 + .4 * h2(floor(p * 97.)), .3 + .5 * v, 1.));
  }
  return px;
}
// One leaf, its foot at o, heading along dir, sz long. kind: 0 ovate, 1 a maple's (five lobes), 2 an oak's
// (lobed), 3 a vine maple's (seven narrow lobes). Its own number for a hue; a dark midrib, paler toward its edge
fn leaf(px: Px, p: vec2f, o: vec2f, dir: vec2f, sz: f32, kind: i32, id: f32) -> Px {
  let q = vec2f(dot(p - o, vec2f(dir.y, -dir.x)), dot(p - o, dir)) / sz;
  var d = -1.; var rib = abs(q.x); var w = .3;
  if (kind == 0 || kind == 2) {
    let v = clamp(q.y, 0., 1.);
    w = .30 * pow(sin(PI * pow(v, .7)), .8);
    if (kind == 2) { w = .30 * pow(sin(PI * v), .6) * (1. + .22 * cos(TAU * 3.5 * v)); }
    d = w - length(vec2f(q.x, q.y - v));
  } else {
    let nl = select(5, 7, kind == 3); let da = select(.55, .42, kind == 3); let wl = select(.3, .2, kind == 3);
    for (var j = 0; j < nl; j++) {
      let m = f32(j) - f32(nl - 1) * .5; let th = m * da; let ln = 1. - .13 * m * m * select(1., .45, kind == 3);
      let ax = vec2f(sin(th), cos(th)); let al = dot(q, ax); let ac = q.x * ax.y - q.y * ax.x;
      let v = clamp(al / ln, 0., 1.);
      let dj = wl * ln * sin(PI * pow(v, .55)) * (1. + .1 * cos(v * 21.)) - length(vec2f(ac, al - v * ln));
      if (dj > d) { d = dj; rib = abs(ac); w = wl * ln; }
    }
  }
  let h = h1(id * 7.31 + 2.);
  return put(px, d * sz, vec3f(.72 + .3 * h1(id * 3.17) - .28 * (1. - ss(.0, .025, rib)) + .14 * ss(0., w, rib), h, 1.));
}
// A cluster of leaves: a zigzag twig with a leaf on a stalk at each node, to one side and the other in turn, the
// last heading on
fn cluster(p: vec2f, kind: i32, sd: f32) -> Px {
  var px = Px(-1., vec3f(.8, .5, 1.));
  var n = 6; var sz = .31;
  if (kind == 0) { n = 9; sz = .24; }
  if (kind == 2) { n = 7; sz = .29; }
  var a = vec2f(.5, .04);
  for (var k = 0; k < n; k++) {
    let hk = h1(f32(k) * 5.1 + sd * 13.);
    let b = vec2f(.5 + .045 * sin(f32(k) * 2.4 + sd * 5.), .04 + .47 * (f32(k) + 1.) / f32(n));
    px = stick(px, p, a, b, .008);
    var ang = (f32(k % 2) * 2. - 1.) * (.55 + .7 * hk);
    if (k == n - 1) { ang = (hk - .5) * .5; }
    let dir = rot(vec2f(0., 1.), -ang);
    let foot = b + dir * (.04 + .05 * hk);
    px = stick(px, p, b, foot, .005);
    px = leaf(px, p, foot, dir, sz * (.8 + .4 * h1(hk * 7.7 + 1.)), kind, f32(k) + sd * 3.);
    a = b;
  }
  return px;
}
// A fern's frond, filling the picture from side to side (the strip it is cut out of gives it its outline): a stalk
// down the middle, leaflets to both sides in turn, raked forward, each narrowing to its tip
fn frond(p: vec2f, sd: f32) -> Px {
  let ax = abs(p.x - .5) * 2.; let n = 17. + 5. * h1(sd); // (far fewer leaflets than a real frond: they must show at ten paces)
  let yy = p.y * n - ax * 1.3 - step(.5, p.x) * .5;
  let k = round(yy); let h = h1(k * 1.7 + sd * 9. + step(.5, p.x) * 3.);
  let d = min((.31 - .2 * ax) * (.8 + .4 * h) - abs(yy - k), (.97 - ax) * 2.) / n;
  return put(Px(d, vec3f(.62 + .45 * h - .2 * ax, .1 + .25 * ax, 1.)), (.05 - ax) * .1, vec3f(.5, .1, .6));
}
fn cell4(i: i32) -> vec4f { return vec4f(f32(i % 4) * .25, f32(i / 4) * .25, .25, .25); }
// What a card with a picture of the layer below shows at p. The card: its foot at o, heading along dir, len long
// and wid wide (below 0: mirrored); its picture: a cell of the layer below, whose alpha holds rb texels; cpx:
// texels of this layer to one of this picture's units; body: 0, or how much of it is closed
fn card(px: Px, p: vec2f, o: vec2f, dir: vec2f, len: f32, wid: f32, cell: vec4f, rb: f32, cpx: f32, body: f32) -> Px {
  let q = vec2f(dot(p - o, vec2f(dir.y, -dir.x)) / wid + .5, dot(p - o, dir) / len);
  if (q.x < 0. || q.x > 1. || q.y < 0. || q.y > 1.) { return px; }
  let sc = len * cpx / (cell.w * NPX); // this layer's texels to one of the card's picture
  let tx = textureSampleLevel(t, s, cell.xy + q * cell.zw, log2(max(1. / sc, 1.)));
  // (body: the card's inner part is closed, a lens that much of its length half as wide)
  let lens = body * len * sin(PI * pow(q.y, .7)) * (.4 + 1.2 * vn(p * 43.)) - abs(q.x - .5) * abs(wid);
  return put(px, max((tx.a - .5) * 2. * rb * sc / cpx, lens), tx.rgb);
}
// A picture made of others (sprigs.js, picture P): its sticks, then its sub-cards, each a card of the layer below.
// bg: the colour beyond its outline
fn made(p: vec2f, P: i32, bg: vec3f, rb: f32, cpx: f32, body: f32) -> Px {
  var px = Px(-1., bg);
  for (var j = 0; j < STKN; j++) {
    let w = STW[P * STKN + j];
    if (w > 0.) { let s = STK[P * STKN + j]; px = stick(px, p, s.xy, s.zw, w); }
  }
  for (var j = 0; j < SUBN; j++) {
    let a = SUB[(P * SUBN + j) * 2]; let b = SUB[(P * SUBN + j) * 2 + 1];
    if (a.w > 0.) { px = card(px, p, a.xy, rot(vec2f(0., 1.), a.z), a.w, b.x, cell4(i32(b.y + .5)), rb, cpx, body); }
  }
  return px;
}
// A whole tree far off in the fog, its crown from its base (y 0) to its top (y 2), as a dark uneven outline.
// Conifers (0 fir, 1 a fir with a broken, leaning top, 2 hemlock with a drooping top, 3 cedar, 4 the small crown
// of a pole): a trunk line with boughs in whorls, each drooping its own way and of its own reach, with air between
// them. Broadleaves (5 maple, 6 birch, 7 oak): clumps of leaves at the ends of limbs
fn farTree(p: vec2f, kind: i32, sd: f32) -> Px {
  var d = -1.;
  let rag = vn(p * 19. + sd * 31.) - .5; let rag2 = vn(p * 47. + sd * 17.) - .5;
  if (kind < 5) {
    var top = 1.93; var lean = (h1(sd * 3.3) - .5) * .12;
    if (kind == 1) { top = 1.5; lean = .2 * (h1(sd * 5.1) - .3); }
    let xc = .5 + lean * (p.y / 2.) * (p.y / 2.);
    d = max(d, .012 * (1. - .4 * p.y) - abs(p.x - xc) - step(top, p.y));
    let n = select(15, 7, kind == 4);
    for (var k = 0; k < n; k++) {
      for (var sdn = 0; sdn < 2; sdn++) {
        let side = f32(sdn) * 2. - 1.; let hk = h1(f32(k * 2 + sdn) * 3.1 + sd * 13.);
        let tt = (f32(k) + .5 * hk) / f32(n); let hy = .04 + (top - .1) * tt;
        var wk = (.44 * (1. - .92 * pow(tt, .8)) + .035) * (.55 + .6 * hk);
        if (kind == 3) { wk *= .8; }
        if (kind == 4) { wk *= .55; }
        let xr = (p.x - (.5 + lean * (hy / 2.) * (hy / 2.))) * side / wk;
        let u = clamp(xr, 0., 1.);
        // a bough's line: out and down, a hemlock's hanging most, a cedar's lifting again at its tip
        var yb = hy + wk * (mix(-.5, .35, tt) * u - .5 * u * u);
        if (kind == 2) { yb = hy + wk * (mix(-.7, .1, tt) * u - .7 * u * u); }
        if (kind == 3) { yb = hy + wk * (-.9 * u + .75 * u * u * u); }
        let thick = (.03 + .07 * sin(PI * pow(u, 1.2))) * (.55 + 1.1 * vn(vec2f(p.x * 30., f32(k) * 7. + sd)));
        d = max(d, thick - abs(p.y - yb + thick * .5) - max(xr - 1., 0.) * wk - max(-xr, 0.) * wk);
      }
    }
    if (kind == 2) { // the hemlock's leader bends over
      let q = p - vec2f(.5 + lean, top);
      d = max(d, .012 - length(vec2f(q.x - .12 * ss(-.1, .12, q.y) * sign(h1(sd) - .5), max(abs(q.y - .02) - .1, 0.))));
    }
  } else {
    let n = select(11, 8, kind == 6);
    for (var k = 0; k < n; k++) {
      let hk = h1(f32(k) * 4.7 + sd * 9.); let hl = h1(f32(k) * 9.1 + sd * 5.);
      let an = f32(k) / f32(n) * TAU + hk; let rr = select(.3, .2, kind == 6) * sqrt(.25 + .75 * hl);
      let c = vec2f(.5 + cos(an) * rr, 1.05 + sin(an) * rr * select(1.9, 2.6, kind == 6) * .9);
      let r = .1 + .08 * hk;
      d = max(d, r * (1. + rag * 1.2) - length((p - c) * vec2f(1., .75)));
      d = max(d, .006 - abs((p.x - .5) * (c.y - .1) - (p.y - .1) * (c.x - .5)) / max(length(c - vec2f(.5, .1)), .01) - step(c.y, p.y) - step(p.y, .1));
    }
  }
  return Px(d + rag2 * .012, vec3f(.62 + .5 * rag, .3, 1.));
}
fn out(px: Px, cpx: f32, r: f32) -> vec4f { return vec4f(px.c, clamp(.5 + px.d * cpx / (2. * r), 0., 1.)); }
@fragment fn fs0(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let g = fc.xy / NPX * 4.; let c = floor(g); let p = g - c; let id = i32(c.x + c.y * 4.);
  var px = Px(-1., vec3f(.7, .3, 1.));
  if (id < 4) { px = spray(p, id, f32(id) * 1.3 + 1.); }
  else if (id < 6) { px = cluster(p, 1, f32(id)); }
  else if (id < 8) { px = cluster(p, 0, f32(id)); }
  else if (id == 8) { px = cluster(p, 2, 3.); }
  else if (id == 9) { px = cluster(p, 3, 5.); }
  else if (id == 11) { let c4 = floor(p.x * 4.); px = frond(vec2f(p.x * 4. - c4, p.y), c4 + 1.); } // four fronds side by side
  return out(px, NPX * .25, R0);
}
@fragment fn fs1(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let g = fc.xy / NPX * 4.; let c = floor(g); let p = g - c; let id = i32(c.x + c.y * 4.);
  var px = Px(-1., vec3f(.7, .3, 1.));
  if (id < 6) { px = made(p, 4 + id, vec3f(.7, .3, 1.), R0, NPX * .25, .06); }
  else if (id <= 10) { px = made(p, 4 + id, vec3f(.8, .5, 1.), R0, NPX * .25, 0.); }
  return out(px, NPX * .25, R1);
}
@fragment fn fs2(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = fc.xy / NPX;
  if (uv.y < .5) {
    // boughs: 0 and 1 a fir's, 2 a hemlock's, 3 a cedar's
    let c = floor(uv.x * 4.); let p = vec2f(uv.x * 4. - c, uv.y * 4.); let id = i32(c);
    return out(made(p, id, vec3f(.7, .3, 1.), R1, NPX * .25, .03), NPX * .25, R2);
  }
  if (uv.y < .75) {
    let c = floor(uv.x * 8.); let p = vec2f(uv.x * 8. - c, (uv.y - .5) * 8.);
    return out(farTree(p, i32(c), c * 1.7 + 2.), NPX * .125, RT);
  }
  return vec4f(.7, .3, 1., 0.);
}
`;
