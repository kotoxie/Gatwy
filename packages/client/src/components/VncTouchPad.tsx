import { useEffect, useRef, type RefObject } from 'react';
import { createWheelAcc, feedWheel } from '../lib/vncWheel';

interface VncTouchPadProps {
  /** noVNC host div that contains the canvas */
  hostRef: RefObject<HTMLDivElement | null>;
  enabled: boolean;
}

const TAP_MS = 280;
const TWO_FINGER_TAP_MS = 400;
const HOLD_MS = 350;
const TAP_AND_A_HALF_MS = 500;
const MOVE_SLOP = 12;
const SCROLL_SLOP = 14;
const SENSITIVITY = 1.15;

function canvasOf(host: HTMLDivElement | null): HTMLCanvasElement | null {
  return host?.querySelector('canvas') ?? null;
}

function fireMouse(
  canvas: HTMLCanvasElement,
  type: 'mousemove' | 'mousedown' | 'mouseup',
  clientX: number,
  clientY: number,
  buttons: number,
  button = 0,
): void {
  canvas.dispatchEvent(new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX,
    clientY,
    buttons,
    button,
    detail: type === 'mouseup' || type === 'mousedown' ? 1 : 0,
  }));
}

function clientOf(canvas: HTMLCanvasElement, x: number, y: number): { x: number; y: number } {
  const r = canvas.getBoundingClientRect();
  return { x: r.left + x, y: r.top + y };
}

/**
 * Moonlight-style trackpad overlay (no extra cursor — the remote pointer is the cursor).
 * One-finger drag moves. Tap = left click. Long-press then drag, or tap then drag,
 * holds left button to move windows. Two-finger tap = right-click at the current
 * cursor (Moonlight: do not move the pointer). Two-finger drag scrolls.
 */
export function VncTouchPad({ hostRef, enabled }: VncTouchPadProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const pos = useRef({ x: 0, y: 0 });
  const gesture = useRef({
    fingers: 0,
    startTime: 0,
    moved: false,
    dragging: false,
    lastX: 0,
    lastY: 0,
    lastMidX: 0,
    lastMidY: 0,
    startFingerX: 0,
    startFingerY: 0,
    lastTapAt: 0,
    twoFingerMoved: false,
    twoFingerStartAt: 0,
    twoFingerTravel: 0,
    /** Once two fingers are down, do not move the cursor until all fingers lift. */
    lockPointer: false,
  });
  const wheelAcc = useRef(createWheelAcc());

  useEffect(() => {
    if (!enabled) return;
    const overlay = overlayRef.current;
    if (!overlay) return;

    const canvasNow = () => canvasOf(hostRef.current);
    let holdTimer: ReturnType<typeof setTimeout> | null = null;

    const clearHold = () => {
      if (holdTimer !== null) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
    };

    const clamp = (canvas: HTMLCanvasElement, x: number, y: number) => {
      const r = canvas.getBoundingClientRect();
      return {
        x: Math.max(0, Math.min(Math.max(1, r.width - 1), x)),
        y: Math.max(0, Math.min(Math.max(1, r.height - 1), y)),
      };
    };

    const releaseCapture = (clientX: number, clientY: number, button = 0) => {
      // noVNC setCapture() only drops the overlay on a window mouseup.
      // Do not remove #noVNC_mouse_capture_elem — that hid the remote cursor.
      window.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX,
        clientY,
        buttons: 0,
        button,
      }));
    };

    const sendMove = (canvas: HTMLCanvasElement, buttons: number) => {
      const c = clientOf(canvas, pos.current.x, pos.current.y);
      fireMouse(canvas, 'mousemove', c.x, c.y, buttons, 0);
    };

    const mouseDown = (canvas: HTMLCanvasElement) => {
      const g = gesture.current;
      if (g.dragging) return;
      const c = clientOf(canvas, pos.current.x, pos.current.y);
      fireMouse(canvas, 'mousemove', c.x, c.y, 0);
      fireMouse(canvas, 'mousedown', c.x, c.y, 1, 0);
      g.dragging = true;
    };

    const mouseUp = (canvas: HTMLCanvasElement) => {
      const g = gesture.current;
      if (!g.dragging) return;
      const c = clientOf(canvas, pos.current.x, pos.current.y);
      fireMouse(canvas, 'mouseup', c.x, c.y, 0, 0);
      releaseCapture(c.x, c.y, 0);
      g.dragging = false;
    };

    const click = (canvas: HTMLCanvasElement, button: 0 | 2) => {
      const c = clientOf(canvas, pos.current.x, pos.current.y);
      const buttons = button === 0 ? 1 : 2;
      fireMouse(canvas, 'mousemove', c.x, c.y, 0);
      fireMouse(canvas, 'mousedown', c.x, c.y, buttons, button);
      fireMouse(canvas, 'mouseup', c.x, c.y, 0, button);
      releaseCapture(c.x, c.y, button);
    };

    const onStart = (e: TouchEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const t = e.touches;
      const g = gesture.current;
      const canvas = canvasNow();
      clearHold();
      if (t.length >= 2 && g.dragging && canvas) mouseUp(canvas);
      g.fingers = Math.max(g.fingers, t.length);
      if (t.length === 1) {
        g.lastX = t[0].clientX;
        g.lastY = t[0].clientY;
        // Safari often re-fires a 1-finger start mid two-finger scroll. Keep the
        // pointer locked so leftover motion cannot fling the cursor to y=0.
        if (g.lockPointer) return;
        g.startTime = Date.now();
        g.moved = false;
        g.twoFingerMoved = false;
        g.twoFingerTravel = 0;
        g.startFingerX = t[0].clientX;
        g.startFingerY = t[0].clientY;
        const recentTap = g.lastTapAt > 0 && Date.now() - g.lastTapAt <= TAP_AND_A_HALF_MS;
        if (recentTap && canvas) {
          mouseDown(canvas);
        } else {
          holdTimer = setTimeout(() => {
            holdTimer = null;
            const c = canvasNow();
            if (c && !gesture.current.moved && !gesture.current.dragging && gesture.current.fingers === 1 && !gesture.current.lockPointer) {
              mouseDown(c);
            }
          }, HOLD_MS);
        }
      } else if (t.length >= 2) {
        // Moonlight: second finger never moves the cursor. Aim with one finger,
        // then tap a second finger for right-click on that spot.
        const alreadyScrolling = g.lockPointer && g.twoFingerMoved;
        g.lockPointer = true;
        g.twoFingerStartAt = alreadyScrolling ? g.twoFingerStartAt : Date.now();
        if (!alreadyScrolling) {
          g.twoFingerMoved = false;
          g.twoFingerTravel = 0;
        }
        g.lastMidX = (t[0].clientX + t[1].clientX) / 2;
        g.lastMidY = (t[0].clientY + t[1].clientY) / 2;
        g.lastX = g.lastMidX;
        g.lastY = g.lastMidY;
      }
    };

    const onMove = (e: TouchEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const canvas = canvasNow();
      if (!canvas) return;
      const t = e.touches;
      const g = gesture.current;
      if (t.length === 1) {
        const dx = t[0].clientX - g.lastX;
        const dy = t[0].clientY - g.lastY;
        g.lastX = t[0].clientX;
        g.lastY = t[0].clientY;
        // Leftover finger during a two-finger scroll: keep scrolling, never move cursor.
        if (g.lockPointer) {
          if (g.twoFingerMoved) {
            // Cap a leftover-finger sample so a 2→1 handoff cannot dump a huge delta.
            const max = 80;
            const cdx = Math.max(-max, Math.min(max, dx));
            const cdy = Math.max(-max, Math.min(max, dy));
            const c = clientOf(canvas, pos.current.x, pos.current.y);
            feedWheel(canvas, c.x, c.y, cdx, cdy, wheelAcc.current);
          }
          return;
        }
        const dist = Math.hypot(t[0].clientX - g.startFingerX, t[0].clientY - g.startFingerY);
        // Deadzone so planting a second finger does not nudge off a folder.
        if (!g.dragging && dist <= MOVE_SLOP) return;
        if (dist > MOVE_SLOP) {
          g.moved = true;
          if (!g.dragging) clearHold();
        }
        pos.current = clamp(canvas, pos.current.x + dx * SENSITIVITY, pos.current.y + dy * SENSITIVITY);
        sendMove(canvas, g.dragging ? 1 : 0);
      } else if (t.length >= 2) {
        const midX = (t[0].clientX + t[1].clientX) / 2;
        const midY = (t[0].clientY + t[1].clientY) / 2;
        const dx = midX - g.lastMidX;
        const dy = midY - g.lastMidY;
        g.lastMidX = midX;
        g.lastMidY = midY;
        g.twoFingerTravel += Math.hypot(dx, dy);
        if (g.twoFingerTravel > SCROLL_SLOP) g.twoFingerMoved = true;
        if (!g.twoFingerMoved) return;
        const c = clientOf(canvas, pos.current.x, pos.current.y);
        feedWheel(canvas, c.x, c.y, dx, dy, wheelAcc.current);
      }
    };

    const onEnd = (e: TouchEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const canvas = canvasNow();
      const g = gesture.current;
      if (e.touches.length > 0) {
        // Moonlight: 2 → 1 without a scroll is a right-click at the current
        // cursor. Mark the remaining finger so it does not left-click or jump.
        if (g.fingers >= 2 && e.touches.length === 1) {
          g.lockPointer = true;
          g.moved = true;
          g.lastTapAt = 0;
          g.lastX = e.touches[0].clientX;
          g.lastY = e.touches[0].clientY;
          if (!g.twoFingerMoved) {
            const twoDt = Date.now() - (g.twoFingerStartAt || g.startTime);
            if (canvas && twoDt <= TWO_FINGER_TAP_MS) click(canvas, 2);
            g.twoFingerMoved = true;
          }
        }
        return;
      }
      clearHold();
      if (!canvas) {
        g.fingers = 0;
        g.dragging = false;
        g.lockPointer = false;
        return;
      }
      if (g.dragging) {
        mouseUp(canvas);
        g.lastTapAt = 0;
      } else if (g.fingers >= 2) {
        const twoDt = Date.now() - (g.twoFingerStartAt || g.startTime);
        if (!g.twoFingerMoved && twoDt <= TWO_FINGER_TAP_MS) click(canvas, 2);
        g.lastTapAt = 0;
      } else {
        const dt = Date.now() - g.startTime;
        const tap = !g.moved && dt <= TAP_MS;
        if (tap) {
          click(canvas, 0);
          g.lastTapAt = Date.now();
        } else {
          g.lastTapAt = 0;
        }
      }
      g.fingers = 0;
      g.twoFingerMoved = false;
      g.twoFingerTravel = 0;
      g.lockPointer = false;
      wheelAcc.current = createWheelAcc();
    };

    const block = (e: Event) => {
      e.preventDefault();
    };

    const opts: AddEventListenerOptions = { passive: false, capture: true };
    overlay.addEventListener('touchstart', onStart, opts);
    overlay.addEventListener('touchmove', onMove, opts);
    overlay.addEventListener('touchend', onEnd, opts);
    overlay.addEventListener('touchcancel', onEnd, opts);
    overlay.addEventListener('gesturestart', block, opts);
    overlay.addEventListener('gesturechange', block, opts);
    overlay.addEventListener('gestureend', block, opts);
    overlay.addEventListener('dblclick', block, opts);
    overlay.addEventListener('click', block, opts);

    const canvas = canvasNow();
    if (canvas) {
      const r = canvas.getBoundingClientRect();
      pos.current = { x: r.width / 2, y: r.height / 2 };
    }

    return () => {
      clearHold();
      // Only if a window-drag is in progress. A leftover mouseup here used to
      // hide/misalign the remote cursor on iOS. Do not hide noVNC's cursor.
      if (gesture.current.dragging) {
        const canvas = canvasNow();
        if (canvas) mouseUp(canvas);
      }
      overlay.removeEventListener('touchstart', onStart, opts);
      overlay.removeEventListener('touchmove', onMove, opts);
      overlay.removeEventListener('touchend', onEnd, opts);
      overlay.removeEventListener('touchcancel', onEnd, opts);
      overlay.removeEventListener('gesturestart', block, opts);
      overlay.removeEventListener('gesturechange', block, opts);
      overlay.removeEventListener('gestureend', block, opts);
      overlay.removeEventListener('dblclick', block, opts);
      overlay.removeEventListener('click', block, opts);
    };
  }, [enabled, hostRef]);

  if (!enabled) return null;

  return (
    <div
      ref={overlayRef}
      className="absolute inset-0 z-10"
      style={{ touchAction: 'none', WebkitUserSelect: 'none', userSelect: 'none' }}
    />
  );
}
