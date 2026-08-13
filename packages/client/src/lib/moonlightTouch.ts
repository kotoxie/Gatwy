/** Shared Moonlight touch-mode helpers (client). Matches moonlight-web v2.10.0 TouchMode. */

export type MlTouchMode = 'pointAndDrag' | 'localCursor' | 'mouseRelative' | 'touch';

export const ML_TOUCH_MODE_DEFAULT: MlTouchMode = 'pointAndDrag';

export const ML_TOUCH_MODE_VALUES: readonly MlTouchMode[] = [
  'pointAndDrag',
  'localCursor',
  'mouseRelative',
  'touch',
];

export interface MlTouchModePreset {
  value: MlTouchMode;
  label: string;
  help: string;
}

/** Right-panel labels — point-and-drag first (best default for tablets). */
export const ML_TOUCH_MODE_PRESETS: MlTouchModePreset[] = [
  {
    value: 'pointAndDrag',
    label: 'Point and drag',
    help: 'Point and drag: tap to click, drag to move.',
  },
  {
    value: 'localCursor',
    label: 'Local cursor',
    help: 'Local cursor: drag the on-screen pointer, tap to click.',
  },
  {
    value: 'mouseRelative',
    label: 'Trackpad',
    help: 'Trackpad: finger movement moves the host cursor relatively.',
  },
  {
    value: 'touch',
    label: 'Native touch',
    help: 'Native touch: pass multitouch through to the host.',
  },
];

const TOUCH_SET = new Set<string>(ML_TOUCH_MODE_VALUES);

/** Coarse pointer / touchscreen — used when no saved pref exists. */
export function prefersTouchPointer(): boolean {
  try {
    if (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0) return true;
    if (typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)')?.matches) {
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

/**
 * Default when unset: pointAndDrag (better than MLW’s mouseRelative on tablets).
 * Coarse/touch devices without a saved pref also get pointAndDrag.
 */
export function defaultMlTouchMode(): MlTouchMode {
  if (prefersTouchPointer()) return 'pointAndDrag';
  return ML_TOUCH_MODE_DEFAULT;
}

export function normalizeMlTouchMode(raw: unknown): MlTouchMode {
  if (typeof raw !== 'string' || !raw.trim()) return defaultMlTouchMode();
  const v = raw.trim();
  if (TOUCH_SET.has(v)) return v as MlTouchMode;
  return defaultMlTouchMode();
}

export function touchModeHelp(mode: MlTouchMode): string {
  return ML_TOUCH_MODE_PRESETS.find((p) => p.value === mode)?.help
    ?? ML_TOUCH_MODE_PRESETS[0].help;
}
