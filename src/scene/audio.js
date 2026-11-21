// ============================================================================
// audio: the forest's sound, played (sounds.js makes it, at load)
// ============================================================================
// A small Web Audio graph made on the first touch once the forest is on screen, and a 10 Hz timer apart from the
// frame loop that reads the scene through `probe` and places and mixes the bank: footsteps by distance walked and
// what is underfoot, the rain by the weather and the crowns, the wind by the gust the trees lean by, thunder after
// each flash as late as it was far. Every type has its own gain (the debug menu's toggles and levels); the steps
// sink under the weather and never go; thunder pushes the rest down a little. Suspended while the tik is hidden.
import { abs, clamp, cos, exp, max, min, pow, sin } from './math.js';
import { makeStep, SHAPE_RATE, SURFACES, thunderShape } from './sounds.js';

// the frame state's slots audio.js reads (scene.js F)
const CX = 0,
  CZ = 2,
  YAW = 3,
  TIME = 16,
  RAIN = 25,
  WET = 28,
  STORM = 30,
  LT = 32,
  LD = 33,
  WIND = 35,
  SOAK = 36;
// (the limiter's own make-up gain, which Web Audio adds by its threshold and ratio, is some 7 dB: VOL is set for it)
const VOL = 0.46, // the master level: an ambient piece, quiet
  STEP_M = 1.7, // metres a step: the walk's 3.4 m/s at the two steps a second of the recordings
  STEP_DB = -13.5; // a step's peak against the master's: about -17 dBFS on gravel, slight
// each surface's own loudness (dB): grass and moss give little
const SURF_DB = [0, -1, -1, -5, -5, 0, 0, 0, 0, 1];
// the water's emitters: name, level at 2 m, how far it carries (m), how fast it falls off (a line, a point); a
// stream narrower than BROOK m half width is a brook
const WATERS = [
    ['brook', 1.5, 30, 0.75],
    ['creek', 0.4, 40, 0.75],
    ['falls', 0.55, 50, 1],
    ['lake', 0.6, 30, 0.75],
  ],
  BROOK = 0.9;
// thunder's level at 1.2 km, and its crack's over it
const THUNDER = 0.65,
  CRACK = 1.5;
// A ceiling at -6 dBFS: straight up to -9, then bending smoothly toward -6, which nothing passes
const CEILING = Float32Array.from({ length: 1025 }, (_, i) => {
  const x = i / 512 - 1,
    a = 0.35,
    c = 0.5;
  return abs(x) <= a
    ? x
    : Math.sign(x) * (a + (c - a) * Math.tanh((abs(x) - a) / (c - a)));
});
// The lake's swell: a level between swells, and one swell's shape up to `top` (rising over `rise` s, back over `fall`)
const SWELL_BASE = 0.2;
const swellCurve = (top, rise, fall) =>
  Float32Array.from({ length: 32 }, (_, i) => {
    const s = (i / 31) * (rise + fall),
      u =
        s < rise
          ? smooth01(s / rise)
          : (exp(-(3 * (s - rise)) / fall) - exp(-3)) / (1 - exp(-3));
    return SWELL_BASE + (top - SWELL_BASE) * u;
  });
const smooth01 = (x) => {
  const s = clamp(x, 0, 1);
  return s * s * (3 - 2 * s);
};
// the types of sound, each with a gain of its own: the debug menu turns each on or off and sets its level
export const TYPES = [
  'steps',
  'rain',
  'drips',
  'wind',
  'thunder',
  'brook',
  'creek',
  'falls',
  'lake',
  'jays',
  'ravens',
];
// each type's switch and level offset (dB), kept here so they hold before the first touch makes the graph
const trim = Object.fromEntries(TYPES.map((k) => [k, { on: true, db: 0 }]));
const trimGain = (k) => (trim[k].on ? pow(10, trim[k].db / 20) : 0);

// the timer's own cost, for the checks: ticks run, their total and longest milliseconds; the limiter's deepest
// reduction in the last offline render
const ticks = { n: 0, sum: 0, max: 0 };
let renderReduction = 0;
let AC = null,
  mix = null,
  timer = 0,
  bank = null,
  on = true;
// the bank sounds.js baked (scene.js hands it over at load)
export const setBank = (b) => (bank = b);
// a type's gain set to its switch and level (at once: a debug switch)
const retrim = (k) => mix && (mix.layer[k].gain.value = trimGain(k));
// how many bytes a bank's sample arrays hold
const bankBytes = (o) =>
  o instanceof Float32Array
    ? o.byteLength
    : o && typeof o === 'object'
      ? Object.values(o).reduce((s, v) => s + bankBytes(v), 0)
      : 0;

// The graph on context ac, fed by bank; probe: what the scene tells (see scene.js's sound block). Returns the tick
// and the voices the debug menu drives. Works on an OfflineAudioContext too (the checks render through it)
function makeMix(ac, probe) {
  const N = (C, o, ...to) => {
    const n = new C(ac, o);
    for (const d of to) n.connect(d);
    return n;
  };
  const G = (gain, ...to) => N(GainNode, { gain }, ...to);
  const BQ = (type, frequency, Q, gain, ...to) =>
    N(BiquadFilterNode, { type, frequency, Q, gain }, ...to);
  // master: a limiter that only thunder should reach (a downpour in a storm stays under it), then the ceiling (the
  // last node) that no peak passes
  const ceiling = N(WaveShaperNode, { curve: CEILING }, ac.destination),
    lim = N(
      DynamicsCompressorNode,
      { threshold: -13, knee: 0, ratio: 20, attack: 0.002, release: 0.3 },
      ceiling,
    ),
    out = G(0, lim);
  // each type: its own gain (the debug menu's toggle and level), then how far thunder has pushed it down (calm)
  const calm = Object.fromEntries(TYPES.map((k) => [k, G(1, out)])),
    layer = Object.fromEntries(TYPES.map((k) => [k, G(trimGain(k), calm[k])]));
  // the feet: left and right a little apart, then the wet ground's middle, the highs the rain masks, the wet
  // leaves' dullness, and how far under the weather they sink
  const duck = G(1, layer.steps),
    open = ac.sampleRate / 2, // (a low pass at the top of the band lets everything through)
    dull = BQ('lowpass', open, 0.7, 0, duck),
    mask = BQ('highshelf', 2000, 0.7, 0, dull),
    wetEq = BQ('peaking', 1100, 0.7, 0, mask),
    // (left and right a little different in tone too: one foot 1.5 dB brighter above 2 kHz, the other duller)
    feet = [-0.08, 0.08].map((pan, k) =>
      N(
        StereoPannerNode,
        { pan },
        BQ('highshelf', 2000, 0.7, k ? -1.5 : 1.5, wetEq),
      ),
    );
  // the rain: hiss and patter each at two speeds (their loops never line up), dulled under the crowns; drops on
  // water near the lake; drips one at a time, from four places round
  const rainDull = BQ('lowpass', 9000, 0.7, 0, layer.rain),
    loop = (buffer, rate, ...to) => {
      const s = N(
        AudioBufferSourceNode,
        { buffer: buffer.ab, loop: true, playbackRate: rate },
        ...to,
      );
      s.start(ac.currentTime, Math.random() * buffer.ab.duration);
      s.rate = s.nominal = rate;
      return s;
    };
  const hiss = G(0, rainDull),
    patter = G(0, rainDull),
    onWater = G(0, layer.rain);
  // (the beds' speeds wander a little, each its own way, so no loop comes round the same twice)
  const beds = [];
  // a bed made in idle time (sounds.js bank.later) starts once it is there
  const waiting = [],
    when = (ready, start) =>
      ready() ? start() : waiting.push({ ready, start });
  when(
    () => bank.rain,
    () => {
      const R = bank.rain;
      beds.push(
        loop(R.hiss, 1, hiss),
        loop(R.hiss, 0.93, hiss),
        loop(R.patter, 1, patter),
        loop(R.patter, 0.91, patter),
        loop(R.water, 1, onWater),
      );
    },
  );
  const dripPans = [-0.7, -0.25, 0.25, 0.7].map((pan) =>
    N(StereoPannerNode, { pan }, layer.drips),
  );
  // the wind: the sough as it is, and again through a band that rises as a gust comes (0.8 to 1.8 kHz); two faint
  // whistles of the needles, higher in a stronger wind; one bed at two speeds
  const windG = G(0, layer.wind),
    windBand = BQ('bandpass', 800, 0.3, 0, windG),
    whistleG = G(0, layer.wind),
    whistles = [800, 1300].map((f) => BQ('bandpass', f, 15, 0, whistleG));
  when(
    () => bank.wind,
    () =>
      beds.push(
        loop(bank.wind, 1, windBand, windG, ...whistles),
        loop(bank.wind, 0.94, windBand, windG),
      ),
  );
  // one-shot voices: buffer at t through gain g into `to` (a new source each time: they cannot be restarted)
  const shot = (buffer, t, g, to, rate = 1) => {
    const s = N(AudioBufferSourceNode, {
        buffer: buffer.ab,
        playbackRate: rate,
      }),
      v = G(g, to);
    s.connect(v);
    s.start(t);
    s.onended = () => v.disconnect();
    return v;
  };
  // Thunder from t0, d km off, from `bearing` (-1 left to 1 right): the roll under a shape drawn anew each time
  // (sounds.js thunderShape: near, up at once and 20 dB down 2.4 to 2.8 s after; far, a swell from nothing), and
  // near, a crack over it. Far its top and its bottom go (high sounds die first with distance); it starts where the
  // flash was and drifts toward the middle; everything else is pushed down under it a while
  const thunder = (t0, d, bearing) => {
    const TH = bank.thunder;
    if (!TH) return;
    const far = clamp((d - 1) / 5, 0, 1),
      shape = thunderShape(far, Math.random),
      secs = (shape.length - 1) / SHAPE_RATE,
      peak = THUNDER * pow(1.2 / max(d, 0.8), 0.6), // (0 dB at 1.2 km, -8 at 6)
      pan = N(StereoPannerNode, { pan: bearing }, layer.thunder),
      // (fitted to the near and the distant recordings' octaves)
      hp = BQ('highpass', 60 + 15 * d, 0.7, 0, pan),
      lp = BQ('lowpass', 2400 * pow(1 + d, -0.75), 0.7, 0, hp),
      env = G(0, lp),
      // (far, played slower: lower, and its bursts drawn out)
      src = N(
        AudioBufferSourceNode,
        {
          buffer: TH.rumble.ab,
          loop: true,
          playbackRate: (1 - 0.3 * far) * (0.92 + 0.16 * Math.random()),
        },
        env,
      );
    let top = 0;
    for (let i = 0; i < shape.length; i++) {
      shape[i] *= peak;
      if (shape[i] > shape[top]) top = i;
    }
    pan.pan.setTargetAtTime(bearing * 0.3, t0 + 0.3, 0.6);
    env.gain.setValueCurveAtTime(shape, t0, secs);
    src.start(t0, Math.random() * TH.rumble.ab.duration);
    src.stop(t0 + secs + 0.05);
    src.onended = () => {
      for (const n of [env, lp, hp, pan]) n.disconnect();
    };
    if (d < 3) {
      const crackLp = BQ('lowpass', 8000 / Math.sqrt(1 + d), 0.7, 0, pan);
      shot(TH.crack, t0, CRACK * peak * (1 - d / 3), crackLp);
    }
    quiet = t0 + 20;
    // (the rest pushed down under it: the rain 3 dB, the others 6, over 0.15 s; back over 2 s)
    for (const k of TYPES) {
      if (k === 'thunder') continue;
      const c = calm[k].gain;
      c.setTargetAtTime(k === 'rain' || k === 'drips' ? 0.7 : 0.5, t0, 0.05);
      c.setTargetAtTime(1, t0 + top / SHAPE_RATE + 0.5, 0.7);
    }
  };
  // Running water and the lake, each from where it is: the nearest brook (a stream under BROOK m half width), the
  // nearest creek, the nearest fall's lip, the lake's shore. Each loop through a low pass that closes and a level
  // that falls with its distance (a stream is a line: it falls off slower than a point), from its bearing
  const emitter = (name) => {
      const g = G(0, layer[name]),
        pan = N(StereoPannerNode, {}, g),
        lp = BQ('lowpass', 8000, 0.7, 0, pan),
        // (the lake: its loop at two speeds under the swells, which come live)
        lake = name === 'lake',
        swell = lake ? G(SWELL_BASE, lp) : lp;
      when(
        () => bank.water?.[name],
        () =>
          beds.push(
            loop(bank.water[name], 1, swell),
            ...(lake ? [loop(bank.water[name], 0.93, swell)] : []),
          ),
      );
      return { g, pan, lp, swell, d: 1e9, b: 0 };
    },
    em = {
      brook: emitter('brook'),
      creek: emitter('creek'),
      falls: emitter('falls'),
      lake: emitter('lake'),
    };
  // A bird's call at t, d m off at `bearing`: a jay's three to six "shook" 0.6 s apart (a rattle after one in
  // three), a raven's two to four croaks a second or more apart; dulled and quieter with distance
  let quiet = 0, // (no song till then: birds hush in thunder)
    calls = 0;
  const call = (t, species, d, bearing) => {
    const BI = bank.birds;
    if (!BI) return t;
    calls++;
    const jay = species === 'jay',
      g = G(
        jay ? 0.35 * (10 / (10 + d)) : 0.45 * (15 / (15 + d)),
        layer[jay ? 'jays' : 'ravens'],
      ),
      pan = N(StereoPannerNode, { pan: clamp(bearing, -1, 1) * 0.9 }, g),
      lp = BQ('lowpass', 8000 / (1 + d / 50), 0.7, 0, pan);
    let at = t;
    if (jay) {
      // (each note its own level, +-3 dB; the call sagging toward its end, in pitch and loudness)
      for (let k = 0, n = 3 + ((Math.random() * 4) | 0); k < n; k++) {
        shot(
          BI.shook[(Math.random() * BI.shook.length) | 0],
          at,
          pow(10, (Math.random() * 6 - 3) / 20) * (1 - 0.05 * k),
          lp,
          (1 - 0.012 * k) * (0.98 + 0.04 * Math.random()),
        );
        at += 0.55 + 0.1 * Math.random();
      }
      if (Math.random() < 1 / 3) {
        shot(BI.rattle, at + 0.2, 0.8, lp);
        at += 1.5;
      }
    } else
      for (let k = 2 + ((Math.random() * 3) | 0); k > 0; k--) {
        shot(
          BI.croak[(Math.random() * BI.croak.length) | 0],
          at,
          1,
          lp,
          0.97 + 0.06 * Math.random(),
        );
        at += 1 + 0.8 * Math.random();
      }
    setTimeout(
      () => {
        lp.disconnect();
        pan.disconnect();
        g.disconnect();
      },
      (at - ac.currentTime + 2) * 1000,
    );
    return at;
  };
  // A step at t on surface code (SURFACES), the wetness and puddles of the ground now; left and right in turn. One
  // of the surface's few not played yet if there is one: the idle work makes each played one anew
  let foot = 0,
    steps = 0;
  const step = (t, code, wet, soak) => {
    foot ^= 1;
    steps++;
    here = code;
    idleDue = true;
    const lv = pow(
        10,
        (STEP_DB + SURF_DB[code] + (Math.random() * 6 - 3)) / 20,
      ),
      kind = SURFACES[code],
      soft = code <= 4;
    const pool = bank.steps[code],
      k0 = (Math.random() * pool.length) | 0;
    if (!pool.length) return; // (none made yet: the first moments after the forest is shown)
    let buffer = pool[k0];
    for (let k = 0; k < pool.length && buffer.used; k++)
      buffer = pool[(k0 + k) % pool.length];
    buffer.used = true;
    const g = shot(
      buffer,
      t,
      lv,
      feet[foot],
      (foot ? 0.985 : 1.015) * (0.97 + 0.06 * Math.random()),
    );
    // wet ground: a shorter tail, and on soft ground a squelch
    if (wet > 0.3 && kind !== 'water') {
      g.gain.setTargetAtTime(0, t + 0.12, 0.25 - 0.18 * wet);
      if (soft && bank.squelches && Math.random() < wet * 0.6)
        shot(
          bank.squelches[(Math.random() * 4) | 0],
          t + 0.02,
          lv * 0.35 * wet,
          feet[foot],
        );
    }
    // a puddle on the dirt track or the grass track's ruts (and now and then on gravel) after long rain
    const puddly =
      kind === 'dirt' || kind === 'grass' ? 0.35 : kind === 'gravel' ? 0.1 : 0;
    if (bank.splashes && Math.random() < puddly * soak)
      shot(
        bank.splashes[(Math.random() * 4) | 0],
        t + 0.01,
        lv * 0.8,
        feet[foot],
      );
  };
  // the state the timer keeps: where the walker was, how far it has walked, where the next step falls; the crowns
  // and the lake round it (sampled twice a second)
  const F = probe.F;
  let lt = ac.currentTime,
    lx = F[CX],
    lz = F[CZ],
    walked = 0,
    nextStep = 0.4,
    canopy = 0,
    lake = 0,
    look = 0,
    nextDrip = lt,
    lastFlash = F[LT],
    drift = 1,
    nextSwell = lt,
    swellEnd = 0,
    period = 4.5;
  const busy = []; // (when each bird may call again)
  const set = (param, v, t, tau) => param.setTargetAtTime(v, t, tau);
  out.gain.setTargetAtTime(VOL, lt, 0.7); // (fades in over two seconds: never a bang on the first touch)
  const tick = () => {
    const now = ac.currentTime,
      t = now + 0.05,
      dt = now - lt;
    if (dt <= 0) return;
    for (let i = waiting.length; i--;)
      if (waiting[i].ready()) {
        waiting[i].start();
        waiting.splice(i, 1);
      }
    let v = Math.hypot(F[CX] - lx, F[CZ] - lz) / dt;
    if (!(v < 30)) v = 0; // (a jump to a viewpoint, or the first tick after a pause)
    lt = now;
    lx = F[CX];
    lz = F[CZ];
    if (now > look) {
      canopy = probe.canopy(lx, lz);
      lake = probe.lake(lx, lz);
      look = now + 0.5;
      // the water round: each emitter's distance and bearing (against the way the walker faces)
      const S = probe.streams,
        cy = cos(F[YAW]),
        sy = sin(F[YAW]),
        near = { brook: [1e9, 0, 0], creek: [1e9, 0, 0], falls: [1e9, 0, 0] };
      for (let i = 0; i < S.length; i += 4) {
        const dx = S[i] - lx,
          dz = S[i + 1] - lz,
          d = dx * dx + dz * dz,
          k = S[i + 3] ? 'falls' : S[i + 2] < BROOK ? 'brook' : 'creek';
        if (d < near[k][0]) near[k] = [d, dx, dz];
      }
      for (const k of ['brook', 'creek', 'falls']) {
        const [d2, dx, dz] = near[k],
          d = Math.sqrt(d2);
        em[k].d = d;
        em[k].b = d > 0.5 ? (dx * cy + dz * sy) / d : 0;
      }
      const [sd, sx, sz] = probe.shore(lx, lz);
      em.lake.d = sd;
      em.lake.b =
        sd > 0.5 ? (sx * cy + sz * sy) / (Math.hypot(sx, sz) || 1) : 0;
    }
    const rain = clamp(F[RAIN], 0, 1),
      wet = clamp(F[WET], 0, 1),
      soak = clamp(F[SOAK], 0, 1),
      storm = clamp(F[STORM], 0, 1),
      wind = clamp(F[WIND], 0, 1);
    // the rain: patter first (a few drops), the hiss as it grows; fuller in the open, duller and thinner under the
    // crowns, which hold some of it back; the hiss drifts +-1.5 dB on a slow random walk (its loops never show)
    drift = clamp(drift * pow(10, (Math.random() - 0.5) * 0.012), 0.84, 1.19);
    for (const b of beds) {
      b.rate = clamp(
        b.rate * (1 + (Math.random() - 0.5) * 0.004),
        b.nominal * 0.97,
        b.nominal * 1.03,
      );
      set(b.playbackRate, b.rate, t, 0.5);
    }
    // (no leaves over open water: the patter gives way to the drops on it)
    set(
      hiss.gain,
      0.28 * pow(rain, 1.8) * (1.25 - 0.45 * canopy) * (1 - 0.3 * lake) * drift,
      t,
      0.6,
    );
    set(
      patter.gain,
      0.3 * pow(rain, 0.5) * (1 - 0.3 * canopy) * (1 - 0.8 * lake),
      t,
      0.6,
    );
    set(rainDull.frequency, 9000 - 5500 * canopy, t, 0.6);
    set(onWater.gain, 0.4 * rain * lake, t, 0.6);
    // the water: within its reach, louder and brighter as the walker nears it; streams up 3 dB after long rain
    for (const [k, g0, reach, p] of WATERS) {
      const e = em[k],
        d = max(e.d, 0),
        on = d < reach ? 1 - smooth01((d - reach * 0.7) / (reach * 0.3)) : 0;
      set(
        e.g.gain,
        g0 * pow(2 / (2 + d), p) * on * (k === 'lake' ? 1 : 1 + 0.4 * soak),
        t,
        0.3,
      );
      set(e.lp.frequency, 1200 + 9000 * Math.exp(-d / 25), t, 0.3);
      set(e.pan.pan, 0.9 * e.b, t, 0.08);
    }
    // the lake's swells, laid on live within its reach: each its own strength and length, the time to the next
    // wandering between 3 and 6 s (one never starts before the last has ended)
    if (em.lake.d < 30 && nextSwell < t + 0.2) {
      const at = max(nextSwell, t, swellEnd + 0.01),
        rise = 0.35 + 0.35 * Math.random(),
        fall = 0.9 + 0.9 * Math.random();
      em.lake.swell.gain.setValueCurveAtTime(
        swellCurve(0.4 + 0.6 * Math.random(), rise, fall),
        at,
        rise + fall,
      );
      swellEnd = at + rise + fall;
      period = clamp(period + (Math.random() - 0.5) * 1.6, 3, 6);
      nextSwell = at + period;
    } else if (em.lake.d >= 30) nextSwell = t;
    // the birds: each now and then, more often in flight; less in rain, none in thunder or a downpour
    if (now > quiet && rain < 0.8)
      probe.birds().forEach((bird, i) => {
        const jay = bird.species === 'jay',
          dx = bird.at[0] - lx,
          dz = bird.at[2] - lz,
          d = Math.hypot(dx, dz);
        if (d > (jay ? 80 : 150) || now < (busy[i] || 0)) return;
        const flying = bird.state === 'flying',
          rate =
            (jay ? (flying ? 1 / 8 : 1 / 90) : flying ? 1 / 15 : 1 / 80) *
            (1 - rain);
        if (Math.random() < rate * dt)
          busy[i] =
            call(
              t,
              bird.species,
              d,
              (dx * cos(F[YAW]) + dz * sin(F[YAW])) / max(d, 1),
            ) + 4;
      });
    // the wind: the gust the trees lean by (the shaders' sway at the walker), heard half a second before the near
    // boughs move, times the weather's wind; a storm deepens the gusts
    const T = F[TIME],
      gust = clamp(
        (0.5 + 0.5 * sin((T + 0.5) * 0.45 - 0.045 * lx - 0.02 * lz)) *
          (1 + 0.5 * storm),
        0,
        1.4,
      ),
      blow = wind + 0.12 * sin(T * 0.21);
    // (a gust 0.5 dB over the mean and a lull as much under; 1.5 in a storm: the recordings' gentle swell; a storm's
    // wind 4 dB under the clear day's scale, so a downpour in it stays under the limiter)
    set(
      windG.gain,
      0.18 *
        blow *
        (1 - 0.37 * storm) *
        pow(10, ((0.5 + storm) * (gust - 0.5) * 2) / 20),
      t,
      0.5,
    );
    set(
      windBand.frequency,
      (700 + 800 * min(gust, 1) ** 2) * (1 - 0.2 * storm),
      t,
      0.5,
    );
    set(
      whistleG.gain,
      0.3 * pow(gust, 2) * blow * blow * (1 - 0.37 * storm),
      t,
      0.5,
    );
    whistles.forEach((w, k) =>
      set(
        w.frequency,
        (700 + 900 * blow) * (k ? 1.6 : 1) * (0.95 + 0.1 * gust),
        t,
        1,
      ),
    );
    // thunder: each new flash heard F[LD] / 343 s after it struck (as much of that as is left), from its bearing
    if (F[LT] !== lastFlash) {
      lastFlash = F[LT];
      const FL = probe.flash,
        len = Math.hypot(FL[0], FL[2]) || 1,
        bearing = (FL[0] * cos(F[YAW]) + FL[2] * sin(F[YAW])) / len;
      thunder(
        now + max(F[LD] / 343 - (T - F[LT]), 0.05),
        F[LD] / 1000,
        clamp(bearing, -1, 1) * 0.8,
      );
    }
    // drips off the crowns: under them, in rain and for a while after it
    const drips = (0.5 + 5 * canopy) * max(rain, wet * 0.6);
    while (drips > 0.05 && bank.rain && nextDrip < t + 0.1) {
      const R = bank.rain;
      nextDrip = max(nextDrip, now) - Math.log(1 - Math.random()) / drips;
      shot(
        R.drips[(Math.random() * R.drips.length) | 0],
        nextDrip,
        0.05 + 0.12 * Math.random() * canopy,
        dripPans[(Math.random() * 4) | 0],
        0.85 + 0.3 * Math.random(),
      );
    }
    if (drips <= 0.05) nextDrip = now;
    // the feet: wet ground's middle up to +6 dB, the highs the rain masks cut, dull wet leaves; and under the
    // weather they sink, to 14 dB down at the most (never gone), and come back as it eases
    const weather = max(pow(rain, 0.7), 0.8 * storm, (wind - 0.5) * 1.2);
    set(wetEq.gain, 6 * wet, t, 0.5);
    set(mask.gain, -8 * rain, t, 0.5);
    set(duck.gain, pow(10, (-14 * clamp(weather, 0, 1)) / 20), t, 0.8);
    // footsteps: those that fall before the next tick are placed inside it, so their rhythm is not the timer's
    walked += v * dt;
    if (v > 0.5)
      while (nextStep - walked < v * 0.1) {
        const at = t + max(nextStep - walked, 0) / v,
          code = probe.surface(lx, lz);
        set(
          dull.frequency,
          SURFACES[code] === 'leaves' ? 2500 + (open - 2500) * (1 - wet) : open,
          at,
          0.01,
        );
        step(at, code, wet, soak);
        // (+-8 percent, and one foot's stride 2 percent longer than the other's)
        nextStep +=
          STEP_M * (0.92 + 0.16 * Math.random()) * (foot ? 1.02 : 0.98);
      }
    else nextStep = walked + 0.4;
  };
  return {
    tick,
    out,
    lim,
    layer,
    step,
    thunder,
    call,
    steps: () => steps,
    calls: () => calls,
    water: () =>
      Object.entries(em).map(([k, e]) => [
        k,
        +e.d.toFixed(1),
        +e.g.gain.value.toFixed(3),
        +e.pan.pan.value.toFixed(2),
      ]),
  };
}

// ---------------------------------------------------------------- idle work
// A step for each surface (the one underfoot first), the bank's later bakes (sounds.js bank.later), then each
// surface's few grown to POOL and each played one made anew. A piece at a time in slices of at most SLICE ms, each
// posted after a frame whose own work left room for it (soundFrame), so never inside a frame
const POOL = 4, // steps kept of each surface
  SLICE = 3; // ms
// the first step of each surface, the cheapest first (the first ones are made before the code is warm)
const FIRST = [8, 3, 9, 4, 7, 6, 5, 2, 1, 0];
let here = 8, // the surface underfoot
  idleDue = true, // (false once there is nothing to do, till the next step)
  posted = false;
const stale = (pool) => pool.length < POOL || pool.some((v) => v.used);
// one piece of the work; false when there is none
function idleWork() {
  const S = bank.steps;
  let code = S[here].length ? (FIRST.find((k) => !S[k].length) ?? -1) : here;
  if (code < 0 && bank.later) {
    if (bank.later.next().done) bank.later = null;
    return true;
  }
  if (code < 0) code = stale(S[here]) ? here : S.findIndex(stale);
  if (code < 0) return false;
  const pool = S[code],
    fresh = makeStep(SURFACES[code], Math.random);
  if (pool.length < POOL) pool.push(fresh);
  else pool[pool.findIndex((v) => v.used)] = fresh;
  return true;
}
// all of it at once (the checks)
const finishBank = () => {
  while (idleWork());
};
const idle =
  typeof requestIdleCallback === 'function'
    ? (f) => requestIdleCallback(f, { timeout: 500 })
    : (f) => setTimeout(f, 0);
// the idle work's cost, for the checks: slices run, their total and longest ms, when the bank was done (s after the
// first slice)
const slices = { n: 0, sum: 0, max: 0, first: 0, done: 0 };
function slice(deadline) {
  posted = false;
  const t0 = performance.now(),
    room =
      deadline && !deadline.didTimeout
        ? clamp(deadline.timeRemaining(), 1, SLICE)
        : SLICE;
  // (a piece is begun only if one as long as the last still fits)
  let last,
    t1 = t0;
  do {
    if (!idleWork()) {
      idleDue = false;
      break;
    }
    last = performance.now() - t1;
    t1 += last;
  } while (t1 + last < t0 + room);
  t1 = performance.now();
  slices.n++;
  slices.sum += t1 - t0;
  slices.max = max(slices.max, t1 - t0);
  slices.first ||= t0;
  if (!bank.later && !slices.done) slices.done = (t1 - slices.first) / 1000;
}
// After each frame once the forest is shown (scene.js), with what the frame's own work cost (ms)
export function soundFrame(cpu) {
  if (posted || !idleDue || !bank || cpu > 8) return;
  posted = true;
  idle(slice);
}

// ---------------------------------------------------------------- the platform
// The first touch with the forest on screen (scene.js wake): the context made, or resumed if it was suspended.
// Browsers allow sound only after a gesture; in the host's app it may sound at once, but it waits for a touch too
export function sound(probe) {
  if (!bank) return;
  if (!AC) {
    AC = new AudioContext({ latencyHint: 'playback' });
    mix = makeMix(AC, probe);
    if (!on) mix.out.gain.cancelScheduledValues(0).value = 0;
  }
  soundResume();
}
// The timer and the context run only while the tik is on screen and the sound is on
export function soundResume() {
  if (!AC || !on) return;
  // (refused without a recent touch, or interrupted on iOS: the next touch retries through sound())
  if (AC.state !== 'running') AC.resume().catch(() => {});
  if (!timer)
    timer = setInterval(() => {
      const t0 = performance.now();
      mix.tick();
      const ms = performance.now() - t0;
      ticks.n++;
      ticks.sum += ms;
      ticks.max = max(ticks.max, ms);
    }, 100);
}
export function soundPause() {
  if (!AC) return;
  AC.suspend().catch(() => {});
  clearInterval(timer);
  timer = 0;
}

// ---------------------------------------------------------------- the debug menu's and the checks' handles
export const soundDebug = {
  // the sound on or off (it fades either way)
  master(v) {
    if (v !== undefined && !!v !== on) {
      on = !!v;
      if (mix) mix.out.gain.setTargetAtTime(on ? VOL : 0, AC.currentTime, 0.15);
      // (off: the context and the timer stop once it has faded)
      if (on) soundResume();
      else setTimeout(() => on || soundPause(), 800);
    }
    return on;
  },
  // a type on or off (undefined: as it is); returns whether it is on
  type(name, v) {
    if (!trim[name]) return false;
    if (v !== undefined) {
      trim[name].on = !!v;
      retrim(name);
    }
    return trim[name].on;
  },
  // a type's level offset in dB (undefined: as it is); returns it
  level(name, db) {
    if (!trim[name]) return 0;
    if (db !== undefined && Number.isFinite(db)) {
      trim[name].db = clamp(db, -30, 12);
      retrim(name);
    }
    return trim[name].db;
  },
  // each type: its name, on, level offset (dB) and its gain node's value now (null before the first touch)
  levels: () =>
    TYPES.map((k) => [
      k,
      trim[k].on,
      trim[k].db,
      mix ? +mix.layer[k].gain.value.toFixed(4) : null,
    ]),
  // four steps on a surface now (wet 0 or 1), whatever is underfoot
  stepOn(surface, wet = 0) {
    const code = SURFACES.indexOf(surface);
    if (!mix || code < 0) return -1;
    for (let k = 0; k < 4; k++)
      mix.step(AC.currentTime + 0.1 + k * 0.5, code, wet, 0);
    return code;
  },
  // thunder now, d km off, ahead
  thunderNow(d) {
    if (!mix) return -1;
    mix.thunder(AC.currentTime + 0.1, d, 0);
    return d;
  },
  // a bird's call now, d m off, ahead (species: jay or raven)
  callNow(species, d) {
    if (!mix) return -1;
    mix.call(AC.currentTime + 0.1, species, d, 0);
    return d;
  },
  // the limiter's gain reduction (dB, 0 when it is idle): now, and the deepest in the last render (read each 0.1 s)
  reduction: () => [
    mix ? +mix.lim.reduction.toFixed(2) : 0,
    +renderReduction.toFixed(2),
  ],
  // the water round the walker: each emitter's name, metres off, level and pan
  water: () => (mix ? mix.water() : []),
  // the context's state, the steps and the birds' calls so far; the timer's ticks, their mean and longest ms; the
  // bank's buffers in MB; the idle slices, their total and longest ms, and when the bank was done (s)
  state: () => [
    AC ? AC.state : 'none',
    mix ? mix.steps() : 0,
    mix ? mix.calls() : 0,
    ticks.n,
    +(ticks.sum / max(ticks.n, 1)).toFixed(3),
    +ticks.max.toFixed(2),
    bank ? +(bankBytes(bank) / 1048576).toFixed(2) : 0,
    slices.n,
    +slices.sum.toFixed(1),
    +slices.max.toFixed(2),
    +slices.done.toFixed(2),
  ],
  // Renders `secs` of the mix offline (mono, sounds.js's rate) with the frame state F given and a walk at speed v
  // m/s on surface `code` (probe's surface for every step), canopy and lake as given; flashes: [second, metres off]
  // each, straight ahead; water: { streams: [x, z, half width, lip]..., shore: [m, dx, dz] }; birds: what
  // probe.birds lists; solo: the types heard (a comma list; none: all): the checks' clips. The scene's clock runs on
  // with the clip
  async render(
    secs,
    F,
    v,
    code,
    canopy = 0,
    lake = 0,
    solo = '',
    flashes = [],
    water = {},
    birds = [],
  ) {
    const ac = new OfflineAudioContext(1, Math.ceil(secs * 22050), 22050),
      probe = {
        F,
        surface: () => code,
        canopy: () => canopy,
        lake: () => lake,
        flash: [sin(F[YAW]), 0.5, -cos(F[YAW]), 0, 0],
        streams: water.streams || [],
        shore: () => water.shore || [1e9, 0, 0],
        birds: () => birds,
      },
      m = (finishBank(), makeMix(ac, probe)),
      only = solo ? solo.split(',') : TYPES;
    m.out.gain.value = VOL;
    // (the mix as made: the debug levels left out)
    for (const k of TYPES) m.layer[k].gain.value = only.includes(k) ? 1 : 0;
    // the timer's ticks, every 0.1 s of the clip, the walker moving on at v
    for (let k = 1; k < secs * 10 - 1e-6; k++) {
      const t = k / 10;
      ac.suspend(t).then(() => {
        F[CX] += v * 0.1;
        F[TIME] += 0.1;
        for (const [at, metres] of flashes)
          if (at > t - 0.1 && at <= t) {
            F[LT] = F[TIME];
            F[LD] = metres;
          }
        m.tick();
        // (from 3 s on: the limiter starts some 14 dB down and takes that long to let go)
        if (t >= 3) renderReduction = min(renderReduction, m.lim.reduction);
        ac.resume();
      });
    }
    renderReduction = 0;
    const buf = await ac.startRendering();
    return buf.getChannelData(0);
  },
};
