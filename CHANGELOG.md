# Changelog

## 0.19.17

### Packaging

- Moonlight enablement is a single env var: `ENABLE_MOONLIGHT=1` (`true`/`yes`, case-insensitive). The entrypoint downloads moonlight-web-stream into `/opt/moonlight-web`, applies Gatwy patches, and Moonlight reports `available: true`.
- Removed previous enable/download/path aliases and the optional image bake-in. Bind, WebRTC port range, and log level are hardcoded. Default image stays MIT-clean until you opt in.

### UI

- When Moonlight is not enabled (runtime missing), the protocol picker, “add Moonlight connection” chrome, and existing Moonlight connections are hidden. Connections stay in the database and reappear if Moonlight is enabled later. RBAC `protocols.moonlight` is unchanged.

## 0.19.16

### Packaging

- Removed `docker-compose.moonlight.yml`. Moonlight is enabled with a runtime opt-in on the default image — that one env var is enough (fetch into `/opt/moonlight-web`, apply Gatwy patches, `available: true`).
- Runtime fetch retries GitHub downloads, chmod's upstream 0644 binaries so the `node` user can exec them, and re-applies chrome patches on start.
- Static `getStreamRectCorrected` patch now targets MLW v2.10.0 `stream/video/index.js` (it never matched `stream/index.js`).
- Optional image bake-in remained in this release. Default image stays MIT-clean until you opt in.

## 0.19.15

### Moonlight session panel

- Removed the long Auto / bitrate / FPS help paragraph from the right-hand session panel so controls stay reachable on short (mobile landscape) viewports. Resolution, touch, Mbps, and FPS controls are unchanged.

## 0.19.14

### Packaging

- Default Docker image no longer embeds moonlight-web-stream (GPL-3.0). Default `docker compose build` matches that.
- Opt in at runtime (entrypoint fetch) or `scripts/fetch-moonlight-web.sh`. Silent download is not used.
- When binaries are missing, Moonlight reports `available: false` (HTTP 503) and other protocols keep working.
- `THIRD_PARTY.md` documents the optional GPL component. Gatwy `LICENSE` is unchanged (MIT / Copyright kotoxie).

### Docs

- README matches upstream voice: 9 protocols as the default set; Moonlight/Sunshine is an optional protocol when enabled.

### Tests

- Unit tests for Moonlight resolution/touch helpers, settings merge/validation, and unavailable runtime when binaries are missing.

## 0.19.13

### Moonlight touch

- **Touch mode** on the Moonlight right panel (RDP-style select): Point and drag, Local cursor, Trackpad, Native touch. Default for new/unset prefs is **point and drag** (better than moonlight-web’s trackpad default on tablets). Saved via `PUT /api/v1/moonlight/:id/settings` like resolution; written into `mlSettings.touchMode` before every (re)launch. Local cursor also gets `localCursorSensitivity: 1` when unset.
- Mid-session changes call ViewerApp `setInputConfig` (no stream restart). If that API is not ready, the stream relaunches with the new mode — same pattern as resolution.
- **Fullscreen fill hit-testing:** `html.gatwy-fullscreen` uses `object-fit: fill`, but moonlight-web’s `getStreamRectCorrected` still assumed contain letterboxing, so taps landed offset. A same-origin wrap on ViewerApp / video renderer `getStreamRect` (runtime inject + Docker `gatwy-stream-rect.js`, plus a static patch of `getStreamRectCorrected`) returns the raw video box in fullscreen. Windowed contain still uses the corrected rect.
- Stream surface and iframe chrome use `touch-action: none` so the page does not scroll or zoom while using the stream. Iframe `onLoad` inject is unchanged. On-screen keyboard, lock mouse, send key, Auto FS remeasure, and quiet neon are untouched.

## 0.19.12

### Moonlight stream UI

- **Fullscreen bars:** Auto remeasure now reads the **fullscreen element** (`sessionRef` / `document.fullscreenElement`) instead of a stale/smaller iframe box. After `fullscreenchange`, wait 2× rAF + ~200ms and retry a few times if size is still drifting or a relaunch lock is held.
- **Fullscreen fill safety net:** while the Gatwy session is fullscreen, the parent toggles `html.gatwy-fullscreen` on the iframe document (on `fullscreenchange` and iframe `onLoad`). Video/canvas then uses `object-fit: fill` so residual letterbox after Auto relaunch is gone. **Windowed** stays `contain` + center (smaller presets remain centered). No translate centering. Overflow lock kept.
- **Reconnect neon:** moonlight-web `standard.css` hardcodes `#00d4ff` / `#00f5ff` / `#00ffff` and `color: var(--accent-cyan-2)` on Connecting / host-loading text — CSS variables alone did not kill it. Accents are now forced muted with `!important` on `html.stream` / `body.stream`; body text-shadow neutralized; `body.stream::before` is solid black (no blue cyber gradient). Connect modal copy, `.textlike`, `.host-loading-text`, buttons, and spinners are muted white; stage lines stay 12px quiet (Close still usable). Notifications stay hidden.
- CSS kept in sync between Docker-baked `gatwy-stream.css` and runtime `MLW_CHROME_STYLE`. Left sidebar hidden, Gatwy-native send key, ESC pointer-lock sync, quiet FormModals, and PIN pairing unchanged.

## 0.19.11

### Moonlight stream UI

- Stream was pushed **up/left** because 0.19.10’s `top/left: 50%` + `transform: translate(-50%,-50%)` + `width/height: auto` fought moonlight-web’s own `--stream-video-top` / canvas bitmap sizing.
- Video/canvas now uses a **full-pane box** (`position: fixed; inset: 0; width/height: 100%`) with `object-fit: contain` and `object-position: center` — no translate centering. Matching the pane (Auto after correct relaunch) fills visually; smaller streams stay truly centered with black bars. Never stuck up/left. No `object-fit: fill` (stretches).
- Neutralized `--stream-video-top` (unused with `inset: 0` + `transform: none`). Overflow lock, hidden left sidebar, quiet MLW modals, Auto fullscreen remeasure, ESC pointer-lock sync, and Gatwy-native send key kept from 0.19.9/0.19.10.
- CSS synced in Docker-baked `gatwy-stream.css` and runtime `MLW_CHROME_STYLE`.

## 0.19.10

### Moonlight stream UI

- Stream video/canvas uses **contain + center** instead of stretch-fill. When the stream is smaller than the pane, it letterboxes/pillarboxes with black bars and stays centered horizontally and vertically. **Auto** (matching client area) still looks full. Overflow lock from 0.19.8/0.19.9 kept — no `100vmin` mins, no scrollbar regress. CSS synced in Docker-baked `gatwy-stream.css` and runtime `MLW_CHROME_STYLE`.
- **Fullscreen Auto remeasure:** on `fullscreenchange` (enter or exit), wait for layout (2× rAF + short settle), remeasure the stream surface / iframe client box, and relaunch with the new even WxH when it differs from `activeSizeRef` so Sunshine’s intrinsic size matches the fullscreen pane — contain shows no letterbox bars. Cancels any mid-transition ResizeObserver debounce that still held the pre-fullscreen box. Fixed presets stay centered (not stretch-filled).
- **Lock mouse** panel label stays in sync when ESC (or OS) exits pointer lock: listeners bind on iframe `onLoad` (not before navigation), `__gatwyMlw` posts lock state to the parent, and a light poll while locked refreshes the UI so the button flips back to **Lock mouse** without reopening the panel. Unlock via the panel still calls `exitPointerLock`.

## 0.19.9

### Moonlight stream UI

- **Auto** measures the visible Gatwy stream surface / iframe client box exactly (even WxH via `clientWidth`/`clientHeight` + floored `getBoundingClientRect`), writes `mlSettings` as `videoSize: 'custom'`, and relaunches so Sunshine (sops) matches the pane — no wasted letterbox / dual-desktop look from a mismatched host size. Post-load correction if the first measure drifted.
- Scrollbars stay gone: stream document overflow lock (from 0.19.8), iframe `scrolling="no"` + `overflow: hidden`, scrollbar gutters hidden. Video sizing was stretch-fill (`inset: 0`, `object-fit: fill`) — superseded by contain+center in 0.19.10.
- **Send key** is Gatwy-native in the right panel (presets + custom VK hex/decimal → same-origin `StreamInput.sendKey`). No longer opens moonlight-web’s neon FormModal.
- Remaining MLW modal / context-menu chrome quieted to dark muted Gatwy style; MLW notification toasts hidden (Gatwy owns session status). Left `.sidebar-overlay` stays fully hidden. Floating soft-keyboard hide button stays, de-neoned.

## 0.19.8

### Moonlight stream UI

- Fixed iframe scrollbars after the 0.19.7 stream fill CSS. moonlight-web’s `body` still used safe-area padding + `min-height: 100vh` without `overflow: hidden`, so a fixed `width/height: 100%` video could grow past the iframe viewport.
- Stream document is now clipped (`html.stream` / `body.stream` overflow hidden, zeroed margin/padding/min-height); video/canvas size via `inset: 0` with `width/height: auto` (fill behavior unchanged — no return to contain/pillarbox). Left sidebar stays hidden.
- CSS kept in sync between Docker-baked `gatwy-stream.css` and runtime `MLW_CHROME_STYLE` inject. Gatwy session surface already used `overflow-hidden`.

## 0.19.7

### Moonlight stream UI

- Removed the embedded moonlight-web left `.sidebar-overlay` (peeking arrow + ViewerSidebar). Session controls live only on Gatwy’s RDP-style right panel.
- Stream video/canvas now fills the iframe pane (`object-fit: fill`, no vmin centering) so horizontal pillarbox bars are gone. Fixed presets in a differently-shaped pane may stretch slightly; **Auto** (exact client-area WxH) remains preferred for a crisp 1:1 fill.
- Right panel gains **Lock mouse**, **On-screen keyboard**, and **Send keycode** (same-origin calls into ViewerApp / ScreenKeyboard). Stats toggle still works with the left sidebar hidden. Floating MLW keyboard hide button remains available while the soft keyboard is open.
- CSS kept in sync between Docker-baked `gatwy-stream.css` and runtime `MLW_CHROME_STYLE` inject. A small iframe helper reparents ScreenKeyboard’s hidden textarea so focus still works with the overlay `display: none`.

## 0.19.6

### Moonlight / Sunshine

- Fixed mid-session resolution changes that appeared to do nothing. Changing preset A → preset B called `relaunchStream` in the same event turn as `setResolution`, but `applyMlwSettings` read the still-stale `resolutionRef` and wrote the previous size into `mlSettings`. Relaunch now takes the intended resolution (and optional bitrate/fps) explicitly.
- Stream launch always uses `videoSize: 'custom'` with exact width×height for every preset (720p/1080p/1440p/4K included), avoiding moonlight-web named-preset mapping ambiguity. Auto still measures the client area and passes `resolution: 'auto'`.
- Connecting overlay further quietened (smaller centered card, softer backdrop, muted 12px copy, quieter spinner, Show logs hidden until hover/focus or debug panel open). Cancel remains available. CSS stays in sync between the Docker-baked patch and runtime iframe inject.

## 0.19.5

### Packaging

- Docker moonlight-web static patch (`patch-static.sh`) is POSIX `/bin/sh` + `sed`/`node` only — no bash/python — so `node:22-trixie-slim` builds no longer fail with exit 127.

## 0.19.4

### Moonlight / Sunshine

- Connecting overlay inside the embedded `/mlw` iframe no longer uses moonlight-web’s huge cyan neon splash. Gatwy injects (and Docker-patches) quiet chrome: dark translucent panel, muted “Connecting…” copy, subtle gray/white spinner — aligned with RDP session status.
- Stream start now forces Moonlight **Optimize game settings** (`sops: true`) so Sunshine can apply `dd_resolution_option=auto` / client width×height. Applied via `mlSettings`, WebSocket `StartStream.settings` wrap, and a build-time patch of moonlight-web `static/stream/index.js`.
- Width/height from Auto and presets still flow into `StartStream.settings` as before; sops is enabled by default for Gatwy sessions (no MLW UI toggle required).
- **Host still required:** in Sunshine → Audio/Video, keep output resolution on **client** / **automatic**. If that is disabled, the host will not resize even with sops on.

## 0.19.3

### Reliability / DB

- sql.js persistence no longer uses `PRAGMA journal_mode = WAL` (not meaningful for full-DB file export); uses `MEMORY` instead.
- Database saves are atomic: write to a temp file, fsync, then rename over the primary path so a mid-write kill cannot truncate/`malformed` the live DB.
- On open, a malformed or integrity-check-failed DB is quarantined to `${dbPath}.corrupt-<timestamp>` (plus any `-wal`/`-shm` leftovers), then Gatwy starts a fresh empty DB and runs migrations — avoiding fatal startup crash-loops.
- Backup restore (`restoreDbFromBytes`) also persists via the same atomic save path.

## 0.19.2

### Moonlight UI polish

- Session chrome now uses the same right-edge flyout panel pattern as RDP (status, fullscreen, bitrate/FPS, resolution, forget pairing, disconnect).
- Pairing modal aligns with other Gatwy session overlays.
- On-stream stats HUD restyled via same-origin `/mlw` CSS injection: small, muted, semi-transparent corner text instead of the default high-contrast overlay.
- README: treat Moonlight like any other protocol (no bold/hype); drop PIN pairing from highlights.

### Moonlight resolution

- Stream resolution presets (720p–4K and common laptop sizes) plus Auto (client area) default.
- Preference persisted per connection (`extra_config_json` / session settings API).
- Auto mode re-measures the session viewport on resize (debounced), updates moonlight-web launch settings, and cleanly restarts the stream so Sunshine follows the new desktop size — not CSS letterboxing.

## 0.19.1

### Packaging

- Docker base image moved from `node:22-bookworm-slim` (glibc 2.36) to `node:22-trixie-slim` so bundled moonlight-web-stream binaries (GLIBC_2.38/2.39) can load.
- Image build now runs `web-server -V`/`help` after downloading moonlight-web, so wrong glibc/arch fails at build time instead of at session start.

### Moonlight / Sunshine

- If the moonlight-web process exits before ready, Gatwy fails fast and surfaces early stderr (e.g. missing GLIBC symbols) in the error shown to the UI.

## 0.19.0

### Moonlight / Sunshine

- Added **Moonlight** as a first-class Remote Control protocol alongside RDP and VNC.
- Browser sessions stream a Sunshine (GameStream-compatible) host through a bundled [moonlight-web-stream](https://github.com/MrCreativ3001/moonlight-web-stream) runtime inside the Gatwy container.
- **PIN pairing flow**: on first connect to an unpaired host, Gatwy shows a modal with a 4-digit PIN to enter in the Sunshine web UI. Pairing material is persisted under `/app/data` (moonlight-web storage + Gatwy encrypted backup) and survives container restarts.
- Subsequent connects skip PIN and stream directly (default app: Desktop).
- **Forget pairing** is available from the connection editor and the Moonlight session chrome.
- RBAC: new `protocols.moonlight` permission, granted by default to admin/user roles that already have RDP/VNC.
- Audit events: `session.moonlight.connect`, `session.moonlight.disconnect`, `session.moonlight.pair`.

### Packaging

- Docker image now bundles moonlight-web `web-server` + `streamer` binaries.
- Compose example builds from the git repo (`docker compose up --build`).
- README updated for Moonlight networking notes.

## 0.18.0

- Prior release baseline (upstream Gatwy feature set).
