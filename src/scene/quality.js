// ============================================================================
// quality level, chosen before anything is built
// ============================================================================
// LV: 0 High, 1 Medium, 2 Low. Medium and Low keep every 2nd / 4th leaf, firefly and pebble and bake fewer shadows;
// Low also drops anti-aliasing and uses coarser meshes, cheaper filtering and fewer light shaft steps.
// localStorage.forest = "level,pixels,detail". forestLoad is set while the world is built: still set on the next
// visit means that load crashed the tab, so this one runs a level lower.
// A phone always runs Low: Medium and High are sized for a desktop GPU.
export const mob = matchMedia('(pointer:coarse)').matches,
  mem = navigator.deviceMemory;
export const keep = (k, v) => {
  try {
    localStorage[k] = v;
  } catch {
    // storage may be blocked: nothing is kept, and the next load starts from the defaults
  }
};
export let SV = [],
  LV,
  bad;
try {
  SV = (localStorage.forest || '').split(',');
  bad = localStorage.forestLoad;
} catch {
  // storage may be blocked: the defaults below stand
}
LV = mob ? 2 : SV[0] ? +SV[0] : mem <= 4 ? 2 : 0;
if (bad && LV < 2) {
  SV = [++LV];
  keep('forest', LV);
}
// WATER: the size of the animated texture (leaf-shadow pattern and lake ripples, W_WATER)
export const THIN = 1 << LV,
  SHADOW = LV ? 2048 : 4096,
  AA = LV > 1 ? 1 : 4,
  WATER = LV > 1 ? 256 : 512,
  RAYN = LV > 1 ? 12 : 34;
// A card of a tree or a shrub is two quads. Within NEAR_D metres of the walker it comes to SPRIGS quads (W_LEAF
// vsN): branchlets or leaf clusters, and the last TWIGQ of them its branch (none on Low: the pictures show it)
export const NEAR_D = LV > 1 ? 10.5 : 18,
  SPRIGS = LV > 1 ? 5 : 14,
  TWIGQ = LV > 1 ? 0 : 2;
// light shafts render at 1/RAYD of the screen size (W_RAYS, scene.js resize): a quarter on Low, where fill rate is short
export const RAYD = LV > 1 ? 4 : 2;
// the foliage atlas (atlas.js): texels across each of its layers, and how many levels it has
export const ATLAS = 1024,
  ATLAS_MIPS = 5;
