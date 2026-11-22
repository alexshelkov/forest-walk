/*
A forest walk built on the renderer of Abyssal Garden by Maksymilian Dendura (https://github.com/Noniv/abyssal-garden),
as the Ocean tik ported it to a portrait phone.

MIT License

Copyright (c) 2026 Maksymilian Dendura

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
import {
  AA,
  ATLAS,
  ATLAS_MIPS,
  demote,
  keep,
  MEDIUM,
  mob,
  NEAR_D,
  RAYD,
  SHADOW,
  SIZE,
  SLOW,
  SPRIGS,
  WATER,
  WHY,
} from './quality.js';
import {
  abs,
  atan2,
  CELLS,
  CELLW,
  clamp,
  cos,
  exp,
  floor,
  hypot,
  lakeD,
  max,
  min,
  mix,
  NCHUNK,
  NTRUNK,
  NX,
  NY,
  NZ,
  OX,
  OY,
  OZ,
  round,
  sin,
  sqrt,
  sstep,
  SUBS,
  VS,
  OPEN,
} from './math.js';
import { W_ATLAS } from './atlas.js';
import { slotTable } from './sprigs.js';
import {
  W_ANIM,
  W_BLIT,
  W_BLOT,
  W_DENS,
  W_DETAIL,
  W_LEAF,
  W_LEVEL,
  W_METER,
  W_POST,
  W_RAYS,
  W_RBLUR,
  W_SOLID,
  W_SIGN,
  W_SPR,
  W_STREAM,
  W_SURF,
  W_WATER,
} from './shaders.js';
import { alongStreams, bake, creekAt, half16, probes, SN } from './water.js';
import {
  buildTerrain,
  heightAt,
  makeWorld,
  MESAS,
  trailField,
  meshBird,
  meshChunk,
  meshFlyer,
  meshLog,
  meshShroom,
  LABELS,
  meshSlab,
  meshStick,
  meshStump,
  meshTrunk,
  primBuffer,
  BOARDWALK,
  TRAIL,
  trailD,
  trailHalf,
  trailK,
  trailMake,
} from './world.js';
import {
  setBank,
  sound,
  soundDebug,
  soundFrame,
  soundPause,
  soundResume,
} from './audio.js';
import { bakeSounds, SURFACES } from './sounds.js';
import { makeCreatures } from './creatures.js';
import { makeDeer } from './deer.js';
import {
  FIRST_JAY_AT,
  JAY_SPACING,
  JAYS,
  JAYS_ON_SIDE_PATHS,
  makeBirds,
  meshJayNear,
  meshPerchStick,
  meshRaven,
  meshSongbird,
  RAVEN_REACH,
} from './birds.js';

// Switched off while the forest itself is being worked on. ANIMALS: the deer, fox, squirrels, owls and ducks of
// creatures.js, the flocks and soaring birds, the fireflies. SOUND: the soundscape of audio.js
const ANIMALS = false,
  SOUND = true;
// The weather. A state is what it brings, each 0 to 1: rain falling, the fog thickening, a storm overhead. The
// walk opens in clear (the mist and low sun of FOG and MIST below) and drifts through DRIFT, a state for so many
// seconds, round and round. Each value eases toward its state's by its own clock (step): the weather never
// switches, the cloud comes before the rain, and the sun returns on a forest still wet
const WEATHER = {
  clear: [0, 0, 0],
  fog: [0, 1, 0],
  rain: [0.45, 0.15, 0],
  storm: [1, 0.3, 1],
};
const DRIFT = [
  ['clear', 70],
  ['fog', 45],
  ['rain', 50],
  ['storm', 60],
  ['rain', 35],
  ['clear', 70],
];
// FOG: one over the distance at which the fog has taken two thirds of a thing on a dry day (hazeT in shaders.js:
// clear up close, half left at 26 m, 6% at 60, 2% at 72). FOG_END: nothing but the ground is drawn beyond it. The
// short view is the budget for the detail up close
const FOG = 0.031,
  FOG_END = 72;
// No leaf may appear, vanish or change size while the fog still shows it. By V, what the fog lets through (hazeT):
// a tree's cards stay whole down to the first, thin by rank to the second, then end between the last two; a
// shrub's the same, ending from where its thinning ends to the last. The fog closes over V's CLOSE (by the
// unclosed curve: hazeT) and everything ends there. The thinning, and a far tree's picture blended in over the
// trees' (W_LEAF vsFar), keep the clear day's distances in every weather (lodNow)
const CLOSE = [0.06, 0.02],
  TREE_FADE = [0.22, 0.07],
  SHRUB_FADE = [0.35, 0.12, 0.12, 0.06];
// MIST: how much of an overcast the fog makes of the day (0 a clear low sun, 1 rain cloud): the sun comes through it
// pale and soft, the light is mostly the fog's own
const MIST = 0.38;

// ============================================================================
// renderer, camera and frame loop; boot() builds the world once, the tik drives it (src/main.ts)
// ============================================================================
export async function boot({ canvas, input, facts, say, problem, dev }) {
  // raf: the frame loop's pending request, 0 while paused; dead: a problem ended the scene; frames: drawn so far
  let raf = 0,
    dead = false,
    frames = 0;
  // Every problem ends the scene and goes on screen. `retry` ones (out of memory, a GPU timeout) on Medium reload
  // at Low first, and this device keeps to Low (quality.js)
  const stop = (m, retry, error) => {
    if (retry && MEDIUM) {
      demote('gpu');
      location.reload();
      return;
    }
    dead = true;
    pause();
    facts.frames = String(frames);
    problem(m, error);
  };
  const fail = (m) => {
    throw new Error(m, { cause: 1 });
  }; // cause marks a message that is shown as it is
  const LEVEL = MEDIUM ? 'Medium' : 'Low';
  facts.detail = `${LEVEL} (${WHY})`;
  if (!navigator.gpu)
    fail(
      'Forest needs WebGPU graphics: iOS 26 or later, or a recent Android phone.',
    );
  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: 'high-performance',
  });
  if (!adapter) fail('This phone has no WebGPU graphics adapter.');
  {
    const i = adapter.info || {};
    facts.gpu =
      [
        ...new Set(
          [i.vendor, i.architecture, i.device, i.description].filter(Boolean),
        ),
      ].join(' ') || 'unknown';
  }
  const hasTS = adapter.features.has('timestamp-query');
  const device = await adapter.requestDevice({
    requiredFeatures: hasTS ? ['timestamp-query'] : [],
  });
  // any GPU error invalidates the frames it touches (a black screen), so it is never left in the console alone
  device.addEventListener('uncapturederror', (e) => {
    console.error('GPU: ' + e.error.message);
    const kind = e.error.constructor.name; // by name: not every browser has every GPU error class
    stop(
      `${kind}: ${e.error.message.slice(0, 300)}`,
      kind === 'GPUOutOfMemoryError',
    );
  });
  device.lost.then((l) => {
    if (l.reason === 'destroyed') return; // the page is closing
    stop(
      `The graphics device was lost (${l.reason || 'no reason given'}). ${(l.message || '').slice(0, 200)}`,
      true,
    );
  });
  const ctx = canvas.getContext('webgpu'),
    FMT = navigator.gpu.getPreferredCanvasFormat();
  const Q = device.queue,
    HDR = 'rgba16float',
    DEPTH = 'depth32float';
  const TU = GPUTextureUsage,
    BU = GPUBufferUsage,
    SS = GPUShaderStage;

  // a shader that fails to compile is reported by name and line, which the pipeline error it causes does not say
  const mod = (code, name) => {
    const m = device.createShaderModule({ code, label: name });
    m.getCompilationInfo?.().then((i) => {
      const e = i.messages.find((x) => x.type === 'error');
      if (e)
        stop(`Shader ${name}, line ${e.lineNum}: ${e.message.slice(0, 300)}`);
    });
    return m;
  };
  // Each pipeline in its own error scope, so a failure names it: a driver's message ("Vertex library failed
  // creation" from Safari) names no shader. The label: module.vertex/fragment entry points, then constants.
  const scoped = (compute, desc) => {
    const v = compute ? desc.compute : desc.vertex,
      c = v.constants ? ' ' + JSON.stringify(v.constants) : '';
    const label = `${v.module.label}.${v.entryPoint}${desc.fragment ? '/' + desc.fragment.entryPoint : ''}${c}`;
    device.pushErrorScope('validation');
    const p = compute
      ? device.createComputePipeline({ ...desc, label })
      : device.createRenderPipeline({ ...desc, label });
    device.popErrorScope().then((e) => {
      if (e) stop(`Pipeline ${label}: ${e.message.slice(0, 300)}`);
    });
    return p;
  };
  const rpipe = (desc) => scoped(false, desc),
    cpipe = (desc) => scoped(true, desc);
  const buf = (data, usage) => {
    const b = device.createBuffer({
      size: max((data.byteLength + 3) & ~3, 4),
      usage: usage | BU.COPY_DST,
    });
    Q.writeBuffer(
      b,
      0,
      data.buffer || data,
      data.byteOffset || 0,
      data.byteLength,
    );
    return b;
  };
  const tex = (w, h, format, usage, o = {}) =>
    device.createTexture({
      size: [w, h, o.d || 1],
      format,
      usage,
      mipLevelCount: o.mips || 1,
      sampleCount: o.samples || 1,
      dimension: o.d ? '3d' : '2d',
    });

  // ---------------------------------------------------------------- static resources
  const sRep = device.createSampler({
    addressModeU: 'repeat',
    addressModeV: 'repeat',
    magFilter: 'linear',
    minFilter: 'linear',
    mipmapFilter: 'linear',
    maxAnisotropy: MEDIUM ? 8 : 4,
  });
  const sClamp = device.createSampler({
    magFilter: 'linear',
    minFilter: 'linear',
  });
  const sCmp = device.createSampler({
    compare: 'less-equal',
    magFilter: 'linear',
    minFilter: 'linear',
  });
  const tShadow = tex(
    SHADOW,
    SHADOW,
    DEPTH,
    TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING,
  );
  const tDummy = tex(1, 1, DEPTH, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING);
  const tWater = tex(
    WATER,
    WATER,
    HDR,
    TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING,
    { mips: 5 },
  );
  const tDetail = tex(
    1024,
    1024,
    'rgba8unorm',
    TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING,
    { mips: 11 },
  );
  const tVol = tex(
    NX / 2,
    NY / 2,
    'rg8unorm',
    TU.TEXTURE_BINDING | TU.COPY_DST,
    { d: NZ / 2 },
  );
  const tMap = tex(512, 512, 'rgba8unorm', TU.TEXTURE_BINDING | TU.COPY_DST);
  // the running water over the world: metres to its edge and its level (water.js bake), for the shaders to wet things
  // by; and in b the ground's height (world.js), for what stands on the ground to tell its foot by
  const tStream = tex(SN, SN, 'rgba16float', TU.TEXTURE_BINDING | TU.COPY_DST);
  // what stands on the ground, as soft discs (world.js): the ground is darker round the foot of things
  const tContact = tex(1024, 1024, 'r8unorm', TU.TEXTURE_BINDING | TU.COPY_DST);

  // the foliage atlas (atlas.js): three layers with their small levels, baked once the shaders are in
  const tAtlas = device.createTexture({
    size: [ATLAS, ATLAS, 3],
    format: 'rgba8unorm',
    usage: TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING | TU.COPY_SRC,
    mipLevelCount: ATLAS_MIPS,
  });

  // the scene's uniforms (struct G in shaders.js): two matrices and seventeen vec4, for the view and for the shadow
  // pass
  const UB = new Float32Array(100),
    UBS = new Float32Array(100);
  const ubo = device.createBuffer({
      size: 400,
      usage: BU.UNIFORM | BU.COPY_DST,
    }),
    uboS = device.createBuffer({ size: 400, usage: BU.UNIFORM | BU.COPY_DST });
  const WT = new Float32Array(4),
    uboW = device.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST });

  const VF = SS.VERTEX | SS.FRAGMENT;
  // the sub-cards a card unfolds near the walker (sprigs.js, W_LEAF vsN)
  const uboLay = buf(slotTable(), BU.UNIFORM);
  const bgl0 = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: VF, buffer: {} },
      { binding: 1, visibility: VF, sampler: {} },
      { binding: 2, visibility: VF, sampler: {} },
      { binding: 3, visibility: VF, sampler: { type: 'comparison' } },
      { binding: 4, visibility: VF, texture: { sampleType: 'depth' } },
      { binding: 5, visibility: VF, texture: {} },
      { binding: 6, visibility: VF, texture: {} },
      { binding: 7, visibility: VF, texture: { viewDimension: '3d' } },
      { binding: 8, visibility: VF, texture: {} },
      { binding: 9, visibility: VF, texture: {} },
      { binding: 10, visibility: VF, texture: {} },
      { binding: 11, visibility: VF, texture: { viewDimension: '2d-array' } },
      { binding: 12, visibility: SS.VERTEX, buffer: {} },
    ],
  });
  const mkBG0 = (u, sh) =>
    device.createBindGroup({
      layout: bgl0,
      entries: [
        { binding: 0, resource: { buffer: u } },
        { binding: 1, resource: sRep },
        { binding: 2, resource: sClamp },
        { binding: 3, resource: sCmp },
        { binding: 4, resource: sh.createView() },
        { binding: 5, resource: tWater.createView() },
        { binding: 6, resource: tDetail.createView() },
        { binding: 7, resource: tVol.createView() },
        { binding: 8, resource: tMap.createView() },
        { binding: 9, resource: tStream.createView() },
        { binding: 10, resource: tContact.createView() },
        { binding: 11, resource: tAtlas.createView({ dimension: '2d-array' }) },
        { binding: 12, resource: { buffer: uboLay } },
      ],
    });
  const bg0 = mkBG0(ubo, tShadow),
    bg0s = mkBG0(uboS, tDummy);
  const pl0 = device.createPipelineLayout({ bindGroupLayouts: [bgl0] });

  const bglBlit = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: SS.FRAGMENT, texture: {} },
      { binding: 1, visibility: SS.FRAGMENT, sampler: {} },
    ],
  });
  const plBlit = device.createPipelineLayout({ bindGroupLayouts: [bglBlit] });
  const mBlit = mod(W_BLIT, 'BLIT');
  const blitPipe = (entry, format, add) =>
    rpipe({
      layout: plBlit,
      vertex: { module: mBlit, entryPoint: 'vs' },
      fragment: {
        module: mBlit,
        entryPoint: entry,
        targets: [
          {
            format,
            blend: add
              ? {
                  color: { srcFactor: 'one', dstFactor: 'one' },
                  alpha: { srcFactor: 'one', dstFactor: 'one' },
                }
              : undefined,
          },
        ],
      },
    });
  const pMip8 = blitPipe('fsMip', 'rgba8unorm'),
    pMip16 = blitPipe('fsMip', HDR),
    pDown0 = blitPipe('fsDown0', HDR),
    pDown = blitPipe('fsDown', HDR),
    pUp = blitPipe('fsUp', HDR, true);
  const blitBG = (view) =>
    device.createBindGroup({
      layout: bglBlit,
      entries: [
        { binding: 0, resource: view },
        { binding: 1, resource: sClamp },
      ],
    });
  const colorAtt = (view, clear) => ({
    view,
    loadOp: clear ? 'clear' : 'load',
    storeOp: 'store',
    clearValue: [0, 0, 0, 0],
  });

  // vertex layouts
  const A = (shaderLocation, offset, format) => ({
    shaderLocation,
    offset,
    format,
  });
  const vbSolid = {
    arrayStride: 16,
    attributes: [A(0, 0, 'float32x3'), A(1, 12, 'snorm8x4')],
  };
  const ibSolid = {
    arrayStride: 48,
    stepMode: 'instance',
    attributes: [
      A(2, 0, 'float32x4'),
      A(3, 16, 'float32x4'),
      A(4, 32, 'float32x4'),
    ],
  };
  const ibLeaf = {
    arrayStride: 36,
    stepMode: 'instance',
    attributes: [
      A(0, 0, 'float32x4'),
      A(1, 16, 'float32x4'),
      A(2, 32, 'unorm8x4'),
    ],
  };
  const ibAnim = {
    arrayStride: 32,
    stepMode: 'instance',
    attributes: [A(2, 0, 'float32x4'), A(3, 16, 'float32x4')],
  };
  const ibBub = {
    arrayStride: 32,
    stepMode: 'instance',
    attributes: [A(0, 0, 'float32x4'), A(1, 16, 'float32x4')],
  };
  const ibSnow = {
    arrayStride: 16,
    stepMode: 'instance',
    attributes: [A(0, 0, 'float32x4')],
  };
  const ibBolt = {
    arrayStride: 32,
    stepMode: 'instance',
    attributes: [A(0, 0, 'float32x4'), A(1, 16, 'float32x4')],
  };
  const vbStream = {
    arrayStride: 40,
    attributes: [
      A(0, 0, 'float32x4'),
      A(1, 16, 'float32x4'),
      A(2, 32, 'float32x2'),
    ],
  }; // water.js bake

  const scenePipe = (m, vsE, fsE, buffers, o = {}) =>
    rpipe({
      layout: o.layout || pl0,
      vertex: { module: m, entryPoint: vsE, buffers, constants: o.constants },
      fragment: {
        module: m,
        entryPoint: fsE,
        targets: [
          { format: HDR, blend: o.blend, writeMask: o.noColor ? 0 : 15 },
        ],
      },
      primitive: {
        topology: o.strip ? 'triangle-strip' : 'triangle-list',
        cullMode: o.cull || 'none',
      },
      depthStencil: {
        format: DEPTH,
        depthWriteEnabled: !o.blend,
        depthCompare: 'greater',
      },
      multisample: { count: AA },
    });
  const shadowPipe = (m, vsE, buffers, o = {}) =>
    rpipe({
      layout: pl0,
      vertex: { module: m, entryPoint: vsE, buffers, constants: o.constants },
      primitive: {
        topology: o.strip ? 'triangle-strip' : 'triangle-list',
        cullMode: o.cull || 'none',
      },
      depthStencil: {
        format: DEPTH,
        depthWriteEnabled: true,
        depthCompare: 'less',
        depthBias: 2,
        depthBiasSlopeScale: 1.5,
      },
    });

  await say('Compiling shaders…', 0.05, 300);
  const mSolid = mod(W_SOLID, 'SOLID'),
    mLeaf = mod(W_LEAF, 'LEAF'),
    mAnim = mod(W_ANIM, 'ANIM'),
    mSurf = mod(W_SURF, 'SURF'),
    mSpr = mod(W_SPR, 'SPR');
  const pTerrain = scenePipe(mSolid, 'vs', 'fs', [vbSolid, ibSolid], {
    cull: 'back',
  });
  const pSolid = scenePipe(mSolid, 'vs', 'fs', [vbSolid, ibSolid]),
    pShell = scenePipe(mSolid, 'vsShell', 'fs', [vbSolid, ibSolid]);
  // Leaf pipelines. Each store thins with distance (W_LEAF thin: the share kept goes from K0 to KMIN): the trees'
  // and the shrubs' cards by distances that follow the fog (STORE 1 and 2, lodNow), the ground's plants by their
  // own (PD1, PD2) and ending at PLANT_END
  const PLANT_END = MEDIUM ? 46 : 38;
  const THIN_TREE = { STORE: 1, K0: 1.25, KMIN: 0.25 },
    THIN_SHRUB = { STORE: 2, K0: 1.25, KMIN: 0.25 },
    THIN_SMALL = { FAR: PLANT_END, PD1: 6, PD2: 28, K0: 1, KMIN: 0.15 };
  // the strips of the ground's plants and of the bare limbs; the quads of a tree's and of a shrub's cards
  const pLeafS = scenePipe(mLeaf, 'vs', 'fs', [ibLeaf], {
      strip: true,
      constants: { ROWS: 3, ...THIN_SMALL },
    }),
    pLeafL = scenePipe(mLeaf, 'vs', 'fs', [ibLeaf], {
      strip: true,
      constants: { ROWS: 3, ...THIN_TREE },
    });
  const pLeafM = scenePipe(mLeaf, 'vsN', 'fs', [ibLeaf], {
      constants: THIN_TREE,
    }),
    pLeafMS = scenePipe(mLeaf, 'vsN', 'fs', [ibLeaf], {
      constants: THIN_SHRUB,
    });
  // a far tree's crown as one picture (W_LEAF vsFar)
  const pFish = scenePipe(mAnim, 'vsFish', 'fsFish', [vbSolid, ibAnim]);
  const pManta = scenePipe(mAnim, 'vsManta', 'fsManta', [vbSolid, ibAnim]);
  // (the boat's lid: a solid drawn into the depth only, so the lake's surface stays out of the hull)
  const pLid = scenePipe(mSolid, 'vs', 'fs', [vbSolid, ibSolid], {
    noColor: true,
  });
  // the birds of birds.js: an instance each, posed in the vertex shader
  const ibBird16 = {
    arrayStride: 64,
    stepMode: 'instance',
    attributes: [
      A(2, 0, 'float32x4'),
      A(3, 16, 'float32x4'),
      A(4, 32, 'float32x4'),
      A(5, 48, 'float32x4'),
    ],
  };
  const pBird = scenePipe(mAnim, 'vsBird', 'fsBird', [vbSolid, ibBird16]),
    // (the jay from close by: its own entry points, for its many parts)
    pJay = scenePipe(mAnim, 'vsJay', 'fsJay', [vbSolid, ibBird16]);
  const ALPHA = {
    color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
  };
  // a far tree's picture blended in (W_LEAF vsFar, fsFar) over the opaque scene, writing no depth (farSorted)
  const pLeafFB = scenePipe(mLeaf, 'vsFar', 'fsFar', [ibLeaf], {
    strip: true,
    blend: ALPHA,
  });
  const ADD = {
    color: { srcFactor: 'one', dstFactor: 'one' },
    alpha: { srcFactor: 'one', dstFactor: 'one' },
  };
  // the dark blot under an animal on the ground: what is there already, darkened
  const pBlot = scenePipe(mod(W_BLOT, 'BLOT'), 'vs', 'fs', [ibBolt], {
    strip: true,
    blend: {
      color: { srcFactor: 'zero', dstFactor: 'src' },
      alpha: { srcFactor: 'zero', dstFactor: 'one' },
    },
  });
  const pSurf = scenePipe(mSurf, 'vs', 'fs', [], { strip: true, blend: ALPHA }),
    pBack = scenePipe(mSurf, 'vsB', 'fsB', [], { strip: true });
  const pStream = scenePipe(mod(W_STREAM, 'STREAM'), 'vs', 'fs', [vbStream], {
    blend: ALPHA,
  });
  const pSnow = scenePipe(mSpr, 'vsSnow', 'fsSnow', [ibSnow], {
      strip: true,
      blend: ADD,
    }),
    pRain = scenePipe(mSpr, 'vsRain', 'fsRain', [ibSnow], {
      strip: true,
      blend: ALPHA,
    });
  // the rain's drips under the crowns, and its two sheets of streaks further off (W_SPR)
  const pDrip = scenePipe(mSpr, 'vsDrip', 'fsRain', [ibSnow], {
      strip: true,
      blend: ALPHA,
    }),
    pVeil = scenePipe(mSpr, 'vsVeil', 'fsVeil', [], {
      strip: true,
      blend: ALPHA,
    });
  // a bolt of lightning: a quad to each segment of its channels (W_SPR vsBolt), its light added to the sky's
  const pBolt = scenePipe(mSpr, 'vsBolt', 'fsBolt', [ibBolt], {
    strip: true,
    blend: ADD,
  });
  // The signposts' lettering: a quad on each face of a board (world.js labels), its words cut out of a small
  // texture drawn here, a name to a row (LABELS), with its smaller levels
  const tLabel = device.createTexture({
    size: [512, 1024],
    format: 'rgba8unorm',
    mipLevelCount: 6,
    usage: TU.TEXTURE_BINDING | TU.COPY_DST | TU.RENDER_ATTACHMENT,
  });
  for (let level = 0; level < 6; level++) {
    const wide = 512 >> level,
      row = 128 >> level,
      sheet = new OffscreenCanvas(wide, row * 8),
      pen = sheet.getContext('2d');
    pen.fillStyle = '#fff';
    pen.textAlign = 'center';
    pen.textBaseline = 'middle';
    pen.font = `600 ${row * 0.74}px Georgia, 'Times New Roman', serif`;
    LABELS.forEach((name, i) =>
      pen.fillText(name, wide / 2, (i + 0.52) * row, wide * 0.96),
    );
    Q.copyExternalImageToTexture(
      { source: sheet },
      { texture: tLabel, mipLevel: level },
      [wide, row * 8],
    );
  }
  const pSign = scenePipe(mod(W_SIGN, 'SIGN'), 'vs', 'fs', [ibBolt], {
    strip: true,
    blend: ALPHA,
    layout: device.createPipelineLayout({ bindGroupLayouts: [bgl0, bglBlit] }),
  });
  const bgSign = device.createBindGroup({
    layout: bglBlit,
    entries: [
      { binding: 0, resource: tLabel.createView() },
      { binding: 1, resource: sRep },
    ],
  });
  const pFall = scenePipe(mSpr, 'vsFall', 'fsFall', [ibSnow], { strip: true });
  // no constants: vsGl reads none, and Safari fails to build a vertex shader given an override it does not use
  const pGl = scenePipe(mLeaf, 'vsGl', 'fsGl', [ibBub], {
    strip: true,
    blend: ADD,
  });
  const pSolidSh = shadowPipe(mSolid, 'vs', [vbSolid, ibSolid]),
    pTerrSh = shadowPipe(mSolid, 'vs', [vbSolid, ibSolid], { cull: 'front' });
  const pLeafSh = shadowPipe(mLeaf, 'vs', [ibLeaf], {
    strip: true,
    constants: { ROWS: 3 },
  });

  const mWater = mod(W_WATER, 'WATER');
  const pWater = rpipe({
    layout: 'auto',
    vertex: { module: mWater, entryPoint: 'vs' },
    fragment: { module: mWater, entryPoint: 'fs', targets: [{ format: HDR }] },
  });
  const bgWater = device.createBindGroup({
    layout: pWater.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uboW } }],
  });
  const waterViews = [0, 1, 2, 3, 4].map((m) =>
    tWater.createView({ baseMipLevel: m, mipLevelCount: 1 }),
  );
  const waterBG = waterViews.map((v) => blitBG(v));
  const waterPass = waterViews.map((v) => ({
    colorAttachments: [colorAtt(v, true)],
  }));

  const mRays = mod(W_RAYS, 'RAYS'),
    mPost = mod(W_POST, 'POST'),
    mRB = mod(W_RBLUR, 'RBLUR');
  const pRB = rpipe({
    layout: 'auto',
    vertex: { module: mRB, entryPoint: 'vs' },
    fragment: { module: mRB, entryPoint: 'fs', targets: [{ format: HDR }] },
  });
  const pRays = rpipe({
    layout: 'auto',
    vertex: { module: mRays, entryPoint: 'vs' },
    fragment: { module: mRays, entryPoint: 'fs', targets: [{ format: HDR }] },
  });
  const pPost = rpipe({
    layout: 'auto',
    vertex: { module: mPost, entryPoint: 'vs' },
    fragment: { module: mPost, entryPoint: 'fs', targets: [{ format: FMT }] },
  });
  // The eye's measure of the frame (W_METER): a 16 x 16 grid of luminance to the 4th power, and the highlights
  // adapted to, in two targets that take turns, one written each frame from the other (meterAt: the one written
  // last)
  const mMeter = mod(W_METER, 'METER'),
    METER = 'r32float',
    meterPipe = (entry) =>
      rpipe({
        layout: 'auto',
        vertex: { module: mMeter, entryPoint: 'vs' },
        fragment: {
          module: mMeter,
          entryPoint: entry,
          targets: [{ format: METER }],
        },
      });
  const pGrid = meterPipe('fsGrid'),
    pAdapt = meterPipe('fsAdapt');
  const tGrid = tex(16, 16, METER, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING),
    tAdapt = [0, 1].map(() =>
      tex(1, 1, METER, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING | TU.COPY_SRC),
    );
  const passGrid = { colorAttachments: [colorAtt(tGrid.createView(), true)] },
    passAdapt = tAdapt.map((t) => ({
      colorAttachments: [colorAtt(t.createView(), true)],
    })),
    bgAdapt = tAdapt.map((t, i) =>
      device.createBindGroup({
        layout: pAdapt.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: ubo } },
          { binding: 4, resource: tGrid.createView() },
          { binding: 5, resource: tAdapt[1 - i].createView() },
        ],
      }),
    );
  let meterAt = 0,
    meterNew = true, // take the next frame's measure at once: the first frame, and after a jump (lookAt)
    frameDt = 0,
    expoMode = 0; // debug.exposure: 0 the old rule stopped down for highlights, 1 the old rule

  // ---------------------------------------------------------------- sun + shadow matrix
  // A low sun, about 21 degrees up and nearly ahead of the walk's first steps: long shadows, light between the trunks
  const SUN = (() => {
    const v = [0.62, 0.36, -0.7],
      l = hypot(...v);
    return v.map((c) => c / l);
  })();
  {
    const L = SUN,
      lr = [L[1], -L[0], 0],
      ll = hypot(...lr);
    lr[0] /= ll;
    lr[1] /= ll;
    const lu = [
      L[1] * lr[2] - L[2] * lr[1],
      L[2] * lr[0] - L[0] * lr[2],
      L[0] * lr[1] - L[1] * lr[0],
    ];
    // R: half the width the map covers; d0 to d1: the span along the light, long because the sun is low
    const R = 225,
      d0 = -240,
      d1 = 240,
      m = UBS;
    m[0] = lr[0] / R;
    m[4] = lr[1] / R;
    m[8] = lr[2] / R;
    m[12] = 0;
    m[1] = lu[0] / R;
    m[5] = lu[1] / R;
    m[9] = lu[2] / R;
    m[13] = 0;
    m[2] = -L[0] / (d1 - d0);
    m[6] = -L[1] / (d1 - d0);
    m[10] = -L[2] / (d1 - d0);
    m[14] = d1 / (d1 - d0);
    m[3] = 0;
    m[7] = 0;
    m[11] = 0;
    m[15] = 1;
    for (let i = 0; i < 16; i++) {
      UBS[16 + i] = m[i];
      UB[16 + i] = m[i];
    }
    for (let i = 0; i < 3; i++) {
      UB[48 + i] = UBS[48 + i] = SUN[i];
    }
    // the shadow pass: res.x 0 marks it for the shaders, no wind, full draw distance
    UBS[58] = 1;
    Q.writeBuffer(uboS, 0, UBS);
  }

  // ---------------------------------------------------------------- world generation
  await say('Raising the hills…', 0.25, 1200);
  // Marks a load in progress at this level (quality.js) while the page is in view: leaving it, or hiding it (a
  // phone may kill an app sent to the background), before the load ends is not a crash
  let loading = true;
  const markLoad = () =>
    keep(
      'forestLoad',
      loading && document.visibilityState === 'visible' ? LEVEL : '',
    );
  markLoad();
  addEventListener('pagehide', () => keep('forestLoad', ''));
  document.addEventListener('visibilitychange', markLoad);
  // The density field (84 MB) lives only inside this call: when it returns, the generator's working memory goes
  const { water, T, Wd } = await (async () => {
    let D, water;
    {
      const prims = primBuffer();
      // bt: how far the trail is from every place (world.js), which the terrain is shaped round
      const bt = buf(trailField(), BU.STORAGE);
      {
        // First the ground's height where the streams are to run, before they cut into it: their levels are set by it
        const pts = probes(),
          n = pts.length / 2,
          p = cpipe({
            layout: 'auto',
            compute: { module: mod(W_LEVEL, 'LEVEL'), entryPoint: 'main' },
          });
        const bo = device.createBuffer({
            size: n * 4,
            usage: BU.STORAGE | BU.COPY_SRC,
          }),
          br = device.createBuffer({
            size: n * 4,
            usage: BU.MAP_READ | BU.COPY_DST,
          });
        const bg = device.createBindGroup({
          layout: p.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: buf(pts, BU.STORAGE) } },
            { binding: 1, resource: { buffer: bo } },
            { binding: 3, resource: { buffer: bt } },
          ],
        });
        const e = device.createCommandEncoder(),
          c = e.beginComputePass();
        c.setPipeline(p);
        c.setBindGroup(0, bg);
        c.dispatchWorkgroups(Math.ceil(n / 64));
        c.end();
        e.copyBufferToBuffer(bo, 0, br, 0, n * 4);
        Q.submit([e.finish()]);
        await br.mapAsync(GPUMapMode.READ);
        water = bake(new Float32Array(br.getMappedRange()));
        br.unmap();
        br.destroy();
        bo.destroy();
      }
      const m = mod(W_DENS, 'DENS'),
        p = cpipe({
          layout: 'auto',
          compute: { module: m, entryPoint: 'main' },
        });
      // One dispatch of the whole field (21M samples, 84 MB) trips a phone GPU's hang timeout and drops WebView's
      // GPU connection, so it runs in slabs of SLAB z-slices, one submit and readback each. SLAB: a multiple of 4.
      const SLAB = 16,
        slabSize = NX * NY * SLAB * 4;
      const u = new ArrayBuffer(48),
        uu = new Uint32Array(u),
        uf = new Float32Array(u);
      uu[0] = NX;
      uu[1] = NY;
      uu[2] = NZ;
      uf[4] = OX;
      uf[5] = OY;
      uf[6] = OZ;
      uf[7] = VS;
      uu[8] = MESAS.length; // u.c in W_DENS: outcrops
      const bu = buf(new Uint8Array(u), BU.UNIFORM),
        bp = buf(prims, BU.STORAGE),
        bs = buf(water.field, BU.STORAGE);
      const bd = device.createBuffer({
          size: slabSize,
          usage: BU.STORAGE | BU.COPY_SRC,
        }),
        br = device.createBuffer({
          size: slabSize,
          usage: BU.MAP_READ | BU.COPY_DST,
        });
      const bg = device.createBindGroup({
        layout: p.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: bu } },
          { binding: 1, resource: { buffer: bd } },
          { binding: 2, resource: { buffer: bp } },
          { binding: 3, resource: { buffer: bt } },
          { binding: 4, resource: { buffer: bs } },
        ],
      });
      D = new Float32Array(NX * NY * NZ);
      for (let z0 = 0; z0 < NZ; z0 += SLAB) {
        facts.ground = `slice ${z0} of ${NZ}`; // where it was, should the GPU give up mid-way
        uu[3] = z0;
        Q.writeBuffer(bu, 0, u); // u.n.w in W_DENS: the slab's first z slice
        const e = device.createCommandEncoder(),
          c = e.beginComputePass();
        c.setPipeline(p);
        c.setBindGroup(0, bg);
        c.dispatchWorkgroups(NX / 4, NY / 4, SLAB / 4);
        c.end();
        e.copyBufferToBuffer(bd, 0, br, 0, slabSize);
        Q.submit([e.finish()]);
        await br.mapAsync(GPUMapMode.READ);
        D.set(new Float32Array(br.getMappedRange()), z0 * NX * NY);
        br.unmap();
      }
      br.destroy();
      bd.destroy();
      delete facts.ground;
      // a GPU that gave up returns zeros or garbage: say so here, not as a crash deep in the generator
      let rock = 0,
        bad = 0;
      for (let i = 0; i < D.length; i += 97) {
        const d = D[i];
        if (d > 0) rock++;
        else if (d !== d) bad++;
      }
      if (!rock || bad)
        fail(
          `This graphics chip did not compute the ground (${rock} rock and ${bad} invalid samples).`,
        );
      // rock connected to the ground: each column's unbroken run up from the bottom is, and the rock above a gap
      // (overhangs, specks) is when it touches rock that is. What never connects is a speck of noise floating in
      // the air (surface nets would make it a small box), so it becomes air
      const S = NX * NY,
        R = new Uint8Array(D.length),
        O = [1, -1, NX, -NX, S, -S],
        b = new Uint8Array(NX),
        L = [];
      for (let i = 0; i < D.length;) {
        b.fill(1);
        for (let y = 0; y < NY; y++)
          for (let x = 0; x < NX; x++, i++)
            if (D[i] <= 0) b[x] = 0;
            else if (b[x]) R[i] = 1;
            else L.push(i);
      }
      for (let k = 1; k; L.reverse()) {
        k = 0;
        for (const i of L) if (!R[i] && O.some((o) => R[i + o])) R[i] = k = 1;
      }
      for (const i of L) if (!R[i]) D[i] = -D[i];
    }
    await say('Cutting the creek…', 0.32, 400);
    const T = buildTerrain(D);
    await say('Growing the forest…', 0.73, 2500);
    return { water, T, Wd: makeWorld(D, T) };
  })();

  // Per-frame float state lives in one preallocated array, so the frame loop allocates no heap numbers. audio.js
  // reads the position and the last four slots (rain, water nearby, gravel underfoot, wetness) from it
  const F = new Float64Array(40),
    P6 = new Float64Array(6);
  const CX = 0,
    CY = 1,
    CZ = 2,
    YAW = 3,
    PIT = 4,
    FX = 5,
    FY = 6,
    FZ = 7,
    RX = 8,
    RZ = 9,
    UX = 10,
    UY = 11,
    UZ = 12,
    VX = 13,
    VZ = 15,
    TIME = 16,
    LAST = 18,
    GPU = 19,
    ADAPT = 22,
    RAIN = 25,
    WATERS = 26,
    GRAVEL = 27,
    WET = 28,
    FOGK = 29,
    STORM = 30,
    LT = 32,
    LD = 33,
    OVER = 34,
    WIND = 35,
    SOAK = 36,
    BLOWN = 37;
  // aim the camera from P6 = position + look-at point
  function aim() {
    const dx = P6[3] - P6[0],
      dy = P6[4] - P6[1],
      dz = P6[5] - P6[2];
    F[CX] = P6[0];
    F[CY] = P6[1];
    F[CZ] = P6[2];
    F[YAW] = atan2(dx, -dz);
    F[PIT] = atan2(dy, sqrt(dx * dx + dz * dz));
  }
  // (a jump there: the eye is adapted at once, F[ADAPT] 0 says so to step; and it stays at the height it was put at
  // until the walker walks: held)
  let held = false;
  const lookAt = (x, y, z, tx, ty, tz) => {
    P6[0] = x;
    P6[1] = y;
    P6[2] = z;
    P6[3] = tx;
    P6[4] = ty;
    P6[5] = tz;
    aim();
    F[ADAPT] = 0;
    meterNew = true;
    held = true;
  };

  // ground(x, z): the height the walker and the animals stand on, the decks of the bridges and the dock included
  const ground = heightAt(Wd.hm);
  // What the walker goes round, in a grid of 6 m cells: obst, discs (trunks, boulders, logs, posts: x, z, radius
  // each), and walled, the lines it slides along (rails, fences, the unseen edges of crossings and the dock: x0, z0,
  // x1, z1, radius each, in every cell they cross)
  const OBW = 6,
    OBN = Math.ceil((NX * VS) / OBW),
    obst = Array.from({ length: OBN * OBN }, () => []),
    walled = Array.from({ length: OBN * OBN }, () => []);
  const cellOf = (v, o) => clamp(floor((v - o) / OBW), 0, OBN - 1);
  for (let i = 0; i < Wd.blocks.length; i += 3)
    obst[cellOf(Wd.blocks[i], OX) + OBN * cellOf(Wd.blocks[i + 1], OZ)].push(
      Wd.blocks[i],
      Wd.blocks[i + 1],
      Wd.blocks[i + 2],
    );
  // The narrow crossings (world.js: a split log, poles side by side, stepping stones) are walked as lanes: x, z,
  // the way along, length, and room, how far the walker may stray from the middle line: what the crossing's
  // unseen stops (0.22 m beside it) leave a walker kept 0.3 m from them (shove), and 5 cm at least, where they
  // leave less. Walk keeps to it, led in by a funnel at each end. The stops leave the walls: two of them too
  // near pushed the walker from one to the other and back
  const LANE_MIN = 0.05,
    lanes = [],
    W8 = Wd.walls,
    inLane = new Uint8Array(W8.length / 5);
  for (const c of Wd.crossings) {
    if (c.length < 11) continue;
    const [x0, z0, x1, z1] = c.slice(6),
      len = hypot(x1 - x0, z1 - z0),
      ux = (x1 - x0) / len,
      uz = (z1 - z0) / len;
    let near = 1e9;
    for (let k = 0; k < W8.length; k += 5) {
      if (abs(W8[k + 4] - 0.22) > 1e-4) continue;
      let far = 0,
        offMin = 1e9;
      for (const e of [0, 2]) {
        const along = (W8[k + e] - x0) * ux + (W8[k + e + 1] - z0) * uz,
          off = abs((W8[k + e + 1] - z0) * ux - (W8[k + e] - x0) * uz);
        if (along < -0.6 || along > len + 0.6 || off > 1.2) far = 1;
        offMin = min(offMin, off);
      }
      if (far) continue;
      near = min(near, offMin);
      inLane[k / 5] = 1;
    }
    lanes.push(x0, z0, ux, uz, len, max(LANE_MIN, near - 0.22 - 0.3));
  }
  for (let k = 0; k < W8.length; k += 5) {
    if (inLane[k / 5]) continue;
    const i0 = cellOf(min(W8[k], W8[k + 2]), OX),
      i1 = cellOf(max(W8[k], W8[k + 2]), OX),
      j0 = cellOf(min(W8[k + 1], W8[k + 3]), OZ),
      j1 = cellOf(max(W8[k + 1], W8[k + 3]), OZ);
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++)
        walled[i + OBN * j].push(...W8.slice(k, k + 5));
  }
  // A step from (x0, z0) to (x, z) kept to the lanes: from within a lane, to within its room of its middle line,
  // and in the funnel at each end within as much more as it is metres past the end (the funnel ends where it is
  // 1.2 m wide). A walker beside a lane is not drawn into it. P2 = the point
  function lane(x, z, x0, z0) {
    for (let i = 0; i < lanes.length; i += 6) {
      const ux = lanes[i + 2],
        uz = lanes[i + 3],
        len = lanes[i + 4],
        room = lanes[i + 5],
        wideAt = (along) => min(room + max(0, -along, along - len), 1.2),
        along0 = (x0 - lanes[i]) * ux + (z0 - lanes[i + 1]) * uz,
        off0 = (z0 - lanes[i + 1]) * ux - (x0 - lanes[i]) * uz,
        along = (x - lanes[i]) * ux + (z - lanes[i + 1]) * uz,
        off = (z - lanes[i + 1]) * ux - (x - lanes[i]) * uz,
        wide = wideAt(along);
      if (abs(off0) > wideAt(along0) + 1e-6 || wide >= 1.2 || abs(off) <= wide)
        continue;
      const o = off > 0 ? wide : -wide;
      x = lanes[i] + ux * along - uz * o;
      z = lanes[i + 1] + uz * along + ux * o;
    }
    P2[0] = x;
    P2[1] = z;
  }
  // P2 = the point (x, z) moved out of every disc and wall around it, to `pad` beyond its radius: straight out
  // from a wall, so along one it slides on a straight line. Again while a move put it into another (a corner)
  const P2 = new Float64Array(2);
  function shove(x, z, pad) {
    const gx = clamp(floor((x - OX) / OBW), 1, OBN - 2),
      gz = clamp(floor((z - OZ) / OBW), 1, OBN - 2);
    for (let pass = 0, moved = true; moved && pass < 4; pass++) {
      moved = false;
      for (let j = gz - 1; j <= gz + 1; j++)
        for (let i = gx - 1; i <= gx + 1; i++) {
          const a = obst[i + OBN * j];
          for (let k = 0; k < a.length; k += 3) {
            const dx = x - a[k],
              dz = z - a[k + 1],
              r = a[k + 2] + pad,
              d2 = dx * dx + dz * dz;
            if (d2 < r * r - 1e-9 && d2 > 1e-6) {
              const s = r / sqrt(d2);
              x = a[k] + dx * s;
              z = a[k + 1] + dz * s;
              moved = true;
            }
          }
          const w = walled[i + OBN * j];
          for (let k = 0; k < w.length; k += 5) {
            const ex = w[k + 2] - w[k],
              ez = w[k + 3] - w[k + 1],
              t = clamp(
                ((x - w[k]) * ex + (z - w[k + 1]) * ez) /
                  (ex * ex + ez * ez || 1),
                0,
                1,
              ),
              qx = w[k] + ex * t,
              qz = w[k + 1] + ez * t,
              dx = x - qx,
              dz = z - qz,
              r = w[k + 4] + pad,
              d2 = dx * dx + dz * dz;
            if (d2 < r * r - 1e-9 && d2 > 1e-6) {
              const s = r / sqrt(d2);
              x = qx + dx * s;
              z = qz + dz * s;
              moved = true;
            }
          }
        }
    }
    P2[0] = x;
    P2[1] = z;
  }
  // What the forest hides. Wd.occ: how much of a level line of sight each metre of forest blocks (world.js), on a grid
  // of 3 m cells. vis[c]: can culling cell c be seen from where the walker stands, through the trees between? Worked
  // out again every few metres walked; drawCells then leaves out the hidden cells (of everything but the ground)
  const OCN = 128,
    OCW = (NX * VS) / OCN,
    occ = Wd.occ,
    vis = new Uint8Array(CELLS * CELLS).fill(1);
  const SIGHT = [0, 0, -9, -9, 9, -9, -9, 9, 9, 9]; // where in a cell the sight lines end: its middle and toward its corners
  let visX = 1e9,
    visZ = 1e9,
    visN = 0;
  function sight() {
    const cx = F[CX],
      cz = F[CZ];
    if ((cx - visX) * (cx - visX) + (cz - visZ) * (cz - visZ) < 6) return;
    visX = cx;
    visZ = cz;
    visN = 0;
    for (let c = 0; c < CELLS * CELLS; c++) {
      const tx = OX + ((c % CELLS) + 0.5) * CELLW,
        tz = OZ + (floor(c / CELLS) + 0.5) * CELLW;
      // (a cell any of which is within 46 m is always drawn: nearer than that the fog leaves enough of a thing for
      // a whole cell of them coming or going to show)
      {
        const hx = max(abs(tx - cx) - CELLW / 2, 0),
          hz = max(abs(tz - cz) - CELLW / 2, 0);
        if (hx * hx + hz * hz < 2116) {
          vis[c] = 1;
          visN++;
          continue;
        }
      }
      let best = 1e9;
      for (let s = 0; s < 5 && best > 0; s++) {
        const ex = tx + SIGHT[s * 2] - cx,
          ez = tz + SIGHT[s * 2 + 1] - cz,
          n = floor(sqrt(ex * ex + ez * ez) / OCW);
        // from 6 m out (what stands closer is looked round) to 9 m short of the end (a place's own trees do not hide it)
        let tau = 0;
        for (let k = 2; k < n - 3 && tau < best; k++)
          tau +=
            occ[
              clamp(floor((cx + (ex * k) / n - OX) / OCW), 0, OCN - 1) +
                OCN * clamp(floor((cz + (ez * k) / n - OZ) / OCW), 0, OCN - 1)
            ] * OCW;
        if (tau < best) best = tau;
      }
      // hidden: under about 2% of it would show. A cell in view stays a little longer, so it does not flicker at the edge
      vis[c] = best < (vis[c] ? 4.6 : 3.8) ? 1 : 0;
      visN += vis[c];
    }
  }
  // Viewpoints for a debugger (debug.view): a point of the trail and how many points ahead to look. 0 is where the
  // walk starts; then the first bridge, the maples, the lake, the creek's mouth, the meadow
  const EYE = 1.65,
    VIEWS = [
      [0, 14],
      [84, 10],
      [135, 12],
      [200, 10],
      [260, 10],
      [310, 12],
    ];
  const view = (i) => {
    const a = TRAIL[VIEWS[i][0] % TRAIL.length],
      b = TRAIL[(VIEWS[i][0] + VIEWS[i][1]) % TRAIL.length];
    lookAt(
      a[0],
      ground(a[0], a[1]) + EYE,
      a[1],
      b[0],
      ground(b[0], b[1]) + EYE - 0.1,
      b[1],
    );
  };

  await say('Building bridges…', 0.94, 1200);
  // lv(low, medium): a value per level. Low is tuned for a phone, where the scene is bound by its triangle count:
  // almost every distance below is where something swaps to a cheaper mesh or stops being drawn.
  const lv = (low, medium) => (MEDIUM ? medium : low);
  const meshes = [],
    KINDS = Array.from({ length: NTRUNK }, (_, k) => k);
  // add(...): appends meshes (built or not) and returns the id of the first
  const add = (...list) => {
    const first = meshes.length;
    for (const m of list) meshes.push(m.build ? m.build() : m);
    return first;
  };
  // The first ids are fixed, world.js files its instances by them: two boulders, a log, a stump, the trunks by kind, the woodwork
  add(
    meshChunk(1, 2, 1),
    meshChunk(7, 2, 1),
    meshLog(),
    meshStump(),
    ...KINDS.map((k) => meshTrunk(k)),
    Wd.wood,
  );
  const M_TRUNK = 4,
    M_WOOD = 4 + NTRUNK;
  // (the middle boulders have the near ones' fine lumps: on Low they are the same mesh, so nothing swaps close by)
  const M_BOULDER_MID = add(
      meshChunk(1, 1, 1),
      meshChunk(7, 1, 1),
      meshLog(1),
      meshStump(1),
    ),
    M_BOULDER_FAR = add(
      meshChunk(1, 0),
      meshChunk(7, 0),
      meshLog(2),
      meshStump(2),
    );
  // loose pieces by kind (world.js chunk): near, the three large rocks' middle level, and one of 20 triangles for each
  // (Low: the small rocks are 20 flat faces at every distance and the large rocks' near mesh is their middle one,
  // 80 flat faces: nothing swaps close by)
  const M_CHUNK = add(
    meshChunk(3, MEDIUM ? 2 : 0),
    meshChunk(11, MEDIUM ? 2 : 0),
    meshShroom(),
    ...[5, 17, 41].map((sd) =>
      MEDIUM ? meshChunk(sd, 3) : meshChunk(sd, 2, 1),
    ),
    meshChunk(9, 1),
    meshStick(),
    meshSlab(),
  );
  const M_CHUNK_MID = add(
    meshChunk(5, 2, 1),
    meshChunk(17, 2, 1),
    meshChunk(41, 2, 1),
  );
  const M_TINY = add(
    meshChunk(3, 0),
    meshChunk(11, 0),
    meshShroom(true),
    meshChunk(5, 0),
    meshChunk(17, 0),
    meshChunk(41, 0),
    meshChunk(9, 0),
    meshStick(true),
    meshSlab(),
  );
  const M_BIRD = add(meshBird()),
    M_FLY = add(meshFlyer(0), meshFlyer(1)),
    M_FLY_FAR = add(meshFlyer(0, true), meshFlyer(1, true)),
    M_SONG = add(
      meshSongbird(false),
      meshSongbird(true),
      meshJayNear(false),
      meshJayNear(true),
      meshRaven(false),
      meshRaven(true),
      meshPerchStick(),
    );
  // the boat by the pier and the lid that keeps the lake out of it (world.js): floated every frame
  const M_BOAT = add(Wd.boat.mesh, Wd.boat.lid);
  // who lives where along the loop: a home at a point of the trail, a range, how many, the species (birds.js)
  const home = (x, z, r, n, species, lives = 'tree') => ({
    x,
    z,
    at: [x, ground(x, z) + 1.5, z],
    r,
    n,
    species,
    lives,
  });
  // A jay is a bird of the woods: not by the lake (the boardwalk, the pier), not in the open, not on a bridge
  const inWoods = (x, z) =>
    lakeD(x, z) > 16 &&
    OPEN.every((o) => hypot(x - o[0], z - o[1]) > o[2] + 10) &&
    Wd.crossings.every(
      (c) => hypot(x - (c[2] + c[4]) / 2, z - (c[3] + c[5]) / 2) > 9,
    );
  // Where the jays live (birds.js says how many and how far apart): along the loop from FIRST_JAY_AT on, a home
  // every JAY_SPACING metres of path or more (the loop's points lie a metre apart), in the woods; then on the
  // side paths, in the middle of the longest
  // (so many jays: all but the side paths' along the loop, as far apart as there is room for and JAY_SPACING at
  // the least if that fits, less if it does not; 11: where they lived when there were eleven)
  const jayHomes = (count) => {
    if (count >= 11)
      return [5, 34, 62, 96, 128, 160, 200, 244, 288, 326, 358].map((k) =>
        home(TRAIL[k][0], TRAIL[k][1], 28, 1, 3),
      );
    const want = max(count - JAYS_ON_SIDE_PATHS, 0);
    let found = [];
    for (
      let gap = max(JAY_SPACING, floor(250 / max(want, 1)));
      gap >= 25 && found.length < want;
      gap -= 5
    ) {
      found = [];
      for (
        let k = FIRST_JAY_AT;
        found.length < want && k <= TRAIL.length - gap + FIRST_JAY_AT;
        k++
      )
        if (inWoods(TRAIL[k][0], TRAIL[k][1])) {
          found.push(TRAIL[k]);
          k += gap - 1;
        }
    }
    Wd.paths
      .slice(1)
      .sort((a, b) => b.length - a.length)
      .slice(0, min(JAYS_ON_SIDE_PATHS, count))
      .forEach((path) => found.push(path[path.length >> 1]));
    return found.map((at) => home(at[0], at[1], 22, 1, 3));
  };
  // The birds (birds.js): a flock of juncos feeding on and beside the first stretch of trail past the first
  // bridge; in the trees two parties of chickadees, two varied thrushes, four Steller's jays
  const birds = makeBirds({
    ground,
    avoid: (x, z, pad) => {
      shove(x, z, pad);
      return [P2[0], P2[1]];
    },
    standing: (x, z, pad) => {
      const gx = cellOf(x, OX),
        gz = cellOf(z, OZ);
      for (let j = max(gz - 1, 0); j <= min(gz + 1, OBN - 1); j++)
        for (let i = max(gx - 1, 0); i <= min(gx + 1, OBN - 1); i++) {
          const a = obst[i + OBN * j];
          for (let k = 0; k < a.length; k += 3)
            if (hypot(x - a[k], z - a[k + 1]) < a[k + 2] + pad) return true;
        }
      return false;
    },
    dry: (x, z) => creekAt(x, z)[0] > 0.3 && lakeD(x, z) > 0.8,
    perches: Wd.perches,
    // (the tops of posts in the woods only)
    tops: Float32Array.from(
      Array.from({ length: Wd.tops.length / 3 }, (_, i) =>
        Array.from(Wd.tops.subarray(i * 3, i * 3 + 3)),
      )
        .filter((top) => inWoods(top[0], top[2]))
        .flat(),
    ),
    // (jays only for now: the smaller birds' homes are left out)
    homes: jayHomes,
    // (on the boardwalk or the dock, at the lake's edge, or in a clearing; a creek in the woods is no bar)
    open: (x, z) =>
      lakeD(x, z) < 3 ||
      OPEN.some((o) => hypot(x - o[0], z - o[1]) < o[2]) ||
      TRAIL.slice(BOARDWALK[0], BOARDWALK[1] + 1).some(
        (p) => hypot(x - p[0], z - p[1]) < 4,
      ),
    paths: Wd.paths,
    pale: (x, z) => trailD(x, z) < trailHalf(trailK(x, z)),
    ravenTops: Wd.ravenSnags,
    // (post tops a metre to three over the ground within three metres of the loop, near the ravens' snags: rails,
    // fence and sign posts)
    ravenLows: Array.from({ length: Wd.tops.length / 3 }, (_, i) =>
      Array.from(Wd.tops.subarray(i * 3, i * 3 + 3)),
    ).filter(
      ([x, y, z]) =>
        y - ground(x, z) > 0.8 &&
        y - ground(x, z) < 3 &&
        trailD(x, z) < trailHalf(trailK(x, z)) + 3 &&
        Wd.ravenSnags.some((s) => hypot(x - s[0], z - s[2]) < RAVEN_REACH),
    ),
    // (a raven walks the middle of the loop, out of the water and away from the crossings: grass, reeds, the
    // path's edges and the dark banks of a creek would hide it)
    openGround: (x, z) =>
      lakeD(x, z) > 0.6 &&
      creekAt(x, z)[0] > 0.5 &&
      trailD(x, z) < trailHalf(trailK(x, z)) * 0.6 &&
      Wd.crossings.every(
        (c) => hypot(x - (c[2] + c[4]) / 2, z - (c[3] + c[5]) / 2) > 8,
      ),
    veil: (x, y, z, dx, dy, dz, far) => veilFrom(x, y, z, dx, dy, dz, 200, far),
    count: JAYS,
  });
  // Deer, a fox, squirrels, owls and ducks: rigid parts moved every frame (creatures.js), in their own buffer.
  // Squirrels get the big conifers nearest the trail (their radius a little up the trunk), owls the nearest snags
  const byTrail = (list, n) =>
    list
      .slice()
      .sort((a, b) => trailD(a.x, a.z) - trailD(b.x, b.z))
      .slice(0, n);
  const critters = ANIMALS
    ? makeCreatures({
        add,
        ground,
        avoid: (x, z, pad) => {
          shove(x, z, pad);
          return [P2[0], P2[1]];
        },
        trunks: byTrail(Wd.trees, 12).map((t) => ({ ...t, r: t.r * 0.9 })),
        snags: byTrail(Wd.snags, 6),
      })
    : { data: new Float32Array(12), groups: [], update() {} };
  // ---------------------------------------------------------------- deer (deer.js)
  // Is the line from a to b (an eye and a deer) hidden: by a trunk (every disc of the walker's obstacles over 0.2 m
  // across its true radius, obst padding them, between the ends), or by the forest it runs through (what Wd.occ
  // says each metre of it blocks, so that a third or less gets through)
  const deerHidden = (ax, ay, az, bx, by, bz) => {
    const len = hypot(bx - ax, bz - az),
      ux = (bx - ax) / (len || 1),
      uz = (bz - az) / (len || 1);
    let blocked = 0;
    for (let t = 1; t < len - 1; t += 1)
      blocked +=
        occ[
          clamp(floor((ax + ux * t - OX) / OCW), 0, OCN - 1) +
            OCN * clamp(floor((az + uz * t - OZ) / OCW), 0, OCN - 1)
        ];
    if (blocked > 1.1) return true;
    for (let t = 0; t < len; t += 3) {
      const a =
        obst[
          clamp(floor((ax + ux * t - OX) / OBW), 0, OBN - 1) +
            OBN * clamp(floor((az + uz * t - OZ) / OBW), 0, OBN - 1)
        ];
      for (let k = 0; k < a.length; k += 3) {
        const r = (a[k + 2] - 0.15) / 1.25,
          s = (a[k] - ax) * ux + (a[k + 1] - az) * uz;
        if (r < 0.2 || r > 1.4 || s < 0.5 || s > len - 0.5) continue;
        if (abs((a[k + 1] - az) * ux - (a[k] - ax) * uz) < r * 0.9) return true;
      }
    }
    return false;
  };
  // How closed the crowns are over a place: the share of eight lines of sight from the eye, 50 degrees up all
  // round, that the crowns veil (what they take of the light, Wd.crown, summed along it to 120, as skyShows has it)
  const deerCanopy = (x, z) => {
    const y = ground(x, z) + EYE;
    let veiled = 0;
    for (let a = 0; a < 8; a++) {
      const dx = cos(a * 0.7854) * 0.64,
        dz = sin(a * 0.7854) * 0.64;
      let sum = 0;
      for (let t = 2; t < 40 && sum < 120; t += 2) {
        const ix = floor((x + dx * t - OX) / VS / 2),
          iy = floor((y + 0.77 * t - OY) / VS / 2),
          iz = floor((z + dz * t - OZ) / VS / 2);
        if (
          ix < 0 ||
          iz < 0 ||
          iy < 0 ||
          ix >= NX / 2 ||
          iz >= NZ / 2 ||
          iy >= NY / 2
        )
          break;
        sum += Wd.crown[ix + (NX / 2) * (iy + (NY / 2) * iz)];
      }
      if (sum >= 120) veiled++;
    }
    return veiled / 8;
  };
  const deer = makeDeer({
    add,
    ground,
    avoid: (x, z, pad) => {
      shove(x, z, pad);
      return [P2[0], P2[1]];
    },
    hidden: deerHidden,
    fogT: (d) => fogT(d),
    paths: Wd.paths,
    // (what is built and stands out in the woods: bridges, the boardwalk, the dock; not a fence or a signpost by
    // the path, which a crossing's line keeps clear of)
    woodwork: [
      ...Wd.crossings.flatMap((c) => [
        [c[2], c[3]],
        [c[4], c[5]],
        [(c[2] + c[4]) / 2, (c[3] + c[5]) / 2],
      ]),
      ...TRAIL.slice(BOARDWALK[0], BOARDWALK[1] + 1),
      [Wd.pier[0], Wd.pier[1]],
      [Wd.pier[2], Wd.pier[3]],
    ],
    canopy: deerCanopy,
    trailD,
    trailHalf,
    trailK,
    creekAt,
  });
  let deerClock = 0;
  // ---------------------------------------------------------------- (deer end)
  let shown = false; // (the loader gone: sound's idle work may begin)
  // ---------------------------------------------------------------- sound (audio.js, sounds.js)
  // The bank is baked here, in the load (soundMs: how long it took). soundProbe is what audio.js reads of the world:
  // F, and what is underfoot, how closed the crowns are, how near the lake. The fallen leaves are kept from the
  // ground map (its green, at half its size) before the map is let go
  const soundFrom = performance.now();
  setBank(bakeSounds());
  const soundMs = performance.now() - soundFrom,
    SOUND_W = NX * VS,
    soundLit = new Uint8Array(256 * 256);
  for (let j = 0; j < 256; j++)
    for (let i = 0; i < 256; i++)
      soundLit[i + 256 * j] = Wd.gm[(2 * i + 1024 * j) * 4 + 1];
  const SURF = Object.fromEntries(SURFACES.map((name, k) => [name, k])),
    soundStreams = [];
  alongStreams((x, z, tx, tz, hw, lv, steep, lip) =>
    soundStreams.push(x, z, hw, lip ? 1 : 0),
  );
  const soundProbe = {
    F,
    // What is underfoot at x, z (a SURFACES code): what crosses the water (planks, a log or two, stepping stones),
    // the boardwalk and the dock, the water's edge, the path's make, and off it the clearings' grass, fallen leaves
    // or the moss and needles of the woods
    surface: (x, z) => {
      for (const c of Wd.crossings) {
        // (the line walked along: the timber's own for logs and stones, the way across, bank to bank, for planks)
        const [x0, z0, x1, z1] = c.length >= 11 ? c.slice(6) : c.slice(2),
          len = hypot(x1 - x0, z1 - z0),
          along = ((x - x0) * (x1 - x0) + (z - z0) * (z1 - z0)) / len;
        if (
          along > -0.3 &&
          along < len + 0.3 &&
          abs(((z - z0) * (x1 - x0) - (x - x0) * (z1 - z0)) / len) < 0.9
        )
          return c[0] < 2 ? SURF.planks : c[0] < 4 ? SURF.log : SURF.stone;
      }
      const [px0, pz0, px1, pz1] = Wd.pier,
        plen = hypot(px1 - px0, pz1 - pz0),
        palong = ((x - px0) * (px1 - px0) + (z - pz0) * (pz1 - pz0)) / plen;
      if (
        palong > 0 &&
        palong < plen &&
        abs(((z - pz0) * (px1 - px0) - (x - px0) * (pz1 - pz0)) / plen) < 1.2
      )
        return SURF.boardwalk;
      const k = trailK(x, z),
        onPath = trailD(x, z) < trailHalf(k) + 0.3;
      if (onPath && k >= BOARDWALK[0] && k <= BOARDWALK[1])
        return SURF.boardwalk;
      if (creekAt(x, z)[0] < 0.1 || lakeD(x, z) < 0.3) return SURF.water;
      if (onPath)
        return [SURF.gravel, SURF.dirt, SURF.leaves, SURF.grass][trailMake(k)];
      if (OPEN.some((o) => hypot(x - o[0], z - o[1]) < o[2] - 1))
        return SURF.grass;
      const lit =
        soundLit[
          clamp(floor(((x + SOUND_W / 2) / SOUND_W) * 256), 0, 255) +
            256 * clamp(floor(((z + SOUND_W / 2) / SOUND_W) * 256), 0, 255)
        ];
      return lit > 90 ? SURF.leaves : SURF.moss;
    },
    canopy: (x, z) => deerCanopy(x, z),
    lake: (x, z) => clamp(1 - lakeD(x, z) / 15, 0, 1),
    // the streams' samples: x, z, half width, 1 at a fall's lip
    streams: soundStreams,
    // metres to the lake's shore (0 on it or in it) and the way to it
    shore: (x, z) => [
      max(lakeD(x, z), 0),
      lakeD(x - 0.5, z) - lakeD(x + 0.5, z),
      lakeD(x, z - 0.5) - lakeD(x, z + 0.5),
    ],
    // the birds: species, place, what each is doing (birds.js)
    birds: () => birds.list(),
    // the way to the last flash, for its thunder's bearing (FL is made further down: read when asked)
    get flash() {
      return FL;
    },
  };
  // ---------------------------------------------------------------- (sound end)
  let nV = 0,
    nI = 0;
  for (const m of meshes) {
    m.v0 = nV;
    m.i0 = nI;
    nV += m.nv;
    nI += m.ib.length;
  }
  const allV = new Uint8Array(nV * 16),
    allI = new Uint32Array(nI);
  for (const m of meshes) {
    allV.set(new Uint8Array(m.vb), m.v0 * 16);
    allI.set(m.ib, m.i0);
  }
  const vbMesh = buf(allV, BU.VERTEX),
    ibMesh = buf(allI, BU.INDEX);
  // the ground: the full mesh, then its far levels of detail
  const terr = [T, ...T.far].map((t) => ({
    vb: buf(new Uint8Array(t.vb), BU.VERTEX),
    ib: buf(t.ib, BU.INDEX),
    n: t.ib.length,
    start: t.start,
    lo: t.lo,
    hi: t.hi,
  }));
  // the single instances (the woodwork), and after them one plain instance that the ground is drawn with
  const nSolid = Wd.solids.data.length / 12;
  const solidData = new Float32Array((nSolid + 1) * 12);
  solidData.set(Wd.solids.data);
  solidData.set([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0], nSolid * 12);
  const ibSolids = buf(solidData, BU.VERTEX),
    ibCreature = buf(critters.data, BU.VERTEX),
    ibBoat = device.createBuffer({ size: 48, usage: BU.VERTEX | BU.COPY_DST }),
    BOAT = new Float32Array(12),
    // Soft dark patches on the lake: three along the boat, one round each pile. They lie a hand under the water's
    // level: at it they fought the boat's lid for the depth and fell in moving wedges onto the boat's floor
    // (three along the boat, one round each pile (x y z radius, strength, 0 0 0)
    vbWaterBlot = buf(
      new Float32Array([
        ...[-1, 0, 1].flatMap((part) => [
          Wd.boat.at[0] + Wd.boat.along[0] * part,
          -0.06,
          Wd.boat.at[1] + Wd.boat.along[1] * part,
          1.05,
          0.42,
          0,
          0,
          0,
        ]),
        ...Wd.boat.piles.flatMap((p) => [
          p[0],
          -0.06,
          p[1],
          0.34,
          0.4,
          0,
          0,
          0,
        ]),
      ]),
      BU.VERTEX,
    ),
    ibBird = device.createBuffer({
      size: birds.data.byteLength,
      usage: BU.VERTEX | BU.COPY_DST,
    }),
    vbBlot = device.createBuffer({
      size: birds.blots.byteLength,
      usage: BU.VERTEX | BU.COPY_DST,
    });
  // (deer: their parts, their blots)
  const ibDeer = device.createBuffer({
      size: deer.data.byteLength,
      usage: BU.VERTEX | BU.COPY_DST,
    }),
    vbDeerBlot = device.createBuffer({
      size: deer.blots.byteLength,
      usage: BU.VERTEX | BU.COPY_DST,
    });
  const ibChunk = Wd.chunks.map((c) => buf(c.data, BU.VERTEX)),
    ibProp = Wd.props.map((c) => buf(c.data, BU.VERTEX)),
    ibBoulder = Wd.boulders.map((c) => buf(c.data, BU.VERTEX));
  const leafBuf = (set) => set && buf(new Uint8Array(set.buf), BU.VERTEX);
  const ibHigh = leafBuf(Wd.high),
    ibBigF = leafBuf(Wd.bigF),
    ibLow = leafBuf(Wd.low),
    ibLimb = leafBuf(Wd.limb),
    ibShrub = leafBuf(Wd.shrub),
    ibShrubF = leafBuf(Wd.shrubF),
    ibSmall = leafBuf(Wd.small),
    ibSmallF = leafBuf(Wd.smallF),
    ibBigL = leafBuf(Wd.bigL),
    ibLowM = leafBuf(Wd.lowM),
    ibSmallL = leafBuf(Wd.smallL);
  const ibFish = buf(Wd.fish, BU.VERTEX),
    ibBirds = buf(Wd.mantas, BU.VERTEX),
    ibSnowB = buf(Wd.snow, BU.VERTEX);
  const ibGl = buf(Wd.glints.data, BU.VERTEX);
  const vbSign = buf(Wd.labels, BU.VERTEX),
    nSign = Wd.labels.length / 8;
  const vbWater = buf(water.vb, BU.VERTEX),
    ibWater = buf(water.ib, BU.INDEX),
    nWater = water.ib.length;
  const nBird = Wd.mantas.length / 8,
    BIRD = meshes[M_BIRD],
    WOOD = meshes[M_WOOD],
    woodAt = Wd.woodAt;
  facts.world = `${Wd.props.reduce((n, c) => n + c.n, 0)} trees, ${Wd.low.n + Wd.high.n} leaves, ${(nI / 3) | 0} mesh triangles`;

  Q.writeTexture(
    { texture: tVol },
    Wd.volD,
    { bytesPerRow: NX, rowsPerImage: NY / 2 },
    [NX / 2, NY / 2, NZ / 2],
  );
  Q.writeTexture({ texture: tMap }, Wd.gm, { bytesPerRow: 2048 }, [512, 512]);
  Q.writeTexture(
    { texture: tContact },
    Wd.cm,
    { bytesPerRow: 1024 },
    [1024, 1024],
  );
  {
    // the stream field with the ground's height beside it (the two grids are the same size), and where white
    // water gathers in the falls
    const px = new Uint16Array(SN * SN * 4);
    for (let i = 0; i < SN * SN; i++) {
      px[i * 4] = water.half[i * 2];
      px[i * 4 + 1] = water.half[i * 2 + 1];
      px[i * 4 + 2] = half16(Wd.hm[i]);
      px[i * 4 + 3] = half16(Wd.foam[i]);
    }
    Q.writeTexture({ texture: tStream }, px, { bytesPerRow: SN * 8 }, [SN, SN]);
  }

  // ---------------------------------------------------------------- one-time bakes: foliage atlas, detail texture, shadow map
  // The atlas, layer by layer: each is drawn from the one below (bound whole, with its small levels), then gets its
  // own small levels. atlasMs: how long it took, from the shader's compiling to the GPU's finishing (debug.atlas)
  let atlasMs = 0;
  {
    const t0 = performance.now(),
      m = mod(W_ATLAS, 'ATLAS'),
      e = device.createCommandEncoder();
    const view = (layer, mip) =>
      tAtlas.createView({
        dimension: '2d',
        baseArrayLayer: layer,
        arrayLayerCount: 1,
        baseMipLevel: mip,
        mipLevelCount: mip < 0 ? ATLAS_MIPS : 1,
      });
    for (let l = 0; l < 3; l++) {
      const p = rpipe({
        layout: plBlit,
        vertex: { module: m, entryPoint: 'vs' },
        fragment: {
          module: m,
          entryPoint: 'fs' + l,
          targets: [{ format: 'rgba8unorm' }],
        },
      });
      // (layer 0 reads nothing: it gets the last layer, which is not being drawn)
      const below = tAtlas.createView({
        dimension: '2d',
        baseArrayLayer: l ? l - 1 : 2,
        arrayLayerCount: 1,
      });
      let r = e.beginRenderPass({
        colorAttachments: [colorAtt(view(l, 0), true)],
      });
      r.setPipeline(p);
      r.setBindGroup(
        0,
        device.createBindGroup({
          layout: bglBlit,
          entries: [
            { binding: 0, resource: below },
            { binding: 1, resource: sRep },
          ],
        }),
      );
      r.draw(3);
      r.end();
      for (let i = 1; i < ATLAS_MIPS; i++) {
        r = e.beginRenderPass({
          colorAttachments: [colorAtt(view(l, i), true)],
        });
        r.setPipeline(pMip8);
        r.setBindGroup(0, blitBG(view(l, i - 1)));
        r.draw(3);
        r.end();
      }
    }
    Q.submit([e.finish()]);
    Q.onSubmittedWorkDone().then(() => {
      atlasMs = performance.now() - t0;
    });
  }
  {
    const m = mod(W_DETAIL, 'DETAIL'),
      p = rpipe({
        layout: 'auto',
        vertex: { module: m, entryPoint: 'vs' },
        fragment: {
          module: m,
          entryPoint: 'fs',
          targets: [{ format: 'rgba8unorm' }],
        },
      });
    const e = device.createCommandEncoder();
    let r = e.beginRenderPass({
      colorAttachments: [
        colorAtt(
          tDetail.createView({ baseMipLevel: 0, mipLevelCount: 1 }),
          true,
        ),
      ],
    });
    r.setPipeline(p);
    r.draw(3);
    r.end();
    for (let i = 1; i < 11; i++) {
      r = e.beginRenderPass({
        colorAttachments: [
          colorAtt(
            tDetail.createView({ baseMipLevel: i, mipLevelCount: 1 }),
            true,
          ),
        ],
      });
      r.setPipeline(pMip8);
      r.setBindGroup(
        0,
        blitBG(tDetail.createView({ baseMipLevel: i - 1, mipLevelCount: 1 })),
      );
      r.draw(3);
      r.end();
    }
    r = e.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: tShadow.createView(),
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    r.setBindGroup(0, bg0s);
    r.setPipeline(pTerrSh);
    r.setVertexBuffer(0, terr[0].vb);
    r.setVertexBuffer(1, ibSolids);
    r.setIndexBuffer(terr[0].ib, 'uint32');
    r.drawIndexed(terr[0].n, 1, 0, 0, nSolid);
    r.setPipeline(pSolidSh);
    r.setVertexBuffer(0, vbMesh);
    r.setIndexBuffer(ibMesh, 'uint32');
    r.drawIndexed(
      WOOD.ib.length,
      1,
      WOOD.i0,
      WOOD.v0,
      Wd.solids.ranges[M_WOOD][0],
    );
    for (let i = 0; i < 4; i++)
      if (Wd.boulders[i].n) {
        r.setVertexBuffer(1, ibBoulder[i]);
        r.drawIndexed(
          meshes[i].ib.length,
          Wd.boulders[i].n,
          meshes[i].i0,
          meshes[i].v0,
          0,
        );
      }
    for (let i = 0; i < NTRUNK; i++)
      if (Wd.props[i].n) {
        const t = meshes[M_TRUNK + i];
        r.setVertexBuffer(1, ibProp[i]);
        r.drawIndexed(t.ib.length, Wd.props[i].n, t.i0, t.v0, 0);
      }
    r.setPipeline(pLeafSh);
    r.setVertexBuffer(0, ibLow);
    r.draw(6, Wd.low.n);
    r.setVertexBuffer(0, ibHigh);
    r.draw(6, Wd.high.n);
    r.end();
    Q.submit([e.finish()]);
  }
  // the GPU has its own copies now: let go of the generator's (but for the far pictures', sorted every frame)
  for (const o of [
    Wd.high,
    Wd.bigF,
    Wd.bigL,
    Wd.low,
    Wd.lowM,
    Wd.limb,
    Wd.shrub,
    Wd.shrubF,
    Wd.small,
    Wd.smallF,
    Wd.smallL,
    Wd.glints,
    ...Wd.chunks,
    ...Wd.props,
    ...Wd.boulders,
  ])
    if (o) o.buf = o.data = 0;
  // How much sky reaches a place 2 m over the ground, kept from the light volume before it goes: the eye adapts by it
  const skyGrid = new Float32Array(((NX / 2) * NZ) / 2);
  for (let j = 0; j < NZ / 2; j++)
    for (let i = 0; i < NX / 2; i++) {
      const iy = clamp(
        floor((Wd.hm[i * 2 + NX * j * 2] + 2 - OY) / VS / 2),
        0,
        NY / 2 - 1,
      );
      skyGrid[i + (NX / 2) * j] =
        Wd.volD[(i + (NX / 2) * (iy + (NY / 2) * j)) * 2 + 1] / 255;
    }
  // the old rule: what the exposure is to be times at a place: 1 in the open, up to 1.4 in deep shade
  const adaptAt = (x, z) => {
    const s =
        skyGrid[
          clamp(floor((x - OX) / VS / 2), 0, NX / 2 - 1) +
            (NX / 2) * clamp(floor((z - OZ) / VS / 2), 0, NZ / 2 - 1)
        ],
      t = clamp((s - 0.12) / 0.48, 0, 1);
    return 1.4 - 0.4 * t * t * (3 - 2 * t);
  };
  const adaptTo = () => adaptAt(F[CX], F[CZ]);
  Wd.volD =
    Wd.gm =
    Wd.cm =
    Wd.wood =
    Wd.blocks =
    Wd.walls =
    T.vb =
    T.ib =
    T.wp =
    T.wn =
    T.far =
      0;

  // ---------------------------------------------------------------- render targets (rebuilt on resize)
  // The scene is drawn at `pix` pixels and scaled up to the window. frame() tunes it and the draw distance scale `det`
  // for 60 fps; both start where the last visit left them, but on a dev machine, where nothing is kept, so that a
  // slow moment there never sticks.
  // phones may go lower in pixels and draw distance before the frame rate gives way: their GPUs run out first
  const PIXMAX = 2560 * 1440,
    PIXMIN = mob ? 18e4 : 5e5,
    PIX0 = MEDIUM ? (mob ? 1280 * 720 : PIXMAX) : 41e4; // the level's own
  // a phone's 3x screen gains little over 2x in this soft, hazy scene, at more than twice the pixels
  const DPRMAX = 2;
  // tan of half the field of view: vertical TANH (set by resize) and the horizontal floor TANW for a tall screen
  const TANH0 = 0.6,
    TANW = 0.48;
  let TANH = TANH0,
    W = 0,
    H = 0,
    DW = 0,
    DH = 0,
    pix = (!dev && SIZE) || PIX0,
    det = 1,
    dynN = 0,
    dynT = 0,
    dynG = 0,
    dynGN = 0,
    dynBad = 0,
    dynOk = 0,
    dynWait = 3;
  // Medium is judged in its first JUDGE s of measured frames: drawn under SLOW_SIZE of its own render size (as much
  // of it as the screen has) for SLOW_FOR s in a row, or over budget at the smallest size as long, it is too slow,
  // and this device runs Low from its next load on (quality.js)
  const JUDGE = 60,
    SLOW_SIZE = 0.7,
    SLOW_FOR = 5;
  let judged = MEDIUM ? 0 : JUDGE,
    smallFor = 0,
    starvedFor = 0;
  let passScene,
    passRays,
    passBlur,
    bgBlur,
    passPost,
    bgRays,
    bgPost = [],
    bgGrid,
    bloomPass = [],
    bloomBG = [],
    targets = [];
  const NB = MEDIUM ? 6 : 4; // bloom levels: each is two render passes, and a phone GPU pays by the pass
  function resize() {
    const dpr = min(devicePixelRatio, DPRMAX);
    DW = max(2, round(canvas.clientWidth * dpr));
    DH = max(2, round(canvas.clientHeight * dpr));
    // portrait keeps the horizontal view at least TANW wide; landscape keeps the original vertical TANH0
    TANH = max(TANH0, (TANW * DH) / DW);
    const s = min(1, sqrt(pix / (DW * DH)));
    const w = max(2, round(DW * s) & ~1),
      h = max(2, round(DH * s) & ~1);
    if (w === W && h === H) return;
    dynN = dynG = dynGN = 0;
    dynT = -300; // let the new size settle before measuring again
    W = w;
    H = h;
    canvas.width = W;
    canvas.height = H;
    facts.canvas = `${W}x${H} of ${DW}x${DH}`;
    ctx.configure({ device, format: FMT, alphaMode: 'opaque' });
    for (const t of targets) t.destroy();
    const tMS = tex(AA > 1 ? W : 1, H, HDR, TU.RENDER_ATTACHMENT, {
        samples: AA,
      }),
      tDp = tex(W, H, DEPTH, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING, {
        samples: AA,
      });
    const rw = max(1, (W / RAYD) | 0),
      rh = max(1, (H / RAYD) | 0);
    const tRes = tex(W, H, HDR, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING),
      tRay = tex(rw, rh, HDR, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING),
      tRay2 = tex(rw, rh, HDR, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING);
    targets = [tMS, tDp, tRes, tRay, tRay2];
    const bl = [];
    for (let i = 0; i < NB; i++) {
      const t = tex(
        max(1, W >> (i + 1)),
        max(1, H >> (i + 1)),
        HDR,
        TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING,
      );
      bl.push(t);
      targets.push(t);
    }
    const vDp = tDp.createView(),
      vRes = tRes.createView(),
      vRay = tRay.createView(),
      vRay2 = tRay2.createView(),
      vBl = bl.map((t) => t.createView());
    // without anti-aliasing (Low) the scene goes straight into the resolve target, and tMS is one unused column
    passScene = {
      colorAttachments: [
        {
          view: AA > 1 ? tMS.createView() : vRes,
          resolveTarget: AA > 1 ? vRes : undefined,
          loadOp: 'clear',
          storeOp: AA > 1 ? 'discard' : 'store',
          clearValue: [0, 0, 0, 1],
        },
      ],
      depthStencilAttachment: {
        view: vDp,
        depthClearValue: 0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    };
    passRays = { colorAttachments: [colorAtt(vRay, true)] };
    passBlur = { colorAttachments: [colorAtt(vRay2, true)] };
    bgBlur = device.createBindGroup({
      layout: pRB.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: vRay }],
    });
    passPost = {
      colorAttachments: [
        {
          view: null,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: [0, 0, 0, 1],
        },
      ],
    };
    bgRays = device.createBindGroup({
      layout: pRays.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: ubo } },
        { binding: 1, resource: sRep },
        { binding: 2, resource: sCmp },
        { binding: 3, resource: tShadow.createView() },
        { binding: 4, resource: tWater.createView() },
        { binding: 5, resource: vDp },
        { binding: 6, resource: tVol.createView() },
        { binding: 7, resource: sClamp },
      ],
    });
    // (one for each of the two adapted values)
    bgPost = tAdapt.map((t) =>
      device.createBindGroup({
        layout: pPost.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: ubo } },
          { binding: 1, resource: sClamp },
          { binding: 2, resource: vRes },
          { binding: 3, resource: vRay2 },
          { binding: 4, resource: vBl[0] },
          { binding: 5, resource: vDp },
          { binding: 6, resource: t.createView() },
        ],
      }),
    );
    bgGrid = device.createBindGroup({
      layout: pGrid.getBindGroupLayout(0),
      entries: [
        { binding: 1, resource: sClamp },
        { binding: 2, resource: vRes },
        { binding: 3, resource: vRay2 },
      ],
    });
    bloomPass = [];
    bloomBG = [];
    // down: res -> b0 -> ... -> b5 ; up: b5 -> b4 (additive) ... -> b0
    for (let i = 0; i < NB; i++) {
      bloomPass.push({ colorAttachments: [colorAtt(vBl[i], true)] });
      bloomBG.push(blitBG(i ? vBl[i - 1] : vRes));
    }
    for (let i = NB - 1; i > 0; i--) {
      bloomPass.push({ colorAttachments: [colorAtt(vBl[i - 1], false)] });
      bloomBG.push(blitBG(vBl[i]));
    }
    UB[52] = W;
    UB[53] = H;
    UB[54] = 1 / W;
    UB[55] = 1 / H;
  }
  resize();
  addEventListener('resize', resize);

  // ---------------------------------------------------------------- timing (GPU timestamp queries)
  let qs,
    qResolve,
    qRead = [],
    tsBegin,
    tsEnd;
  if (hasTS) {
    qs = device.createQuerySet({ type: 'timestamp', count: 2 });
    qResolve = device.createBuffer({
      size: 16,
      usage: BU.QUERY_RESOLVE | BU.COPY_SRC,
    });
    for (let i = 0; i < 6; i++) {
      const b = device.createBuffer({
        size: 16,
        usage: BU.MAP_READ | BU.COPY_DST,
      });
      const o = { b, busy: false, done: null };
      o.done = () => {
        const a = new BigInt64Array(b.getMappedRange());
        const ms = Number(a[1] - a[0]) / 1e6;
        F[GPU] = ms;
        b.unmap();
        o.busy = false;
        if (dynT > 0 && ms > 0 && ms < 1e3) {
          dynG += ms;
          dynGN++;
        }
      };
      qRead.push(o);
    }
    tsBegin = { querySet: qs, beginningOfPassWriteIndex: 0 };
    tsEnd = { querySet: qs, endOfPassWriteIndex: 1 };
  }

  // ---------------------------------------------------------------- frame
  let lkx = 0,
    lky = 0,
    l2x = 0,
    l2y = 0,
    tunes = 0;
  const NEAR = 0.1,
    EXPO = 0.6,
    RAYS = 1;
  // Exposure (W_POST): the old rule's, by how much sky reaches the walker, stopped down while the highlights in
  // view (W_METER, adapted) times it would go over HIGH: their value on the walk's opening view (debug.trail(0, 10),
  // clear, the eye settled: EXPO_OPEN), the brightest the scene allows; OPEN_HIGH, those highlights as
  // debug.exposureNow measured them at each level (the mean of 40 s)
  const EXPO_OPEN = EXPO * (1 + 0.9 * MIST) * adaptAt(TRAIL[0][0], TRAIL[0][1]),
    OPEN_HIGH = lv(0.4654, 0.4677),
    HIGH = EXPO_OPEN * OPEN_HIGH;
  // the exposure in use, by debug.exposure's mode, from the old rule's (place) and the highlights adapted to
  const exposureOf = (place, high) =>
    expoMode ? place : place * clamp(HIGH / (place * high), 0.4, 1);
  const submitList = [null];
  const rowOrd = new Uint8Array(CELLS);
  // Where things swap meshes or stop (metres, scaled by `det` like every distance but the ground's and the trees')
  const TERR_FAR = lv([34, 60], [44, 68]); // ground: to its 1/4 and 1/16 meshes
  // (the far meshes come in deep in the fog, where the change of outline is a pixel or two)
  const BOULDER = lv([14, 40], [14, 56]); // boulders, logs and stumps: to their middle mesh, then the far one
  const CHUNK = lv([12, 16, 40], [16, 16, 56]); // small rocks and mushrooms to their 20-odd triangles; large rocks to 1/4, then to 20
  const CHUNK_END = lv(48, 96); // small rocks and mushrooms stop here (world.js gives the rocks the same fade)
  const PEBBLE = lv([1, 12], [1, 24]); // pebbles: as 20 triangles?, and how far
  const FLY_NEAR = lv(20, 50),
    GLINT_END = lv(60, 90);
  const SPRITES = lv([2500, 3500, 500, 260], [6000, 7000, 900, 500]); // dust, raindrops, falling leaves, drips (of Wd.snow)
  // D(v): where the fog of the moment lets v through along a level ray (hazeT in S_G, from G.wx.w and G.st.y)
  const hazeNow = () =>
    FOG + 0.006 * F[OVER] + 0.009 * F[RAIN] + 0.046 * F[FOGK];
  const fogV = (d) => exp(-((hazeNow() * d) ** (1.7 - 0.4 * F[FOGK])));
  // and closed (hazeT: by the ray's length, from LOD.close[0] to [1])
  const fogT = (d) => fogV(d) * (1 - sstep(LOD.close[0], LOD.close[1], d));
  const fogD = (v) => (-Math.log(v)) ** (1 / (1.7 - 0.4 * F[FOGK])) / hazeNow();
  // the same on a clear day (its haze: FOG and MIST's overcast), for the thinning that keeps to it
  const clearD = (v) => (-Math.log(v)) ** (1 / 1.7) / (FOG + 0.006 * MIST);
  const TREE_CLEAR = [clearD(TREE_FADE[0]), clearD(TREE_FADE[1]), 0, 0],
    SHRUB_CLEAR = SHRUB_FADE.map(clearD);
  // where a store's share kept (W_LEAF thin) has fallen to k: the inverse of mix(K0, KMIN, ss(from, to, d))
  const shareAt = (s, d, k) => {
    const f = clamp((s.K0 - k) / (s.K0 - s.KMIN), 0, 1);
    return d[0] + (d[1] - d[0]) * (0.5 - sin(Math.asin(1 - 2 * f) / 3));
  };
  // A store's set of the cards of rank under c (world.js lowRank: .75, .53, .27, .18) is drawn from where the
  // shader shows none over it: its share down to c, less the .03 the set holds over for rounding
  const cutAt = (s, d, c) => shareAt(s, d, max(c - 0.03, s.KMIN));
  // W_LEAF thin mirrored: a card's width times at cd metres (its size is 1 at every distance)
  const thinW = (s, d, rank, cd) => {
    const k = mix(s.K0, s.KMIN, sstep(d[0], d[1], cd)),
      r = sqrt(d[2] / d[3]),
      h = sin(rank * 31.7 * 127.1) * 43758.5453,
      end = d[3] * mix(r, 1, h - floor(h));
    return clamp((k - rank) / (0.2 * k), 0, 1) * (1 - sstep(end * r, end, cd));
  };
  // V at the nearest distance where any card of a store is not whole (debug.lod)
  const wholeTo = (s, d) => {
    for (let cd = 0; cd < d[3]; cd += 0.05)
      for (let i = 0; i <= 2048; i++)
        if (thinW(s, d, min(i / 2048, 0.999999), cd) !== 1) return fogV(cd);
    return 0;
  };
  const SMALL_D = [THIN_SMALL.PD1, THIN_SMALL.PD2],
    SMALL_F = cutAt(THIN_SMALL, SMALL_D, 0.53),
    SMALL_L = cutAt(THIN_SMALL, SMALL_D, 0.18);
  // The fog's distances now (G.lt, G.ls, G.lf) and the cuts of LEAVES that follow them, for every frame. The far
  // trees' pictures (far: where they begin to come in and are whole, as the trees' cards thin) are drawn to where
  // the fog has closed (farSorted); so are the ground plants, a card's reach (2.5 m) on. (The fog's close is drawn
  // in to end by FOG_END, were it ever that thin)
  const LOD = {
      tree: new Float64Array(4),
      shrub: new Float64Array(4),
      far: TREE_CLEAR.slice(0, 2),
      close: [0, 0],
    },
    TIER = {};
  const lodNow = () => {
    const t = LOD.tree,
      s = LOD.shrub;
    const q = min(1, FOG_END / fogD(CLOSE[1]));
    LOD.close[0] = fogD(CLOSE[0]) * q;
    LOD.close[1] = fogD(CLOSE[1]) * q;
    // the clear day's thinning; the trees' cards end in the closed fog, the shrubs' as on a clear day or there
    t.set(TREE_CLEAR);
    t[2] = LOD.close[1];
    t[3] = FOG_END + 1;
    s.set(SHRUB_CLEAR);
    TIER.plant = min(PLANT_END, LOD.close[1] + 2.5);
    TIER.tree = drawEnd(5);
    TIER.lowM = min(max(NEAR_D, cutAt(THIN_TREE, t, 0.75)), TIER.tree);
    TIER.bigF = min(max(TIER.lowM, cutAt(THIN_TREE, t, 0.53)), TIER.tree);
    TIER.bigL = min(cutAt(THIN_TREE, t, 0.27), TIER.tree);
    TIER.farEnd = drawEnd(9);
    TIER.shrub = min(s[3], drawEnd(2.5));
    TIER.shrubF = min(max(NEAR_D, cutAt(THIN_SHRUB, s, 0.53)), TIER.shrub);
  };
  // leaves: pipeline, buffer, set, margin, vertices per blade, from, to (metres, or the name of a cut in TIER). A
  // tree's or a shrub's card is SPRIGS quads within NEAR_D and its first two beyond (W_LEAF vsN: the others are
  // folded away by then; the trees' cards high in a crown, Wd.high, never have more). Further off each store is
  // drawn whole up to where the shader has thinned away its cards of rank over a half, then only those under
  // (Wd.bigF, shrubF, smallF), and from where it has thinned them to their least a third set (bigL, smallL); the
  // trees' low cards have one of three quarters before that (lowM). So no cut, made by sub-cell, ever shows
  const LEAVES = [
    [pLeafM, ibLow, Wd.low, 5, SPRIGS * 6, 0, NEAR_D],
    [pLeafM, ibLow, Wd.low, 5, 12, NEAR_D, 'lowM'],
    [pLeafM, ibLowM, Wd.lowM, 5, 12, 'lowM', 'bigF'],
    [pLeafM, ibHigh, Wd.high, 5, 12, 0, 'bigF'],
    [pLeafM, ibBigF, Wd.bigF, 5, 12, 'bigF', 'bigL'],
    [pLeafM, ibBigL, Wd.bigL, 5, 12, 'bigL', 'tree'],
    [pLeafMS, ibShrub, Wd.shrub, 2.5, SPRIGS * 6, 0, NEAR_D],
    [pLeafMS, ibShrub, Wd.shrub, 2.5, 12, NEAR_D, 'shrubF'],
    [pLeafMS, ibShrubF, Wd.shrubF, 2.5, 12, 'shrubF', 'shrub'],
    [pLeafL, ibLimb, Wd.limb, 5, 6, 0, 'tree'],
    [pLeafS, ibSmall, Wd.small, 2.5, 6, 0, SMALL_F],
    [pLeafS, ibSmallF, Wd.smallF, 2.5, 6, SMALL_F, SMALL_L],
    [pLeafS, ibSmallL, Wd.smallL, 2.5, 6, SMALL_L, 'plant'],
  ];
  const tierAt = (x) => (typeof x === 'string' ? TIER[x] : x);
  // where solids stop being drawn: FOG_END, or where the fog has closed over all of them (mar: their reach)
  const drawEnd = (mar) => min(FOG_END, LOD.close[1] + mar);
  // one level of detail of a cell-sorted set of solids: `mesh` for the cells within [from, to)
  const tier = (r, set, mesh, mar, from, to) => {
    if (to > from) drawCells(r, set, mar, mesh, 0, from, to);
  };
  // The far pictures to blend in this frame where the fog closes: those in view from where they begin to come in
  // to where the fog has closed over them (TIER.farEnd), far to near, into vbFar (world.js farT's records: crown
  // foot, height; yaw, tilt, width, height up its tree; kind and seeds as bytes). Returns how many
  const farF = new Float32Array(Wd.farT.buf),
    farB = new Uint8Array(Wd.farT.buf),
    vbFar = device.createBuffer({
      size: max(Wd.farT.n * 36, 4),
      usage: BU.VERTEX | BU.COPY_DST,
    }),
    farOut = new Uint8Array(Wd.farT.n * 36),
    farK = new Uint32Array(Wd.farT.n),
    farD = new Float32Array(Wd.farT.n);
  let farN = 0;
  const farSorted = () => {
    const from = LOD.far[0],
      to = TIER.farEnd,
      cx = F[CX],
      cz = F[CZ];
    let n = 0;
    for (let c = 0; c < CELLS * CELLS; c++) {
      if (!vis[c] && !ISO[3]) continue;
      const px = abs(OX + ((c % CELLS) + 0.5) * CELLW - cx),
        pz = abs(OZ + (floor(c / CELLS) + 0.5) * CELLW - cz);
      if (
        hypot(max(px - CELLW / 2, 0), max(pz - CELLW / 2, 0)) >= to ||
        hypot(px + CELLW / 2, pz + CELLW / 2) < from
      )
        continue;
      for (let k = Wd.farT.start[c]; k < Wd.farT.start[c + 1]; k++) {
        const x = farF[k * 9],
          z = farF[k * 9 + 2],
          h = farF[k * 9 + 3],
          d = hypot(x - cx, z - cz);
        if (d < from || d >= to) continue;
        if (seen(x, farF[k * 9 + 1] + h / 2, z, (h + farF[k * 9 + 6]) / 2) < 0)
          continue;
        farD[k] = d;
        farK[n++] = k;
      }
    }
    farK.subarray(0, n).sort((a, b) => farD[b] - farD[a]);
    for (let j = 0; j < n; j++)
      farOut.set(farB.subarray(farK[j] * 36, farK[j] * 36 + 36), j * 36);
    if (n) Q.writeBuffer(vbFar, 0, farOut, 0, n * 36);
    return n;
  };
  // How far a sphere is (0 inside it) when any of it is in view, else -1.
  function seen(x, y, z, rad) {
    const px = x - F[CX],
      py = y - F[CY],
      pz = z - F[CZ],
      tx = (TANH * W) / H;
    const df = px * F[FX] + py * F[FY] + pz * F[FZ];
    if (
      df < -rad ||
      abs(px * F[RX] + pz * F[RZ]) - df * tx > rad * sqrt(1 + tx * tx) ||
      abs(px * F[UX] + py * F[UY] + pz * F[UZ]) - df * TANH >
        rad * sqrt(1 + TANH * TANH)
    )
      return -1;
    const dist = sqrt(px * px + py * py + pz * pz) - rad;
    return dist > 0 ? dist : 0;
  }
  // Draws what of a cell-sorted store is in view and within [minD, maxD) of the camera (scaled by `det`, but not for
  // the ground), as merged runs, nearest rows first. A store with `sub` is cut by sub-cell where a cell straddles
  // either distance; one without (the ground) goes cell by cell, by the cell's nearest point.
  // indexed: 1 for the ground, a mesh for instances of it, false for `verts` vertices per instance.
  function drawCells(r, set, mar, indexed, verts, minD, maxD) {
    const start = set.start,
      lo = set.lo,
      hi = set.hi,
      sub = set.sub;
    auditCur = auditing && indexed !== 1 ? auditNote(set, minD, maxD) : null;
    const cx = F[CX],
      cy = F[CY],
      cz = F[CZ],
      fx = F[FX],
      fy = F[FY],
      fz = F[FZ],
      rx = F[RX],
      rz = F[RZ],
      ux = F[UX],
      uy = F[UY],
      uz = F[UZ];
    const ds = indexed === 1 ? 1 : det * det;
    const tx = (TANH * W) / H,
      hw = CELLW * 0.5,
      ex = hw + mar,
      min2 = minD * minD * ds,
      max2 = maxD * maxD * ds;
    for (let k = 0; k < CELLS; k++) {
      const rw = rowOrd[k],
        row = rw * CELLS,
        pz = OZ + (rw + 0.5) * CELLW - cz,
        hz = max(abs(pz) - hw, 0),
        gz = abs(pz) + hw;
      // the run of instances gathered so far (to: -1, not 0, or a run that begins with the store's very first
      // instance would never start)
      let from = -1,
        to = -1;
      for (let x = 0; x < CELLS; x++) {
        const c = row + x,
          l = lo[c],
          h = hi[c];
        // (debug.isolate shows its tree whatever would hide it)
        if (l > h || (indexed !== 1 && !vis[c] && !ISO[3])) continue;
        const px = OX + (x + 0.5) * CELLW - cx,
          hx = max(abs(px) - hw, 0),
          near2 = hx * hx + hz * hz;
        if (near2 >= max2) continue;
        const gx = abs(px) + hw,
          far2 = gx * gx + gz * gz;
        if (sub ? far2 < min2 : near2 < min2) continue;
        const py = (l + h) * 0.5 - cy,
          ey = (h - l) * 0.5 + mar,
          lim =
            px * fx +
            py * fy +
            pz * fz +
            ex * abs(fx) +
            ey * abs(fy) +
            ex * abs(fz);
        if (
          lim < 0 ||
          abs(px * rx + pz * rz) - ex * (abs(rx) + abs(rz)) > lim * tx ||
          abs(px * ux + py * uy + pz * uz) -
            ex * (abs(ux) + abs(uz)) -
            ey * abs(uy) >
            lim * TANH
        )
          continue;
        if (!sub || (near2 >= min2 && far2 < max2)) {
          // the whole cell
          const a = start[c],
            b = start[c + 1];
          if (a === b) continue;
          if (to !== a) {
            if (from >= 0) drawRun(r, indexed, verts, from, to);
            from = a;
          }
          to = b;
          continue;
        }
        for (let s = 0; s < SUBS * SUBS; s++) {
          // a cell on the edge of the range: its sub-cells one by one
          const qx = max(
              abs(px + ((s % SUBS) + 0.5 - SUBS / 2) * SUBW) - SUBW / 2,
              0,
            ),
            qz = max(
              abs(pz + (floor(s / SUBS) + 0.5 - SUBS / 2) * SUBW) - SUBW / 2,
              0,
            ),
            d2 = qx * qx + qz * qz;
          if (d2 < min2 || d2 >= max2) continue;
          const a = sub[c * SUBS * SUBS + s],
            b = sub[c * SUBS * SUBS + s + 1];
          if (a === b) continue;
          if (to !== a) {
            if (from >= 0) drawRun(r, indexed, verts, from, to);
            from = a;
          }
          to = b;
        }
      }
      if (from >= 0) drawRun(r, indexed, verts, from, to);
    }
  }
  const SUBW = CELLW / SUBS;
  // triBy: the frame's triangles so far by what they are (render sets `cat`), for the stats line: the scene is bound
  // by triangles, so this is what to read before adding geometry. drawN: draw calls
  const CATS = ['ground', 'rocks+logs', 'trunks', 'leaves', 'plants', 'air'],
    triBy = new Float64Array(CATS.length); // air: dust, falling leaves, rain
  let cat = 0,
    birdTris = 0, // (the last frame's, the sticks under them too: debug.birdTris)
    drawN = 0,
    cpuMs = 0;
  // the frame's triangles for each row of LEAVES (debug.tiers)
  const tierTris = new Float64Array(16);
  // debug.audit: does the culling leave out anything it should draw? While auditing, every store drawn in a frame
  // is noted with the runs of it that were drawn and the distances it was asked for (auditSets); audit() then
  // counts the cells (the sub-cells, where a store has them) that hold something, lie wholly within 40 m and
  // within those distances, have a corner inside the frame, and are in no run. [cells checked, cells missed]
  let auditing = false,
    auditCur = null;
  const auditSets = new Map();
  const auditNote = (set, minD, maxD) => {
    let rec = auditSets.get(set);
    if (!rec) auditSets.set(set, (rec = { runs: [], min: 1e9, max: 0 }));
    rec.min = min(rec.min, minD);
    rec.max = max(rec.max, maxD);
    return rec;
  };
  const audit = () => {
    const m = UB,
      cx = F[CX],
      cz = F[CZ];
    let checked = 0,
      missed = 0;
    const inFrame = (x, y, z) => {
      const w = m[3] * x + m[7] * y + m[11] * z + m[15];
      return (
        w > 0.1 &&
        abs(m[0] * x + m[4] * y + m[8] * z + m[12]) < w &&
        abs(m[1] * x + m[5] * y + m[9] * z + m[13]) < w
      );
    };
    // one box of a store, holding its instances (or the woodwork's triangles) a to b
    const check = (rec, x0, z0, wide, y0, y1, a, b) => {
      const x1 = x0 + wide,
        z1 = z0 + wide,
        far = hypot(
          max(abs(x0 - cx), abs(x1 - cx)),
          max(abs(z0 - cz), abs(z1 - cz)),
        ),
        near = hypot(max(x0 - cx, cx - x1, 0), max(z0 - cz, cz - z1, 0));
      // (a box right on a store's distance limit belongs to it or to its neighbour by a rounding: left out)
      if (a === b || far > min(40, rec.max) - 0.01 || near < rec.min + 0.01)
        return;
      let seenAny = false;
      for (let k = 0; k < 8 && !seenAny; k++)
        seenAny = inFrame(k & 1 ? x1 : x0, k & 2 ? y1 : y0, k & 4 ? z1 : z0);
      if (!seenAny) return;
      checked++;
      for (let i = 0; i < rec.runs.length; i += 2)
        if (rec.runs[i] <= a && b <= rec.runs[i + 1]) return;
      missed++;
    };
    for (const [set, rec] of auditSets)
      for (let c = 0; c < CELLS * CELLS; c++) {
        const x0 = OX + (c % CELLS) * CELLW,
          z0 = OZ + floor(c / CELLS) * CELLW;
        if (set === woodAt)
          check(rec, x0, z0, CELLW, F[CY] - 3, F[CY] + 3, set[c], set[c + 1]);
        else if (!set.sub)
          check(
            rec,
            x0,
            z0,
            CELLW,
            set.lo[c],
            set.hi[c],
            set.start[c],
            set.start[c + 1],
          );
        else
          for (let s = 0; s < SUBS * SUBS; s++)
            check(
              rec,
              x0 + (s % SUBS) * SUBW,
              z0 + floor(s / SUBS) * SUBW,
              SUBW,
              set.lo[c],
              set.hi[c],
              set.sub[c * SUBS * SUBS + s],
              set.sub[c * SUBS * SUBS + s + 1],
            );
      }
    return [checked, missed];
  };
  function drawRun(r, indexed, verts, from, to) {
    drawN++;
    if (auditCur) auditCur.runs.push(from, to);
    triBy[cat] +=
      indexed === 1
        ? (to - from) * 2
        : indexed
          ? (indexed.ib.length / 3) * (to - from)
          : (verts > 6 ? verts / 3 : verts - 2) * (to - from);
    if (indexed === 1) r.drawIndexed((to - from) * 6, 1, from * 6, 0, nSolid);
    else if (indexed)
      r.drawIndexed(indexed.ib.length, to - from, indexed.i0, indexed.v0, from);
    else r.draw(verts, to - from, 0, from);
  }
  function render() {
    triBy.fill(0);
    cat = drawN = 0;
    if (auditing) auditSets.clear();
    sight();
    // camera basis (right vector is horizontal)
    const cx = F[CX],
      cy = F[CY],
      cz = F[CZ],
      pitch = F[PIT],
      yaw = F[YAW];
    const cp = cos(pitch),
      fy = sin(pitch),
      rx = cos(yaw),
      rz = sin(yaw),
      fx = cp * rz,
      fz = -cp * rx;
    const ux = -rz * fy,
      uy = rz * fx - rx * fz,
      uz = rx * fy;
    F[FX] = fx;
    F[FY] = fy;
    F[FZ] = fz;
    F[RX] = rx;
    F[RZ] = rz;
    F[UX] = ux;
    F[UY] = uy;
    F[UZ] = uz;
    const asp = W / H,
      sx = 1 / (TANH * asp),
      sy = 1 / TANH,
      m = UB;
    m[0] = rx * sx;
    m[4] = 0;
    m[8] = rz * sx;
    m[12] = -(rx * cx + rz * cz) * sx;
    m[1] = ux * sy;
    m[5] = uy * sy;
    m[9] = uz * sy;
    m[13] = -(ux * cx + uy * cy + uz * cz) * sy;
    m[2] = 0;
    m[6] = 0;
    m[10] = 0;
    m[14] = NEAR;
    m[3] = fx;
    m[7] = fy;
    m[11] = fz;
    m[15] = -(fx * cx + fy * cy + fz * cz);
    m[32] = cx;
    m[33] = cy;
    m[34] = cz;
    m[35] = F[TIME];
    m[36] = rx;
    m[37] = 0;
    m[38] = rz;
    m[39] = TANH * asp;
    m[40] = ux;
    m[41] = uy;
    m[42] = uz;
    m[43] = TANH;
    m[44] = fx;
    m[45] = fy;
    m[46] = fz;
    m[47] = NEAR;
    // The weather (struct G): sun.w how overcast (the clouds come before the rain), mis exposure (the eye opens up
    // under cloud, but a storm stays dark), shafts, draw distance, debug.sprigs; wx wetness, wind, rain falling, haze per metre
    // (thick fog closes the view in at about 30 m)
    const rain = F[RAIN],
      fogK = F[FOGK],
      over = F[OVER];
    m[51] = over;
    m[56] =
      ISO[3] === 2
        ? EXPO_OPEN
        : EXPO *
          (1 + 0.9 * over) *
          (1 - 0.22 * F[STORM]) *
          (F[ADAPT] || adaptTo());
    // (a tree shown alone and shaded: no shafts, the opening view's exposure, held)
    m[57] = ISO[3] === 2 ? 0 : RAYS;
    m[58] = det;
    m[59] = sprigsMode;
    m[60] = F[WET];
    m[61] = windNow();
    m[62] = rain;
    m[63] = hazeNow();
    // fl: where in the sky the lightning is and how bright now; st: storm, thick fog, the flash's kind, and how
    // far a bolt has crept out
    m[64] = FL[0];
    m[65] = FL[1];
    m[66] = FL[2];
    m[67] = flashNow();
    m[68] = F[STORM];
    m[69] = fogK;
    m[70] = FL[3];
    m[71] = crawlNow();
    // wy: how far the wind has blown things so far (a distance: a speed times the time would run away as the wind
    // changes), how soaked the ground is, the walker's own speed (rain leans against it)
    m[72] = F[BLOWN];
    m[73] = F[SOAK];
    m[74] = F[VX];
    m[75] = F[VZ];
    // lt, ls, lf: where the leaves thin and end in this fog (lodNow; LEAVES cuts by the same numbers)
    lodNow();
    m.set(LOD.tree, 76);
    m.set(LOD.shrub, 80);
    m[84] = LOD.far[0];
    m[85] = LOD.far[1];
    m.set(LOD.close, 86);
    // ex: the highlights' key, 1 for the old exposure rule (debug.exposure); ea: the frame's seconds, 1 to take its
    // measure at once
    m[88] = HIGH;
    m[89] = ISO[3] === 2 ? 1 : expoMode;
    m[90] = isoPart;
    m[92] = frameDt;
    m[93] = meterNew ? 1 : 0;
    // dbg: debug.isolate
    m.set(ISO, 96);
    meterNew = false;
    Q.writeBuffer(ubo, 0, UB);
    WT[0] = F[TIME];
    WT[1] = m[61];
    Q.writeBuffer(uboW, 0, WT);

    {
      let cr = floor((cz - OZ) / CELLW) | 0;
      cr = cr < 0 ? 0 : cr > CELLS - 1 ? CELLS - 1 : cr;
      let n = 0;
      rowOrd[n++] = cr;
      for (let d = 1; d < CELLS; d++) {
        if (cr - d >= 0) rowOrd[n++] = cr - d;
        if (cr + d < CELLS) rowOrd[n++] = cr + d;
      }
    }
    const e = device.createCommandEncoder();
    let slot = null;
    if (hasTS) {
      for (let i = 0; i < qRead.length; i++)
        if (!qRead[i].busy) {
          slot = qRead[i];
          break;
        }
    }
    waterPass[0].timestampWrites = slot ? tsBegin : undefined;
    passPost.timestampWrites = slot ? tsEnd : undefined;
    // the animated texture (leaf shadows, ripples) + mips
    let r = e.beginRenderPass(waterPass[0]);
    r.setPipeline(pWater);
    r.setBindGroup(0, bgWater);
    r.draw(3);
    r.end();
    for (let i = 1; i < 5; i++) {
      r = e.beginRenderPass(waterPass[i]);
      r.setPipeline(pMip16);
      r.setBindGroup(0, waterBG[i - 1]);
      r.draw(3);
      r.end();
    }
    // scene
    r = e.beginRenderPass(passScene);
    // (debug.isolate: only its tree, on black; the vertex shaders leave out every other card and solid)
    const alone = ISO[3] > 0;
    // the signposts' lettering, the falling leaves, the sky, a bolt, the lake and the streams
    const backdrop = () => {
      // the signposts' lettering, over their boards
      r.setPipeline(pSign);
      r.setBindGroup(1, bgSign);
      r.setVertexBuffer(0, vbSign);
      r.draw(4, nSign);
      drawN++;
      // falling leaves (opaque), the sky behind everything, then the lake's water blended over its bed
      r.setPipeline(pFall);
      r.setVertexBuffer(0, ibSnowB);
      r.draw(4, SPRITES[2]);
      drawN++;
      triBy[5] += SPRITES[2] * 2;
      r.setPipeline(pBack);
      r.draw(4);
      // a bolt of lightning, on the sky: behind everything else, and under the rain drawn after it
      if (FL[3] > 1 && boltN && flick.length && flashAge() < 2.5) {
        r.setPipeline(pBolt);
        r.setVertexBuffer(0, vbBolt);
        r.draw(4, boltN);
        drawN++;
        triBy[5] += boltN * 2;
      }
      r.setPipeline(pSurf);
      r.draw(4);
      // a soft dark patch on the lake under the boat and round each pile
      r.setPipeline(pBlot);
      r.setVertexBuffer(0, vbWaterBlot);
      r.draw(4, 3 + Wd.boat.piles.length);
      drawN++;
      // the running water: one mesh for both streams (a few thousand triangles, so it is not culled)
      r.setPipeline(pStream);
      r.setVertexBuffer(0, vbWater);
      r.setIndexBuffer(ibWater, 'uint32');
      r.drawIndexed(nWater);
      drawN++;
      triBy[0] += nWater / 3;
    };

    r.setBindGroup(0, bg0);
    // The ground: each far level starts one ring of cells early, under the finer one, which hides the cracks. The
    // last goes on a little past where the fog has taken everything else
    r.setPipeline(pTerrain);
    r.setVertexBuffer(1, ibSolids);
    for (let l = 0; l < terr.length; l++) {
      const t = terr[l];
      r.setVertexBuffer(0, t.vb);
      r.setIndexBuffer(t.ib, 'uint32');
      drawCells(
        r,
        t,
        1.5,
        1,
        0,
        l ? TERR_FAR[l - 1] - CELLW : 0,
        l < terr.length - 1 ? TERR_FAR[l] : FOG_END + 30,
      );
    }
    cat = 1;
    r.setPipeline(pSolid);
    r.setVertexBuffer(0, vbMesh);
    r.setIndexBuffer(ibMesh, 'uint32');
    // The woodwork: one mesh, one instance, its triangles in the order of the culling cells (woodAt): what stands
    // in the cells in view and within the fog is drawn, as runs
    {
      // (to: -1, not 0. With 0 the run that begins with the mesh's first triangle never started, and every cell
      // drawn straight after it went with it: whole lengths of fence gone until that first cell left the view)
      let from = -1,
        to = -1;
      const run = () => {
        r.drawIndexed(
          (to - from) * 3,
          1,
          WOOD.i0 + from * 3,
          WOOD.v0,
          Wd.solids.ranges[M_WOOD][0],
        );
        triBy[cat] += to - from;
        drawN++;
        if (auditCur) auditCur.runs.push(from, to);
      };
      auditCur = auditing ? auditNote(woodAt, 0, drawEnd(0)) : null;
      for (let c = 0; c < CELLS * CELLS; c++) {
        const a = woodAt[c],
          b = woodAt[c + 1];
        if (a === b || !vis[c]) continue;
        const d = seen(
          OX + ((c % CELLS) + 0.5) * CELLW,
          F[CY],
          OZ + (floor(c / CELLS) + 0.5) * CELLW,
          CELLW * 0.85,
        );
        if (d < 0 || d > drawEnd(0)) continue;
        if (to !== a) {
          if (from >= 0) run();
          from = a;
        }
        to = b;
      }
      if (from >= 0) run();
    }
    // boulders, logs and stumps, to the fog's end whatever the draw distance scale (they are large and do not fade)
    for (let i = 0; i < 4; i++) {
      const c = Wd.boulders[i];
      r.setVertexBuffer(1, ibBoulder[i]);
      tier(r, c, meshes[i], 7, 0, BOULDER[0]);
      tier(r, c, meshes[M_BOULDER_MID + i], 7, BOULDER[0], BOULDER[1]);
      tier(r, c, meshes[M_BOULDER_FAR + i], 7, BOULDER[1], drawEnd(7) / det);
    }
    // trunks, to the fog's end: one mesh at every distance
    cat = 2;
    for (let i = 0; i < NTRUNK; i++) {
      const c = Wd.props[i];
      r.setVertexBuffer(1, ibProp[i]);
      tier(r, c, meshes[M_TRUNK + i], 8, 0, drawEnd(8) / det);
    }
    // the bark's shell on the trunks close by (W_SOLID vsShell)
    r.setPipeline(pShell);
    for (let i = 0; i < NTRUNK; i++) {
      r.setVertexBuffer(1, ibProp[i]);
      tier(r, Wd.props[i], meshes[M_TRUNK + i], 8, 0, 8);
    }
    r.setPipeline(pSolid);
    cat = 1;
    for (let i = 0; i < NCHUNK; i++) {
      const c = Wd.chunks[i];
      r.setVertexBuffer(1, ibChunk[i]);
      if (i > 7) {
        tier(r, c, meshes[M_CHUNK + i], 3, 0, drawEnd(3));
        continue;
      } // stepping stones: one mesh at every distance
      if (i > 6) {
        tier(r, c, meshes[M_CHUNK + i], 3, 0, CHUNK[0] + 2);
        tier(
          r,
          c,
          meshes[M_TINY + i],
          3,
          CHUNK[0] + 2,
          min(CHUNK_END, drawEnd(3)),
        );
        continue;
      } // fallen branches
      if (i > 5) {
        tier(r, c, meshes[(PEBBLE[0] ? M_TINY : M_CHUNK) + i], 3, 0, PEBBLE[1]);
        continue;
      }
      if (i < 3) {
        tier(r, c, meshes[M_CHUNK + i], 3, 0, CHUNK[0]);
        tier(r, c, meshes[M_TINY + i], 3, CHUNK[0], min(CHUNK_END, drawEnd(3)));
        continue;
      }
      tier(r, c, meshes[M_CHUNK + i], 3, 0, CHUNK[1]);
      tier(r, c, meshes[M_CHUNK_MID + i - 3], 3, CHUNK[1], CHUNK[2]);
      tier(r, c, meshes[M_TINY + i], 3, CHUNK[2], drawEnd(3));
    }
    // the animals: under a hundred instances, so every group is drawn
    {
      // the boat by the pier, then its lid into the depth only
      const hull = meshes[M_BOAT],
        lid = meshes[M_BOAT + 1];
      r.setPipeline(pSolid);
      r.setVertexBuffer(1, ibBoat);
      r.drawIndexed(hull.ib.length, 1, hull.i0, hull.v0, 0);
      r.setPipeline(pLid);
      r.drawIndexed(lid.ib.length, 1, lid.i0, lid.v0, 0);
      r.setPipeline(pSolid);
      drawN += 2;
      triBy[1] += hull.ib.length / 3;
    }
    r.setVertexBuffer(1, ibCreature);
    for (let i = 0; i < critters.groups.length; i++) {
      const g = critters.groups[i],
        t = meshes[g.mesh];
      r.drawIndexed(t.ib.length, g.count, t.i0, t.v0, g.first);
    }
    // deer (deer.js): what is awake of them, part by part
    r.setVertexBuffer(1, ibDeer);
    for (const g of deer.groups) {
      if (!g.count) continue;
      const t = meshes[g.mesh];
      r.drawIndexed(t.ib.length, g.count, t.i0, t.v0, g.first);
      triBy[5] += (t.ib.length / 3) * g.count;
      drawN++;
    }
    if (ANIMALS) {
      r.setPipeline(pManta);
      r.setVertexBuffer(1, ibBirds);
      r.drawIndexed(BIRD.ib.length, nBird, BIRD.i0, BIRD.v0, 0);
    }
    // flocks: each one that is in view, without the fine parts when far (butterflies sooner: they are tiny)
    r.setPipeline(pFish);
    r.setVertexBuffer(1, ibFish);
    for (let i = 0; ANIMALS && i < Wd.schools.length; i++) {
      const sc = Wd.schools[i],
        d = seen(sc.x, sc.y, sc.z, sc.r + 5);
      if (d < 0 || d > 150) continue;
      const t =
        meshes[
          (d < FLY_NEAR * (sc.kind ? 1 : 0.4) ? M_FLY : M_FLY_FAR) + sc.kind
        ];
      r.drawIndexed(t.ib.length, sc.count, t.i0, t.v0, sc.first);
    }
    // the birds, mesh by mesh (birds.js counts): the songbird's near and far, the jay's, the raven's (the crow
    // family's on vsJay); then the sticks under those that sit on a dead branch, after them in the same buffer
    let nBirds = 0;
    birdTris = 0;
    for (let slot = 0; slot < 6; slot++) nBirds += birds.counts[slot];
    if (nBirds && !alone) {
      r.setVertexBuffer(1, ibBird);
      for (let slot = 0, first = 0; slot < 6; first += birds.counts[slot++]) {
        const mesh = meshes[M_SONG + slot],
          count = birds.counts[slot];
        if (!count) continue;
        r.setPipeline(slot > 1 ? pJay : pBird);
        r.drawIndexed(mesh.ib.length, count, mesh.i0, mesh.v0, first);
        drawN++;
        triBy[5] += (mesh.ib.length / 3) * count;
        birdTris += (mesh.ib.length / 3) * count;
      }
      if (birds.counts[7]) {
        const stick = meshes[M_SONG + 6];
        r.setPipeline(pJay);
        r.drawIndexed(
          stick.ib.length,
          birds.counts[7],
          stick.i0,
          stick.v0,
          nBirds,
        );
        drawN++;
        birdTris += (stick.ib.length / 3) * birds.counts[7];
      }
    }
    // leaves: fewer rows per blade with distance, then thinned-out sets
    for (let i = 0; i < LEAVES.length; i++) {
      const t = LEAVES[i];
      tierTris[i] = 0;
      r.setPipeline(t[0]);
      r.setVertexBuffer(0, t[1]);
      cat = t[0] === pLeafS || t[0] === pLeafMS || t[1] === ibShrub ? 4 : 3;
      const before = triBy[cat];
      drawCells(r, t[2], t[3], false, t[4], tierAt(t[5]), tierAt(t[6]));
      tierTris[i] = triBy[cat] - before;
    }
    // a dark blot under each bird on the ground
    if (birds.counts[6] && !alone) {
      r.setPipeline(pBlot);
      r.setVertexBuffer(0, vbBlot);
      r.draw(4, birds.counts[6]);
      drawN++;
    }
    // (deer's blots: three under each)
    if (deer.groups[0].count && !alone) {
      r.setPipeline(pBlot);
      r.setVertexBuffer(0, vbDeerBlot);
      r.draw(4, deer.groups[0].count * 3);
      drawN++;
    }
    // (none of it with a tree alone, but the sky shaded: fsB)
    if (!alone) backdrop();
    else if (ISO[3] === 2) {
      r.setPipeline(pBack);
      r.draw(4);
    }
    // the far trees' pictures, blended over everything opaque and the water (which writes no depth: a tree before
    // it must come after it), far to near
    // (none where the fog has closed before they begin to come in)
    farN = LOD.close[1] > LOD.far[0] ? farSorted() : 0;
    if (farN) {
      r.setPipeline(pLeafFB);
      r.setVertexBuffer(0, vbFar);
      r.draw(4, farN);
      drawN++;
      triBy[3] += farN * 2;
    }
    // lights added on top: fireflies, dust in the sun, rain
    if (ANIMALS && !alone) {
      r.setPipeline(pGl);
      r.setVertexBuffer(0, ibGl);
      drawCells(r, Wd.glints, 2, false, 4, 0, GLINT_END);
    }
    r.setVertexBuffer(0, ibSnowB);
    if (rain < 0.25 && fogK < 0.99 && !alone) {
      r.setPipeline(pSnow);
      r.draw(4, SPRITES[0]);
      drawN++;
      triBy[5] += SPRITES[0] * 2;
    }
    // the rain: its sheets of streaks further off, the drops near the walker, the drips under the crowns (these
    // for as long as the leaves are wet)
    if (rain > 0.01 && !alone) {
      r.setPipeline(pVeil);
      r.draw(42, 2);
      r.setPipeline(pRain);
      r.draw(4, SPRITES[1]);
      drawN += 2;
      triBy[5] += 80 + SPRITES[1] * 2;
    }
    if ((rain > 0.01 || F[WET] > 0.05) && !alone) {
      r.setPipeline(pDrip);
      r.draw(4, SPRITES[3]);
      drawN++;
      triBy[5] += SPRITES[3] * 2;
    }
    r.end();
    // light shafts
    r = e.beginRenderPass(passRays);
    r.setPipeline(pRays);
    r.setBindGroup(0, bgRays);
    r.draw(3);
    r.end();
    r = e.beginRenderPass(passBlur);
    r.setPipeline(pRB);
    r.setBindGroup(0, bgBlur);
    r.draw(3);
    r.end();
    // the eye's measure of the frame, before its exposure and its bloom: into the adapted value the post reads
    meterAt ^= 1;
    r = e.beginRenderPass(passGrid);
    r.setPipeline(pGrid);
    r.setBindGroup(0, bgGrid);
    r.draw(3);
    r.end();
    r = e.beginRenderPass(passAdapt[meterAt]);
    r.setPipeline(pAdapt);
    r.setBindGroup(0, bgAdapt[meterAt]);
    r.draw(3);
    r.end();
    // bloom
    for (let i = 0; i < bloomPass.length; i++) {
      r = e.beginRenderPass(bloomPass[i]);
      r.setPipeline(i === 0 ? pDown0 : i < NB ? pDown : pUp);
      r.setBindGroup(0, bloomBG[i]);
      r.draw(3);
      r.end();
    }
    // composite
    passPost.colorAttachments[0].view = ctx.getCurrentTexture().createView();
    r = e.beginRenderPass(passPost);
    r.setPipeline(pPost);
    r.setBindGroup(0, bgPost[meterAt]);
    r.draw(3);
    r.end();
    if (slot) {
      e.resolveQuerySet(qs, 0, 2, qResolve, 0);
      e.copyBufferToBuffer(qResolve, 0, slot.b, 0, 16);
    }
    submitList[0] = e.finish();
    Q.submit(submitList);
    if (slot) {
      slot.busy = true;
      slot.b.mapAsync(GPUMapMode.READ).then(slot.done);
    }
  }

  // Can the walker stand at (x, z), coming from (x0, z0) on ground at height h0 over a step of `len`? Not in water
  // over the ankles, not beyond 150 m from the middle of the world, not up a bank or a boulder
  // (a stream counts where its bed lies more than a hand's breadth under its surface: its shallows can be waded)
  const passable = (x, z, x0, z0, h0, len) => {
    const h = ground(x, z),
      ck = creekAt(x, z);
    if (h <= -0.3 || (ck[0] < 0 && ck[1] - h > 0.25) || x * x + z * z >= 22500)
      return false;
    if (h - h0 < len * 1.1 + 0.01) return true; // no steeper than about 48 degrees
    // steeper, but a lump or a stone, not a bank: the ground 0.45 m on the same way is no more than 0.35 m up
    const k = 0.45 / (hypot(x - x0, z - z0) || 1);
    return max(h, ground(x0 + (x - x0) * k, z0 + (z - z0) * k)) - h0 < 0.35;
  };
  // The ground evened out for the eye to ride: its mean over a footprint 2.8 m long the way the walker goes and 1 m
  // wide, each sample kept within 0.45 m of the ground right under them (the drop beside a deck or the top of a bank
  // next to the path does not pull it). So slopes are followed and small lumps are not felt. The footprint lies
  // `lead` metres ahead: as far as the walker gets while the eye eases to it, so on a slope the eye is not left behind
  const FOOT = [
    [0, 0],
    [0.7, 0],
    [-0.7, 0],
    [1.4, 0],
    [-1.4, 0],
    [0, 0.5],
    [0, -0.5],
  ];
  let footX = 0,
    footZ = -1; // the way they last walked
  const footing = (x, z, lead) => {
    const g0 = ground(x, z);
    let sum = 0;
    for (const [along, across] of FOOT)
      sum += clamp(
        ground(
          x + footX * (along + lead) - footZ * across,
          z + footZ * (along + lead) + footX * across,
        ),
        g0 - 0.45,
        g0 + 0.45,
      );
    return sum / FOOT.length;
  };
  // The state of the weather now: the one held (debug.weather), or where the drift has got to
  let wxClock = 0,
    wxHold = '',
    flashHeld = -1,
    flick = [];
  // flashes fired, how many of them drew a bolt, and the sum of the shares of those bolts that were on screen
  // with open sky behind (debug.flashes)
  const flashCount = [0, 0, 0];
  const weatherNow = () => {
    if (wxHold) return wxHold;
    let t = wxClock % DRIFT.reduce((sum, s) => sum + s[1], 0);
    for (const s of DRIFT) {
      if (t < s[1]) return s[0];
      t -= s[1];
    }
    return 'clear';
  };
  // weather(name, eased): holds a state ('auto': back to the drift, from its start). At once, for stills, unless eased
  const weather = (name, eased) => {
    if (name !== 'auto' && !WEATHER[name]) return;
    wxHold = name === 'auto' ? '' : name;
    if (!wxHold) wxClock = 0;
    flashHeld = -1;
    flick = [];
    flashCount.fill(0);
    if (eased) return;
    const to = WEATHER[weatherNow()];
    F[RAIN] = to[0];
    F[FOGK] = to[1];
    F[STORM] = to[2];
    F[WET] = F[SOAK] = to[0] > 0.1 ? 1 : 0;
    F[OVER] = overcast(to);
    F[WIND] = 0.4 + 0.5 * to[0];
  };
  // how overcast a state is: full under rain, most of the way in thick fog, MIST on a clear day
  const overcast = (to) => (to[0] > 0 ? 1 : MIST + (1 - MIST) * 0.72 * to[1]);
  // the wind now: the weather's, with a slow gusting
  const windNow = () => F[WIND] + 0.12 * sin(F[TIME] * 0.21);
  weather('auto');
  // Lightning: a flash up in the cloud. FL: the way to it (a unit vector, 15 degrees up or more: never at the
  // horizon), its kind (0 a patch of cloud lit from within, 1 sheet lightning, 2 a bolt crawling from cloud to
  // cloud: half of them) and a seed; flick: each flicker's start and strength. Two in three strike in the part of
  // the sky the walker faces, low enough to be in the frame of a level view. F[LT], F[LD]: when the last one
  // struck and how many metres off (for the thunder: audio.js)
  const FL = new Float32Array(5);
  let flashDue = 0;
  let clockHeld = false; // the scene's clock stands still (debug.clock: stills an exact time apart)
  const ISO = new Float32Array(4); // debug.isolate: x, z, reach, 1 a white mask, 2 shaded on black
  let isoPart = 0; // and 1 the tree without its far picture, 2 the far picture alone
  let sprigsMode = 0; // debug.sprigs: 1 no sub-cards drawn near the walker, 2 all held flat on their cards
  let pixHeld = false; // debug.pixels: the render size held
  let flickRise = 0.012,
    flickFall = 0.11;
  // A bolt is a tree of channels, grown afresh for every flash (growBolt) into BOLT: a segment in eight numbers,
  // one instance of a quad each (W_SPR vsBolt). CRAWL: the seconds its channels take to creep out from the root,
  // before the whole tree flashes
  const BOLT_MAX = 1600,
    BOLT_MIN = 100, // (a bolt of fewer segments is too little to show: a glow in the cloud instead)
    CRAWL = 0.2,
    BOLT = new Float32Array(BOLT_MAX * 8),
    vbBolt = device.createBuffer({
      size: BOLT.byteLength,
      usage: BU.VERTEX | BU.COPY_DST,
    });
  let boltN = 0,
    boltBranches = 0;
  // The tree, by the flash's seed (the same seed grows the same tree), in the sky's plane round the flash's
  // place: x to the side and y up, in radians. Several main channels leave the root to both sides and a little
  // upward; each wanders in long lazy bends with a kink at every step, thins toward its tip, and forks again and
  // again into thinner, dimmer, shorter branches. A segment: its two ends, its thickness (1 a trunk channel at the
  // root), how far along the tree it lies (0 the root, 1 the furthest tip: the crawl goes by it), its heat
  // BOX: the bolt's bounds in its own plane (left, right, top): two thirds of the view's width, the frame's top
  const BOX = [-0.3, 0.3, 0.4];
  // where a place falls in the frame, 0 to 1 across and down (by the last frame's view); null behind the eye
  const onScreen = (x, y, z) => {
    const w = UB[3] * x + UB[7] * y + UB[11] * z + UB[15];
    return w > 0.1
      ? [
          ((UB[0] * x + UB[4] * y + UB[8] * z + UB[12]) / w) * 0.5 + 0.5,
          0.5 - ((UB[1] * x + UB[5] * y + UB[9] * z + UB[13]) / w) * 0.5,
        ]
      : null;
  };
  // is a place on screen (by the last frame's view)?
  const inView = (x, y, z) => {
    const w = UB[3] * x + UB[7] * y + UB[11] * z + UB[15];
    return (
      w > 0.1 &&
      abs(UB[0] * x + UB[4] * y + UB[8] * z + UB[12]) < w &&
      abs(UB[1] * x + UB[5] * y + UB[9] * z + UB[13]) < w
    );
  };
  // How veiled the sky is along a ray from the eye: what the crowns take of the light (Wd.crown), summed along
  // it up to `most`; wholly, where the ray meets rising ground
  const crown = Wd.crown;
  // (from any place, as far as `far` m: the ravens, birds.js, look for open sky with it)
  const veilFrom = (x0, y0, z0, dx, dy, dz, most, far = 70) => {
    let sum = 0;
    for (let t = 3; t < far; t += 2) {
      const ix = floor((x0 + dx * t - OX) / VS / 2),
        iy = floor((y0 + dy * t - OY) / VS / 2),
        iz = floor((z0 + dz * t - OZ) / VS / 2);
      if (
        iy >= NY / 2 ||
        iy < 0 ||
        ix < 0 ||
        iz < 0 ||
        ix >= NX / 2 ||
        iz >= NZ / 2
      )
        break;
      sum += crown[ix + (NX / 2) * (iy + (NY / 2) * iz)];
      if (ground(x0 + dx * t, z0 + dz * t) > y0 + dy * t) sum = 1e6;
      if (sum > most) break;
    }
    return sum;
  };
  const skyVeil = (dx, dy, dz, most) =>
    veilFrom(F[CX], F[CY], F[CZ], dx, dy, dz, most);
  // CLEAR: the most of it with the sky open; VEILED: with the sky, and a bolt in it, still showing between thin
  // crowns
  const CLEAR = 50,
    VEILED = 120;
  const skyShows = (dx, dy, dz) => skyVeil(dx, dy, dz, VEILED) <= VEILED;
  // the way to a place of the bolt's plane, x to the side and y up from the flash's place (as W_SPR vsBolt)
  const boltDir = (x, y) => {
    const fx = FL[0],
      fy = FL[1],
      fz = FL[2],
      l = hypot(fx, fz),
      sx = fz / l,
      sz = -fx / l,
      dx = fx + sx * x + fy * sz * y,
      dy = fy + (fz * sx - fx * sz) * y,
      dz = fz + sz * x - fy * sx * y,
      dl = hypot(dx, dy, dz);
    return [dx / dl, dy / dl, dz / dl];
  };
  // A bolt strikes only where the walker can see it. frameWay: the frame's upper half as a grid of ways, seven
  // across and nine up (a way, and where in the frame it is); openSky: how well a bolt would show along each, 11
  // to 70 degrees up (over the land, under the zenith): 1 in open sky, a half between thin crowns, 0 hidden
  const frameWay = (i, j) => {
    const tw = (TANH * W) / H,
      nx = (i / 6 - 0.5) * 1.3,
      ny = 0.06 + (0.9 * j) / 8,
      dx = F[FX] + F[RX] * nx * tw + F[UX] * ny * TANH,
      dy = F[FY] + F[UY] * ny * TANH,
      dz = F[FZ] + F[RZ] * nx * tw + F[UZ] * ny * TANH,
      l = hypot(dx, dy, dz);
    return [dx / l, dy / l, dz / l, nx, ny];
  };
  const openSky = () => {
    const open = new Float32Array(63);
    for (let j = 0; j < 9; j++)
      for (let i = 0; i < 7; i++) {
        const d = frameWay(i, j);
        if (d[1] < 0.19 || d[1] > 0.94) continue;
        const veil = skyVeil(d[0], d[1], d[2], VEILED);
        open[i + 7 * j] = veil <= CLEAR ? 1 : veil <= VEILED ? 0.5 : 0;
      }
    return open;
  };
  // boltPlace: a place for the root in the largest patch of sky that shows in the frame: the way with the most
  // sky round it (two ways to each side, one above and below: the worth of four open ones at least; the rows
  // beyond count half, so it sits in the middle of a tall patch), with a little chance in it so bolts do not all
  // strike one spot. Nothing if there is no such patch. It sets the
  // flash's place and BOX
  const boltPlace = () => {
    const open = openSky();
    let best = -1,
      most = 0;
    for (let j = 0; j < 9; j++)
      for (let i = 1; i < 6; i++) {
        if (!open[i + 7 * j]) continue;
        let n = 0,
          beyond = 0;
        for (let v = max(j - 2, 0); v <= min(j + 2, 8); v++)
          for (let u = max(i - 2, 0); u <= min(i + 2, 6); u++)
            if (abs(v - j) < 2) n += open[u + 7 * v];
            else beyond += open[u + 7 * v];
        if (n < 4) continue;
        n += beyond * 0.5 + Math.random() * 3;
        if (n > most) {
          most = n;
          best = i + 7 * j;
        }
      }
    if (best < 0) return false;
    const tw = (TANH * W) / H,
      d = frameWay(best % 7, floor(best / 7)),
      side = Math.atan(d[3] * tw),
      half = Math.atan(tw) * 0.67;
    place(atan2(d[2], d[0]), Math.asin(d[1]));
    BOX.splice(
      0,
      3,
      side - half,
      side + half,
      max(Math.atan(TANH) * 0.95 - Math.atan(d[4] * TANH), 0.03),
    );
    return true;
  };
  // how much of the bolt just grown is on screen with the sky showing behind it: 0 to 1
  const boltShown = () => {
    let n = 0,
      shown = 0;
    for (let i = 0; i < boltN; i += 6, n++) {
      const d = boltDir(BOLT[i * 8], BOLT[i * 8 + 1]);
      if (
        inView(F[CX] + d[0] * 50, F[CY] + d[1] * 50, F[CZ] + d[2] * 50) &&
        skyShows(d[0], d[1], d[2])
      )
        shown++;
    }
    return n ? shown / n : 0;
  };
  const growBolt = () => {
    let seed = (FL[4] * 4294967296) >>> 0 || 1;
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const STEP = 0.01,
      low = 0.19 - Math.asin(FL[1]); // no channel comes nearer the horizon than eleven degrees
    const shows = (x, y) => skyShows(...boltDir(x, y));
    let n = 0,
      far = 0;
    boltBranches = 0;
    // One channel from (x, y). It sets out along `way` and wanders from it: its heading turns a little more or
    // less at every step (the long lazy bends), is drawn back slowly, and each step is kinked on top of that
    const channel = (x, y, way, len, thick, dist, depth) => {
      boltBranches++;
      let head = way,
        aim = way,
        turn = 0;
      for (let gone = 0; gone < len && n < BOLT_MAX; gone += STEP) {
        turn = turn * 0.9 + (rnd() - 0.5) * 0.12;
        // (it never turns back on itself: no more than 110 degrees off its way)
        head = clamp(head + turn + (aim - head) * 0.035, aim - 1.9, aim + 1.9);
        // (near the lowest it may come, or the top of its bounds, it turns away for good: its way with it)
        const off = y < low + 0.04 ? -1 : y > BOX[2] - 0.04 ? 1 : 0;
        if (off * sin(head) > 0) head = -head;
        if (off * sin(aim) > 0) aim = -aim;
        let kink = head + (rnd() - 0.5) * 1.1;
        // Where crowns stand before the sky it turns away half the time, back into the open (up for down, or
        // left for right, whichever shows sky); else it runs on behind them
        if (!shows(x + cos(kink) * STEP, y + sin(kink) * STEP) && rnd() < 0.5)
          for (const turned of [-kink, Math.PI - kink])
            if (shows(x + cos(turned) * STEP, y + sin(turned) * STEP)) {
              const flip =
                turned === -kink ? (way) => -way : (way) => Math.PI - way;
              kink = turned;
              head = flip(head);
              aim = flip(aim);
              break;
            }
        const x1 = x + cos(kink) * STEP,
          y1 = y + sin(kink) * STEP,
          // (thinner along its length, and its last third thins away to nothing: the twigs fade out)
          k =
            thick *
            (1 - (0.5 * gone) / len) *
            min(1, (len - gone) / (0.3 * len)) ** 0.7;
        if (x1 < BOX[0] || x1 > BOX[1] || y1 > BOX[2]) break; // it ends at the bolt's bounds
        BOLT.set([x, y, x1, y1, k, dist + gone, 0, 0], n++ * 8);
        x = x1;
        y = y1;
        far = max(far, dist + gone);
        // a branch leaves at a shallow angle and goes its own way; the thinner the channel the fewer
        if (depth < 3 && gone > 0.02 && rnd() < (depth ? 0.05 : 0.085))
          channel(
            x,
            y,
            head + (rnd() < 0.5 ? -1 : 1) * (0.25 + 0.5 * rnd()),
            (0.1 + 0.3 * rnd()) * (depth ? 0.6 : 1),
            k * (0.55 + 0.25 * rnd()),
            dist + gone,
            depth + 1,
          );
      }
    };
    // two to four trunk channels, each its own way: mostly sideways, to the left and the right in turn
    for (let c = 0, trunks = 2 + ((rnd() * 3) | 0); c < trunks; c++) {
      const up = -0.25 + 0.75 * rnd();
      channel(
        0,
        0,
        c % 2 ? Math.PI - up : up,
        0.24 + 0.2 * rnd(),
        1 - 0.25 * rnd(),
        0,
        0,
      );
    }
    for (let i = 0; i < n; i++) {
      const o = i * 8,
        at = BOLT[o + 5] / far;
      BOLT[o + 5] = at;
      BOLT[o + 6] = BOLT[o + 4] ** 1.5 * (1 - 0.6 * at); // hot where it is thick and near the root
    }
    boltN = n;
    Q.writeBuffer(vbBolt, 0, BOLT, 0, n * 8);
    return n >= BOLT_MIN ? boltShown() : 0;
  };
  // boltFits: grows the bolt at the place set, from up to four seeds that follow the flash's own, and keeps the
  // growth that shows most of itself. False if even that is too small, or less than a third of it shows: the
  // crowns may hide the rest
  const boltFits = () => {
    const first = FL[4];
    let best = 0,
      bestSeed = first;
    for (let i = 0; i < 4 && best < 0.6; i++) {
      FL[4] = (first + i * 0.137) % 1;
      const shown = growBolt();
      if (shown > best) {
        best = shown;
        bestSeed = FL[4];
      }
    }
    if (FL[4] !== bestSeed) {
      FL[4] = bestSeed;
      growBolt();
    }
    return best >= 1 / 3;
  };
  // (Never more than three flickers, the later ones weaker, so a screen never flashes more than three times in a
  // second; a far flash no weaker than 0.6 of a near one. For one who has asked for reduced motion: a single
  // slow, faint glow)
  const flash = () => {
    const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
    F[LT] = F[TIME];
    F[LD] = 1200 + 5000 * Math.random();
    const pick = Math.random(),
      ahead = Math.random() < 0.67,
      facing = atan2(F[FZ], F[FX]);
    // half the flashes are bolts, where there is open sky in the frame for one; the others, and those, a glow in
    // the cloud: ahead within 20 degrees of the way they face and 20 to 35 degrees up, or anywhere
    FL[4] = Math.random();
    const kind =
      pick < 0.5 && boltPlace() && boltFits() ? 2 : Math.random() < 0.6 ? 0 : 1;
    if (kind < 2)
      place(
        ahead ? facing + (Math.random() - 0.5) * 0.7 : Math.random() * 6.2832,
        0.35 + (ahead ? 0.26 : 0.7) * Math.random(),
      );
    FL[3] = kind;
    flashCount[0]++;
    flicker(calm, false);
    if (kind > 1) {
      flashCount[1]++;
      flashCount[2] += boltShown();
    }
  };
  // the flickers of a flash: a bolt's come after its crawl. set: the three even ones of a held flash (stills)
  const flicker = (calm, set) => {
    const first = (calm ? 0.15 : 1) * (1 - (0.4 * (F[LD] - 1200)) / 5000),
      from = FL[3] > 1 ? CRAWL : 0;
    flick = [from, set ? 1 : first];
    flickRise = calm ? 0.15 : 0.012;
    flickFall = calm ? 0.5 : 0.11;
    if (calm) return;
    const second = set ? 0.14 : 0.09 + 0.12 * Math.random();
    flick.push(
      from + second,
      flick[1] * (set ? 0.7 : 0.45 + 0.25 * Math.random()),
    );
    if (set || Math.random() < 0.5)
      flick.push(
        from + second + (set ? 0.16 : 0.09 + 0.12 * Math.random()),
        flick[1] * (set ? 0.45 : 0.25 + 0.2 * Math.random()),
      );
  };
  // puts the flash at a bearing and a height in the sky
  const place = (az, el) => {
    FL[0] = cos(el) * cos(az);
    FL[1] = sin(el);
    FL[2] = cos(el) * sin(az);
  };
  // debug.flash(kind, az, el, at): one flash now; of a given kind and place in the sky (radians) if asked. With
  // `at` it is held that many seconds into itself, three set flickers and one seed (so stills of different
  // moments show the same flash), and no other strikes, until the weather is set again
  const flashAt = (kind, az, el, at, seed) => {
    if (!(at >= 0) && F[TIME] - F[LT] < 1.2 && flick.length) return -1; // (never two within 1.2 s)
    flash();
    flashHeld = at >= 0 ? at : -1;
    if (kind >= 0) FL[3] = kind;
    if (el) {
      place(az, el);
      BOX.splice(0, 3, -0.3, 0.3, 0.4);
    }
    if (flashHeld >= 0) FL[4] = seed || 0.37;
    // (a bolt asked for without a place goes where one can be seen; where none can, a glow instead)
    if (FL[3] > 1 && !(el ? growBolt() || true : boltPlace() && boltFits()))
      FL[3] = 0;
    flicker(false, flashHeld >= 0);
    return FL[3];
  };
  // seconds into the flash
  const flashAge = () => (flashHeld >= 0 ? flashHeld : F[TIME] - F[LT]);
  // How bright the flash is now: a flicker is on in a hundredth of a second and dies away in a tenth (calm: in
  // 0.15 s and in half a second); after the last a faint glow lingers in the cloud for a few tenths more. While
  // a bolt crawls the cloud round its root glows faintly already
  const flashNow = () => {
    const t = flashAge();
    let b = 0;
    if (t < 4 && flick.length) {
      for (let i = 0; i < flick.length; i += 2) {
        const s = t - flick[i];
        if (s > 0)
          b = max(
            b,
            flick[i + 1] *
              (s < flickRise
                ? s / flickRise
                : exp(-(s - flickRise) / flickFall)),
          );
      }
      const after = t - flick[flick.length - 2] - flickRise;
      if (after > 0) b = max(b, 0.16 * flick[1] * exp(-after / 0.4));
      if (FL[3] > 1 && t < CRAWL) b = max(b, (0.1 * flick[1] * t) / CRAWL);
    }
    return b;
  };
  // how far a bolt's channels have crept out from its root: 0 to 1, 1 from its first flash on
  const crawlNow = () => (FL[3] > 1 ? min(flashAge() / CRAWL, 1) : 1);
  // what the birds know of the walker: where the eye is, the pace, how long they have stood still, the weather
  let stoodStill = 0,
    birdClock = 0;
  const walkerNow = () => ({
    x: F[CX],
    y: F[CY],
    z: F[CZ],
    speed: hypot(F[VX], F[VZ]),
    vx: F[VX],
    vz: F[VZ],
    // (the way they face, level, from the yaw: right even before the next frame after a jump)
    fx: sin(F[YAW]),
    fz: -cos(F[YAW]),
    still: stoodStill,
    rain: F[RAIN],
    fog: F[FOGK],
  });
  // One step of the walk by (dx, dz): it slides along what stops it, and goes round trunks, rocks, logs and rails
  function walk(dx, dz) {
    const x0 = F[CX],
      z0 = F[CZ],
      h0 = ground(x0, z0),
      len = sqrt(dx * dx + dz * dz);
    if (len < 1e-6) return;
    lane(x0 + dx, z0 + dz, x0, z0);
    let x = P2[0],
      z = P2[1];
    if (!passable(x, z, x0, z0, h0, len)) {
      if (passable(x, z0, x0, z0, h0, len)) z = z0;
      else if (passable(x0, z, x0, z0, h0, len)) x = x0;
      else return;
    }
    shove(x, z, 0.3);
    lane(P2[0], P2[1], x0, z0);
    if (!passable(P2[0], P2[1], x0, z0, h0, len + 0.4)) return;
    F[CX] = P2[0];
    F[CZ] = P2[1];
  }

  // At most 60 frames a second: a 90 or 120 Hz phone screen would double the GPU work and heat for little gain.
  // pace carries the time over since the last drawn frame, so 90 Hz draws two frames in three, not one in two.
  const PACE = 1000 / 60;
  let pace = 0,
    paceAt = 0;
  // a throw in a frame would repeat every frame over a frozen picture: it ends the scene and is shown instead
  function frame(now) {
    raf = requestAnimationFrame(frame);
    pace += now - paceAt;
    paceAt = now;
    if (pace < PACE - 2) return;
    pace = min(pace - PACE, PACE);
    try {
      step(now);
    } catch (e) {
      stop('The scene stopped: ' + e.message, false, e);
    }
  }
  // stats(): the frame rate and worst frame since the last call, for the stats line (main.ts)
  let stN = 0,
    stWorst = 0,
    stAt = 0;
  function stats() {
    const now = performance.now(),
      fps = (stN * 1000) / max(now - stAt, 1),
      gpu = hasTS ? ` · gpu ${F[GPU].toFixed(1)}ms` : '';
    const line = `${fps.toFixed(0)} fps · worst ${stWorst.toFixed(0)}ms${gpu} · cpu ${cpuMs.toFixed(1)}ms · ${CATS.map((c, k) => `${c} ${(triBy[k] / 1e3) | 0}k`).join(', ')} tris in ${drawN} draws · ${visN}/${CELLS * CELLS} cells · ${W}x${H} (${((W * H * 100) / (DW * DH)).toFixed(0)}%) · far ${(det * 100).toFixed(0)}% · ${LEVEL}`;
    stN = 0;
    stWorst = 0;
    stAt = now;
    return line;
  }
  function step(now) {
    const cpu0 = performance.now(),
      dtr = now - F[LAST];
    F[LAST] = now;
    stN++;
    if (dtr > stWorst && dtr < 1e3) stWorst = dtr;
    let dt = dtr / 1000;
    if (dt > 0.1) dt = 0.1;
    frameDt = dt;
    // Dynamic resolution for 60 fps: every second (0.4 s for the first few, to settle fast) scale the load by k
    // (held while debug.isolate shows a tree alone, or debug.pixels holds a size: frames to compare)
    if (
      !ISO[3] &&
      !pixHeld &&
      dtr < 1e3 &&
      (dynT += dtr) > 0 &&
      (dynN++, dynT > (tunes < 6 ? 400 : 1000))
    ) {
      tunes++;
      // (SLOW, dev: every frame taken as 20 ms longer, to try the demotion)
      const late = SLOW ? 20 : 0,
        a = dynT / dynN + late,
        g = dynGN ? dynG / dynGN + late : 0;
      if (judged < JUDGE) {
        const span = dynT / 1000,
          over = g ? g > 13.6 : a > 17.6;
        judged += span;
        smallFor = W * H < SLOW_SIZE * min(PIX0, DW * DH) ? smallFor + span : 0;
        starvedFor = over && pix <= PIXMIN ? starvedFor + span : 0;
        if (smallFor >= SLOW_FOR || starvedFor >= SLOW_FOR) {
          demote('slow');
          judged = JUDGE;
        }
      }
      let k = 1;
      // with GPU timing: keep it between 9.8 and 13.6 ms
      if (g) {
        if (g > 13.6 || g < 9.8) k = 11.7 / g;
      }
      // without: slow for two periods in a row means fewer pixels, and twice as long before trying to go back up
      else if (a > 17.6) {
        dynOk = 0;
        if (++dynBad > 1) {
          k = 15 / a;
          dynBad = 0;
          dynWait = min(dynWait * 2, 60);
        }
      }
      // at the display's rate there is no telling if there is room, so try a little more now and then
      else {
        dynBad = 0;
        if (a < 12.5) k = 15 / a;
        else if (++dynOk > dynWait) {
          k = 1.17;
          dynOk = 0;
        }
      }
      // Behind the loader it may jump to where it belongs; after that by 7% a step at most, so the picture never
      // visibly changes sharpness. Only the pixels are tuned: the fog ends the view, the draw distances stay put
      const lim = tunes > 6 ? 0.07 : 0.5;
      k = k < 1 - lim ? 1 - lim : k > 1 + lim * 1.4 ? 1 + lim * 1.4 : k;
      const top = min(PIXMAX, DW * DH),
        was = pix + det;
      {
        const end = k < 1 ? PIXMIN : top;
        pix *= k;
        if (k < 1 ? pix < end : pix > end) pix = end;
      }
      if (!dev && was !== pix + det)
        keep('forestSize', [LEVEL, pix < top ? pix | 0 : '']); // nothing kept at full resolution
      dynN = dynT = dynG = dynGN = 0;
      resize();
    }
    if (!clockHeld) F[TIME] += dt;
    {
      // drag to look: screen pixels in radians (a short side's drag turns ~140°), through two cascaded low-pass stages
      const kq = 1 - exp(-dt * 30),
        ls = 2.42 / min(innerWidth, innerHeight);
      lkx += input.lookX * ls;
      lky += input.lookY * ls;
      input.lookX = input.lookY = 0;
      const ax = lkx * kq,
        ay = lky * kq;
      lkx -= ax;
      lky -= ay;
      l2x += ax;
      l2y += ay;
      const dyw = l2x * kq,
        dpt = l2y * kq;
      l2x -= dyw;
      l2y -= dpt;
      const yaw = F[YAW] + dyw + input.turn * 1.6 * dt; // (a key turns the view a quarter turn a second)
      let pitch = F[PIT] - dpt;
      pitch = pitch < -1.3 ? -1.3 : pitch > 1.3 ? 1.3 : pitch;
      // The walk, eased in and out: forward the way the walker faces while the button is held. A keyboard (keys.ts)
      // also walks back and steps sideways, a diagonal no faster than straight on, and doubles the pace
      const fwd = input.walk ? 1 : input.forward,
        side = input.strafe,
        going = hypot(fwd, side),
        sp = (3.4 * (input.fast ? 2 : 1)) / max(going, 1),
        k = 1 - exp(-dt * 5);
      F[VX] += ((sin(yaw) * fwd + cos(yaw) * side) * sp - F[VX]) * k;
      F[VZ] += ((-cos(yaw) * fwd + sin(yaw) * side) * sp - F[VZ]) * k;
      F[YAW] = yaw;
      F[PIT] = pitch;
      // (a view left by the debug calls must never poison the walk: a pace or a height that is not a number
      // starts afresh)
      if (Number.isNaN(F[VX] + F[VZ])) F[VX] = F[VZ] = 0;
      if (Number.isNaN(F[CY])) F[CY] = ground(F[CX], F[CZ]) + EYE;
      walk(F[VX] * dt, F[VZ] * dt);
      // The eye rides EYE over the evened ground, easing to it over 0.4 s, with no bob to the stride: a calm walk.
      // It never comes nearer than 1.3 m to the ground right under it (eased from 1.4 m, so that is rarely met)
      const speed = hypot(F[VX], F[VZ]),
        under = ground(F[CX], F[CZ]);
      if (speed > 0.3) {
        footX = F[VX] / speed;
        footZ = F[VZ] / speed;
      }
      if (going > 0) held = false;
      if (!held) {
        F[CY] +=
          (footing(F[CX], F[CZ], speed * 0.4) + EYE - F[CY]) *
          (1 - exp(-dt / 0.4));
        if (F[CY] < under + 1.4)
          F[CY] += (under + 1.4 - F[CY]) * (1 - exp(-dt * 12));
        if (F[CY] < under + 1.3) F[CY] = under + 1.3;
      }
    }
    {
      // the weather, and what the sound wants to know: water nearby (the creek within 12 m, the shore within 8), gravel underfoot
      if (!wxHold) wxClock += dt;
      // Each value goes two thirds of the way to its state's in `up` seconds rising and `down` falling. The cloud
      // closes first and the rain waits for it; the wind gusts as the rain begins; the fog comes and goes slowly;
      // leaves and planks are wet at once and dry in a minute, the ground soaks slowly and dries last
      const to = WEATHER[weatherNow()],
        toward = (slot, target, up, down) => {
          F[slot] +=
            (target - F[slot]) *
            (1 - exp(-dt / (target > F[slot] ? up : down)));
        };
      toward(OVER, overcast(to), 6, 14);
      toward(RAIN, F[OVER] > 0.7 ? to[0] : 0, 8, 12);
      toward(
        WIND,
        0.4 + 0.5 * to[0] + (to[0] > F[RAIN] + 0.2 ? 0.3 : 0),
        5,
        20,
      );
      toward(STORM, to[2], 15, 25);
      toward(FOGK, to[1], 25, 40);
      toward(WET, F[RAIN] > 0.1 ? 1 : 0, 12, 50);
      toward(SOAK, F[RAIN] > 0.1 ? 1 : F[WET] < 0.5 ? 0 : F[SOAK], 45, 200);
      if (!clockHeld) F[BLOWN] += windNow() * dt;
      // at the storm's height a flash every 3 to 8 seconds
      if (F[STORM] > 0.6 && F[TIME] > flashDue && flashHeld < 0) {
        flash();
        flashDue = F[TIME] + 3 + 5 * Math.random();
      }
      // the eye adapts to where the walker stands, over a second or so (at once after a jump)
      F[ADAPT] = F[ADAPT]
        ? F[ADAPT] + (adaptTo() - F[ADAPT]) * min(dt / 1.2, 1)
        : adaptTo();
      F[WATERS] = max(
        1 - max(creekAt(F[CX], F[CZ])[0], 0) / 10,
        1 - abs(lakeD(F[CX], F[CZ])) / 8,
        0,
      );
      F[GRAVEL] = trailD(F[CX], F[CZ]) < 1.3 ? 1 : 0;
    }
    critters.update(F[TIME], F[CX], F[CZ]);
    Q.writeBuffer(ibCreature, 0, critters.data);
    {
      // The boat rides the lake: it rises, rolls and pitches by a few slow waves that never fall into step, more
      // in a wind. Its instance: place, turn (small angles), timber, a seed under -50 (painted: W_SOLID)
      const [ax, az] = Wd.boat.along,
        t = F[TIME],
        swell = 0.6 + 0.8 * F[WIND],
        rise =
          swell *
          (0.011 * sin(t * 1.13 + 0.4) +
            0.007 * sin(t * 1.71 + 2.1) +
            0.005 * sin(t * 0.47)),
        roll =
          swell * (0.014 * sin(t * 0.83 + 1) + 0.009 * sin(t * 1.37 + 0.2)),
        pitch = swell * 0.006 * sin(t * 0.67 + 0.5);
      BOAT.set([
        Wd.boat.at[0],
        rise,
        Wd.boat.at[1],
        1,
        (ax * roll - az * pitch) / 2,
        0,
        (az * roll + ax * pitch) / 2,
        1,
        3,
        -100.5,
        1,
        0,
      ]);
      Q.writeBuffer(ibBoat, 0, BOAT);
      // the birds live by the scene's clock (held, they hold still; set on, they move on by as much)
      const walker = walkerNow();
      stoodStill = walker.speed < 0.3 ? stoodStill + dt : 0;
      birds.update(max(F[TIME] - birdClock, 0), walker);
      birdClock = F[TIME];
      Q.writeBuffer(ibBird, 0, birds.data);
      Q.writeBuffer(vbBlot, 0, birds.blots);
      // deer (deer.js), by the scene's clock like the birds
      deer.update(max(F[TIME] - deerClock, 0), walker, {
        rain: F[RAIN],
        storm: F[STORM],
      });
      deerClock = F[TIME];
      Q.writeBuffer(ibDeer, 0, deer.data);
      Q.writeBuffer(vbDeerBlot, 0, deer.blots);
    }
    render();
    const cpuNow = performance.now() - cpu0;
    cpuMs += (cpuNow - cpuMs) * 0.05; // a running mean of what a frame costs this thread
    // sound (audio.js): its idle work posted after the frame, once the forest is shown
    if (SOUND && (shown || (shown = document.body.dataset.state === 'ready')))
      soundFrame(cpuNow);
    // frames 30 and 300: a picture with no light in it is a failure that raises no error. Only twice: each look
    // waits for the GPU, a hitch on a phone
    frames++;
    if (canPeek && (frames === 30 || frames === 300)) {
      if (peek() > 0) lit = frames;
      else
        stop(
          lit
            ? `The picture went black at frame ${frames} (frame ${lit} was fine).`
            : 'The scene draws only black frames.',
        );
    }
  }

  // ---------------------------------------------------------------- black frame watch
  // peek(): the brightest colour value in the frame just drawn, read through a tiny 2D canvas. Only the task that
  // drew the frame can read it. lit: the last frame seen with light; canPeek: set by the test at the end of boot.
  const peek2d = document
    .createElement('canvas')
    .getContext('2d', { willReadFrequently: true });
  peek2d.canvas.width = peek2d.canvas.height = 8;
  let lit = 0,
    canPeek = false;
  const peek = () => {
    try {
      peek2d.clearRect(0, 0, 8, 8);
      peek2d.drawImage(canvas, 0, 0, 8, 8);
      const d = peek2d.getImageData(0, 0, 8, 8).data;
      let m = 0;
      for (let i = 0; i < d.length; i += 4)
        m = max(m, d[i], d[i + 1], d[i + 2]);
      return m;
    } catch {
      return -1;
    }
  };

  // ---------------------------------------------------------------- start, pause, resume
  // function declarations: device.lost may call pause() before the world is built
  function pause() {
    cancelAnimationFrame(raf);
    raf = 0;
    soundPause();
  }
  function resume() {
    if (raf || dead) return;
    raf = requestAnimationFrame((t) => {
      F[LAST] = paceAt = stAt = t;
      pace = PACE;
      raf = requestAnimationFrame(frame);
    });
    soundResume();
  }

  // Can this browser read a frame back? Clear the (still hidden) canvas to white and look. Where it cannot, the
  // black frame watch stays off instead of raising a false alarm.
  {
    const e = device.createCommandEncoder();
    e.beginRenderPass({
      colorAttachments: [
        {
          view: ctx.getCurrentTexture().createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: [1, 1, 1, 1],
        },
      ],
    }).end();
    Q.submit([e.finish()]);
    canPeek = peek() > 200;
    facts['frame check'] = canPeek ? 'on' : 'off';
  }

  // draw the first frame and wait for the GPU to finish it (pipelines get compiled on first use) before the reveal
  view(0);
  await say('Letting the light in…', 1, 400);
  render();
  await Q.onSubmittedWorkDone();
  // (the load counts as survived after 15 s of frames)
  setTimeout(() => {
    loading = false;
    markLoad();
    document.removeEventListener('visibilitychange', markLoad);
  }, 15e3);
  // wake: the first touch starts the sound (browsers allow audio only after a gesture)
  // debug: for looking around from a debugger. view(i) jumps to one of the six viewpoints, look(x, y, z, tx, ty, tz)
  // to any place and target, stand(x, z, tx, tz) on the ground at a place facing another, weather(name) holds a state
  // of the weather, flash() fires one lightning flash, at() where the walker is, ground(x, z) the height they would
  // stand on there; creatures is what creatures.js moves.
  const stand = (x, z, tx, tz) =>
    lookAt(x, ground(x, z) + EYE, z, tx, ground(tx, tz) + 1, tz);
  // atlasShot(layer, alpha): a layer of the foliage atlas as a PNG data URL (its colours, or its outlines), to look at
  const atlasShot = async (layer, alpha) => {
    const b = device.createBuffer({
        size: ATLAS * ATLAS * 4,
        usage: BU.COPY_DST | BU.MAP_READ,
      }),
      e = device.createCommandEncoder();
    e.copyTextureToBuffer(
      { texture: tAtlas, origin: [0, 0, layer] },
      { buffer: b, bytesPerRow: ATLAS * 4 },
      [ATLAS, ATLAS, 1],
    );
    Q.submit([e.finish()]);
    await b.mapAsync(GPUMapMode.READ);
    const px = new Uint8ClampedArray(b.getMappedRange().slice(0)),
      c = document.createElement('canvas');
    b.destroy();
    for (let i = 0; i < px.length; i += 4) {
      if (alpha) px[i] = px[i + 1] = px[i + 2] = px[i + 3];
      px[i + 3] = 255;
    }
    c.width = c.height = ATLAS;
    c.getContext('2d').putImageData(new ImageData(px, ATLAS, ATLAS), 0, 0);
    return c.toDataURL('image/png');
  };
  // trail(k, ahead): stand on point k of the trail, facing the point `ahead` further on
  const onTrail = (k, ahead) => {
    const a = TRAIL[k % TRAIL.length],
      b = TRAIL[(k + ahead) % TRAIL.length];
    stand(a[0], a[1], b[0], b[1]);
  };
  return {
    pause,
    resume,
    stats,
    walker: () => [F[CX], F[CZ]],
    debug: {
      view,
      look: lookAt,
      stand,
      trail: onTrail,
      near: (kind, x, z) => {
        const list =
          kind === 'trunk'
            ? Wd.trees.map((t) => [t.x, t.y, t.z, t.r])
            : Wd.spots[kind];
        let best = null,
          bd = 1e9;
        for (const p of list) {
          const d = hypot(p[0] - x, p[2] - z);
          if (d < bd) {
            bd = d;
            best = p;
          }
        }
        return best;
      },
      bridges: () => Wd.bridges,
      crossings: () => Wd.crossings,
      pier: () => Wd.pier,
      birds: () =>
        birds.list().map((bird) => ({
          ...bird,
          inFrame: inView(bird.at[0], bird.at[1] + 0.1, bird.at[2]),
          screen: onScreen(bird.at[0], bird.at[1] + 0.1, bird.at[2]),
        })),
      birdCross: () => birds.cross(walkerNow()),
      birdTris: () => birdTris,
      ravens: (count) => birds.ravens(count),
      ravenFlyover: () => birds.flyover(walkerNow()),
      jays: (count) => birds.count(count),
      birdsOn: (on) => birds.on(on),
      birdsHeed: (on) => birds.heed(on),
      perches: () => birds.perches(),
      bird: (k, pose, s, x, z, yaw) => birds.hold(k, pose, s, x, z, yaw),
      birdDo: (k, what) => birds.act(k, what, walkerNow()),
      tiers: () =>
        Array.from(tierTris.slice(0, LEAVES.length), (n) => (n / 1e3) | 0),
      exposure: (mode) => {
        if (mode !== undefined) expoMode = mode;
        return expoMode;
      },
      // (read back from the GPU, for a debugger only)
      exposureNow: async () => {
        const b = device.createBuffer({
            size: 4,
            usage: BU.COPY_DST | BU.MAP_READ,
          }),
          e = device.createCommandEncoder(),
          old = UB[56];
        e.copyTextureToBuffer(
          { texture: tAdapt[meterAt] },
          { buffer: b },
          [1, 1],
        );
        Q.submit([e.finish()]);
        await b.mapAsync(GPUMapMode.READ);
        const high = new Float32Array(b.getMappedRange())[0];
        b.destroy();
        return [high, exposureOf(old, high), old, HIGH];
      },
      // (one tree alone, white on black, for measuring how much it covers: W_POST)
      isolate: (x, z, reach, shaded, part) => {
        ISO[3] = x === undefined ? 0 : shaded ? 2 : 1;
        isoPart = ISO[3] ? ({ near: 1, far: 2 }[part] ?? 0) : 0;
        if (!ISO[3]) return null;
        ISO[0] = x;
        ISO[1] = z;
        ISO[2] = reach ?? 3;
        // the nearest far picture (world.js farT): its kind (atlas.js farTree) and its crown's foot and height
        let best = null,
          bd = 1e9;
        for (let k = 0; k < Wd.farT.n; k++) {
          const d = hypot(farF[k * 9] - x, farF[k * 9 + 2] - z);
          if (d < bd) {
            bd = d;
            best = [
              floor((farB[k * 36 + 35] / 255) * 8),
              ...farF.subarray(k * 9, k * 9 + 4),
            ];
          }
        }
        return best;
      },
      pixels: (n) => {
        pixHeld = n > 0;
        if (pixHeld) {
          pix = n;
          resize();
        }
        return W * H;
      },
      sprigs: (mode) => {
        if (mode !== undefined) sprigsMode = mode;
        return sprigsMode;
      },
      lod: () => {
        lodNow();
        const m1 = (x) => round(x * 10) / 10,
          cuts = { ...TIER, smallF: SMALL_F, smallL: SMALL_L };
        for (const k in cuts) cuts[k] = m1(cuts[k]);
        return {
          tree: LOD.tree.map(m1),
          close: LOD.close.map(m1),
          closed: [LOD.tree[0], LOD.tree[1], TIER.tree, TIER.farEnd].map(
            (d) => round(fogT(d) * 1e4) / 1e4,
          ),
          treeEnd: m1(TIER.tree),
          farEnd: m1(TIER.farEnd),
          farN,
          shrub: [LOD.shrub[0], LOD.shrub[1], LOD.shrub[3]].map(m1),
          far: LOD.far.map(m1),
          whole: [
            wholeTo(THIN_TREE, LOD.tree),
            wholeTo(THIN_SHRUB, LOD.shrub),
          ].map((v) => round(v * 1e3) / 1e3),
          cuts,
        };
      },
      weather,
      flash: flashAt,
      lastFlash: () => [F[LT], F[LD]],
      flashes: () => [...flashCount],
      audit: (on) => {
        if (on === undefined) return audit();
        auditing = on;
        return [];
      },
      paths: () => Wd.paths,
      bolt: () => [boltN, boltN * 2, boltBranches],
      openSky: (veils) =>
        Array.from({ length: 9 }, (_, j) =>
          veils
            ? Array.from({ length: 7 }, (_, i) => {
                const d = frameWay(i, 8 - j);
                return min(9, floor(skyVeil(d[0], d[1], d[2], 900) / 30));
              }).join('')
            : Array.from(
                openSky().subarray((8 - j) * 7, (9 - j) * 7),
                (o) => o * 2,
              ).join(''),
        ),
      menu: () => {}, // (main.ts puts the debug menu's switch here on a dev machine)
      clock: (to, hold) => {
        if (to >= 0) {
          if (hold) F[BLOWN] += windNow() * (to - F[TIME]); // (what the wind carries moves on with it)
          F[TIME] = to;
        }
        clockHeld = !!hold;
        return [F[TIME], F[BLOWN], windNow()];
      },
      at: () => [F[CX], F[CY], F[CZ]],
      ground,
      atlasShot,
      atlas: () => [
        round(atlasMs),
        round(
          ((ATLAS * ATLAS * 3 * 4 * (1 - 0.25 ** ATLAS_MIPS)) /
            0.75 /
            1048576) *
            10,
        ) / 10,
      ],
      creatures: critters,
      // ---------------------------------------------------------------- deer (deer.js)
      deerCount: (n) => deer.count(n),
      deerStretches: () =>
        deer.stretches.map((s) => {
          const p = Wd.paths[s.path][(s.from + s.to) >> 1];
          return [s.path, s.from, s.to, p[0], p[1]];
        }),
      deerCross: (stretch, delay = 5, side) => {
        const r = deer.crossAt(
          stretch,
          delay,
          side ?? (Math.random() < 0.5 ? 1 : -1),
        );
        lookAt(
          r.stand[0],
          ground(r.stand[0], r.stand[1]) + EYE,
          r.stand[1],
          r.at[0],
          ground(r.stand[0], r.stand[1]) + EYE,
          r.at[1],
        );
        return r;
      },
      deerIn: () => deer.pendingIn(),
      deerRoutes: () => deer.routes(),
      deerHold: (i, pose, x, z, yaw) => deer.hold(i, pose, x, z, yaw),
      deerTris: () => deer.tris(meshes),
      deerProbe: (x, z) => deer.probe(x, z),
      deerState: () => deer.state(),
      deerDo: (i, what) => deer.force(i, what, F[CX], F[CZ]),
      deerWalkTest: (seconds, odds) => deer.walkTest(seconds, odds),
      deerHomes: () => deer.homeList(),
      // ---------------------------------------------------------------- (deer end)
      // ---------------------------------------------------------------- sound (audio.js)
      soundMaster: (v) => soundDebug.master(v),
      soundOn: (type, v) => soundDebug.type(type, v),
      soundLevel: (type, db) => soundDebug.level(type, db),
      soundLevels: () => soundDebug.levels(),
      soundStepOn: (surface, wet) => soundDebug.stepOn(surface, wet),
      soundState: () => [...soundDebug.state(), +soundMs.toFixed(1)],
      soundHere: () => SURFACES[soundProbe.surface(F[CX], F[CZ])],
      soundThunder: (km) => soundDebug.thunderNow(km),
      soundCall: (species, d) => soundDebug.callNow(species, d),
      soundWater: () => soundDebug.water(),
      soundReduction: () => soundDebug.reduction(),
      soundRender: async (
        secs,
        state,
        v,
        surface,
        canopy,
        lake,
        solo,
        flashes,
        water,
        birdsHeard,
      ) => {
        const F2 = new Float64Array(F.length);
        F2.set(F);
        for (const [k, val] of Object.entries(state || {})) F2[+k] = val;
        const x = await soundDebug.render(
          secs,
          F2,
          v,
          SURFACES.indexOf(surface),
          canopy,
          lake,
          solo,
          flashes,
          water,
          birdsHeard,
        );
        return Array.from(x, (s) => Math.round(s * 32767));
      },
      // ---------------------------------------------------------------- (sound end)
    },
    // (sound: only once the forest is shown, the loader gone)
    wake: () => {
      if (raf && SOUND && document.body.dataset.state === 'ready')
        sound(soundProbe);
    },
  };
}
