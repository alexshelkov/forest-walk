import { clamp, exp, hypot, max, pow, rnd, rr } from './math.js';

// ============================================================================
// audio: procedural forest ambience (no sample files)
// ============================================================================
// A fixed Web Audio graph, built on the first touch and driven by a 10 Hz timer, not the frame loop.
// Layers: wind, rain and thunder, the creek, footsteps, birdsong, an owl, crickets and drips.
// cam is scene.js's frame state: 0-2 the walker's position, 25 rain (0 dry, 1 pouring), 26 how near water is,
// 27 on the gravel trail (1) or on leaves (0), 28 how wet the forest is.
let AC,
  tick,
  timer = 0;
const VOL = 0.8; // master level: about -18 LUFS in dry weather
const STRIDE = 0.75; // metres walked per footstep
function mkSound(ac, cam) {
  const sr = ac.sampleRate;
  // node of class C with options o, connected to every node / param in `to`; sources start at once
  const N = (C, o, ...to) => {
    const n = new C(ac, o);
    for (const d of to) n.connect(d);
    if (n.start) n.start();
    return n;
  };
  const G = (gain, ...to) => N(GainNode, { gain }, ...to);
  const BQ = (type, frequency, Q, ...to) =>
    N(BiquadFilterNode, { type, frequency, Q }, ...to);
  const lfo = (frequency, depth, to) =>
    N(OscillatorNode, { frequency }, G(depth, to));
  const noise = (secs, f) => {
    const n = (sr * secs) | 0,
      b = new AudioBuffer({ length: n, numberOfChannels: 2, sampleRate: sr });
    f(b.getChannelData(0), n);
    f(b.getChannelData(1), n);
    return b;
  };
  // seamless brown noise loop (the end cross-fades into the start): wind and thunder
  const nb = noise(11, (d, n) => {
    for (let i = 0, b = 0; i < n + 4096; i++) {
      b = (b + 0.02 * (rnd() * 2 - 1)) / 1.02;
      if (i < n) d[i] = b * 3.5;
      else {
        const k = (i - n) / 4096;
        d[i - n] = d[i - n] * k + b * 3.5 * (1 - k);
      }
    }
  });
  // white noise loop: rain, the creek and footsteps (its samples are unrelated, so the loop has no seam)
  const nw = noise(3, (d, n) => {
    for (let i = 0; i < n; i++) d[i] = rnd() * 2 - 1;
  });
  // reverb impulse: 2.5 s of noise that fades out and gets darker, shorter and drier than a hall
  const ir = noise(2.5, (d, n) => {
    for (let i = 0, b = 0; i < n; i++) {
      const t = i / sr;
      b += (rnd() * 2 - 1 - b) * (0.08 + 0.6 * exp(-t * 4));
      d[i] = b * (1 - exp(-t * 60)) * exp(-t * 2.6) * (1 - i / n);
    }
  });

  const lim = N(
    DynamicsCompressorNode,
    { threshold: -6, knee: 6, ratio: 20, attack: 0.003, release: 0.3 },
    ac.destination,
  );
  const out = G(0, lim),
    wet = N(ConvolverNode, { buffer: ir }, out);
  const src = (buffer, playbackRate, ...to) =>
    N(AudioBufferSourceNode, { buffer, loop: true, playbackRate }, ...to);
  // wind in the canopy: a low band that swells in slow gusts, and a thin rustle of leaves over it
  const wind = G(0.2, out),
    gust = G(1, wind);
  src(nb, 0.8, BQ('bandpass', 420, 0.5, gust));
  src(nw, 0.6, BQ('bandpass', 2600, 0.7, G(0.035, gust)));
  lfo(0.07, 0.3, gust.gain);
  lfo(0.113, 0.22, gust.gain);
  // rain: a soft hiss and a lower patter on the leaves, the same noise at two speeds so the loops never line up
  const rain = G(0, out);
  src(nw, 1, BQ('bandpass', 5000, 0.5, G(0.12, rain)));
  src(nw, 0.71, BQ('bandpass', 850, 0.6, G(0.2, rain)));
  // thunder: low noise let through in a burst, most of it by way of the reverb
  const thunder = G(0, out, G(1.4, wet));
  src(nb, 0.45, BQ('lowpass', 240, 0.6, thunder));
  // creek and lake shore: noise through two narrow bands whose pitch wanders, which is what makes it babble
  const creek = G(0, out),
    c1 = BQ('bandpass', 1100, 2.2, creek),
    c2 = BQ('bandpass', 2400, 3, G(0.6, creek));
  src(nw, 0.83, c1, c2);
  lfo(3.1, 320, c1.frequency);
  lfo(0.37, 200, c1.frequency);
  lfo(4.7, 600, c2.frequency);
  lfo(0.53, 300, c2.frequency);
  // footsteps: the noise through one band, opened for a moment per step
  const stepG = G(0, out),
    stepF = BQ('bandpass', 900, 0.9, stepG);
  src(nw, 1.31, stepF);
  // crickets: a high tone cut into fast pulses, the pulses into chirps
  const cricket = G(0, out),
    chirp = G(0.55, cricket),
    pulse = G(0.5, chirp);
  N(OscillatorNode, { frequency: 4350 }, pulse);
  lfo(31, 0.5, pulse.gain);
  lfo(1.3, 0.45, chirp.gain);
  // pooled voices: oscillator -> envelope -> pan -> dry + reverb
  const pool = (n, send, type) =>
    Array.from({ length: n }, () => {
      const p = N(StereoPannerNode, {}, out, G(send, wet)),
        g = G(0, p);
      return { p, g, o: N(OscillatorNode, { type }, g) };
    });
  const bird = pool(5, 0.35),
    owl = pool(2, 0.9, 'triangle'),
    drip = pool(3, 0.25);
  // one note: pitch glides f0 -> f1 over dur, level rises to vol in att then dies away
  const play = (vs, t, f0, f1, dur, vol, att, pan) => {
    const v = vs.shift(),
      f = v.o.frequency,
      g = v.g.gain;
    vs.push(v);
    v.p.pan.setValueAtTime(pan, t);
    f.setValueAtTime(f0, t);
    f.exponentialRampToValueAtTime(f1, t + dur);
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(vol, t + att);
    g.setTargetAtTime(0, t + att, (dur - att) / 5);
  };
  // one footstep at t: bright and crisp on gravel, with a second grain as the stones settle; dull and soft on leaves
  const step = (t, gravel) => {
    const g = stepG.gain,
      lv = gravel ? rr(0.24, 0.34) : rr(0.3, 0.45);
    stepF.frequency.setValueAtTime(gravel ? rr(1700, 2600) : rr(500, 900), t);
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(lv, t + 0.008);
    g.setTargetAtTime(0, t + 0.012, gravel ? 0.03 : 0.055);
    if (gravel) {
      g.setValueAtTime(lv * 0.5, t + 0.08);
      g.setTargetAtTime(0, t + 0.085, 0.025);
    }
  };
  // one bird's phrase from t, all of it from one side; returns when it ends
  const sing = (t) => {
    const kind = (rnd() * 4) | 0,
      pan = rr(-0.8, 0.8),
      vol = rr(0.012, 0.035);
    if (kind === 0) {
      // quick rising chirps
      const f = rr(3200, 4600);
      for (let n = (3 + rnd() * 4) | 0; n--;) {
        play(bird, t, f * rr(0.9, 1), f * rr(1.25, 1.5), 0.09, vol, 0.01, pan);
        t += rr(0.11, 0.18);
      }
    } else if (kind === 1) {
      // a two-note whistle, the second note lower
      const f = rr(3000, 3800);
      play(bird, t, f, f * 0.99, 0.45, vol, 0.04, pan);
      play(bird, t + 0.5, f * 0.84, f * 0.83, 0.5, vol, 0.04, pan);
      t += 1.1;
    } else if (kind === 2) {
      // a fast trill on one pitch
      const f = rr(3800, 5600);
      for (let n = (8 + rnd() * 7) | 0; n--;) {
        play(bird, t, f, f * rr(0.96, 1.04), 0.05, vol * 0.8, 0.006, pan);
        t += 0.065;
      }
    } else {
      // a warble: glides up and down in turn
      const f = rr(2200, 3200);
      for (let n = (4 + rnd() * 4) | 0; n--;) {
        const up = n & 1;
        play(bird, t, up ? f : f * 1.3, up ? f * 1.3 : f, 0.16, vol, 0.02, pan);
        t += rr(0.17, 0.24);
      }
    }
    return t;
  };
  // the owl's five hoots (length, then the wait before the next), low and far off
  const HOOTS = [
    [0.32, 0.5],
    [0.14, 0.2],
    [0.4, 0.65],
    [0.4, 0.55],
    [0.45, 0.6],
  ];
  // walked: metres covered so far; nextStep: where along them the next footstep falls
  let lt = ac.currentTime,
    tB = lt + 2,
    tO = lt + rr(15, 35),
    tT = lt,
    tD = lt,
    lx = cam[0],
    ly = cam[1],
    lz = cam[2],
    walked = 0,
    nextStep = 0.3;
  out.gain.setTargetAtTime(VOL, lt, 1);
  return () => {
    const now = ac.currentTime,
      t = now + 0.05,
      dt = now - lt;
    if (dt <= 0) return;
    let v = hypot(cam[0] - lx, cam[1] - ly, cam[2] - lz) / dt;
    if (!(v < 30)) v = 0; // ignore jumps to a viewpoint
    lt = now;
    lx = cam[0];
    ly = cam[1];
    lz = cam[2];
    const R = clamp(cam[25] || 0, 0, 1),
      water = clamp(cam[26] || 0, 0, 1),
      gravel = cam[27] > 0.5,
      damp = clamp(cam[28] || 0, 0, 1);
    wind.gain.setTargetAtTime(0.2 + 0.14 * R, t, 1.5);
    rain.gain.setTargetAtTime(0.62 * pow(R, 1.4), t, 0.6);
    creek.gain.setTargetAtTime(0.4 * water, t, 0.4);
    cricket.gain.setTargetAtTime(0.012 * (1 - R) * (1 - R), t, 1);
    // footsteps: those that fall before the next tick are placed inside it, so their rhythm is not the timer's
    walked += v * dt;
    if (v > 0.5)
      while (nextStep - walked < v * 0.1) {
        step(t + max(nextStep - walked, 0) / v, gravel);
        nextStep += STRIDE * rr(0.92, 1.08);
      }
    else nextStep = walked + 0.3;
    if (t > tB) {
      // birdsong: fewer phrases as the rain picks up, none in a downpour
      const end = rnd() < R * R * 1.5 ? t : sing(t);
      tB = end + rr(1.5, 6) * (1 + 5 * R);
    }
    if (t > tO) {
      let tt = t;
      const f = rr(300, 360),
        pan = rr(-0.6, 0.6);
      if (R < 0.6)
        for (const [dur, gap] of HOOTS) {
          play(owl, tt, f, f * 0.94, dur, 0.045, dur * 0.3, pan);
          tt += gap;
        }
      tO = tt + rr(40, 90);
    }
    if (R > 0.7 && t > tT) {
      // a clap, then a second roll as it dies away
      const p = rr(0.45, 0.8),
        g = thunder.gain;
      g.setTargetAtTime(p, t, 0.07);
      g.setTargetAtTime(p * 0.3, t + 0.3, 0.5);
      g.setTargetAtTime(p * 0.6, t + 1.2, 0.12);
      g.setTargetAtTime(0, t + 1.6, 1.4);
      tT = t + rr(25, 60);
    }
    if (damp > 0.3 && R < 0.5 && t > tD) {
      // drips off the leaves after a shower: short falling plinks
      const f = rr(1400, 2600);
      play(
        drip,
        t,
        f,
        f * rr(0.55, 0.7),
        0.07,
        rr(0.015, 0.035) * damp,
        0.003,
        rr(-0.8, 0.8),
      );
      tD = t + rr(0.4, 3) / damp;
    }
  };
}
// cam: the scene's frame state (see the top of this file); called on every touch, builds the graph once
export function sound(cam) {
  if (!AC) {
    AC = new AudioContext({ latencyHint: 'playback' });
    tick = mkSound(AC, cam);
  }
  soundResume();
}
// the 10 Hz timer and the context run only while the tik is on screen
export function soundResume() {
  if (!AC) return;
  // refused without a recent touch; the next touch retries through sound()
  if (AC.state === 'suspended') AC.resume().catch(() => {});
  if (!timer) timer = setInterval(tick, 100);
}
export function soundPause() {
  if (!AC) return;
  AC.suspend().catch(() => {});
  clearInterval(timer);
  timer = 0;
}
