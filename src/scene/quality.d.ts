// Types for quality.js: what the TypeScript side uses of it (the scene's own modules are plain JavaScript)

/** A dev machine: the tik served by `codetik dev` on this computer (the debug menu, keyboard walking). */
export const DEV: boolean;
/** Picks Low or Medium (quality.js tells how) and sets what goes with it; before the scene is loaded. */
export function chooseLevel(): Promise<void>;
/** The level running: Medium, else Low (set by chooseLevel). */
export let MEDIUM: boolean;
/** How the level was chosen: the debug menu, a demotion and its cause, or the signals with their values. */
export let WHY: string;
