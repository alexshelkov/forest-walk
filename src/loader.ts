// The loading screen's painting, revealed in steps with the progress bar: from the start its sky and its land as flat
// silhouettes, then the land's flat colours, the painting itself, and a warm light in the mist. Every picture of the
// loader, the logo's too, is a cell of one sprite sheet (public/assets/loader/loader.webp; its cells are cut out in
// index.html), so they all arrive together. Each step is one Web Animation of opacity on one full-screen layer
// (#art's), made as the bar sets out for that step's share (reach, from main.ts say at each stage's start) and as
// long as the bar's glide there: made while the thread is still free, it runs on the compositor through the build, as
// the bar does. Once a layer is in, the one under it is hidden.

export const SHEET = '/assets/loader/loader.webp';

// the pictures over the silhouettes, and the bar's share each comes in with: the stages that take the bar there
// (scene.js: Raising the hills, Growing the forest, Building bridges), so the whole painting stands through the last
const STEPS: [string, number][] = [
  ['colour', 0.25],
  ['detail', 0.73],
  ['light', 0.94],
];
const MIN_FADE_MS = 1200; // a fade lasts as long as the bar's glide, at least this

export interface Reveal {
  /** The bar sets out for `to` (0 to 1) over `ms`: each step whose share it reaches comes in now, over as long (a
   * skipped stage's step at once with the next; at the end, all). */
  reach(to: number, ms: number): void;
  /** Shows every step up to `upTo` (0 to 1) at once (the dev build's held loader). */
  show(upTo: number): void;
}

interface Step {
  layer: HTMLElement;
  share: number;
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
  const steps: Step[] = STEPS.map(([kind, share]) => {
    const step = {
      layer: layer(kind),
      share,
      covers: kind === 'light' ? null : below,
    };
    below = step.layer;
    return step;
  });
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let next = 0; // the first step not yet begun
  return {
    reach(to, ms) {
      for (
        ;
        next < steps.length && (steps[next].share <= to || to >= 1);
        next++
      ) {
        const { layer: element, covers } = steps[next];
        // (reduced motion: the step simply switches on)
        const fade = element.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: still ? 1 : Math.max(ms, MIN_FADE_MS),
          fill: 'both',
          easing: 'ease-in-out',
        });
        if (covers)
          fade.finished
            .then(() => (covers.style.visibility = 'hidden'))
            .catch(() => {});
      }
    },
    show(upTo) {
      for (const { layer: element, share, covers } of steps)
        if (share <= upTo) {
          element.style.opacity = '1';
          if (covers) covers.style.visibility = 'hidden';
        }
    },
  };
}
