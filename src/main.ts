// Entry: the loading screen, the touch controls and the tik's visible/hidden switch around the scene.
// The world is built on the first visible, not while the feed preloads: the build takes seconds and
// hundreds of MB, which would stall the tik the user is looking at.
import { attachControls } from './controls';
import { attachBudgetView, BUDGET_VIEW, type BudgetView } from './budget';
import type { DebugMenu } from './debug-menu';
import { attachReveal, decodeSheet, type Reveal } from './loader';
import { VERSION } from './version';
import type { Keys } from './keys';
import { chooseLevel, DEV, guard, STEPS } from './scene/quality.js';
import type { Scene, SceneInput } from './scene/scene.js';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const bar = document.getElementById('bar')!;
const status = document.getElementById('status')!;
const details = document.getElementById('details')!;
const stats = document.getElementById('stats')!;
const walkButton = document.getElementById('walk')!;
// The loader's one sprite sheet (loader.ts): the logo shows once it is decoded (never half drawn), and start()
// waits a little for it before the build takes the thread, so the logo and the painting's silhouettes are on
// screen from the loader's first moments. 'sheet decode': from asking for it to it decoded
// the start guard's step (quality.js guard), taken before anything shows: a load that lost the GPU or crashed makes
// the next start a step lighter (step 3 leaves the painting out); a new VERSION starts full again
const step = guard(VERSION);
const logo = document.getElementById('logo')!;
const showLogo = (): void => logo.classList.add('shown');
performance.mark('sheet decode');
const sheetDecoded = decodeSheet().then(() => {
  performance.measure('sheet decode', 'sheet decode');
  showLogo();
});
const FIRST_PAINT_MS = 150; // the longest the load waits for it
// each stage of the load and when it began (say), for the budget view's load line: each stage's first word and
// seconds, then the whole; and how long the start waited for the sprite sheet, and whether it gave up at the cap
const stageAt: [string, number][] = [];
let sheetWaitMs = 0;
let sheetCapped = false;
function loadLine(): string {
  if (stageAt.length < 2) return 'load: …';
  const wait = `sheet wait ${Math.round(sheetWaitMs)} ms${sheetCapped ? ' (cap)' : ''}`;
  const parts = stageAt
    .slice(0, -1)
    .map(
      ([message, at], k) =>
        `${message.split(' ')[0].toLowerCase()} ${((stageAt[k + 1][1] - at) / 1000).toFixed(1)}`,
    );
  const whole = (stageAt[stageAt.length - 1][1] - stageAt[0][1]) / 1000;
  return `load ${whole.toFixed(1)} s: ${wait} · ${parts.join(' · ')}`;
}
const budgetView: BudgetView | null = BUDGET_VIEW
  ? attachBudgetView(loadLine)
  : null;
// The loading screen's painting is left out at the start guard's step 3, and on a dev machine with
// localStorage.forestArt = '0' (to time the load without it); the logo still shows, from the same sheet
function artOff(): boolean {
  if (step >= 3) return true;
  try {
    return DEV && localStorage.getItem('forestArt') === '0';
  } catch {
    return false;
  }
}
const art = document.getElementById('art')!;
if (artOff()) art.remove();
const reveal: Reveal = artOff()
  ? { reach: () => {}, show: () => {} }
  : attachReveal(art);

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
// `forest` in the console, with keyboard walking. A published build has DEV false, so neither ships (the iOS app
// serves tiks from 127.0.0.1 too: the hostname alone would not tell).
const ON_DEV_MACHINE = DEV;
// What is known about this run, printed under a problem; the scene adds its own lines (scene.js).
const facts: Record<string, string> = {
  version: `v${VERSION}`,
  start: step ? `step ${step}: ${STEPS[step]}` : 'full',
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
const LEAVE_M = 12;
const LEAVE_CHECK_MS = 500;

let scene: Scene | null = null;
let booted = false;
let loaded = 0;
let statsOn = false;
let statsTimer = 0;
let walkFrom: number[] | null = null;
let leaveTimer = 0;
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

// Each stage glides the bar on the compositor, so it moves while the build blocks this thread, and brings in the
// painting's steps whose share of the bar it reaches (loader.ts), the same way.
function say(message: string, to: number, ms: number): Promise<void> {
  if (problems.length) return Promise.reject(STOPPED);
  facts.stage = message;
  stageAt.push([message, performance.now()]);
  status.textContent = message;
  reveal.reach(to, ms);
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
  // the sheet first (at most FIRST_PAINT_MS), its logo shown and painted once, then the load; the wait is the
  // performance measure 'loader wait'
  performance.mark('loader wait');
  const waitFrom = performance.now();
  sheetCapped = await Promise.race([
    sheetDecoded.then(() => false),
    new Promise<boolean>((done) =>
      setTimeout(() => done(true), FIRST_PAINT_MS),
    ),
  ]);
  sheetWaitMs = performance.now() - waitFrom;
  showLogo();
  await new Promise((done) => requestAnimationFrame(() => setTimeout(done)));
  performance.measure('loader wait', 'loader wait');
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
  stageAt.push(['', performance.now()]);
  budgetView?.attach(scene);
  if (menuWanted()) void attachMenu(scene);
  // on a dev machine: `forest.debug.view(3)` in the console jumps between the six viewpoints
  if (ON_DEV_MACHINE) {
    Object.assign(window, { forest: scene, budgetView });
    void attachDevTools();
  }
  // The scene runs behind the loader for a moment, so the resolution and draw distance settle (and the
  // resizes that takes) before anyone sees it.
  document.body.dataset.state = 'settling';
  if (tik.visible()) scene.resume();
  setTimeout(() => {
    if (problems.length) return;
    document.body.dataset.state = 'ready';
  }, SETTLE_MS);
}

// The dev machine's tool, loaded only there: the keyboard (keys.ts)
async function attachDevTools(): Promise<void> {
  const { attachKeys } = await import('./keys');
  keys = attachKeys(input, markWalked);
}

// The testing menu (debug-menu.ts), in every build but hidden: four quick taps in the top right corner show or
// hide it, kept on this device (MENU_KEY). It is loaded the first time it is wanted, once the scene is built;
// scene.debug.menu(false) hides it for clean stills.
const MENU_KEY = 'forestTestMenu'; // '1': shown. Never on by default: users get a clean screen
let menu: DebugMenu | null = null;
let menuLoading: Promise<DebugMenu> | null = null;
function menuWanted(): boolean {
  try {
    return localStorage.getItem(MENU_KEY) === '1';
  } catch {
    return false;
  }
}
function attachMenu(active: Scene): Promise<DebugMenu> {
  menuLoading ??= import('./debug-menu').then(({ attachDebugMenu }) => {
    menu = attachDebugMenu(active, toggleStats, budgetView, () =>
      showMenu(false),
    );
    active.debug.menu = menu.show;
    return menu;
  });
  return menuLoading;
}
function showMenu(on: boolean): void {
  try {
    localStorage.setItem(MENU_KEY, on ? '1' : '');
  } catch {
    // storage is blocked: it shows or hides for this load only
  }
  if (!on) {
    menu?.show(false);
    return;
  }
  // (asked for while loading: it comes once the scene is built)
  if (!scene) return;
  void attachMenu(scene).then((shown) => {
    shown.show(true);
    shown.open();
  });
}
function toggleMenu(): void {
  showMenu(!(menu ? menu.shown() : menuWanted()));
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

// The stats line is a tuning tool, shown or hidden from the testing menu.
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

// the hint goes after the first steps, by the corner or by a key; from then on the walker's way from there is watched
function markWalked(): void {
  document.body.classList.add('walked');
  if (!walkFrom && scene) {
    walkFrom = scene.walker();
    watchLeaving();
  }
}

// Once the walker is LEAVE_M (straight line) from where the walk began, the start area is learnt: the ring fades
// away for good (.left; the corner still walks). Checked twice a second while the tik is on screen
function watchLeaving(): void {
  if (leaveTimer || !walkFrom || document.body.classList.contains('left'))
    return;
  leaveTimer = window.setInterval(() => {
    if (!scene || !walkFrom) return;
    const [x, z] = scene.walker();
    if (Math.hypot(x - walkFrom[0], z - walkFrom[1]) <= LEAVE_M) return;
    document.body.classList.add('left');
    stopWatching();
  }, LEAVE_CHECK_MS);
}

function stopWatching(): void {
  clearInterval(leaveTimer);
  leaveTimer = 0;
}

const controls = attachControls(
  canvas,
  walkButton,
  input,
  () => scene?.wake(),
  toggleMenu,
);
walkButton.addEventListener('pointerdown', markWalked, { once: true });

function onVisible(): void {
  if (problems.length) return;
  budgetView?.resume();
  if (!booted) void start();
  else scene?.resume();
  startStats();
  watchLeaving();
}

function onHidden(): void {
  budgetView?.pause();
  controls.release();
  keys?.release();
  scene?.pause();
  stopStats();
  stopWatching();
}

// Dev only: ?loader=0.6 (or localStorage.forestLoader) holds the loading screen at that point, nothing loaded
function heldLoader(): number | null {
  if (!ON_DEV_MACHINE) return null;
  let held = new URLSearchParams(location.search).get('loader');
  try {
    held ??= localStorage.getItem('forestLoader');
  } catch {
    // storage is blocked: only the address can hold it
  }
  const at = Number(held);
  return held !== null && at >= 0 && at <= 1 ? at : null;
}
const held = heldLoader();
if (held !== null) {
  booted = true; // (the load never starts)
  reveal.show(held);
  bar.style.transform = `scaleX(${held})`;
  status.textContent = `Held at ${Math.round(held * 100)}%`;
}

if (tik.visible()) onVisible();
tik.on('visible', onVisible);
tik.on('hidden', onHidden);
