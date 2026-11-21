// ============================================================================
// sounds: every sound of the forest, computed into plain sample arrays (no sound files)
// ============================================================================
// bakeSounds() hands back the bank with its sounds still to make: bank.later, a generator audio.js runs a slice at a
// time in idle time once the forest is shown; makeStep() makes one footstep (audio.js keeps a few of each surface,
// each made anew once played). Plain JavaScript, seeded; nothing here needs a browser (the checks render it in Node).
// Recipes and the measured references they are fitted to: research/11-sound-refs.md
import { abs, cos, exp, floor, max, min, PI, pow, sin, TAU } from './math.js';

export const SR = 22050, // nothing in a forest needs more than 11 kHz
  LOW_SR = 16000, // the wind's and the running water's beds: nothing above 8 kHz
  DEEP_SR = 8000; // thunder's roll: nothing above 2.5 kHz
const CHUNK = 4096; // samples a pass works on between yields (a fraction of a millisecond)

// ---------------------------------------------------------------- the kit
// a seeded stream of numbers in [0, 1)
export const stream = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
// runs a generator to its end at once; its value
export const run = (gen) => {
  for (;;) {
    const r = gen.next();
    if (r.done) return r.value;
  }
};
// A biquad's coefficients (the Audio EQ Cookbook): lp, hp, bp (0 dB at its peak), pk (a bell of dB)
const coef = (type, f, Q, dB, sr) => {
  const w = (TAU * min(f, sr * 0.45)) / sr,
    cw = cos(w),
    al = sin(w) / (2 * Q),
    A = pow(10, dB / 40);
  const [b0, b1, b2, a0, a1, a2] =
    type === 'lp'
      ? [(1 - cw) / 2, 1 - cw, (1 - cw) / 2, 1 + al, -2 * cw, 1 - al]
      : type === 'hp'
        ? [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2, 1 + al, -2 * cw, 1 - al]
        : type === 'bp'
          ? [al, 0, -al, 1 + al, -2 * cw, 1 - al]
          : [1 + al * A, -2 * cw, 1 - al * A, 1 + al / A, -2 * cw, 1 - al / A];
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
};
// A biquad that keeps its state from call to call: (x, from, to) filters x[from..to) in place
const biquad = (type, f, Q, dB = 0, sr = SR) => {
  const [b0, b1, b2, a1, a2] = coef(type, f, Q, dB, sr);
  let x1 = 0,
    x2 = 0,
    y1 = 0,
    y2 = 0;
  return (x, from = 0, to = x.length) => {
    for (let i = from; i < to; i++) {
      const x0 = x[i],
        y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = x0;
      y2 = y1;
      y1 = y0;
      x[i] = y0;
    }
  };
};
// x through a biquad, in place, at once
export const filter = (x, type, f, Q, dB = 0, sr = SR) => {
  biquad(type, f, Q, dB, sr)(x);
  return x;
};
// Passes over x a chunk at a time, yielding between chunks: each pass a function (x, from, to) with its own state
// (a source, a filter, a level), all of them over a chunk before the next
function* passes(x, ...each) {
  for (let i = 0; i < x.length; i += CHUNK) {
    const to = min(i + CHUNK, x.length);
    for (const pass of each) pass(x, i, to);
    yield;
  }
}
const white =
  (rnd, g = 1) =>
  (x, from, to) => {
    for (let i = from; i < to; i++) x[i] = (rnd() * 2 - 1) * g;
  };
const scale = (k) => (x, from, to) => {
  for (let i = from; i < to; i++) x[i] *= k;
};
// pink noise (Kellet's filter: equal energy in every octave)
const pink = (rnd) => {
  let b0 = 0,
    b1 = 0,
    b2 = 0,
    b3 = 0,
    b4 = 0,
    b5 = 0,
    b6 = 0;
  return (x, from, to) => {
    for (let i = from; i < to; i++) {
      const w = rnd() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      x[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
  };
};
// the level wandering by +-db dB, smoothly, about `rate` times a second (worked out every 32 samples, a line between)
const wander = (sr, rnd, db, rate) => {
  const span = floor(sr / rate);
  let seg = 0,
    a = rnd() * 2 - 1,
    b = rnd() * 2 - 1;
  const at = (i) => {
    const k = floor(i / span);
    while (seg < k) {
      seg++;
      a = b;
      b = rnd() * 2 - 1;
    }
    const u = 0.5 - 0.5 * cos(((i - k * span) / span) * PI);
    return pow(10, ((a + (b - a) * u) * db) / 20);
  };
  let g1 = at(0);
  return (x, from, to) => {
    for (let i = from; i < to; i += 32) {
      const g0 = g1,
        n = min(32, to - i);
      g1 = at(i + 32);
      for (let j = 0; j < n; j++) x[i + j] *= g0 + ((g1 - g0) * j) / 32;
    }
  };
};
// scales x so its loudest sample is `peak`
function* norm(x, peak) {
  let m = 0;
  yield* passes(x, (y, from, to) => {
    for (let i = from; i < to; i++) m = max(m, abs(y[i]));
  });
  if (m > 0) yield* passes(x, scale(peak / m));
  return x;
}
const normNow = (x, peak) => run(norm(x, peak));
// white noise that grains are read from, each at a place of its own (a draw per grain, not per sample)
const NOISE = (() => {
  const r = stream(77),
    a = new Float32Array(1 << 16);
  for (let i = 0; i < a.length; i++) a[i] = r() * 2 - 1;
  return a;
})();
// A grain into out at t seconds: noise rising over `att` and dying by e every `tau` seconds, through a band at f
// (Q), peak level about `gain`
const grain = (out, rnd, t, gain, tau, f, Q, att = 0.001, sr = SR) => {
  const i0 = floor(t * sr),
    n = min(floor((att + tau * 5) * sr), 4096, out.length - i0);
  if (n <= 0) return;
  const w = (TAU * min(f, sr * 0.45)) / sr,
    al = sin(w) / (2 * Q),
    b0 = al / (1 + al),
    a1 = (-2 * cos(w)) / (1 + al),
    a2 = (1 - al) / (1 + al),
    // (a band pass at Q passes about 1/sqrt(Q) of white noise's level: given back so `gain` is the grain's)
    k = Math.sqrt(Q) * 1.6 * gain,
    na = att * sr,
    fall = exp(-1 / (tau * sr));
  let o = floor(rnd() * (NOISE.length - n)),
    x1 = 0,
    x2 = 0,
    y1 = 0,
    y2 = 0,
    e = 1;
  for (let i = 0; i < n; i++, o++) {
    let env = e;
    if (i < na) env = i / na;
    else e *= fall;
    const x0 = NOISE[o] * env,
      y0 = b0 * (x0 - x2) - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    out[i0 + i] += y0 * k;
  }
};
// A grain as above, through the band twice (its skirts fall twice as steeply: a footstep's grains stay in their
// band, where one pass would smear each over every octave)
const grain2 = (out, rnd, t, gain, tau, f, Q, att = 0.001) => {
  const i0 = floor(t * SR),
    n = min(floor((att + tau * 6) * SR), 4096, out.length - i0);
  if (n <= 0) return;
  const w = (TAU * min(f, SR * 0.45)) / SR,
    al = sin(w) / (2 * Q),
    b0 = al / (1 + al),
    a1 = (-2 * cos(w)) / (1 + al),
    a2 = (1 - al) / (1 + al),
    k = Q * 2.2 * gain,
    na = att * SR,
    fall = exp(-1 / (tau * SR));
  let o = floor(rnd() * (NOISE.length - n)),
    x1 = 0,
    x2 = 0,
    y1 = 0,
    y2 = 0,
    z1 = 0,
    z2 = 0,
    e = 1;
  for (let i = 0; i < n; i++, o++) {
    let env = e;
    if (i < na) env = i / na;
    else e *= fall;
    const x0 = NOISE[o] * env,
      y0 = b0 * (x0 - x2) - a1 * y1 - a2 * y2,
      z0 = b0 * (y0 - y2) - a1 * z1 - a2 * z2;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    z2 = z1;
    z1 = z0;
    out[i0 + i] += z0 * k;
  }
};
// A struck body into out at t: decaying sines, [frequency, level, seconds to fall by e] each, a little detuned (each
// by its recurrence: no sine per sample)
const modes = (out, rnd, t, gain, list) => {
  const i0 = floor(t * SR);
  for (const [f0, a, tau] of list) {
    const w = (TAU * f0 * (0.94 + 0.12 * rnd())) / SR,
      ph = rnd() * TAU,
      r = exp(-1 / (tau * SR)),
      c = 2 * r * cos(w),
      n = min(floor(tau * 7 * SR), out.length - i0),
      ramp = 0.0015 * SR;
    let y2 = sin(ph - w) / r,
      y1 = sin(ph);
    for (let i = 0; i < n; i++) {
      out[i0 + i] += gain * a * y1 * min(i / ramp, 1);
      const y0 = c * y1 - r * r * y2;
      y2 = y1;
      y1 = y0;
    }
  }
};
// A bubble into out at t (Minnaert, after van den Doel): a sine at f that dies by its damping and rises in pitch as
// it does, by `rise` (0 deep, 0.1 near the surface). A turning phasor, its step set anew every 16 samples
const bubble = (out, t, gain, f, rise, sr = SR) => {
  const d = 0.043 * f + 0.0014 * pow(f, 1.5),
    i0 = floor(t * sr),
    n = min(floor((5 / d) * sr), out.length - i0),
    fall = exp(-d / sr),
    ramp = 0.001 * sr;
  let re = 1,
    im = 0,
    c = 1,
    s = 0,
    e = gain;
  for (let i = 0; i < n; i++) {
    if (!(i & 15)) {
      const w = (TAU * f * (1 + (rise * d * i) / sr)) / sr;
      c = cos(w);
      s = sin(w);
    }
    const r = re * c - im * s;
    im = re * s + im * c;
    re = r;
    out[i0 + i] += e * im * min(i / ramp, 1);
    e *= fall;
  }
};
// n samples at rate sr: in a browser an AudioBuffer's own channel (audio.js plays its .ab, so nothing is copied),
// elsewhere a plain array
const alloc = (n, sr = SR) => {
  if (typeof AudioBuffer !== 'function') return new Float32Array(n);
  const ab = new AudioBuffer({ length: n, sampleRate: sr }),
    d = ab.getChannelData(0);
  d.ab = ab;
  return d;
};
// A looping bed of `secs` at sr: fill(x) (a generator) writes into a scratch array a little longer than the loop,
// whose overrun is cross-faded (equal power) into its start, so the loop has no seam
function* bed(secs, sr, fill) {
  const n = floor(secs * sr),
    F = floor(0.25 * sr),
    tmp = new Float32Array(n + F);
  yield* fill(tmp, sr);
  const out = alloc(n, sr);
  out.set(tmp.subarray(0, n));
  yield;
  for (let i = 0; i < F; i++) {
    const k = (i / F) * PI * 0.5;
    out[i] = tmp[i] * sin(k) + tmp[n + i] * cos(k);
  }
  return out;
}

// ---------------------------------------------------------------- footsteps
// What can be underfoot, in the order audio.js codes it
export const SURFACES = [
  'gravel',
  'dirt',
  'leaves',
  'grass',
  'moss',
  'planks',
  'boardwalk',
  'log',
  'stone',
  'water',
];
export const STEP_LEN = 0.5; // seconds of a step's buffer (the roll's tail dies inside it)
// A cluster of grains into out from t: a burst that starts dense and thins out (its rate and its grains' loudness
// falling by e every `fade` seconds, to nothing by the step's end); each grain its own size (tau0 to tau1 s), pitch
// (lo to hi Hz, the more so low as `skew` is over 1) and loudness (most small, a few big; the high ones smaller)
const cluster = (
  out,
  rnd,
  t,
  gain,
  rate,
  fade,
  lo,
  hi,
  skew,
  tau0,
  tau1,
  Q,
) => {
  const end = min(fade * 4, STEP_LEN - 0.07 - t);
  for (let s = -Math.log(1 - rnd()) / rate; s < end;) {
    const f = lo * pow(hi / lo, pow(rnd(), skew));
    grain2(
      out,
      rnd,
      t + s,
      gain *
        exp(-s / fade) *
        (1 - s / end) ** 2 *
        (0.15 - 0.35 * Math.log(1 - rnd())) *
        pow(lo / f, 0.3),
      tau0 + (tau1 - tau0) * rnd(),
      f,
      Q,
    );
    s += -Math.log(1 - rnd()) / (rate * exp(-s / fade));
  }
};
// each soft surface's grains: their band (Hz) and its skew (cluster), their size (s), Q; the heel's rate (grains a
// second at first) and fade (s), the roll's; the body under them (Hz) and its share (0: none)
const GRAINS = {
  gravel: [250, 4500, 1.8, 0.0015, 0.006, 2.5, 500, 0.07, 300, 0.1, 180, 1.2],
  dirt: [200, 1800, 1.3, 0.004, 0.014, 2, 220, 0.07, 150, 0.09, 150, 1.4],
  leaves: [1600, 6500, 1.2, 0.001, 0.004, 3, 420, 0.08, 300, 0.12, 300, 0.5],
  grass: [2500, 8000, 1, 0.002, 0.006, 1, 60, 0.05, 30, 0.08, 120, 2.5],
  moss: [250, 900, 1, 0.004, 0.01, 1, 80, 0.06, 40, 0.1, 200, 1],
  water: [500, 4000, 1, 0.003, 0.01, 0.8, 300, 0.05, 120, 0.1, 520, 1.5],
  stone: [1000, 4000, 1, 0.001, 0.003, 1.4, 150, 0.02, 40, 0.05, 0, 0],
};
// A foot on wood: a dull thump, a plank's few modes over it and a soft click, drawn anew each step: the lowest mode
// between f0 and f1 Hz, the others at rough ratios of it (PLANK), each dying in 30 to 80 ms; the click's level
const WOOD = {
  planks: [140, 240, 0.25],
  boardwalk: [95, 165, 0.15],
  log: [200, 320, 0.35],
};
const PLANK = [
  [1, 1],
  [2.1, 2.7],
  [3.6, 4.6],
  [5.6, 7.2],
];
// One step on surface `kind`, all of it drawn anew from rnd: the heel's strike and, 70 to 140 ms later, the softer
// roll of the sole, the ground settling under them; now and then a scuff between (Cook's footsteps: an envelope
// feeding grains). Each step its own weight: its band up or down a third of an octave, more or fewer grains, a
// longer or shorter tail. Fitted to the recordings (11-sound-refs.md 1). Dry: audio.js wets it as it plays (more
// middle, a shorter tail, a squelch); `wet` 1 does that here (the checks)
export function makeStep(kind, rnd, wet = 0) {
  const out = alloc(floor(STEP_LEN * SR)),
    roll = 0.07 + 0.07 * rnd(),
    rg = 0.35 + 0.35 * rnd(),
    tail = (0.75 + 0.5 * rnd()) * (wet ? 0.6 : 1), // (wet ground: a shorter tail)
    wood = WOOD[kind];
  if (wood) {
    const [f0, f1, click] = wood;
    for (const [t, g] of [
      [0.003, 1],
      [roll, rg],
    ]) {
      const low = f0 * pow(f1 / f0, rnd());
      grain2(out, rnd, t, g * click, 0.0008, 1200 + 1500 * rnd(), 1.5, 0.0002);
      grain2(
        out,
        rnd,
        t,
        g,
        0.01 + 0.012 * rnd(),
        low * (1.3 + rnd()),
        1,
        0.002,
      );
      modes(
        out,
        rnd,
        t,
        g * 0.45,
        PLANK.map(([r0, r1], k) => [
          low * (r0 + (r1 - r0) * rnd()),
          k ? 0.3 + 0.7 * rnd() : 1,
          (0.0045 + 0.007 * rnd()) / (1 + 0.25 * k),
        ]),
      );
    }
  } else {
    const [lo0, hi0, skew, tau0, tau1, Q, hr, hf, rr, rf, body, bg] =
        GRAINS[kind],
      up = pow(2, (rnd() - 0.5) * 0.66),
      lo = lo0 * up,
      hi = min(hi0 * up, 9500),
      dense = 0.6 + 0.8 * rnd();
    for (const [t, g, rate, fade] of [
      [0.003, 1, hr, hf],
      [roll, rg, rr, rf * tail],
    ]) {
      // (the onset: one sharp grain; the thump of the foot under it)
      grain2(out, rnd, t, g * 0.7, 0.0008, lo * (2 + 3 * rnd()), 1, 0.0002);
      if (body)
        grain2(
          out,
          rnd,
          t,
          g * bg,
          0.02 + 0.015 * rnd(),
          body * (0.85 + 0.3 * rnd()),
          0.8,
          0.003,
        );
      cluster(out, rnd, t, g, rate * dense, fade, lo, hi, skew, tau0, tau1, Q);
    }
    if (rnd() < 0.4)
      cluster(
        out,
        rnd,
        roll * 0.5,
        0.15,
        80,
        0.03,
        lo,
        hi,
        skew,
        tau0,
        tau1,
        Q,
      );
    if (kind === 'moss' && rnd() < 0.15)
      grain(out, rnd, 0.05, 0.9, 0.006, 1500 + 2500 * rnd(), 1.5); // (a twig)
    if (kind === 'water')
      for (let k = 0; k < 3; k++)
        bubble(out, 0.02 + 0.05 * rnd(), 0.25, 1500 * pow(2.5, rnd()), 0.1);
  }
  if (kind === 'dirt') filter(out, 'lp', 2400, 0.7);
  if (wet && kind !== 'water') {
    filter(out, 'pk', 1100, 0.7, 6);
    if (!wood) bubble(out, 0.025, 0.12, 1000 + 2000 * rnd(), 0.1);
  }
  // the first 2 ms faded in (no click from the buffer's start), the last 50 out
  for (let i = 0; i < out.length; i++)
    out[i] *= min(i / 40, 1, (out.length - i) / (0.05 * SR));
  return normNow(out, 0.9);
}
// A squelch, laid over a step on wet ground: a bubble or two
function bakeSquelch(rnd) {
  const out = alloc(floor(0.08 * SR));
  bubble(out, 0.002, 0.5, 1000 + 2000 * rnd(), 0.1);
  if (rnd() < 0.5)
    bubble(out, 0.02 + 0.02 * rnd(), 0.3, 1500 + 1500 * rnd(), 0.1);
  return normNow(out, 0.9);
}
// A splash, laid over a step into a puddle: bright water, 0.3 s
function bakeSplash(rnd) {
  const out = alloc(floor(0.4 * SR));
  grain(out, rnd, 0.005, 1, 0.05, 3500, 0.8);
  grain(out, rnd, 0.01, 0.6, 0.08, 1500, 0.7);
  for (let k = 0; k < 6; k++)
    bubble(out, 0.03 + 0.2 * rnd(), 0.2, 700 * pow(4, rnd()), 0.1);
  for (let i = 0; i < out.length; i++)
    out[i] *= min(i / 40, 1, (out.length - i) / (0.03 * SR));
  return normNow(out, 0.9);
}

// ---------------------------------------------------------------- rain
// The rain's layers, each a loop (audio.js plays each at two speeds at once, so its repeats never line up):
// hiss, the dense roar of rain all round (0.45 to 8 kHz, as much in each octave, steady); patter, drops on leaves
// near by (ticks and taps, some 15 a second, most of them small); on water, drops ticking then ringing as bubbles
// (0.2 to 1.4 kHz) over a low wash.
// drips: single drops off the crowns (5 to 9 kHz), played one at a time
function* bakeRain(rnd) {
  const hiss = yield* bed(8, SR, function* (x) {
    yield* passes(
      x,
      pink(rnd),
      biquad('hp', 450, 0.7),
      biquad('lp', 9900, 0.7),
    );
    yield* norm(x, 0.5);
  });
  const patter = yield* bed(7, SR, function* (x) {
    yield* passes(x, white(rnd, 0.01));
    for (let t = 0, k = 0; t < x.length / SR - 0.05; k++) {
      const g = pow(-Math.log(1 - rnd()), 1.5) * 0.2; // (a long tail: now and then a big drop)
      grain(x, rnd, t, g, 0.001 + 0.003 * rnd(), 3000 * pow(3, rnd()), 2);
      if (rnd() < 0.8)
        grain(
          x,
          rnd,
          t,
          g * 1.2,
          0.003 + 0.006 * rnd(),
          400 * pow(3, rnd()),
          1.5,
        );
      t += -Math.log(1 - rnd()) / 15;
      if (!(k & 15)) yield;
    }
    yield* passes(x, wander(SR, rnd, 1.5, 1));
    yield* norm(x, 0.9);
  });
  const water = yield* bed(6, SR, function* (x) {
    yield* passes(x, white(rnd, 0.06), biquad('bp', 130, 0.5), scale(8));
    // (each drop a tick as it hits, then its bubble)
    for (let t = 0, k = 0; t < x.length / SR - 0.1; k++) {
      grain(x, rnd, t, 0.4 * rnd(), 0.002, 2000 + 5000 * rnd(), 1.2);
      bubble(x, t + 0.002, 0.1 + 0.2 * rnd(), 200 * pow(7, rnd()), 0.1 * rnd());
      t += -Math.log(1 - rnd()) / 30;
      if (!(k & 7)) yield;
    }
    yield* passes(x, wander(SR, rnd, 1.5, 1));
    yield* norm(x, 0.9);
  });
  const drips = [];
  for (let k = 0; k < 8; k++) {
    const x = alloc(floor(0.06 * SR));
    grain(x, rnd, 0.001, 1, 0.002 + 0.004 * rnd(), 5000 + 4000 * rnd(), 1.5);
    grain(x, rnd, 0.002, 0.3, 0.006, 900 + 900 * rnd(), 1.2);
    drips.push(normNow(x, 0.9));
  }
  return { hiss, patter, water, drips };
}

// ---------------------------------------------------------------- wind
// The sough of wind in conifers (11-sound-refs.md 4): pink noise in a band of 300 Hz to 2.5 kHz, falling off above
// 800 Hz, its level fluttering a little; the gusts are the scene's and come live (audio.js), as does the band's rise
// with them
function* bakeWind(rnd) {
  return yield* bed(9, LOW_SR, function* (x, sr) {
    yield* passes(
      x,
      pink(rnd),
      biquad('hp', 80, 0.7, 0, sr),
      biquad('lp', 3630, 0.7, 0, sr),
      wander(sr, rnd, 0.7, 1.5),
    );
    yield* norm(x, 0.8);
  });
}

// ---------------------------------------------------------------- thunder
// Thunder (11-sound-refs.md 3): crack, the near flash's tearing at the start (noise 0.45 to 3.6 kHz, sudden, four
// claps over most of a second, each dying long before the buffer ends); rumble, a 10 s loop of low roll (brown
// noise from 30 Hz) whose bursts sway it a few dB only: the strike's shape is thunderShape's, drawn anew each time
// and laid over it live (audio.js), as is what the distance takes off its top
function* bakeThunder(rnd) {
  const crack = alloc(floor(1.9 * LOW_SR), LOW_SR);
  {
    const x = crack,
      sr = LOW_SR;
    for (let k = 0, t = 0.002; k < 4; k++, t += 0.12 + 0.18 * rnd()) {
      const i0 = floor(t * sr),
        rise = 0.002 * sr,
        fall = exp(-1 / (0.11 * sr));
      for (let i = i0, e = pow(0.8, k); i < x.length; i++) {
        x[i] += (rnd() * 2 - 1) * e * min((i - i0) / rise, 1);
        e *= fall;
        if (!(i & 4095)) yield;
      }
    }
    yield* passes(
      x,
      biquad('hp', 435, 0.7, 0, sr),
      biquad('lp', 3630, 0.7, 0, sr),
    );
    yield* norm(x, 0.9);
  }
  const rumble = yield* bed(10, DEEP_SR, function* (x, sr) {
    const env = new Float32Array(x.length);
    let b = 0;
    yield* passes(
      x,
      (y, from, to) => {
        for (let i = from; i < to; i++) {
          b = (b + 0.04 * (rnd() * 2 - 1)) * 0.995;
          y[i] = b;
        }
      },
      biquad('hp', 30, 0.7, 0, sr),
    );
    // the bursts: claps of 3 to 6, each burst rising in 0.08 s and dying over 0.45, of uneven size, over a steady roll
    for (let t = 0; t < x.length / sr;) {
      const claps = 3 + floor(rnd() * 4);
      for (let c = 0; c < claps; c++) {
        const g = (0.12 + 0.2 * rnd()) * pow(0.8, c),
          i0 = floor(t * sr),
          rise = 0.08 * sr,
          fall = exp(-1 / (0.45 * sr));
        let e = g;
        for (let i = i0; i < min(x.length, i0 + 1.2 * sr); i++) {
          const k = i - i0;
          env[i] += k < rise ? (g * k) / rise : (e *= fall);
        }
        t += 0.15 + 0.15 * rnd();
      }
      t += 0.2 + 0.5 * rnd();
      yield;
    }
    for (let i = 0; i < x.length; i++) x[i] *= 0.7 + env[i];
    yield* norm(x, 0.9);
  });
  return { crack, rumble };
}
export const SHAPE_RATE = 50; // thunderShape's points a second
// A strike's shape, as gains at SHAPE_RATE from the moment it is heard: `far` 0 (a kilometre) to 1 (six or more).
// Near: up in a fifth of a second, then falling with a swell or two on the way, at -20 dB 2.4 to 2.8 s after its
// peak; far: swelling in from nothing over 2.5 to 4 s, at -20 dB some 5 s after. Then a tail that falls on, a fainter
// swell or two in it, to -90 dB, and silence: it never stops loud
export function thunderShape(far, rnd) {
  const rise = 0.2 + far * (2.3 + 1.5 * rnd()),
    t20 = 2.45 + 0.3 * rnd() + far * (2.1 + 0.8 * rnd()),
    tail = 7 + 3 * far,
    swell = (t, at, len, db) =>
      db * max(0, sin((PI * (t - at)) / len)) * (t > at && t < at + len),
    swells = (n, from, to, db) =>
      Array.from({ length: n }, () => {
        const len = 0.5 + 0.4 * rnd();
        return [
          from + (to - from - len) * rnd(),
          len,
          db * (0.6 + 0.4 * rnd()),
        ];
      }),
    early = swells(1 + floor(rnd() * 2), 0.4, t20 - 0.3, 7),
    late = swells(1 + floor(rnd() * 2), t20 + 0.5, t20 + 5, 4),
    // the swell's own bumps on the way up (far: it comes in waves)
    up = swells(2, 0, rise, 6),
    n = floor((rise + t20 + tail) * SHAPE_RATE) + 2,
    out = new Float32Array(n);
  for (let i = 0; i < n - 1; i++) {
    const t = i / SHAPE_RATE;
    let db;
    if (t < rise) {
      // (from nothing: a gain rising as the square of the time, waves on it that never top the peak)
      const u = t / rise;
      out[i] =
        u *
        u *
        min(
          1,
          pow(
            10,
            up.reduce(
              (s, [a, l, d]) => s + swell(t, a * rise, l * rise, d),
              -6 * (1 - u),
            ) / 20,
          ),
        );
      continue;
    }
    const s = t - rise;
    if (s < t20) {
      db = (-20 * s) / t20;
      for (const [a, l, d] of early)
        db = min(db + swell(s, a, l, d), -0.5 * (s > 0.2));
    } else {
      // the tail: -20 to -45 over 4 s, then on to -90 over the rest; its swells stay under -21
      const r = s - t20;
      db = r < 4 ? -20 - 6.25 * r : -45 - (45 * (r - 4)) / (tail - 4);
      for (const [a, l, d] of late) db = min(db + swell(s, a, l, d), -21);
    }
    out[i] = pow(10, db / 20);
  }
  return out;
}

// ---------------------------------------------------------------- running water and the lake
// (11-sound-refs.md 5) brook: bubbles, 120 a second, half near 1 kHz (radii of 2 to 4 mm), the rest 3 to 6 kHz,
// over a soft hiss, and a sparkle of tiny splashes (6 to 10 kHz); creek: a steady wash near 2 kHz with bubbles
// too many to tell apart; falls: a broad roar, 250 Hz to 4 kHz; lake: the shore's lapping (150 Hz to 1.1 kHz), with
// plinks and slaps
function* bakeBrook(rnd) {
  return yield* bed(6, SR, function* (x, sr) {
    yield* passes(x, white(rnd, 0.01), biquad('bp', 2000, 0.7));
    // the sparkle: tiny splashes, clicks of 6 to 10 kHz
    for (let t = 0, k = 0; t < x.length / sr - 0.01; k++) {
      grain(
        x,
        rnd,
        t,
        -Math.log(1 - rnd()) * 0.28,
        0.0015,
        6000 + 4000 * rnd(),
        1.5,
      );
      t += -Math.log(1 - rnd()) / 150;
      if (!(k & 31)) yield;
    }
    for (let t = 0, k = 0; t < x.length / sr - 0.05; k++) {
      const f = rnd() < 0.55 ? 750 * pow(2, rnd()) : 2800 * pow(2, rnd());
      bubble(
        x,
        t,
        pow(-Math.log(1 - rnd()), 2) * 0.05 * pow(f / 1200, 0.3),
        f,
        0.1 * rnd(),
      );
      t += -Math.log(1 - rnd()) / 120;
      if (!(k & 7)) yield;
    }
    yield* norm(x, 0.8);
  });
}
function* bakeCreek(rnd) {
  return yield* bed(6, LOW_SR, function* (x, sr) {
    yield* passes(
      x,
      white(rnd),
      biquad('bp', 1960, 0.7, 0, sr),
      wander(sr, rnd, 2.5, 4),
    );
    yield* norm(x, 0.8);
  });
}
function* bakeFalls(rnd) {
  return yield* bed(6, LOW_SR, function* (x, sr) {
    yield* passes(
      x,
      pink(rnd),
      biquad('hp', 220, 0.7, 0, sr),
      biquad('lp', 5080, 0.6, 0, sr),
      wander(sr, rnd, 1.5, 3),
    );
    yield* norm(x, 0.8);
  });
}
function* bakeLake(rnd) {
  // (steady: the swells are laid over it live, each its own strength, 3 to 6 s apart: audio.js)
  return yield* bed(8, LOW_SR, function* (x, sr) {
    yield* passes(
      x,
      pink(rnd),
      biquad('hp', 150, 0.7, 0, sr),
      biquad('lp', 1100, 0.7, 0, sr),
      wander(sr, rnd, 2, 3),
    );
    // plinks and small slaps on the stones, a few a second
    for (let t = 0, k = 0; t < x.length / sr - 0.2; k++) {
      if (rnd() < 0.7) bubble(x, t, 0.03, 300 + 900 * rnd(), 0.1, sr);
      else grain(x, rnd, t, 0.12, 0.03, 250 + 350 * rnd(), 1, 0.005, sr);
      t += -Math.log(1 - rnd()) / 4;
      if (!(k & 3)) yield;
    }
    yield* norm(x, 0.8);
  });
}

// ---------------------------------------------------------------- birds
// (11-sound-refs.md 6) A Steller's jay's "shook": a harsh rasp of 0.25 to 0.33 s, a stack of rough partials of a
// voice near 1 kHz (the 2 kHz one strongest, the rest falling off to 6 kHz, the 1 kHz one 15 dB down), the voice
// arching up by about a tenth over the note's first third and falling further over the rest, swelling in over 30 ms
// and dying over 80; each partial wavers on its own and all flutter fast (60 to 90 Hz). audio.js strings three to
// six 0.6 s apart, each its own level, the call sagging toward its end. Its rattle: eight 40 ms bursts at 6.5 a
// second, 1.5 to 5 kHz. A raven's croak: a rattle, a hoarse voice near 320 Hz broken into pulses 40 to 70 times a
// second (the close partials at 1, 1.3, 1.6 and 2 kHz, none much over its neighbours), arching in its first 0.12 s,
// then falling in pitch and level over 0.3 to 0.5 s
// A voice into a new array of `secs`: partials [multiple, level] of f0At(s), each with its own slow waver; its
// loudness shaken by `rough` (0 to 1) at about `flutter` Hz and, with `pulse` (Hz), broken into pulses at about
// that rate; noise of `breath` share through a band at `band` Hz; shape(s) its envelope
// (a generator: it yields every 2048 samples; f0At, shape and each partial's waver are read every 16)
function* voice(
  rnd,
  secs,
  f0At,
  partials,
  rough,
  flutter,
  breath,
  band,
  shape,
  pulse = 0,
) {
  const n = floor(secs * SR),
    x = alloc(n),
    noise = Float32Array.from({ length: n }, () => rnd() * 2 - 1),
    P = partials.length,
    mult = partials.map((p) => p[0]),
    level = partials.map((p) => p[1]),
    ph = partials.map(() => rnd()),
    wph = partials.map(() => rnd() * TAU),
    wrate = partials.map(() => 3 + 5 * rnd()),
    step = new Float64Array(P);
  filter(noise, 'bp', band, 1.2);
  // the shake: a random level at each flutter period, eased between (and a pitch shake with it); the pulses: each
  // its own length
  let a = 1,
    b = 1,
    left = 0,
    len = 1,
    jit = 0,
    env = 0,
    pph = 0,
    prate = pulse;
  for (let i = 0; i < n; i++) {
    if (left-- <= 0) {
      a = b;
      b = 1 - rough * rnd();
      len = left = floor(SR / (flutter * (0.8 + 0.4 * rnd())));
      jit = (rnd() - 0.5) * 0.04 * rough;
    }
    if (!(i & 15)) {
      const s = i / SR,
        f0 = (f0At(s) * (1 + jit)) / SR;
      env = shape(s);
      for (let k = 0; k < P; k++)
        step[k] = f0 * mult[k] * (1 + 0.006 * sin(wph[k] + TAU * wrate[k] * s));
    }
    let v = 0;
    for (let k = 0; k < P; k++) {
      ph[k] += step[k];
      v += level[k] * sin(TAU * ph[k]);
    }
    let beat = 1;
    if (pulse) {
      pph += prate / SR;
      if (pph >= 1) {
        pph -= 1;
        prate = pulse * (0.75 + 0.5 * rnd());
      }
      beat = sin(PI * pph) ** 2;
    }
    x[i] =
      (v * (1 - breath) + noise[i] * breath * 6) *
      (b + (a - b) * (left / len)) *
      beat *
      env;
    if (!(i & 2047)) yield;
  }
  return x;
}
// a note's edges: in over `att` s and out over `rel` s, each eased (no corner)
const edges = (s, secs, att, rel) =>
  sin(0.5 * PI * min(s / att, (secs - s) / rel, 1)) ** 2;
function* bakeBirds(rnd) {
  const shook = [];
  for (let v = 0; v < 6; v++) {
    const k = 0.97 + 0.06 * rnd(),
      secs = 0.25 + 0.08 * rnd(),
      arch = 0.07 + 0.06 * rnd(),
      drop = arch + 0.04 + 0.04 * rnd();
    const x = yield* voice(
      rnd,
      secs,
      // (up by `arch` over the first third, then down by `drop` from there)
      (s) => {
        const u = s / secs;
        return (
          1000 *
          k *
          (u < 1 / 3
            ? 1 + arch * sin(1.5 * PI * u)
            : 1 + arch - drop * ((u - 1 / 3) * 1.5) ** 1.3)
        );
      },
      [
        [1, 0.18],
        [2, 1],
        [3, 0.42],
        [4, 0.26],
        [5, 0.15],
        [6, 0.08],
      ],
      0.6,
      60 + 30 * rnd(),
      0.15,
      2300 * k,
      (s) => edges(s, secs, 0.03, 0.08),
    );
    filter(filter(x, 'hp', 900, 0.7), 'hp', 900, 0.7);
    shook.push(normNow(filter(x, 'lp', 6500, 0.7), 0.9));
    yield;
  }
  const rattle = alloc(floor(1.3 * SR));
  for (let p = 0; p < 8; p++)
    grain(rattle, rnd, p / 6.5, 1, 0.012, 2200 + 1500 * rnd(), 1.2);
  normNow(rattle, 0.9);
  yield;
  const croak = [];
  for (let v = 0; v < 4; v++) {
    const k = 0.94 + 0.12 * rnd(),
      fall = 0.3 + 0.2 * rnd(),
      secs = 0.12 + fall;
    const x = yield* voice(
      rnd,
      secs,
      // (up and down over the first 0.12 s, then sinking by a seventh)
      (s) =>
        k *
        (s < 0.12
          ? 320 + 40 * sin((PI * s) / 0.12)
          : 320 - 45 * ((s - 0.12) / fall)),
      [
        [1, 0.08],
        [2, 0.25],
        [3, 0.9],
        [4, 1],
        [5, 0.8],
        [6, 0.6],
        [7, 0.2],
        [8, 0.08],
      ],
      0.3,
      80,
      0.15,
      1300 * k,
      // (then down 10 dB as it sinks)
      (s) =>
        edges(s, secs, 0.02, 0.06) *
        (s < 0.12 ? 1 : pow(10, (-10 * (s - 0.12)) / fall / 20)),
      55,
    );
    filter(x, 'hp', 380, 0.7);
    croak.push(normNow(filter(x, 'lp', 2600, 0.7), 0.9));
    yield;
  }
  return { shook, rattle, croak };
}

// ---------------------------------------------------------------- the bank
// The bank, nothing made yet: steps, each surface's few (audio.js makes them), and bank.later, which puts each sound
// in the bank as it is done
export function bakeSounds() {
  const bank = { steps: SURFACES.map(() => []) };
  bank.later = bakeLater(bank);
  return bank;
}
// in the order they may be wanted: the wind, squelches and splashes, the water, the birds, the rain, thunder
function* bakeLater(bank) {
  const rnd = stream(2222),
    squelches = [],
    splashes = [];
  bank.wind = yield* bakeWind(rnd);
  for (let k = 0; k < 4; k++) {
    squelches.push(bakeSquelch(rnd));
    splashes.push(bakeSplash(rnd));
    yield;
  }
  bank.squelches = squelches;
  bank.splashes = splashes;
  bank.water = {};
  bank.water.brook = yield* bakeBrook(rnd);
  bank.water.lake = yield* bakeLake(rnd);
  bank.water.creek = yield* bakeCreek(rnd);
  bank.water.falls = yield* bakeFalls(rnd);
  bank.birds = yield* bakeBirds(rnd);
  bank.rain = yield* bakeRain(rnd);
  bank.thunder = yield* bakeThunder(rnd);
}
