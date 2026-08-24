/** Optional per-connection VNC pointer scale.

If the remote desktop is scaled (125%, 150%, 200%, …) but VNC still
sends the full-resolution picture, the cursor can sit in the wrong place.
Set pointerScaleX/Y to 100 / desktopScalePercent. Leave at 1 for a
normal (100%) desktop.
*/
export type VncPointerMap = {
  pointerScaleX: number;
  pointerScaleY: number;
  pointerOffsetX: number;
  pointerOffsetY: number;
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
    pointerOffsetX: num(o.pointerOffsetX, 0),
    pointerOffsetY: num(o.pointerOffsetY, 0),
  };
}

export function isIdentityPointerMap(map: VncPointerMap): boolean {
  return (
    map.pointerScaleX === 1 &&
    map.pointerScaleY === 1 &&
    map.pointerOffsetX === 0 &&
    map.pointerOffsetY === 0
  );
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
  if (rec.__gatwyPtrMap || !rec._display) return false;
  const ax = rec._display.absX.bind(rec._display);
  const ay = rec._display.absY.bind(rec._display);
  rec._display.absX = (n) => Math.round(ax(n) * map.pointerScaleX + map.pointerOffsetX);
  rec._display.absY = (n) => Math.round(ay(n) * map.pointerScaleY + map.pointerOffsetY);
  rec.__gatwyPtrMap = true;
  return true;
}
