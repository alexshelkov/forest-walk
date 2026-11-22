// Types for scene.js, the WebGPU renderer kept in the plain JavaScript of the project it grew from. Its modules are
// built for the level (Low or Medium) quality.js sets as they load: import it only after chooseLevel (main.ts).

/**
 * What the frame loop reads. Touch: walk while held, look deltas in CSS pixels (consumed each frame). A keyboard
 * (keys.ts, a dev machine only): forward, sideways and turning from -1 to 1, and twice the pace.
 */
export interface SceneInput {
  walk: boolean;
  lookX: number;
  lookY: number;
  forward: number;
  strafe: number;
  turn: number;
  fast: boolean;
}

export interface SceneEnv {
  canvas: HTMLCanvasElement;
  input: SceneInput;
  /** Lines for the problem screen. The scene adds what it learns: the level and why, GPU, canvas size. */
  facts: Record<string, string>;
  /** One loading stage: show the message, glide the bar to `to` (0-1) over about `ms`. A rejection ends the build. */
  say(message: string, to: number, ms: number): Promise<void>;
  /** Something went wrong and the scene has stopped; `error` carries the stack when there is one. */
  problem(message: string, error?: unknown): void;
  /** A dev machine (main.ts): the render size is neither taken from the last visit nor kept for the next. */
  dev?: boolean;
}

export interface Scene {
  pause(): void;
  resume(): void;
  /** Call on a user gesture: starts the sound once the loop runs. */
  wake(): void;
  /** One line of numbers since the last call: frame rate, worst frame, render size, draw distance, level. */
  stats(): string;
  /** Where the walker stands: x and z, in metres. */
  walker(): number[];
  /** For looking around from a debugger: jump to a viewpoint (0-5) or to any place and target, hold a state of the weather. */
  debug: {
    view(index: number): void;
    look(
      x: number,
      y: number,
      z: number,
      targetX: number,
      targetY: number,
      targetZ: number,
    ): void;
    /** Stand on the ground at (x, z), facing (targetX, targetZ). */
    stand(x: number, z: number, targetX: number, targetZ: number): void;
    /** Stand on point `index` of the trail, facing the point `ahead` further on. */
    trail(index: number, ahead: number): void;
    /** The bush, young tree, bough, maple crown, big trunk, log, stump or fence post nearest a place: x, y, z, size. */
    near(
      kind:
        | 'bush'
        | 'young'
        | 'bough'
        | 'maple'
        | 'trunk'
        | 'log'
        | 'stump'
        | 'fence'
        | 'sign'
        | 'fall',
      x: number,
      z: number,
    ): number[] | null;
    /** The points of the trail (for `trail`) where a bridge crosses running water. */
    bridges(): number[];
    /**
     * Every crossing of running water, on the loop and the side paths: its make (0 planks on posts, 1 planks, 2
     * logs side by side, 3 a split log with a rail, 4 stepping stones), the water's half width, and where the
     * way across begins and ends (x, z each); for 2 to 4 also the line walked along (x, z each) and how far the
     * timber reaches to each side of it (0 for stones).
     */
    crossings(): number[][];
    /** The dock: where the walk onto it begins, on the boardwalk, and where its planks end (x, z each). */
    pier(): number[];
    /**
     * Every bird: its species ('junco', 'chickadee', 'thrush', 'jay', 'raven'), where it is (x, y, z), the bearing it faces
     * (radians), what it is doing ('still', 'hop', 'peck', 'crouch', 'settle', 'flying', 'perched', 'branch hop'),
     * where it is flying to, and, once it has been flushed, its place in that flush and how far off the walker was.
     */
    birds(): {
      species: string;
      /** the middle of where it lives (x, z) */
      home: number[];
      at: number[];
      facing: number;
      state: string;
      to: number[] | null;
      /** seconds of its flight left */
      eta: number;
      /** is it inside the frame (trunks in front of it not counted)? */
      inFrame: boolean;
      /** where it falls in the frame, 0 to 1 across and down; null behind the eye */
      screen: number[] | null;
      /** is this flight one across the path ahead of the walker? */
      crossing: boolean;
      /** is this flight a raven's over the open sky? */
      over: boolean;
      left: number[] | null;
    }[];
    /** The last frame's triangles of the birds, the sticks under them included. */
    birdTris(): number;
    /** How many jays there are; given a count, the world's jays are placed afresh, that many. */
    jays(count?: number): number;
    /**
     * A jay flies across the path ahead of the walker now and lands in view on the other side: which bird and how
     * (from its perch, or brought in from out of sight), or -1 and why not (open ground or water).
     */
    birdCross(): [number, string];
    /** How many ravens there are (a pair at most, by their snags at the meadow and the lake); given a count, set. */
    ravens(count?: number): number;
    /** A raven (or the pair) goes over the sky ahead of the walker now: which bird and how, or -1 and why not. */
    ravenFlyover(): [number, string];
    /** Are the birds on? Sets it if given: off, none moves or is drawn. */
    birdsOn(on?: boolean): boolean;
    /** Do the birds mind the walker? Sets it if given: off, a still can be taken from close by. */
    birdsHeed(on?: boolean): boolean;
    /** How many branches there are for a bird to sit on. */
    perches(): number;
    /**
     * Holds bird `index` in a pose for a still, on the ground at (x, z) facing `bearing` (radians) if given: 'stand',
     * 'peck' (`part` of the way down), 'hop' (`part` of the way through it), 'wing' (a metre up, a raven two, `part`
     * of the way through a wingbeat, a raven's tail fanned), 'post' or 'branch' (on the post's top or the branch
     * nearest the place, the crest raised by `part`; 'stand' takes the crest from `part` too). Without a pose it is
     * let go.
     */
    bird(
      index: number,
      pose?:
        | 'stand'
        | 'peck'
        | 'hop'
        | 'wing'
        | 'post'
        | 'branch'
        | 'cock'
        | 'pick'
        | 'ruffle',
      part?: number,
      x?: number,
      z?: number,
      bearing?: number,
    ): void;
    /**
     * Bird `index` does it now: 'hop' a run of hops (on the ground, or along its branch), 'peck', 'fly' (a tree
     * bird to another branch), 'flush' (its flock leaves the ground, it first), 'return' (the perched ones of its
     * flock come down as soon as they may), 'walk' (a raven on the ground: a few strides on the way it faces).
     */
    birdDo(
      index: number,
      what:
        | 'hop'
        | 'peck'
        | 'fly'
        | 'pick'
        | 'ruffle'
        | 'turn'
        | 'flush'
        | 'return'
        | 'walk',
    ): void;
    /**
     * The exposure: 0 the old rule (by how much sky reaches the walker) stopped down for bright highlights in view,
     * 1 the old rule alone. Returns the mode now.
     */
    exposure(mode?: 0 | 1): number;
    /**
     * What the eye has adapted to and what it makes of it: the frame's highlights (the power mean of its luminance
     * with exponent 4, before exposure, eased); the exposure in use; the old rule's; the highlights' key H.
     */
    exposureNow(): Promise<number[]>;
    /**
     * Shows one tree alone on black (its cards, trunk and far picture: all rooted within `reach`, 3 m by default,
     * of x, z): white, or `shaded` as it is (fogged, no light shafts, the opening view's exposure); `part` near:
     * without its far picture, far: the far picture alone. Without arguments everything again. Returns the nearest
     * far picture: its kind (atlas.js farTree: 0-1 fir, 2 hemlock, 3 cedar, 4 pole, 5-7 broadleaves), the foot of
     * its crown (x, y, z) and its height.
     */
    isolate(
      x?: number,
      z?: number,
      reach?: number,
      shaded?: boolean,
      part?: 'near' | 'far',
    ): number[] | null;
    /**
     * The sub-cards that turn out of a card near the walker (W_LEAF vsN): 0 as normal, 1 none drawn, 2 drawn but
     * held flat on their cards, as at the edge of the near range. Returns the mode now.
     */
    sprigs(mode?: 0 | 1 | 2): number;
    // ---------------------------------------------------------------- deer (deer.js)
    /** How many deer live in the world (0 to 3); returns it. */
    deerCount(n?: number): number;
    /** The stretches where a deer may cross the path: path, first and last point, its middle (x, z). */
    deerStretches(): number[][];
    /**
     * A crossing at stretch i: the walker stood on the path 10 m before its place, looking level at it, and the
     * deer fired `delay` seconds on (0: at once) whatever the weather. Returns where the walker stands, the place
     * and the side the deer comes from.
     */
    deerCross(
      stretch: number,
      delay?: number,
      side?: 1 | -1,
    ): { stand: number[]; at: number[]; side: number };
    /** Seconds until the crossing asked for fires (-1: none). */
    deerIn(): number;
    /** Every way across a crossing may take: [stretch, side]. */
    deerRoutes(): number[][];
    /** A still: deer i held in a pose (stand, graze, alert, walk) at x, z facing yaw; no pose lets it go again. */
    deerHold(
      i: number,
      pose?: 'stand' | 'graze' | 'alert' | 'walk',
      x?: number,
      z?: number,
      yaw?: number,
    ): number[] | null;
    /** The deer's triangles in the last frame. */
    deerTris(): number;
    /** What decides where deer live and cross, at x, z: crowns' cover, metres to water, to anything built, to an opening; the path's half width; how many homes. */
    deerProbe(x: number, z: number): number[];
    /** What each deer is doing: state, x, z, neck pitch, shown (the three at rest, then the two that cross); hoof heights, leg bends, pitch, feet down. */
    deerState(): (string | number | number[])[][];
    /** Sets deer i about something now (graze, look, alert, moveoff: away from the walker). */
    deerDo(i: number, what: string): string;
    /** How many crossings a walk of `seconds` along the side paths would set off (none run), and how many times the odds were rolled. */
    deerWalkTest(seconds: number, odds?: number): number[];
    /** The homes of the deer at rest: x, z, yaw, metres to the nearest path, the path point it is seen nearest from (x, z), how far that is, 1 at the meadow's edge, every path point it is seen from; and the ms the search took. */
    deerHomes(): { ms: number; homes: (number | number[][])[][] };
    // ---------------------------------------------------------------- (deer end)
    // ---------------------------------------------------------------- sound (audio.js)
    /** All the sound on or off (it fades); returns whether it is on. */
    soundMaster(on?: boolean): boolean;
    /** A type of sound on or off (steps, rain, drips, wind, thunder, brook, creek, falls, lake, jays, ravens); returns whether it is on. */
    soundOn(type: string, on?: boolean): boolean;
    /** A type's level offset in dB (-30 to 12); returns it. */
    soundLevel(type: string, dB?: number): number;
    /** Each type: its name, on, level offset in dB, and its gain node's value now (null before the first touch). */
    soundLevels(): [string, boolean, number, number | null][];
    /** Four steps on a surface now (gravel, dirt, leaves, grass, moss, planks, boardwalk, log, stone, water), wet 0 or 1. */
    soundStepOn(surface: string, wet?: number): number;
    /** The context's state, steps and bird calls played, the timer's ticks and their mean and longest ms, the bank's MB, the idle slices with their total and longest ms and the seconds from the first slice to the bank done, the ms the load's bake took. */
    soundState(): (string | number)[];
    /** What is underfoot where the walker stands. */
    soundHere(): string;
    /**
     * Renders `secs` of the mix offline (mono, 22050 a second, 16-bit values): frame state slots set from `state`
     * (slot: value), a walk at v m/s on `surface`, the crowns' cover and the lake's nearness; `solo` the types heard
     * (a comma list; none: all).
     */
    soundRender(
      secs: number,
      state: Record<number, number>,
      v: number,
      surface: string,
      canopy?: number,
      lake?: number,
      solo?: string,
      flashes?: number[][],
      water?: { streams?: number[]; shore?: number[] },
      birds?: { species: string; at: number[]; state: string }[],
    ): Promise<number[]>;
    /** A bird's call now, d m off, straight ahead (jay or raven). */
    soundCall(species: string, d: number): number;
    /** The limiter's gain reduction in dB (0 while it is idle): now, and the deepest in the last soundRender. */
    soundReduction(): number[];
    /** The water round the walker: each emitter's name, metres off, level and pan. */
    soundWater(): (string | number)[][];
    /** Thunder now, km off, straight ahead. */
    soundThunder(km: number): number;
    // ---------------------------------------------------------------- (sound end)
    /**
     * Holds the render size at about n pixels (the frame-time tuner left off), or lets the tuner go again (0).
     * Returns the size now.
     */
    pixels(n: number): number;
    /** The last frame's triangles for each leaf tier, in thousands. */
    tiers(): number[];
    /**
     * The leaves' distances in the fog of the moment, in metres: a tree's cards whole to tree[0], thinned by rank
     * to tree[1], ending between tree[2] and tree[3]; a shrub's the same, ending by shrub[2]; a far tree's picture
     * blended in from far[0] to far[1] (as the trees' cards are thinned) and drawn to farEnd, farN of them in the
     * last frame; a tree's cards are drawn to treeEnd. whole: for the trees and the shrubs, what the fog lets through at the
     * nearest distance where any card is not whole (W_LEAF thin, mirrored over every rank). cuts: where the leaf
     * tiers change sets.
     */
    lod(): {
      tree: number[];
      shrub: number[];
      far: number[];
      /** Where the fog closes: from, to (metres; far off when it does not). */
      close: number[];
      /**
       * What the closed fog lets through where a tree's cards start and stop thinning, where they and where the far
       * pictures stop being drawn.
       */
      closed: number[];
      treeEnd: number;
      farEnd: number;
      farN: number;
      whole: number[];
      cuts: Record<string, number>;
    };
    /** Hold a state of the weather, at once (for stills) unless eased; 'auto' returns to the drift from its start. */
    weather(
      name: 'clear' | 'fog' | 'rain' | 'storm' | 'auto',
      eased?: boolean,
    ): void;
    /**
     * Fire one lightning flash now; of a kind (0 patch, 1 sheet, 2 bolt) and at a bearing and height (radians)
     * if given. With `at` it is held that many seconds into itself until the weather is set again, grown from
     * `seed` (0 to 1; the same seed gives the same bolt). A bolt without a place goes where one can be seen, or
     * is a patch instead. Returns the kind it became (-1: too soon after the last, none fired).
     */
    flash(
      kind?: number,
      bearing?: number,
      height?: number,
      at?: number,
      seed?: number,
    ): number;
    /** The last flash: the scene time it struck at in seconds, its distance in metres (for the thunder). */
    lastFlash(): number[];
    /**
     * Since the weather was last set: flashes fired, how many drew a bolt, and the sum of the shares of those
     * bolts that were on screen with open sky behind them.
     */
    flashes(): number[];
    /**
     * The culling's check. With `on`: switches it on or off. Without: for the frame drawn last, the cells
     * checked (holding something, within 40 m, in the frame) and how many of them were left undrawn.
     */
    audit(on?: boolean): number[];
    /** Every path as its points (x, z), about a metre apart: the loop first, then the side paths. */
    paths(): number[][][];
    /** The last bolt of lightning: its segments, triangles and branches. */
    bolt(): number[];
    /**
     * Where a bolt would show: the frame's upper half as rows of ways, top row first: 2 open sky, 1 between thin
     * crowns, 0 hidden. With `veils`: how much crown lies along each way instead, in 30ths (9: 270 or more;
     * sky shows up to 120).
     */
    openSky(veils?: boolean): string[];
    /** Shows or hides the debug menu of a dev machine (main.ts sets it; a no-op elsewhere). */
    menu(on: boolean): void;
    /**
     * The scene's clock (set if given, and held there if `hold`: for stills an exact time apart), how far the
     * wind has blown things so far, the wind now.
     */
    clock(seconds?: number, hold?: boolean): number[];
    /** Where the walker is: x, y, z. */
    at(): number[];
    /** The foliage atlas: milliseconds its bake took, megabytes it holds. */
    atlas(): number[];
    /** A layer (0-2) of the foliage atlas as a PNG data URL: its colours, or its outlines. */
    atlasShot(layer: number, alpha?: boolean): Promise<string>;
    /** The height the walker would stand on at (x, z): the ground, or a deck over it. */
    ground(x: number, z: number): number;
    creatures: {
      data: Float32Array;
      groups: { first: number; count: number }[];
    };
  };
}

/** Builds the world (several seconds) and resolves once the first frame is drawn, paused. Rejects with
 * `cause: 1` on a message meant for the user as is. */
export function boot(env: SceneEnv): Promise<Scene>;
