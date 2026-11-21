// Entry: the loading screen, the touch controls and the tik's visible/hidden switch around the scene.
// The world is built on the first visible, not while the feed preloads: the build takes seconds and
// hundreds of MB, which would stall the tik the user is looking at.
import { attachControls } from './controls';
import type { Keys } from './keys';
import { chooseLevel, DEV } from './scene/quality.js';
import type { Scene, SceneInput } from './scene/scene.js';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const bar = document.getElementById('bar')!;
const status = document.getElementById('status')!;
const details = document.getElementById('details')!;
const stats = document.getElementById('stats')!;
const walkButton = document.getElementById('walk')!;

const input: SceneInput = {
  walk: false,
  lookX: 0,
  lookY: 0,
  forward: 0,
  strafe: 0,
  turn: 0,
  fast: false,
};
// A dev machine (quality.js DEV): the tik served by `codetik dev` on this computer. Only there the scene is on
// `forest` in the console, with a debug menu and keyboard walking. A published build has DEV false, so none of
// it ships (the iOS app serves tiks from 127.0.0.1 too: the hostname alone would not tell).
const ON_DEV_MACHINE = DEV;
// What is known about this run, printed under a problem; the scene adds its own lines (scene.js).
const facts: Record<string, string> = {
  stage: 'starting',
  screen: `${innerWidth}x${innerHeight} @${devicePixelRatio}`,
  system: systemName(),
};
// Every problem is fatal and stays on screen: the first is the headline, later ones join the details.
const problems: string[] = [];
const MAX_PROBLEMS = 8;
// say() rejects with this once a problem is on screen, which ends the build without a second message
const STOPPED = new Error('stopped');
const STATS_EVERY_MS = 500;
const SETTLE_MS = 2500;

let scene: Scene | null = null;
let booted = false;
let loaded = 0;
let statsOn = false;
let statsTimer = 0;
let keys: Keys | null = null;

function systemName(): string {
  const agent = navigator.userAgent;
  const system =
    /Android [\d.]+|iPhone OS [\d_]+|Mac OS X [\d_.]+|Windows NT [\d.]+/.exec(
      agent,
    );
  const engine =
    /Chrome\/[\d.]+/.exec(agent) ??
    /Version\/[\d.]+/.exec(agent) ??
    /AppleWebKit\/[\d.]+/.exec(agent);
  return [system?.[0], engine?.[0]].filter(Boolean).join(', ') || 'unknown';
}

// The top frames of a stack without the origin: enough to find the line in the bundle.
function whereFrom(error: unknown): string {
  const stack = error instanceof Error ? (error.stack ?? '') : '';
  return stack
    .split('\n')
    .filter((line) => /:\d+:\d+/.test(line))
    .slice(0, 3)
    .map((line) =>
      line
        .trim()
        .replace(/^at /, '')
        .replace(/https?:\/\/[^/\s]+\//g, ''),
    )
    .join(' < ');
}

function showProblem(message: string, error?: unknown): void {
  const where = whereFrom(error);
  if (where && !facts.where) facts.where = where;
  if (!problems.includes(message) && problems.length < MAX_PROBLEMS) {
    problems.push(message);
  }
  scene?.pause();
  stopStats();
  document.body.dataset.state = 'error';
  status.textContent = problems[0];
  details.textContent = [
    ...problems.slice(1).map((problem) => `also: ${problem}`),
    ...Object.entries(facts).map(([name, value]) => `${name}: ${value}`),
  ].join('\n');
}

// Each stage glides the bar on the compositor, so it moves while the build blocks this thread.
function say(message: string, to: number, ms: number): Promise<void> {
  if (problems.length) return Promise.reject(STOPPED);
  facts.stage = message;
  status.textContent = message;
  const animation = bar.animate(
    [{ transform: `scaleX(${loaded})` }, { transform: `scaleX(${to})` }],
    {
      duration: ms,
      fill: 'forwards',
      easing: 'cubic-bezier(.3,.5,.5,1)',
    },
  );
  loaded = to;
  // go on once the animation runs: one not started before the thread gets busy stays stuck
  return new Promise((resolve) => {
    void animation.ready.then(() => setTimeout(resolve));
    setTimeout(resolve, 1000);
  });
}

async function start(): Promise<void> {
  booted = true;
  try {
    // the level first (it asks the GPU adapter): every module of the scene is built for it
    await chooseLevel();
    const { boot } = await import('./scene/scene.js');
    scene = await boot({
      canvas,
      input,
      facts,
      say,
      problem: showProblem,
      dev: ON_DEV_MACHINE,
    });
  } catch (error) {
    if (error === STOPPED) return;
    console.error(error);
    const shownAsIs = error instanceof Error && error.cause === 1;
    const message = error instanceof Error ? error.message : String(error);
    showProblem(
      shownAsIs ? message : `Forest could not start: ${message}`,
      error,
    );
    return;
  }
  if (problems.length) return;
  facts.stage = 'running';
  // on a dev machine: `forest.debug.view(3)` in the console jumps between the six viewpoints
  if (ON_DEV_MACHINE) {
    Object.assign(window, { forest: scene });
    void attachDevTools(scene);
  }
  // The scene runs behind the loader for a moment, so the resolution and draw distance settle (and the
  // resizes that takes) before anyone sees it.
  document.body.dataset.state = 'settling';
  if (tik.visible()) scene.resume();
  setTimeout(() => {
    if (!problems.length) document.body.dataset.state = 'ready';
  }, SETTLE_MS);
}

// The dev machine's tools, loaded only there: the keyboard (keys.ts) and the debug menu (debug-menu.ts), which
// scene.debug.menu(false) hides.
async function attachDevTools(active: Scene): Promise<void> {
  const [{ attachKeys }, { attachDebugMenu }] = await Promise.all([
    import('./keys'),
    import('./debug-menu'),
  ]);
  keys = attachKeys(input, markWalked);
  const menu = attachDebugMenu(active, toggleStats);
  active.debug.menu = menu.show;
}

// Anything else that goes wrong is shown too: a silent failure looks like a black screen.
addEventListener('error', (event) => {
  showProblem(`Error: ${event.message}`, event.error);
});
addEventListener('unhandledrejection', (event) => {
  const reason: unknown = event.reason;
  if (reason === STOPPED) return;
  const message = reason instanceof Error ? reason.message : String(reason);
  showProblem(`Unhandled: ${message}`, reason);
});

// The stats line is a tuning tool: four quick taps in the top right corner show or hide it.
function startStats(): void {
  if (!statsOn || statsTimer || !scene) return;
  const active = scene;
  statsTimer = window.setInterval(() => {
    stats.textContent = active.stats();
  }, STATS_EVERY_MS);
}

function stopStats(): void {
  clearInterval(statsTimer);
  statsTimer = 0;
}

function toggleStats(): boolean {
  statsOn = !statsOn;
  stats.hidden = !statsOn;
  if (statsOn) startStats();
  else stopStats();
  return statsOn;
}

// the hint goes after the first steps, by the button or by a key
function markWalked(): void {
  document.body.classList.add('walked');
}

const controls = attachControls(
  canvas,
  walkButton,
  input,
  () => scene?.wake(),
  toggleStats,
);
walkButton.addEventListener('pointerdown', markWalked, { once: true });

function onVisible(): void {
  if (problems.length) return;
  if (!booted) void start();
  else scene?.resume();
  startStats();
}

function onHidden(): void {
  controls.release();
  keys?.release();
  scene?.pause();
  stopStats();
}

if (tik.visible()) onVisible();
tik.on('visible', onVisible);
tik.on('hidden', onHidden);
