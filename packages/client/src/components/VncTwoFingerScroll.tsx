import { useEffect, useRef, type RefObject } from 'react';
import { createWheelAcc, feedWheel } from '../lib/vncWheel';

interface VncTwoFingerScrollProps {
  hostRef: RefObject<HTMLDivElement | null>;
  enabled: boolean;
}

const SCROLL_SLOP = 14;

function canvasOf(host: HTMLDivElement | null): HTMLCanvasElement | null {
  return host?.querySelector('canvas') ?? null;
}

/**
 * Touchscreen two-finger scroll. Intercepts 2+ fingers in capture phase so
 * noVNC does not move the cursor, and sends faster wheel ticks. One-finger
 * taps/drags still go to noVNC.
 */
export function VncTwoFingerScroll({ hostRef, enabled }: VncTwoFingerScrollProps) {
  const acc = useRef(createWheelAcc());
  const gesture = useRef({
    active: false,
    moved: false,
    lastMidX: 0,
    lastMidY: 0,
    travel: 0,
  });

  useEffect(() => {
    if (!enabled) return;
    const host = hostRef.current;
    if (!host) return;

    const reset = () => {
      gesture.current.active = false;
      gesture.current.moved = false;
      gesture.current.travel = 0;
      acc.current = createWheelAcc();
    };

    const onStart = (e: TouchEvent) => {
      if (e.touches.length < 2) return;
      e.preventDefault();
      e.stopPropagation();
      const g = gesture.current;
      g.active = true;
      g.moved = false;
      g.travel = 0;
      g.lastMidX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      g.lastMidY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      acc.current = createWheelAcc();
    };

    const onMove = (e: TouchEvent) => {
      if (!gesture.current.active && e.touches.length < 2) return;
      if (e.touches.length < 2) return;
      e.preventDefault();
      e.stopPropagation();
      const canvas = canvasOf(host);
      if (!canvas) return;
      const g = gesture.current;
      g.active = true;
      const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      const dx = midX - g.lastMidX;
      const dy = midY - g.lastMidY;
      g.lastMidX = midX;
      g.lastMidY = midY;
      g.travel += Math.hypot(dx, dy);
      if (g.travel > SCROLL_SLOP) g.moved = true;
      if (!g.moved) return;
      const r = canvas.getBoundingClientRect();
      feedWheel(canvas, r.left + r.width / 2, r.top + r.height / 2, dx, dy, acc.current);
    };

    const onEnd = (e: TouchEvent) => {
      if (e.touches.length >= 2) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (gesture.current.active) {
        e.preventDefault();
        e.stopPropagation();
      }
      reset();
    };

    const opts: AddEventListenerOptions = { passive: false, capture: true };
    host.addEventListener('touchstart', onStart, opts);
    host.addEventListener('touchmove', onMove, opts);
    host.addEventListener('touchend', onEnd, opts);
    host.addEventListener('touchcancel', onEnd, opts);
    return () => {
      host.removeEventListener('touchstart', onStart, opts);
      host.removeEventListener('touchmove', onMove, opts);
      host.removeEventListener('touchend', onEnd, opts);
      host.removeEventListener('touchcancel', onEnd, opts);
    };
  }, [enabled, hostRef]);

  return null;
}
