// The debug menu of a dev machine (main.ts attaches it only there): a button in the top right corner that opens
// a panel of switches over the scene's debug API. Its styles travel with it, so a published page carries none.
import { MEDIUM, WHY } from './scene/quality.js';
import type { Scene } from './scene/scene.js';

type Weather = 'auto' | 'clear' | 'fog' | 'rain' | 'storm';

const WEATHERS: Weather[] = ['auto', 'clear', 'fog', 'rain', 'storm'];
const FLASHES = ['patch', 'sheet', 'bolt']; // the kinds of scene.debug.flash, in its order
const LEVELS = ['Low', 'Medium']; // quality.js: the pick is kept as forestLevel
// a place: a point of the trail and how many points ahead to look (scene.debug.trail)
const PLACES: [string, number, number][] = [
  ['start', 0, 10],
  ['junction', 17, 8],
  ['meadow', 310, 12],
  ['boardwalk', 202, 8],
];
// what crosses the water at a crossing, by its make (scene.debug.crossings)
const MAKES = [
  'bridge on posts',
  'plank bridge',
  'pole crossing',
  'split log',
  'stepping stones',
];
const BEFORE = 2; // a crossing is looked along from this many metres before its near end
const SOUND_KEY = 'forestSound'; // each sound type's [on, dB offset], kept by the menu

// (#stats makes room for the button; plain insets: a tik's safe area is outside its frame)
const CSS = `
#debug { position: fixed; top: 10px; right: 10px; z-index: 5; display: flex; flex-direction: column;
  align-items: flex-end; gap: 6px; max-height: calc(100% - 20px); pointer-events: none; }
#debug > * { pointer-events: auto; }
#debug button { border: 0; color: inherit; font: inherit; touch-action: manipulation; }
#debug .open { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 50%;
  background: #120a0599; box-shadow: 0 0 0 1px #ffe9bf40; }
#debug .panel { display: none; width: 216px; padding: 10px; overflow: auto; border-radius: 12px;
  background: #120a05e6; box-shadow: 0 0 0 1px #ffe9bf40; font: 600 12px/1.3 system-ui, sans-serif; }
#debug.is-open .panel { display: block; }
#debug h2 { margin: 8px 0 4px; font: inherit; font-size: 10px; letter-spacing: 0.1em;
  text-transform: uppercase; opacity: 0.6; }
#debug h2:first-child { margin-top: 0; }
#debug .row { display: flex; flex-wrap: wrap; gap: 4px; }
#debug .row button { min-height: 30px; padding: 4px 9px; border-radius: 8px; background: #ffffff1f; }
#debug .row button[aria-pressed='true'] { background: #ffc24a; color: #120a05; }
#debug .note { margin: 6px 0 0; font-weight: 400; opacity: 0.8; }
#debug .row.mix { display: grid; grid-template-columns: 1fr 30px 48px 30px; align-items: center; margin-bottom: 4px; }
#debug .mix span { text-align: center; font-variant-numeric: tabular-nums; }
#stats { right: 64px; }
`;

export interface DebugMenu {
  /** Shows the menu, or hides it altogether (for clean stills). */
  show(on: boolean): void;
}

export function attachDebugMenu(
  scene: Scene,
  toggleStats: () => boolean,
): DebugMenu {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);

  const root = document.createElement('div');
  root.id = 'debug';
  root.dataset.debugMenu = '';
  const open = document.createElement('button');
  open.className = 'open';
  open.setAttribute('aria-label', 'Debug menu');
  open.innerHTML =
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';
  const panel = document.createElement('div');
  panel.className = 'panel';
  root.append(open, panel);

  // A row of buttons under a heading. With `pressed` one of them is lit: the one pressed last, or, where `act`
  // answers on or off (a switch), each by its own answer
  const row = (
    title: string,
    names: string[],
    act: (index: number) => boolean | void,
    pressed = -1,
  ): void => {
    const heading = document.createElement('h2');
    heading.textContent = title;
    const buttons = document.createElement('div');
    buttons.className = 'row';
    names.forEach((name, index) => {
      const button = document.createElement('button');
      button.textContent = name;
      if (pressed >= 0)
        button.setAttribute('aria-pressed', `${index === pressed}`);
      button.addEventListener('click', () => {
        const answer = act(index);
        if (typeof answer === 'boolean') {
          button.setAttribute('aria-pressed', `${answer}`);
        } else if (pressed >= 0) {
          for (const other of buttons.children) {
            other.setAttribute('aria-pressed', `${other === button}`);
          }
        }
        button.blur(); // the keys walk again at once (keys.ts ignores them while the menu has the focus)
      });
      buttons.append(button);
    });
    panel.append(heading, buttons);
  };

  row('Weather', WEATHERS, (index) => scene.debug.weather(WEATHERS[index]), 0);
  row('Lightning', FLASHES, (index) => {
    scene.debug.flash(index);
  });
  // ways walked along: the pier from the boardwalk, then every crossing from a little before its near end
  const ways: [string, number, number[]][] = [
    ['pier', 0, scene.debug.pier()],
    ...scene.debug
      .crossings()
      .map((crossing): [string, number, number[]] => [
        MAKES[crossing[0]],
        BEFORE,
        crossing.slice(2),
      ]),
  ];
  row(
    'Go to',
    [...PLACES.map((place) => place[0]), ...ways.map((way) => way[0])],
    (index) => {
      if (index < PLACES.length) {
        scene.debug.trail(PLACES[index][1], PLACES[index][2]);
        return;
      }
      const [, before, [fromX, fromZ, toX, toZ]] = ways[index - PLACES.length];
      const length = Math.hypot(toX - fromX, toZ - fromZ);
      scene.debug.stand(
        fromX - ((toX - fromX) / length) * before,
        fromZ - ((toZ - fromZ) / length) * before,
        toX,
        toZ,
      );
    },
  );
  // (birds: on or off; jay crossing: one flies across the path ahead of the walker now; raven flyover: one goes over
  // the sky ahead now)
  row(
    'Animals',
    ['birds', 'jay crossing', 'raven flyover'],
    (index) => {
      if (index === 0) return scene.debug.birdsOn(!scene.debug.birdsOn());
      if (index === 1) scene.debug.birdCross();
      else scene.debug.ravenFlyover();
      return false;
    },
    0,
  );
  // ---------------------------------------------------------------- deer (deer.js)
  // How many live in the world; a crossing by the next way across (a stretch and a side its route is clear from: the
  // walker put there, the deer fired five seconds on, counted down here)
  const DEER = [0, 1, 3];
  row(
    'Deer',
    DEER.map((count) => `${count}`),
    (index) => {
      scene.debug.deerCount(DEER[index]);
    },
    DEER.indexOf(scene.debug.deerCount()),
  );
  let next = 0;
  const countdown = document.createElement('p');
  countdown.className = 'note';
  row('Deer crossing', ['deer crossing'], () => {
    const n = scene.debug.deerStretches().length;
    const routes = scene.debug.deerRoutes();
    if (!routes.length) {
      countdown.textContent = 'no stretch where a deer may cross';
      return false;
    }
    const [at, side] = routes[next++ % routes.length];
    scene.debug.deerCross(at, 5, side as 1 | -1);
    const tick = (): void => {
      const left = scene.debug.deerIn();
      countdown.textContent =
        left > 0
          ? `deer in ${Math.ceil(left)} (stretch ${at + 1} of ${n})`
          : '';
      if (left > 0) setTimeout(tick, 200);
    };
    tick();
    return false;
  });
  panel.append(countdown);
  // ---------------------------------------------------------------- (deer end)
  // ---------------------------------------------------------------- sound (audio.js)
  // (each starts the sound first if it has not started: a press in the menu is a touch too) On or off; four steps
  // on a surface, dry or wet
  const SURFACE = [
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
  let wetSteps = 0;
  row(
    'Sound',
    ['on', 'wet steps'],
    (index) => {
      scene.wake();
      if (index === 0)
        return scene.debug.soundMaster(!scene.debug.soundMaster());
      wetSteps = 1 - wetSteps;
      return wetSteps === 1;
    },
    0,
  );
  // One line per type of sound: on or off, and its level 3 dB a press; kept across reloads (this menu is dev only)
  const savedMix = ((): Record<string, [boolean, number]> => {
    try {
      return JSON.parse(localStorage.getItem(SOUND_KEY) ?? '{}');
    } catch {
      return {};
    }
  })();
  const keepMix = (): void => {
    const all = scene.debug
      .soundLevels()
      .map(([name, on, dB]) => [name, [on, dB]]);
    try {
      localStorage.setItem(SOUND_KEY, JSON.stringify(Object.fromEntries(all)));
    } catch {
      // storage is blocked: the mix holds for this load only
    }
  };
  const mixHeading = document.createElement('h2');
  mixHeading.textContent = 'Sound types';
  panel.append(mixHeading);
  const shows: (() => void)[] = [];
  const control = (text: string, act: () => void): HTMLButtonElement => {
    const button = document.createElement('button');
    button.textContent = text;
    button.addEventListener('click', () => {
      scene.wake();
      act();
      keepMix();
      for (const show of shows) show();
      button.blur();
    });
    return button;
  };
  for (const [name] of scene.debug.soundLevels()) {
    const [on, dB] = savedMix[name] ?? [true, 0];
    scene.debug.soundOn(name, on);
    scene.debug.soundLevel(name, dB);
    const line = document.createElement('div');
    line.className = 'row mix';
    const toggle = control(name, () =>
      scene.debug.soundOn(name, !scene.debug.soundOn(name)),
    );
    const level = document.createElement('span');
    const step = (by: number): void => {
      scene.debug.soundLevel(name, scene.debug.soundLevel(name) + by);
    };
    line.append(
      toggle,
      control('-', () => step(-3)),
      level,
      control('+', () => step(3)),
    );
    shows.push(() => {
      const offset = scene.debug.soundLevel(name);
      toggle.setAttribute('aria-pressed', `${scene.debug.soundOn(name)}`);
      level.textContent = `${offset > 0 ? '+' : ''}${offset} dB`;
    });
    panel.append(line);
  }
  for (const show of shows) show();
  const levelList = document.createElement('p');
  levelList.className = 'note';
  row('Sound mix', ['all on', 'all off', 'reset', 'show levels'], (index) => {
    scene.wake();
    const levels = scene.debug.soundLevels();
    for (const [name] of levels) {
      if (index < 2) scene.debug.soundOn(name, index === 0);
      if (index === 2) {
        scene.debug.soundOn(name, true);
        scene.debug.soundLevel(name, 0);
      }
    }
    if (index === 3) {
      levelList.textContent = levels
        .map(([name, on, dB]) => `${name} ${dB} dB${on ? '' : ' (off)'}`)
        .join(', ');
      console.log('sound levels', levels);
    }
    keepMix();
    for (const show of shows) show();
  });
  panel.append(levelList);
  row('Step on', SURFACE, (index) => {
    scene.wake();
    scene.debug.soundStepOn(SURFACE[index], wetSteps);
  });
  row('Thunder now', ['near', 'far'], (index) => {
    scene.wake();
    scene.debug.soundThunder(index ? 5 : 1.2);
  });
  row('Call now', ['jay', 'raven'], (index) => {
    scene.wake();
    scene.debug.soundCall(index ? 'raven' : 'jay', 20);
  });
  // ---------------------------------------------------------------- (sound end)
  const RAVENS = [0, 1, 2];
  row(
    'Ravens',
    RAVENS.map((count) => `${count}`),
    (index) => {
      scene.debug.ravens(RAVENS[index]);
    },
    RAVENS.indexOf(scene.debug.ravens()),
  );
  const COUNTS = [3, 6, 9, 11];
  row(
    'Jays',
    COUNTS.map((count) => `${count}`),
    (index) => {
      scene.debug.jays(COUNTS[index]);
    },
    COUNTS.indexOf(scene.debug.jays()),
  );
  // the nearest of a kind, looked at from far enough off not to put it up (metres away for each bird)
  const KINDS = ['jay', 'raven', 'deer'];
  const OFF = [7, 14];
  row('Nearest', KINDS, (index) => {
    const [fromX, , fromZ] = scene.debug.at();
    const far = (at: number[]): number =>
      Math.hypot(at[0] - fromX, at[2] - fromZ);
    // deer (deer.js): the nearest path point with a view of a resting deer, looking at it
    if (KINDS[index] === 'deer') {
      const herd = scene.debug.deerState().slice(0, 3);
      let best: number[] | null = null;
      scene.debug.deerHomes().homes.forEach((home, i) => {
        if (!herd[i]?.[4]) return;
        for (const [x, z] of home[8] as number[][]) {
          const d = far([x, 0, z]);
          if (!best || d < best[0])
            best = [d, x, z, herd[i][1] as number, herd[i][2] as number];
        }
      });
      if (best) scene.debug.stand(best[1], best[2], best[3], best[4]);
      return;
    }
    const nearest = scene.debug
      .birds()
      .filter((bird) => bird.species === KINDS[index])
      .sort((first, second) => far(first.at) - far(second.at))[0];
    if (!nearest) return;
    const [x, y, z] = nearest.at;
    const away = far(nearest.at) || 1;
    scene.debug.stand(
      x + ((fromX - x) / away) * OFF[index],
      z + ((fromZ - z) / away) * OFF[index],
      x,
      z,
    );
    // (looked at where it is: a raven may be up on its snag)
    const [eyeX, eyeY, eyeZ] = scene.debug.at();
    scene.debug.look(eyeX, eyeY, eyeZ, x, y + 0.2, z);
  });
  row(
    'Quality (reloads)',
    LEVELS,
    (index) => {
      try {
        localStorage.setItem('forestLevel', LEVELS[index]);
      } catch {
        return; // storage is blocked: the level cannot be kept, so a reload would change nothing
      }
      location.reload();
    },
    MEDIUM ? 1 : 0,
  );
  row('Show', ['stats line'], toggleStats, 1);
  const level = document.createElement('p');
  level.className = 'note';
  level.textContent = `Running ${MEDIUM ? 'Medium' : 'Low'} (${WHY})`;
  panel.append(level);
  row(
    'Exposure',
    ['highlights', 'old'],
    (index) => {
      scene.debug.exposure(index ? 1 : 0);
    },
    scene.debug.exposure(),
  );
  // (animals and sound get their rows here when those phases land)

  open.addEventListener('click', () => {
    root.classList.toggle('is-open');
    open.blur();
  });
  document.body.append(root);

  return {
    show(on) {
      root.style.display = on ? '' : 'none';
    },
  };
}
