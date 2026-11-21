// ============================================================================
// quality level, chosen before anything is built (chooseLevel: main.ts, before it loads the scene)
// ============================================================================
// Two levels. Low is what a phone is judged at; Medium is for a high-end one: it keeps every 2nd firefly and pebble
// (Low every 4th), anti-aliases, bakes and draws finer and further, with more light-shaft steps and the near sprays
// in full. The level, in this order: on a dev machine the debug menu's pick (forestLevel); Low for good once this
// device was demoted (forestSlow: Medium measured too slow (scene.js), or a Medium load crashed the tab or lost the
// GPU); else Medium only when every signal the browser gives says high-end (highEnd). localStorage also keeps
// forestLoad (the level of a load in progress, while in view: still set at the next one means it crashed), forestSize
// ("level,pixels": the render size the frame-time tuner settled on); on a dev machine forestSim, made-up signals
// over the real ones (JSON; null: not told). The old key `forest`, of three levels, is never read.
export const DEV =
  import.meta.env.DEV &&
  /^(localhost|127\.0\.0\.1|.+\.localhost)$/.test(location.hostname);
export const mob = matchMedia('(pointer:coarse)').matches;
export const keep = (k, v) => {
  try {
    localStorage[k] = v;
  } catch {
    // storage may be blocked: nothing is kept, and the next load starts from the defaults
  }
};
const read = (k) => {
  try {
    return localStorage[k];
  } catch {
    return undefined; // storage may be blocked: the defaults stand
  }
};
// This device runs Low from its next load on, for good. why: slow, crash, gpu
export const demote = (why) => keep('forestSlow', why);
const DEMOTED = {
  slow: 'Medium measured too slow here',
  crash: 'a Medium load crashed',
  gpu: 'Medium lost the GPU',
};

// Is this device high-end, by what its browser tells? Every signal has to be there and say so, or it is Low:
// memory 8 GB or more (navigator.deviceMemory: Chrome and Android's WebView only, rounded, on Android 8 at most;
// Safari, and so an iPhone, tells none), 8 or more logical cores (navigator.hardwareConcurrency: Safari tells 4 or
// 8 whatever it has), and a WebGPU adapter that is no software fallback and takes buffers over the 256 MiB every
// adapter must (limits.maxBufferSize)
export const highEnd = ({ memory, cores, fallback, maxBuffer }) =>
  memory >= 8 && cores >= 8 && fallback === false && maxBuffer > 268435456;

// What the browser tells (the adapter as scene.js asks for it); on a dev machine forestSim's fields over it, and
// its `slow`: every frame on Medium taken as slow, to try the demotion
async function signals() {
  const adapter = await navigator.gpu
    ?.requestAdapter({ powerPreference: 'high-performance' })
    .catch(() => null);
  const info = adapter?.info;
  const told = {
    memory: navigator.deviceMemory,
    cores: navigator.hardwareConcurrency,
    fallback: adapter
      ? Boolean(info?.isFallbackAdapter ?? adapter.isFallbackAdapter)
      : undefined,
    maxBuffer: adapter?.limits.maxBufferSize,
    gpu: [info?.vendor, info?.architecture].filter(Boolean).join(' '),
  };
  if (!DEV) return told;
  try {
    const sim = JSON.parse(read('forestSim') || 'null');
    return sim ? { ...told, ...sim, sim: true } : told;
  } catch {
    return told; // not JSON: the real signals
  }
}

// The level and what it sets. MEDIUM: Medium, else Low; WHY: how it was chosen; SIZE: the render size kept for it
// (0: none); SLOW: forestSim's slowness (dev). THIN: keep one in so many fireflies and pebbles (world.js); WATER: the
// size of the animated texture (leaf-shadow pattern and lake ripples, W_WATER); RAYN: light-shaft steps.
// A card of a tree or a shrub is two quads. Within NEAR_D metres of the walker it comes to SPRIGS quads (W_LEAF
// vsN): branchlets or leaf clusters, and the last TWIGQ of them its branch (none on Low: the pictures show it).
// Light shafts render at 1/RAYD of the screen size (W_RAYS, scene.js resize): a quarter on Low, where fill rate is
// short
export let MEDIUM = false,
  WHY = '',
  SIZE = 0,
  SLOW = false,
  THIN = 4,
  SHADOW = 2048,
  AA = 1,
  WATER = 256,
  RAYN = 12,
  NEAR_D = 10.5,
  SPRIGS = 5,
  TWIGQ = 0,
  RAYD = 4;
export async function chooseLevel() {
  const pick = DEV ? read('forestLevel') : undefined,
    s = await signals();
  if (read('forestLoad') === 'Medium') demote('crash');
  const told = (v, unit = '') => (v == null ? 'none' : v + unit),
    demoted = read('forestSlow');
  if (pick === 'Low' || pick === 'Medium') {
    MEDIUM = pick === 'Medium';
    WHY = 'debug menu';
  } else if (demoted) WHY = `demoted: ${DEMOTED[demoted] || demoted}`;
  else {
    MEDIUM = highEnd(s);
    const mib = s.maxBuffer && Math.round(s.maxBuffer / 1048576);
    WHY = `signals${s.sim ? ' (simulated)' : ''}: memory ${told(s.memory, ' GB')}, ${told(s.cores)} cores, GPU ${s.gpu || 'unnamed'}${s.fallback ? ' (fallback)' : ''}, buffers to ${told(mib, ' MiB')}`;
  }
  SLOW = DEV && MEDIUM && Boolean(s.slow);
  const size = (read('forestSize') || '').split(',');
  SIZE = size[0] === (MEDIUM ? 'Medium' : 'Low') ? +size[1] || 0 : 0;
  THIN = MEDIUM ? 2 : 4;
  AA = MEDIUM ? 4 : 1;
  WATER = MEDIUM ? 512 : 256;
  RAYN = MEDIUM ? 34 : 12;
  NEAR_D = MEDIUM ? 18 : 10.5;
  SPRIGS = MEDIUM ? 14 : 5;
  TWIGQ = MEDIUM ? 2 : 0;
  RAYD = MEDIUM ? 2 : 4;
}
// the foliage atlas (atlas.js): texels across each of its layers, and how many levels it has
export const ATLAS = 1024,
  ATLAS_MIPS = 5;
