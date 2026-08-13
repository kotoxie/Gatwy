/** Shared Moonlight stream resolution helpers (client). */

export const ML_RESOLUTION_AUTO = 'auto';

export interface MlResolutionPreset {
  value: string;
  label: string;
}

/** Common desktop / laptop presets + Auto. */
export const ML_RESOLUTION_PRESETS: MlResolutionPreset[] = [
  { value: ML_RESOLUTION_AUTO, label: 'Auto (client area)' },
  { value: '1280x720', label: '1280 × 720' },
  { value: '1366x768', label: '1366 × 768' },
  { value: '1600x900', label: '1600 × 900' },
  { value: '1920x1080', label: '1920 × 1080' },
  { value: '1920x1200', label: '1920 × 1200' },
  { value: '2560x1440', label: '2560 × 1440' },
  { value: '2560x1600', label: '2560 × 1600' },
  { value: '3840x2160', label: '3840 × 2160' },
];

const PRESET_VALUES = new Set(ML_RESOLUTION_PRESETS.map((p) => p.value));

export function normalizeMlResolution(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) return ML_RESOLUTION_AUTO;
  const v = raw.trim().toLowerCase();
  if (v === 'auto' || v === 'native' || v === '') return ML_RESOLUTION_AUTO;
  if (PRESET_VALUES.has(v)) return v;
  if (/^\d{3,5}x\d{3,5}$/.test(v)) return v;
  return ML_RESOLUTION_AUTO;
}

export function parseResolutionPreset(value: string): { width: number; height: number } | null {
  const n = normalizeMlResolution(value);
  if (n === ML_RESOLUTION_AUTO) return null;
  const m = /^(\d{3,5})x(\d{3,5})$/.exec(n);
  if (!m) return null;
  return { width: Number(m[1]), height: Number(m[2]) };
}

/** Even dimensions; encoders / Moonlight prefer even sizes. */
export function snapStreamSize(width: number, height: number): { width: number; height: number } {
  const w = Math.max(640, Math.floor(width / 2) * 2);
  const h = Math.max(360, Math.floor(height / 2) * 2);
  return { width: w, height: h };
}

export function sizesDiffer(
  a: { width: number; height: number },
  b: { width: number; height: number },
  threshold = 8,
): boolean {
  return Math.abs(a.width - b.width) >= threshold || Math.abs(a.height - b.height) >= threshold;
}

export type MlwVideoSizeFields = {
  /** Always `custom` so MLW uses exact width/height (avoids preset mapping ambiguity). */
  videoSize: 'custom';
  videoSizeCustom: { width: number; height: number };
};

/**
 * Map Gatwy resolution choice → moonlight-web mlSettings fields.
 * Auto uses custom size from the measured client area (not CSS scale).
 * Fixed presets always launch as `videoSize: 'custom'` + exact WxH so StartStream
 * cannot pick a stale named preset while videoSizeCustom disagrees.
 */
export function resolutionToMlwVideoSize(
  resolution: string,
  clientArea: { width: number; height: number } | null,
): MlwVideoSizeFields {
  const parsed = parseResolutionPreset(resolution);
  if (!parsed) {
    const size = snapStreamSize(clientArea?.width ?? 1920, clientArea?.height ?? 1080);
    return { videoSize: 'custom', videoSizeCustom: size };
  }
  return { videoSize: 'custom', videoSizeCustom: snapStreamSize(parsed.width, parsed.height) };
}

/**
 * Append launch overrides for diagnostics / older MLW builds.
 * MLW v2.10.0 ignores videoSize query params (size comes from localStorage mlSettings);
 * keep them for debugging only — do not treat as the correctness path.
 */
export function appendStreamLaunchParams(
  streamPath: string,
  opts: {
    bitrateKbps: number;
    fps: number;
    resolution: string;
    clientArea: { width: number; height: number } | null;
  },
  origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost',
): string {
  const url = new URL(streamPath, origin);
  const mapped = resolutionToMlwVideoSize(opts.resolution, opts.clientArea);
  url.searchParams.set('bitrate', String(opts.bitrateKbps));
  url.searchParams.set('fps', String(opts.fps));
  url.searchParams.set('videoSize', mapped.videoSize);
  url.searchParams.set('videoSizeCustom.width', String(mapped.videoSizeCustom.width));
  url.searchParams.set('videoSizeCustom.height', String(mapped.videoSizeCustom.height));
  url.searchParams.set('dataTransport', 'websocket');
  // Optimize game settings — Sunshine needs this to apply client resolution.
  url.searchParams.set('sops', 'true');
  return `${url.pathname}${url.search}`;
}
