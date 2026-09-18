export type VncTouchMode = 'touchscreen' | 'touchpad';

const STORAGE_KEY = 'gatwy.vnc.touchMode';

export function loadVncTouchMode(): VncTouchMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'touchpad' || v === 'touchscreen') return v;
  } catch { /* ignore */ }
  return 'touchscreen';
}

export function saveVncTouchMode(mode: VncTouchMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch { /* ignore */ }
}
