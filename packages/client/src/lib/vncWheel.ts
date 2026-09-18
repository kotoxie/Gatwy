/** noVNC only emits one VNC wheel notch per event, and only after 50px of delta. */
export const NOVNC_WHEEL_STEP = 50;

/** Finger pixels → wheel pixels. ~6 notches per 50px of two-finger travel. */
export const FINGER_TO_WHEEL = 6;

export type WheelAcc = { x: number; y: number };

export function createWheelAcc(): WheelAcc {
  return { x: 0, y: 0 };
}

function fireWheel(canvas: HTMLCanvasElement, clientX: number, clientY: number, deltaX: number, deltaY: number): void {
  canvas.dispatchEvent(new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX,
    clientY,
    deltaX,
    deltaY,
    deltaMode: 0,
  }));
}

/** Convert a two-finger pixel delta into as many noVNC wheel notches as it is worth. */
export function feedWheel(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
  fingerDx: number,
  fingerDy: number,
  acc: WheelAcc,
): void {
  // Finger down (positive dy) → page down (negative wheel).
  acc.x += -fingerDx * FINGER_TO_WHEEL;
  acc.y += -fingerDy * FINGER_TO_WHEEL;
  while (Math.abs(acc.y) >= NOVNC_WHEEL_STEP) {
    const s = Math.sign(acc.y);
    fireWheel(canvas, clientX, clientY, 0, s * NOVNC_WHEEL_STEP);
    acc.y -= s * NOVNC_WHEEL_STEP;
  }
  while (Math.abs(acc.x) >= NOVNC_WHEEL_STEP) {
    const s = Math.sign(acc.x);
    fireWheel(canvas, clientX, clientY, s * NOVNC_WHEEL_STEP, 0);
    acc.x -= s * NOVNC_WHEEL_STEP;
  }
}
