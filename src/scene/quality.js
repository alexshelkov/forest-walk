// ============================================================================
// quality tier, chosen before anything is built (chooseLevel: main.ts, before it loads the scene)
// ============================================================================
// The tiers, lowest first: Low, Medium, High. Medium is what a phone starts at; High is for a high-end one: it keeps
// every 2nd pebble (Medium and Low every 4th), anti-aliases, bakes and draws finer and further, with more light-shaft
// steps and the near sprays in full. Low is Medium with the light of its ground, its solids and its leaves baked once
// at load or worked out per vertex (scene.js LOW, W_SOLID_LOW, W_LEAF_LOW), nothing swaying, and a smaller foliage
// atlas. They differ only through the values set here and what reads HIGH or LOW (scene.js lv() and its branches,
// world.js, deer.js, shaders.js). The phone is the reference: a change to the picture is checked at Low first, then
// Medium and High.
// The tier, in this order: the budget view's Try knob (forestTryTier, any build; the testing menu's tier row sets it
// too); on a dev machine forestTier, set by hand; the tier this device was demoted to, for good (forestDemoted
// "tier:why": High or Medium measured too slow (scene.js), or a High load crashed the tab or lost the GPU); High once
// Medium earned it here (forestPromoted: scene.js watches a Medium start); else High only when every signal the browser
// gives says high-end (highEnd), and Medium otherwise. localStorage also keeps forestTierLoad (the tier of a load in
// progress, while in view, or of one that lost the GPU: still set at the next one means it failed; 'no adapter': a
// start after a failed one found no GPU, scene.js, so the next takes no step), forestStep (the start guard's step,
// guard), forestTierSize ("tier,pixels": the render size the frame-time tuner settled on); on a dev machine forestSim,
// made-up signals over the real ones (JSON; null: not told). The keys of before the tiers' renaming are moved once
// (migrate).
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
const drop = (k) => {
  try {
    localStorage.removeItem(k);
  } catch {
    // storage may be blocked: there is nothing to drop
  }
};
// Version 4 renamed the tiers (the old Medium is High, the old Low is Medium) and moved every key that names one: an
// old value is renamed into its new key (unless that holds one already) and the old key removed, so none is misread
const RENAMED = { Medium: 'High', Low: 'Medium' };
const MOVED = [
  ['forestLevel', 'forestTier'],
  ['forestLoad', 'forestTierLoad'],
  ['forestSize', 'forestTierSize'],
  ['forestSlow', 'forestDemoted'],
];
export function migrate() {
  for (const [old, now] of MOVED) {
    const value = read(old);
    if (value == null) continue;
    if (!read(now))
      keep(
        now,
        value.replace(/^(Medium|Low)\b/, (tier) => RENAMED[tier]),
      );
    drop(old);
  }
}
// This device runs the tier `to` from its next load on, for good, and is never promoted again. why: slow, crash, gpu
export const demote = (why, to = 'Medium') => {
  keep('forestDemoted', `${to}:${why}`);
  keep('forestPromoted', '');
};
const DEMOTED = {
  'Medium:slow': 'High measured too slow here',
  'Medium:crash': 'a High load crashed',
  'Medium:gpu': 'High lost the GPU',
  'Low:slow': 'Medium measured too slow here',
};
// the tiers a pick may name, lowest first
export const TIERS = ['Low', 'Medium', 'High'];
// Medium held the full render size with half its frame to spare (scene.js): this device runs High from its next load
export const promote = () => keep('forestPromoted', 'room');

// Is this device high-end, by what its browser tells? Every signal has to be there and say so, or it is Medium:
// memory 8 GB or more (navigator.deviceMemory: Chrome and Android's WebView only, rounded, on Android 8 at most;
// Safari, and so an iPhone, tells none), 8 or more logical cores (navigator.hardwareConcurrency: Safari tells 4 or
// 8 whatever it has), and a WebGPU adapter that is no software fallback and takes buffers over the 256 MiB every
// adapter must (limits.maxBufferSize)
export const highEnd = ({ memory, cores, fallback, maxBuffer }) =>
  memory >= 8 && cores >= 8 && fallback === false && maxBuffer > 268435456;

// What the browser tells (the adapter as scene.js asks for it); on a dev machine forestSim's fields over it, and
// its `slow`: every frame on High or Medium taken as slow, to try the demotion
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

// The tier and what it sets. TIER: its name; HIGH: High, LOW: Low (else Medium); WHY: how it was chosen; PROMOTABLE:
// a Medium start that may earn High (scene.js); SIZE: the render size kept for it (0: none); SLOW: forestSim's
// slowness (dev). THIN: keep one in so many pebbles (world.js); WATER: the size of the animated texture
// (leaf-shadow pattern and lake ripples, W_WATER); RAYN: light-shaft steps.
// A card of a tree or a shrub is two quads. Within NEAR_D metres of the walker it comes to SPRIGS quads (W_LEAF
// vsN): branchlets or leaf clusters, and the last TWIGQ of them its branch (none below High: the pictures show it).
// Light shafts render at 1/RAYD of the screen size (W_RAYS, scene.js resize): a quarter below High, where fill rate
// is short. ATLAS: the foliage atlas's texels across each of its layers (atlas.js), ATLAS_MIPS its levels
export let TIER = 'Medium',
  HIGH = false,
  LOW = false,
  ATLAS = 1024,
  ATLAS_MIPS = 5,
  WHY = '',
  PROMOTABLE = false,
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
// The start guard, at the very start (main.ts, before the loader's painting shows): a load still marked in progress
// (forestTierLoad) failed, by a crash or a lost GPU. After a High one this device goes Medium for good (demote);
// after a lower one it goes a step down (STEP, kept in forestStep as "version:step"; a device that starts keeps its
// step, Full in the budget view clears it, and a new version starts full: what failed was the old one's).
// LAST_FAILED: the last load failed (forestDemoted is no sign of that: it is for good)
export const STEPS = [
  'full',
  'leaf shadows baked in runs of 5,000 cards',
  'no leaf shadows',
  "no leaf shadows, no loader's painting",
];
export let STEP = 0;
export let LAST_FAILED = false;
let guarded = false;
export function guard(version) {
  if (guarded) return STEP;
  guarded = true;
  migrate();
  const failed = read('forestTierLoad'),
    [keptFor, kept] = (read('forestStep') || '').split(':'),
    same = keptFor === String(version);
  keep('forestTierLoad', ''); // (this load marks itself: scene.js markLoad)
  LAST_FAILED = Boolean(failed);
  STEP = same ? Math.min(Number(kept) || 0, STEPS.length - 1) : 0;
  if (failed === 'High') demote('crash');
  else if (same && (failed === 'Medium' || failed === 'Low'))
    STEP = Math.min(STEP + 1, STEPS.length - 1);
  keep('forestStep', `${version}:${STEP}`);
  return STEP;
}
export const fullStart = () => keep('forestStep', '');
// the Try knob's tier (the budget view; '' none): kept, and the page reloads into it
export const tryTier = (tier) => keep('forestTryTier', tier);
export async function chooseLevel() {
  const tried = read('forestTryTier'),
    pick = DEV ? read('forestTier') : undefined,
    s = await signals();
  const told = (v, unit = '') => (v == null ? 'none' : v + unit),
    demotedTo = read('forestDemoted'),
    // (a value of before the Low tier, the cause alone, demoted to Medium)
    demoted =
      demotedTo && !demotedTo.includes(':') ? `Medium:${demotedTo}` : demotedTo,
    promoted = read('forestPromoted');
  TIER = 'Medium';
  if (TIERS.includes(tried)) {
    TIER = tried;
    WHY = 'Try knob';
  } else if (TIERS.includes(pick)) {
    TIER = pick;
    WHY = 'debug menu';
  } else if (demoted) {
    TIER = TIERS.includes(demoted.split(':')[0])
      ? demoted.split(':')[0]
      : 'Medium';
    WHY = `demoted: ${DEMOTED[demoted] || demoted}`;
  } else if (promoted) {
    TIER = 'High';
    WHY = 'promoted: Medium had room';
  } else {
    TIER = highEnd(s) ? 'High' : 'Medium';
    PROMOTABLE = TIER === 'Medium';
    const mib = s.maxBuffer && Math.round(s.maxBuffer / 1048576);
    WHY = `signals${s.sim ? ' (simulated)' : ''}: memory ${told(s.memory, ' GB')}, ${told(s.cores)} cores, GPU ${s.gpu || 'unnamed'}${s.fallback ? ' (fallback)' : ''}, buffers to ${told(mib, ' MiB')}`;
  }
  HIGH = TIER === 'High';
  LOW = TIER === 'Low';
  // (Low's atlas a quarter of the texels: its bake a quarter as long, and some 13 MB less)
  ATLAS = LOW ? 512 : 1024;
  ATLAS_MIPS = LOW ? 4 : 5;
  SLOW = DEV && !LOW && Boolean(s.slow);
  const size = (read('forestTierSize') || '').split(',');
  SIZE = size[0] === TIER ? +size[1] || 0 : 0;
  THIN = HIGH ? 2 : 4;
  AA = HIGH ? 4 : 1;
  WATER = HIGH ? 512 : 256;
  RAYN = HIGH ? 34 : 12;
  NEAR_D = HIGH ? 18 : 10.5;
  SPRIGS = HIGH ? 14 : 5;
  TWIGQ = HIGH ? 2 : 0;
  RAYD = HIGH ? 2 : 4;
}
