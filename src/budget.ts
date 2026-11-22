// The on-screen budget view (main.ts attaches it in every build while BUDGET_VIEW is on): a small plate top left
// with the version, the tier, the frame's times, the render size, what is drawn by group, the GPU and the screen,
// and the last load's stages; read from the scene about twice a second. Its Measure button times frames one at a
// time with each part left out in turn (Scene.measure) and shows the table, most saved first, until it is tapped
// away; its Full button, there on a start guard's step (quality.js), clears the step for the next start; its Try
// button opens the knobs (Scene.knobs): each tap takes a knob to its next choice, at once, kept on this device; its
// tier knob reloads into the tier picked (High, Medium, Low, or back to the tier chosen as usual).
// Hidden until the testing menu (debug-menu.ts) switches it on; kept on this device (VIEW_KEY). Touches pass
// through the plate except on its buttons and its table, and where it is longer than the screen, so it scrolls.
import {
  fullStart,
  STEP,
  STEPS,
  TIER,
  TIERS,
  tryTier,
  WHY,
} from './scene/quality.js';
import type { Budget, Knobs, Measure, Scene } from './scene/scene.js';
import { VERSION } from './version';

export const BUDGET_VIEW = true; // false: no view, in any build
const EVERY_MS = 500;
const VIEW_KEY = 'forestDebugView'; // '1': shown. Never on by default: users get a clean screen

// (max-height leaves the walk corner, bottom left, free)
const CSS = `
#budget { position: fixed; top: 8px; left: 8px; z-index: 4; max-width: calc(100% - 76px);
  max-height: calc(100% - 156px); overflow-y: auto; overscroll-behavior: contain; touch-action: pan-y;
  padding: 6px 8px; border-radius: 8px; background: #000000a6; color: #f3ead8;
  font: 500 10px/1.35 ui-monospace, Menlo, monospace; white-space: pre-wrap; word-break: break-word;
  pointer-events: none; }
#budget[hidden] { display: none; }
#budget.scrolls { pointer-events: auto; }
#budget button { pointer-events: auto; min-width: 88px; min-height: 44px; margin: 6px 6px 0 0; padding: 0 12px;
  border: 0; border-radius: 8px; background: #f3ead833; color: inherit; font: inherit; font-weight: 700;
  touch-action: manipulation; }
#budget .table { pointer-events: auto; margin-top: 6px; }
#budget .try { display: flex; flex-wrap: wrap; margin-top: 6px; }
#budget .try p { flex-basis: 100%; margin: 0; }
#budget .try button { min-width: 96px; padding: 0 8px; }
`;
// The Try knobs' buttons (scene.js KNOBS): each knob's name and how a value of it reads; fx: four, one a bit
const KNOB_TEXT: [string, string, (value: number) => string][] = [
  ['d', 'draw', (v) => `${v}%`],
  ['f', 'pictures from', (v) => `${v} m`],
  ['l', 'leaves', (v) => `${v}%`],
  ['p', 'plants', (v) => `${v}%`],
  ['s', 'shadow taps', (v) => `${v}`],
  ['w', 'sway', (v) => (v ? 'on' : 'off')],
  ['n', 'near sprays', (v) => (v ? 'on' : 'off')],
  ['r', 'floor', (v) => `${v}k px`],
];
const EFFECTS = ['shafts', 'bloom', 'water motion', 'metering'];

// a number of thousands, to one place below ten
const kilo = (n: number): string =>
  n >= 1e4 ? `${Math.round(n / 1e3)}k` : `${(n / 1e3).toFixed(1)}k`;
// milliseconds to a tenth; n/a where the device does not tell them (NaN, or a time below 0)
const ms = (n: number): string =>
  Number.isNaN(n) || n < 0 ? 'n/a' : `${n.toFixed(1)}`;
// a saving, signed (leaving a part out can cost a little too)
const saved = (n: number): string =>
  Number.isNaN(n) ? 'n/a' : `${n > -0.05 ? ' ' : '-'}${Math.abs(n).toFixed(1)}`;

function lines(b: Budget, load: string, cleared: boolean): string {
  const [w, h, dw, dh] = b.size;
  const fps = b.frameMs ? 1000 / b.frameMs : 0;
  const start = STEP ? `step ${STEP}, ${STEPS[STEP]}` : 'full';
  const nth =
    b.every === 1
      ? 'every'
      : `every ${b.every}${b.every === 2 ? 'nd' : b.every === 3 ? 'rd' : 'th'}`;
  return [
    `v${VERSION} · ${b.level} (${b.why}) · start: ${start}${cleared ? ' (cleared: full next start)' : ''}`,
    ...(b.decided ? [`tier: ${b.decided}`] : []),
    `${fps.toFixed(1)} fps of ${b.target} (${nth} refresh of ${b.hz.toFixed(0)} Hz) · frame ${ms(b.frameMs)} ms, worst ${ms(b.worstMs)} · script ${ms(b.cpuMs)} · gpu ${ms(b.gpuMs)}${b.gpuBy === 'timer' ? '' : ` (${b.gpuBy})`}`,
    `render ${w}x${h} of ${dw}x${dh} (${Math.round((100 * w * h) / Math.max(dw * dh, 1))}%) · ${b.passes} passes · floor ${Math.round(b.pixMin / 1e3)}k${b.atFloor ? ' (at it)' : ''} · draw distance ${Math.round(b.det * 100)}% (not tuned)`,
    `try: ${b.tryCode}`,
    `${b.groups.map(([name, tris, draws]) => `${name} ${kilo(tris)}/${draws}`).join(' · ')}`,
    `${b.draws} draws · cells ${b.cells[0]}/${b.cells[1]}`,
    `${b.gpu} · screen ${innerWidth}x${innerHeight} @${devicePixelRatio}`,
    `memory: gpu buffers ${b.gpuMB[0].toFixed(0)} MB, textures ${b.gpuMB[1].toFixed(0)} MB · js heap ${b.heapMB < 0 ? 'n/a' : `${b.heapMB.toFixed(0)} MB`} · pipelines: ${b.pipelines}`,
    `${load} · bake ms: ${b.bake}`,
  ].join('\n');
}

// (a saving within the noise is marked ~)
function table(result: Measure): string {
  const { base, noise, rows } = result;
  const head = [
    `all on: wall ${ms(base.wall)} · gpu ${ms(base.gpu)} · script ${ms(base.cpu)} ms`,
    `noise (all on's spread): wall ${ms(noise.wall)} · gpu ${ms(noise.gpu)} ms`,
    'saved (ms)          wall    gpu',
  ];
  const body = rows.map(
    (row) =>
      `${row.part.padEnd(18).slice(0, 18)} ${saved(row.savedMs).padStart(5)}${row.inNoise ? '~' : ' '} ${saved(row.gpuSavedMs).padStart(5)}${row.gpuInNoise ? '~' : ' '}`,
  );
  return [...head, ...body, '(~: within the noise · tap to close)'].join('\n');
}

// the Try block's buttons, from the knobs as they are
function tryButtons(
  knobs: Knobs,
  set: (key: string, value: string) => void,
  reset: () => void,
): HTMLElement[] {
  const next = (key: string): string => {
    const choices = knobs.choices[key].map(String);
    return choices[
      (choices.indexOf(String(knobs.values[key])) + 1) % choices.length
    ];
  };
  const make = (text: string, act: () => void): HTMLElement => {
    const b = document.createElement('button');
    b.textContent = text;
    b.addEventListener('click', act);
    return b;
  };
  const code = document.createElement('p');
  code.textContent = `try: ${knobs.code}`;
  const fx = String(knobs.values.fx);
  const tried = WHY === 'Try knob',
    tiers = [...TIERS].reverse().concat(''),
    nextTier = tiers[(tiers.indexOf(tried ? TIER : '') + 1) % tiers.length];
  return [
    code,
    make(`tier ${TIER}${tried ? '' : ' (as chosen)'}`, () => {
      tryTier(nextTier);
      location.reload();
    }),
    ...KNOB_TEXT.map(([key, name, read]) =>
      make(`${name} ${read(Number(knobs.values[key]))}`, () =>
        set(key, next(key)),
      ),
    ),
    ...EFFECTS.map((name, bit) =>
      make(`${name} ${fx[bit] === '1' ? 'on' : 'off'}`, () =>
        set(
          'fx',
          fx.slice(0, bit) + (fx[bit] === '1' ? '0' : '1') + fx.slice(bit + 1),
        ),
      ),
    ),
    make('reset', reset),
  ];
}

export interface BudgetView {
  /** Starts reading the scene (once it is built). */
  attach(scene: Scene): void;
  /** Stops reading it (the tik hidden), and starts again. */
  pause(): void;
  resume(): void;
  /** The view's own cost: its updates' mean ms, and how many. */
  cost(): number[];
  /** Shows or hides it (kept on this device), or with no argument answers whether it shows. */
  show(on?: boolean): boolean;
}

const shownBefore = (): boolean => {
  try {
    return localStorage.getItem(VIEW_KEY) === '1';
  } catch {
    return false;
  }
};

// load(): the last load's stage times as one line (main.ts keeps them)
export function attachBudgetView(load: () => string): BudgetView {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
  const root = document.createElement('div');
  root.id = 'budget';
  const text = document.createElement('div');
  text.textContent = `v${VERSION}`;
  const button = document.createElement('button');
  button.textContent = 'Measure';
  button.hidden = true;
  const full = document.createElement('button');
  full.textContent = 'Full';
  full.hidden = true;
  const tryButton = document.createElement('button');
  tryButton.textContent = 'Try';
  tryButton.hidden = true;
  const tryBlock = document.createElement('div');
  tryBlock.className = 'try';
  tryBlock.hidden = true;
  const result = document.createElement('div');
  result.className = 'table';
  result.hidden = true;
  root.append(text, button, full, tryButton, tryBlock, result);
  let visible = shownBefore();
  root.hidden = !visible;
  document.body.append(root);

  let scene: Scene | null = null;
  let timer = 0;
  let spent = 0;
  let updates = 0;
  let measuring = false;
  let cleared = false;
  // the plate takes touches only while it is longer than the screen allows, so a finger can scroll it
  const fit = (): void => {
    root.classList.toggle('scrolls', root.scrollHeight > root.clientHeight + 1);
  };
  const update = (): void => {
    if (!scene || measuring) return;
    const t0 = performance.now();
    text.textContent = lines(scene.budget(), load(), cleared);
    fit();
    spent += performance.now() - t0;
    updates++;
  };
  button.addEventListener('click', () => {
    if (!scene || measuring) return;
    measuring = true;
    button.disabled = true;
    result.hidden = true;
    text.textContent = 'Measuring: hold still…';
    scene
      .measure((at, of, part, frames) => {
        text.textContent = `Measuring ${at + 1}/${of}: ${part} · ${frames} frames`;
      })
      .then((measured) => {
        result.textContent = table(measured);
        result.hidden = false;
        fit();
        console.log('measure', measured);
      })
      .catch((error: unknown) => {
        result.textContent = `measure failed: ${String(error)}`;
        result.hidden = false;
        fit();
      })
      .finally(() => {
        measuring = false;
        button.disabled = false;
        update();
      });
  });
  full.addEventListener('click', () => {
    fullStart();
    cleared = true;
    full.hidden = true;
    update();
  });
  const showTry = (): void => {
    if (!scene) return;
    const active = scene;
    tryBlock.replaceChildren(
      ...tryButtons(
        active.knobs(),
        (key, value) => {
          active.knob(key, value);
          showTry();
          update();
        },
        () => {
          active.tryCode('');
          showTry();
          update();
        },
      ),
    );
  };
  tryButton.addEventListener('click', () => {
    tryBlock.hidden = !tryBlock.hidden;
    if (!tryBlock.hidden) showTry();
    fit();
  });
  result.addEventListener('click', () => {
    result.hidden = true;
    fit();
  });
  return {
    attach(active) {
      scene = active;
      button.hidden = false;
      tryButton.hidden = false;
      full.hidden = !STEP || cleared;
      this.resume();
    },
    pause() {
      clearInterval(timer);
      timer = 0;
    },
    resume() {
      if (timer || !scene || !visible) return;
      timer = window.setInterval(update, EVERY_MS);
      update();
    },
    cost: () => [updates ? spent / updates : 0, updates],
    show(on) {
      if (on === undefined) return visible;
      visible = on;
      root.hidden = !on;
      try {
        localStorage.setItem(VIEW_KEY, on ? '1' : '');
      } catch {
        // storage is blocked: it shows or hides for this load only
      }
      if (on) this.resume();
      else this.pause();
      return visible;
    },
  };
}
