/** Optional per-connection VNC pointer scale.

If the remote desktop is scaled (125%, 150%, 200%, …) but VNC still
sends the full-resolution picture, the cursor can sit in the wrong place.
Set pointerScaleX/Y to 100 / desktopScalePercent. Leave at 1 for a
normal (100%) desktop.
*/
export type VncPointerMap = {
  pointerScaleX: number;
  pointerScaleY: number;
};

function num(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

export function parseVncPointerMap(extra: unknown): VncPointerMap {
  const o = extra && typeof extra === 'object' ? (extra as Record<string, unknown>) : {};
  return {
    pointerScaleX: num(o.pointerScaleX, 1),
    pointerScaleY: num(o.pointerScaleY, 1),
  };
}

export function isIdentityPointerMap(map: VncPointerMap): boolean {
  return map.pointerScaleX === 1 && map.pointerScaleY === 1;
}

/** Convert a pointer scale factor back to the desktop scale percentage (e.g. 0.5 → 200). */
export function pointerScaleToPercent(factor: number): number {
  if (!Number.isFinite(factor) || factor <= 0 || factor === 1) return 100;
  return Math.round(100 / factor);
}

type RfbDisplay = {
  __gatwyPtrMap?: boolean;
  _display?: {
    absX: (n: number) => number;
    absY: (n: number) => number;
  };
};

/** Wrap noVNC Display.absX/absY. Safe to call more than once. */
export function applyVncPointerMap(rfb: object, extra: unknown): boolean {
  const map = parseVncPointerMap(extra);
  if (isIdentityPointerMap(map)) return false;
  const rec = rfb as RfbDisplay;
  if (rec.__gatwyPtrMap || !rec._display?.absX || !rec._display?.absY) return false;
  const ax = rec._display.absX.bind(rec._display);
  const ay = rec._display.absY.bind(rec._display);
  rec._display.absX = (n) => Math.round(ax(n) * map.pointerScaleX);
  rec._display.absY = (n) => Math.round(ay(n) * map.pointerScaleY);
  rec.__gatwyPtrMap = true;
  return true;
}
