// The loading screen's painting, revealed in steps over the load: from the start its sky and its land as flat
// silhouettes, then the land's flat colours, the painting itself, and a warm light in the mist. Every picture of the
// loader, the logo's too, is a cell of one sprite sheet (public/assets/loader/loader.webp; its cells are cut out in
// index.html), so they all arrive together. Each step is one long Web Animation of opacity on one full-screen layer
// (#art's), all made when the load begins (begin(), main.ts) and timed as shares of how long the last load took
// here, so the finished painting stands for the last quarter; made at once while the thread is still free, they run
// on the compositor through the build with nothing more asked of it. Once a layer is in, the one under it is hidden.

export const SHEET = '/assets/loader/loader.webp';

// the pictures over the silhouettes: the share of the load where each begins to come in, and where it is in
const STEPS: [string, number, number][] = [
  ['colour', 0.03, 0.24],
  ['detail', 0.25, 0.5],
  ['light', 0.5, 0.75],
];
const LENGTH_KEY = 'forestLoadMs'; // how long the last load took here, from its beginning to the forest shown
const FIRST_MS = 7000; // a first visit's guess at its load's length
const LENGTH_MS = [3000, 15000]; // what a kept length is held within (a load paused off screen must not count)

export interface Reveal {
  /** The load begins: every step is timed now, from how long the last load took. */
  begin(): void;
  /** The load reaches its last stage: a step not yet begun begins now, so all are seen. */
  last(): void;
  /** The forest is shown: this load's length is kept for the next. */
  done(): void;
  /** Shows every step up to `upTo` (0 to 1) at once (the dev build's held loader). */
  show(upTo: number): void;
}

interface Step {
  layer: HTMLElement;
  from: number;
  to: number;
  covers: HTMLElement | null; // (hidden once this is in; the light covers nothing)
}

// The sheet, asked for and decoded at once (the page's layers and logo show from it as soon as it is); settles when
// it is ready, or failed
export function decodeSheet(): Promise<void> {
  const sheet = new Image();
  sheet.src = SHEET;
  return sheet.decode().catch(() => {});
}

export function attachReveal(art: HTMLElement): Reveal {
  const layer = (kind: string): HTMLElement => art.querySelector(`.${kind}`)!;
  let below = layer('shapes');
  const steps: Step[] = STEPS.map(([kind, from, to]) => {
    const step = {
      layer: layer(kind),
      from,
      to,
      covers: kind === 'light' ? null : below,
    };
    below = step.layer;
    return step;
  });
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fades: Animation[] = [];
  let began = 0;
  return {
    begin() {
      if (began) return;
      began = performance.now();
      let length = FIRST_MS;
      try {
        length = Number(localStorage.getItem(LENGTH_KEY)) || FIRST_MS;
      } catch {
        // storage is blocked: the first visit's guess
      }
      length = Math.min(Math.max(length, LENGTH_MS[0]), LENGTH_MS[1]);
      for (const { layer: element, from, to, covers } of steps) {
        // (reduced motion: the step simply switches on where it would have been in)
        const fade = element.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: still ? 1 : (to - from) * length,
          delay: (still ? to : from) * length,
          fill: 'both',
          easing: 'ease-in-out',
        });
        fades.push(fade);
        if (covers)
          fade.finished
            .then(() => (covers.style.visibility = 'hidden'))
            .catch(() => {});
      }
    },
    last() {
      // (one not begun yet begins now: its wait ends at the time it has reached)
      for (const fade of fades)
        if (fade.playState !== 'finished')
          fade.effect?.updateTiming({
            delay: Math.min(
              Number(fade.currentTime) || 0,
              Number(fade.effect.getTiming().delay) || 0,
            ),
          });
    },
    done() {
      if (!began) return;
      try {
        localStorage.setItem(
          LENGTH_KEY,
          `${Math.round(performance.now() - began)}`,
        );
      } catch {
        // storage is blocked: the next load guesses
      }
    },
    show(upTo) {
      for (const { layer: element, to, covers } of steps)
        if (to <= upTo) {
          element.style.opacity = '1';
          if (covers) covers.style.visibility = 'hidden';
        }
    },
  };
}
