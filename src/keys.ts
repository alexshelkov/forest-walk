// Keyboard walking for a dev machine (main.ts attaches it only there): W A S D or the arrows walk and step
// sideways, Q and E turn, Shift doubles the pace. It feeds the same input the walk button does.
import type { SceneInput } from './scene/scene.js';

type Axis = 'forward' | 'strafe' | 'turn';

// event.code, so the keys keep their places on any keyboard layout
const AXES: Record<string, [Axis, number]> = {
  KeyW: ['forward', 1],
  ArrowUp: ['forward', 1],
  KeyS: ['forward', -1],
  ArrowDown: ['forward', -1],
  KeyD: ['strafe', 1],
  ArrowRight: ['strafe', 1],
  KeyA: ['strafe', -1],
  ArrowLeft: ['strafe', -1],
  KeyE: ['turn', 1],
  KeyQ: ['turn', -1],
};
const SHIFTS = ['ShiftLeft', 'ShiftRight'];
// where a key belongs to what has the focus: a text field, or the debug menu's own buttons
const BUSY = 'input, textarea, select, [contenteditable], [data-debug-menu]';

export interface Keys {
  /** Lets go of every key (on blur and on hide, so a key cannot stick). */
  release(): void;
}

export function attachKeys(input: SceneInput, onWalk: () => void): Keys {
  const held = new Set<string>();

  // the input is worked out afresh from the held keys, so two keys for one way never add up or get stuck
  const apply = (): void => {
    const sum: Record<Axis, number> = { forward: 0, strafe: 0, turn: 0 };
    for (const code of held) {
      const axis = AXES[code];
      if (axis) sum[axis[0]] += axis[1];
    }
    input.forward = Math.sign(sum.forward);
    input.strafe = Math.sign(sum.strafe);
    input.turn = Math.sign(sum.turn);
    input.fast = SHIFTS.some((code) => held.has(code));
    if (input.forward || input.strafe) onWalk();
  };
  const release = (): void => {
    held.clear();
    apply();
  };

  addEventListener('keydown', (event) => {
    if (!(event.code in AXES) && !SHIFTS.includes(event.code)) return;
    // a browser shortcut (reload, back) is not a walk
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target instanceof Element && event.target.closest(BUSY)) return;
    if (event.code in AXES) event.preventDefault(); // the arrows would scroll
    held.add(event.code);
    apply();
  });
  addEventListener('keyup', (event) => {
    if (held.delete(event.code)) apply();
  });
  addEventListener('blur', release);

  return { release };
}
