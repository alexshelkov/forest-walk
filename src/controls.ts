// Touch controls: the corner button walks while held, a drag anywhere else turns the view.
// Each gets its own finger, so one thumb can walk while the other steers.
import type { SceneInput } from './scene/scene.js';

// A hidden tuning gesture: SECRET_TAPS taps within SECRET_MS in the top right SECRET_PX square.
const SECRET_TAPS = 4;
const SECRET_MS = 1500;
const SECRET_PX = 72;

// Keeps a finger's moves and lift on the element it went down on. A pointer that has already ended
// (lifted before the handler ran) cannot be captured, and its lift has come or will come anyway.
function capture(element: HTMLElement, pointerId: number): void {
  try {
    element.setPointerCapture(pointerId);
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'NotFoundError')) {
      throw error;
    }
  }
}

export interface Controls {
  /** Drops every finger and stops walking (on hide, so a later lift cannot restart anything). */
  release(): void;
}

export function attachControls(
  stage: HTMLElement,
  walkButton: HTMLElement,
  input: SceneInput,
  onTouch: () => void,
  onSecret: () => void,
): Controls {
  let lookPointer: number | null = null;
  let walkPointer: number | null = null;
  let lastX = 0;
  let lastY = 0;
  let cornerTaps: number[] = [];

  const countCornerTap = (event: PointerEvent): void => {
    const inCorner =
      event.clientX > innerWidth - SECRET_PX && event.clientY < SECRET_PX;
    if (!inCorner) {
      cornerTaps = [];
      return;
    }
    cornerTaps = [
      ...cornerTaps.filter((at) => event.timeStamp - at < SECRET_MS),
      event.timeStamp,
    ];
    if (cornerTaps.length < SECRET_TAPS) return;
    cornerTaps = [];
    onSecret();
  };

  stage.addEventListener('pointerdown', (event) => {
    onTouch();
    countCornerTap(event);
    if (lookPointer !== null) return;
    lookPointer = event.pointerId;
    lastX = event.clientX;
    lastY = event.clientY;
    capture(stage, event.pointerId);
  });
  stage.addEventListener('pointermove', (event) => {
    if (event.pointerId !== lookPointer) return;
    input.lookX += event.clientX - lastX;
    input.lookY += event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
  });
  const endLook = (event: PointerEvent): void => {
    if (event.pointerId === lookPointer) lookPointer = null;
  };
  stage.addEventListener('pointerup', endLook);
  stage.addEventListener('pointercancel', endLook);
  stage.addEventListener('lostpointercapture', endLook);

  const setWalk = (on: boolean): void => {
    input.walk = on;
    walkButton.classList.toggle('on', on);
  };
  walkButton.addEventListener('pointerdown', (event) => {
    onTouch();
    if (walkPointer !== null) return;
    walkPointer = event.pointerId;
    setWalk(true);
    capture(walkButton, event.pointerId);
  });
  const endWalk = (event: PointerEvent): void => {
    if (event.pointerId !== walkPointer) return;
    walkPointer = null;
    setWalk(false);
  };
  walkButton.addEventListener('pointerup', endWalk);
  walkButton.addEventListener('pointercancel', endWalk);
  walkButton.addEventListener('lostpointercapture', endWalk);
  // a long press must not open the text or image menu
  walkButton.addEventListener('contextmenu', (event) => event.preventDefault());

  return {
    release() {
      lookPointer = null;
      walkPointer = null;
      input.lookX = 0;
      input.lookY = 0;
      setWalk(false);
    },
  };
}
