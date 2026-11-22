// Types for quality.js: what the TypeScript side uses of it (the scene's own modules are plain JavaScript)

/** A dev machine: the tik served by `codetik dev` on this computer (`forest` in the console, keyboard walking). */
export const DEV: boolean;
/** Picks the tier, High, Medium or Low (quality.js tells how), and sets what goes with it; before the scene loads. */
export function chooseLevel(): Promise<void>;
/** The start guard (quality.js tells how): runs once, first of all, before the loader's painting shows (a new
 * version starts full); gives the step. */
export function guard(version: number): number;
/** What each step turns off (0: full). */
export const STEPS: string[];
/** The step this start is on (set by guard). */
export let STEP: number;
/** Clears the step: the next start is full. */
export function fullStart(): void;
/** Did the last load here fail (set by guard)? */
export let LAST_FAILED: boolean;
/** The tier running, by name (set by chooseLevel). */
export let TIER: string;
/** The tier running is High; is Low (set by chooseLevel). */
export let HIGH: boolean;
export let LOW: boolean;
/** The tiers a pick may name, lowest first. */
export const TIERS: string[];
/** Keeps the Try knob's tier ('' none) for the next start. */
export function tryTier(tier: string): void;
/** How the tier was chosen: the Try knob, a dev machine's pick, a demotion and its cause, a promotion, or the signals. */
export let WHY: string;
