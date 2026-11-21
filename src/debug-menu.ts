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
  // the nearest of a kind, looked at from far enough off not to put it up
  const KINDS = ['jay'];
  row('Nearest', KINDS, (index) => {
    const [fromX, , fromZ] = scene.debug.at();
    const far = (at: number[]): number =>
      Math.hypot(at[0] - fromX, at[2] - fromZ);
    const nearest = scene.debug
      .birds()
      .filter((bird) => bird.species === KINDS[index])
      .sort((first, second) => far(first.at) - far(second.at))[0];
    if (!nearest) return;
    const [x, , z] = nearest.at;
    const away = far(nearest.at) || 1;
    scene.debug.stand(
      x + ((fromX - x) / away) * 7,
      z + ((fromZ - z) / away) * 7,
      x,
      z,
    );
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
