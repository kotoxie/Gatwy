import { useCallback, useEffect, useRef, useState } from 'react';
import { DisconnectOverlay } from './DisconnectOverlay';
import { MoonlightPairModal } from './MoonlightPairModal';
import {
  ML_RESOLUTION_AUTO,
  ML_RESOLUTION_PRESETS,
  appendStreamLaunchParams,
  normalizeMlResolution,
  resolutionToMlwVideoSize,
  sizesDiffer,
  snapStreamSize,
} from '../lib/moonlightResolution';
import {
  ML_TOUCH_MODE_PRESETS,
  defaultMlTouchMode,
  normalizeMlTouchMode,
  touchModeHelp,
  type MlTouchMode,
} from '../lib/moonlightTouch';

type SessionStatus = 'connecting' | 'pairing' | 'streaming' | 'disconnected';

interface MoonlightSessionProps {
  connectionId: string;
  connectionName: string;
  isActive: boolean;
  onStatusChange?: (status: 'connecting' | 'connected' | 'disconnected') => void;
  onClose?: (connectionId: string) => void;
}

interface StatusResponse {
  available: boolean;
  paired: boolean;
  hostId: number;
  host: string;
  appName?: string;
  apps?: { appId: number; title: string }[];
  bitrateKbps?: number;
  fps?: number;
  resolution?: string;
  touchMode?: string;
  error?: string;
}

interface SessionResponse {
  sessionId: string;
  hostId: number;
  appId: number;
  appTitle: string;
  streamPath: string;
  bitrateKbps: number;
  fps: number;
  resolution?: string;
  touchMode?: string;
  needsPairing?: boolean;
  error?: string;
}

const RESIZE_DEBOUNCE_MS = 220;

/** Injected into the same-origin /mlw iframe: quiet stats + Gatwy-style connecting chrome.
 * Keep in sync with docker/mlw-patches/gatwy-stream.css (baked into the image). */
const MLW_CHROME_STYLE = `
.video-stats {
  color: rgba(255, 255, 255, 0.55) !important;
  text-shadow: none !important;
  font-size: 11px !important;
  font-weight: 400 !important;
  line-height: 1.35 !important;
  letter-spacing: 0.01em !important;
  opacity: 0.55 !important;
  white-space: pre !important;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace !important;
  background: transparent !important;
  padding: 0 !important;
  border: none !important;
  box-shadow: none !important;
  position: absolute !important;
  top: 10px !important;
  left: 10px !important;
  z-index: 5 !important;
  max-width: min(42vw, 360px) !important;
  pointer-events: none !important;
}

/* Match RDP connecting chrome: mute MLW accent colors on the splash.
 * !important is required — standard.css hardcodes #00d4ff / #00f5ff / #00ffff. */
html.stream,
html.stream body,
body.stream {
  --accent-cyan: rgba(255, 255, 255, 0.4) !important;
  --accent-cyan-2: rgba(255, 255, 255, 0.5) !important;
  --accent-cyan-light: rgba(255, 255, 255, 0.6) !important;
  --glow-cyan: none !important;
  --glow-cyan-bright: none !important;
  --shadow-button: 0 4px 12px rgba(0, 0, 0, 0.45) !important;
  --text-1: rgba(255, 255, 255, 0.65) !important;
  --bg-0: #000000 !important;
  --bg-1: #050505 !important;
  --bg-2: #000000 !important;
  --bg-3: #0a0a0a !important;
  color: rgba(255, 255, 255, 0.7) !important;
  text-shadow: none !important;
  background: #000 !important;
  background-image: none !important;
}
html.stream body::before,
body.stream::before {
  background: #000 !important;
  background-image: none !important;
  background-color: #000 !important;
  box-shadow: none !important;
  filter: none !important;
  opacity: 1 !important;
}
.modal-background:not(.modal-disabled):has(.modal-video-connect),
.modal-background:not(.modal-disabled):has(.host-loading-overlay) {
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  background-color: rgba(0, 0, 0, 0.62) !important;
  backdrop-filter: blur(1px) !important;
}
.modal-background:not(.modal-disabled):has(.modal-video-connect) .modal-content,
.modal-background:not(.modal-disabled):has(.host-loading-overlay) .modal-content {
  background: rgba(16, 16, 18, 0.94) !important;
  border: 1px solid rgba(255, 255, 255, 0.1) !important;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5) !important;
  color: rgba(255, 255, 255, 0.65) !important;
  width: auto !important;
  max-width: min(280px, 84vw) !important;
  max-height: none !important;
  margin: 0 !important;
  padding: 14px 16px !important;
  border-radius: 10px !important;
  text-shadow: none !important;
  overflow: hidden !important;
}
.modal-video-connect {
  align-items: center !important;
  gap: 8px !important;
  min-height: 0 !important;
  color: rgba(255, 255, 255, 0.7) !important;
  text-shadow: none !important;
}
.modal-video-connect > p,
.modal-video-connect .textlike,
.modal-video-connect p {
  font-size: 12px !important;
  font-weight: 400 !important;
  line-height: 1.35 !important;
  color: rgba(255, 255, 255, 0.7) !important;
  text-shadow: none !important;
  text-align: center !important;
  margin: 0 !important;
  white-space: pre-wrap !important;
}
.modal-video-connect .modal-video-connect-options {
  width: 100%;
  justify-content: center !important;
  gap: 6px !important;
  margin-top: 2px !important;
  min-height: 28px !important;
}
/* MLW appends Show logs first, Close second — hide Show logs during normal connect. */
.modal-video-connect:not(:has(.modal-video-connect-debug)) .modal-video-connect-options button:first-child {
  display: none !important;
}
.modal-video-connect:hover:not(:has(.modal-video-connect-debug)) .modal-video-connect-options button:first-child,
.modal-video-connect:focus-within:not(:has(.modal-video-connect-debug)) .modal-video-connect-options button:first-child,
.modal-video-connect:has(.modal-video-connect-debug) .modal-video-connect-options button:first-child {
  display: inline-flex !important;
}
.modal-video-connect .modal-video-connect-options button,
.modal-video-connect button {
  background: transparent !important;
  border: 1px solid rgba(255, 255, 255, 0.14) !important;
  color: rgba(255, 255, 255, 0.5) !important;
  box-shadow: none !important;
  text-shadow: none !important;
  font-size: 11px !important;
  font-weight: 500 !important;
  padding: 5px 10px !important;
  border-radius: 8px !important;
  margin: 0 !important;
}
.modal-video-connect .modal-video-connect-options button:hover,
.modal-video-connect button:hover {
  background: rgba(255, 255, 255, 0.06) !important;
  color: rgba(255, 255, 255, 0.78) !important;
  transform: none !important;
}
.modal-video-connect .modal-video-connect-debug {
  max-width: 100% !important;
  max-height: 28vh !important;
  font-size: 11px !important;
  color: rgba(255, 255, 255, 0.4) !important;
  text-shadow: none !important;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  padding-top: 8px;
  margin-top: 4px;
}
.host-element.connecting::before {
  width: 18px !important;
  height: 18px !important;
  margin: -9px 0 0 -9px !important;
  border: 1.5px solid rgba(255, 255, 255, 0.16) !important;
  border-top-color: rgba(255, 255, 255, 0.55) !important;
  box-shadow: none !important;
}
.host-loading-overlay {
  background: rgba(0, 0, 0, 0.62) !important;
  backdrop-filter: blur(1px) !important;
}
.host-loading-spinner {
  width: 18px !important;
  height: 18px !important;
  border: 1.5px solid rgba(255, 255, 255, 0.14) !important;
  border-top-color: rgba(255, 255, 255, 0.55) !important;
  box-shadow: none !important;
}
.host-loading-text {
  font-size: 12px !important;
  color: rgba(255, 255, 255, 0.7) !important;
  text-shadow: none !important;
}
.host-loading-cancel {
  background: transparent !important;
  border: 1px solid rgba(255, 255, 255, 0.14) !important;
  color: rgba(255, 255, 255, 0.5) !important;
  box-shadow: none !important;
  text-shadow: none !important;
  font-size: 11px !important;
  font-weight: 500 !important;
}
.host-loading-cancel:hover,
.host-loading-cancel:active,
.host-loading-cancel:focus {
  transform: none !important;
  background: rgba(255, 255, 255, 0.06) !important;
  box-shadow: none !important;
}

/* Override hardcoded cyan in MLW standard.css on connect/reconnect chrome. */
html.stream .modal-video-connect,
html.stream .modal-video-connect > p,
html.stream .modal-video-connect p,
html.stream .modal-video-connect .textlike,
html.stream .textlike,
html.stream .host-loading-text,
html.stream .modal-background:not(.modal-disabled) .modal-content,
html.stream .modal-background:not(.modal-disabled) .modal-content p,
html.stream .modal-background:not(.modal-disabled) .modal-content span {
  color: rgba(255, 255, 255, 0.7) !important;
  text-shadow: none !important;
}
html.stream .modal-video-connect button,
html.stream .modal-video-connect .modal-video-connect-options button,
html.stream .host-loading-cancel {
  color: rgba(255, 255, 255, 0.5) !important;
  border-color: rgba(255, 255, 255, 0.14) !important;
  box-shadow: none !important;
  text-shadow: none !important;
}
html.stream .host-element.connecting::before,
html.stream .host-loading-spinner {
  border-color: rgba(255, 255, 255, 0.16) !important;
  border-top-color: rgba(255, 255, 255, 0.55) !important;
  box-shadow: none !important;
}

/* Hide MLW left ViewerSidebar chrome (Gatwy right panel owns controls). */
.sidebar-overlay {
  display: none !important;
  visibility: hidden !important;
  pointer-events: none !important;
}

/*
 * Lock stream document: MLW body safe-area padding + min-height:100vh without
 * overflow:hidden lets fixed fill grow past the iframe → scrollbars.
 */
html.stream,
html.stream body,
body.stream {
  --stream-video-top: 0;
  overflow: hidden !important;
  overscroll-behavior: none !important;
  touch-action: none !important;
  -webkit-user-select: none !important;
  user-select: none !important;
  margin: 0 !important;
  padding: 0 !important;
  width: 100% !important;
  height: 100% !important;
  min-height: 0 !important;
  max-height: 100% !important;
  box-sizing: border-box !important;
  scrollbar-width: none !important;
}
html.stream::-webkit-scrollbar,
html.stream body::-webkit-scrollbar,
body.stream::-webkit-scrollbar {
  display: none !important;
  width: 0 !important;
  height: 0 !important;
}
#root,
#input,
.video-stream,
video.video-stream,
canvas.video-stream {
  overflow: hidden !important;
  touch-action: none !important;
  -webkit-user-select: none !important;
  user-select: none !important;
}

/* Quiet ALL MLW modals (FormModal etc.) — not only connecting. */
.modal-background:not(.modal-disabled) {
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  background-color: rgba(0, 0, 0, 0.62) !important;
  backdrop-filter: blur(1px) !important;
}
.modal-background:not(.modal-disabled) .modal-content {
  background: rgba(16, 16, 18, 0.94) !important;
  border: 1px solid rgba(255, 255, 255, 0.1) !important;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5) !important;
  color: rgba(255, 255, 255, 0.65) !important;
  text-shadow: none !important;
  border-radius: 10px !important;
  width: auto !important;
  max-width: min(320px, 88vw) !important;
  max-height: min(70vh, 480px) !important;
  margin: 0 !important;
  padding: 14px 16px !important;
  overflow: auto !important;
}
.modal-content button,
.modal-content input,
.modal-content select,
.modal-content .textlike {
  background: transparent !important;
  border: 1px solid rgba(255, 255, 255, 0.14) !important;
  color: rgba(255, 255, 255, 0.7) !important;
  box-shadow: none !important;
  text-shadow: none !important;
  border-radius: 8px !important;
}
.modal-content button:hover {
  background: rgba(255, 255, 255, 0.06) !important;
  color: rgba(255, 255, 255, 0.88) !important;
  transform: none !important;
}

/* Hide MLW toasts — Gatwy owns session status. */
#notification-list,
.notification-list,
.notification-element {
  display: none !important;
  visibility: hidden !important;
  pointer-events: none !important;
  opacity: 0 !important;
}

.context-menu-background {
  background: rgba(16, 16, 18, 0.96) !important;
  border: 1px solid rgba(255, 255, 255, 0.12) !important;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5) !important;
  color: rgba(255, 255, 255, 0.7) !important;
}
.context-menu-element {
  color: rgba(255, 255, 255, 0.7) !important;
}
.context-menu-element:hover {
  background: rgba(255, 255, 255, 0.06) !important;
  border-left: none !important;
  transform: none !important;
  padding-left: 10px !important;
}
.stream-keyboard-floating-button {
  border: 1px solid rgba(255, 255, 255, 0.18) !important;
  background: rgba(0, 0, 0, 0.55) !important;
  color: rgba(255, 255, 255, 0.7) !important;
  box-shadow: none !important;
  border-radius: 10px !important;
}

/* Full-pane contain: fill when matching; center when smaller. No translate. */
.video-stream,
video.video-stream,
canvas.video-stream {
  position: fixed !important;
  inset: 0 !important;
  top: 0 !important;
  left: 0 !important;
  right: 0 !important;
  bottom: 0 !important;
  transform: none !important;
  width: 100% !important;
  height: 100% !important;
  max-width: 100% !important;
  max-height: 100% !important;
  min-width: 0 !important;
  min-height: 0 !important;
  object-fit: contain !important;
  object-position: center center !important;
  box-sizing: border-box !important;
  overflow: hidden !important;
  margin: 0 !important;
}

/* FS safety net: residual letterbox after Auto relaunch. Windowed stays contain. */
html.gatwy-fullscreen .video-stream,
html.gatwy-fullscreen video.video-stream,
html.gatwy-fullscreen canvas.video-stream {
  object-fit: fill !important;
}
`;

/**
 * Force StartStream.settings.sops = true (Moonlight "Optimize game settings").
 * Sunshine applies dd_resolution_option=auto / client width×height only when sops is on.
 */
const MLW_SOPS_SCRIPT = `
(function(){
  if (typeof WebSocket === 'undefined') return;
  if (WebSocket.prototype.__gatwySopsWrapped) return;
  var originalSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function(data) {
    try {
      if (typeof data === 'string' && data.indexOf('StartStream') !== -1) {
        var msg = JSON.parse(data);
        if (msg && msg.StartStream && msg.StartStream.settings) {
          msg.StartStream.settings.sops = true;
          data = JSON.stringify(msg);
        }
      }
    } catch (e) {}
    return originalSend.call(this, data);
  };
  WebSocket.prototype.__gatwySopsWrapped = true;
})();
`;

/**
 * Same-origin helpers for Gatwy’s right panel. Reparents ScreenKeyboard’s
 * hidden textarea out of the CSS-hidden .sidebar-overlay so focus still works.
 */
const MLW_GATWY_HELPER_SCRIPT = `
(function(){
  if (window.__gatwyMlwInstalled) return;
  window.__gatwyMlwInstalled = true;

  function getApp() {
    return window.app || null;
  }

  function rawVideoRect() {
    var el = document.querySelector('video.video-stream, canvas.video-stream, .video-stream');
    if (el && typeof el.getBoundingClientRect === 'function') {
      return el.getBoundingClientRect();
    }
    return null;
  }

  /**
   * Under html.gatwy-fullscreen, object-fit:fill stretches the video to the
   * pane. MLW getStreamRectCorrected still letterbox-adjusts as if contain —
   * wrap ViewerApp / renderer getStreamRect to return the raw video box.
   */
  function wrapGetStreamRect(obj) {
    if (!obj || typeof obj.getStreamRect !== 'function' || obj.getStreamRect.__gatwyFillWrap) {
      return false;
    }
    var orig = obj.getStreamRect.bind(obj);
    function wrapped() {
      try {
        if (document.documentElement && document.documentElement.classList.contains('gatwy-fullscreen')) {
          var raw = rawVideoRect();
          if (raw) return raw;
        }
      } catch (e) {}
      return orig();
    }
    wrapped.__gatwyFillWrap = true;
    obj.getStreamRect = wrapped;
    return true;
  }

  function patchStreamRect() {
    var app = getApp();
    wrapGetStreamRect(app);
    try {
      var stream = app && typeof app.getStream === 'function' ? app.getStream() : null;
      var renderer = stream && typeof stream.getVideoRenderer === 'function'
        ? stream.getVideoRenderer()
        : null;
      wrapGetStreamRect(renderer);
    } catch (e) {}
    return true;
  }

  function setTouchMode(mode) {
    var app = getApp();
    if (!app || typeof app.getInputConfig !== 'function' || typeof app.setInputConfig !== 'function') {
      return false;
    }
    try {
      var config = app.getInputConfig();
      if (!config) return false;
      config.touchMode = mode;
      if (mode === 'localCursor') {
        var sens = Number(config.localCursorSensitivity);
        if (!isFinite(sens) || sens <= 0) config.localCursorSensitivity = 1;
      }
      app.setInputConfig(config);
      return true;
    } catch (e) {
      return false;
    }
  }

  function getScreenKeyboard() {
    var app = getApp();
    try {
      return app && app.sidebar && typeof app.sidebar.getScreenKeyboard === 'function'
        ? app.sidebar.getScreenKeyboard()
        : null;
    } catch (e) {
      return null;
    }
  }

  function reparentHiddenKeyboard() {
    var kb = getScreenKeyboard();
    var el = null;
    try {
      el = kb && typeof kb.getHiddenElement === 'function' ? kb.getHiddenElement() : null;
    } catch (e) {}
    if (!el) {
      el = document.querySelector('textarea.hiddeninput, .hiddeninput');
    }
    if (el && el.parentElement !== document.body) {
      try { document.body.appendChild(el); } catch (e) {}
    }
  }

  function armPointerLock() {
    var armed = false;
    function onPointerDown() {
      if (armed) return;
      armed = true;
      document.removeEventListener('pointerdown', onPointerDown, true);
      var app = getApp();
      if (app && typeof app.requestPointerLock === 'function') {
        try { app.requestPointerLock(true); } catch (e) {}
      }
    }
    document.addEventListener('pointerdown', onPointerDown, true);
    // Also try immediately (works when caller already has activation in this doc).
    var app = getApp();
    if (app && typeof app.requestPointerLock === 'function') {
      try {
        var p = app.requestPointerLock(true);
        if (p && typeof p.then === 'function') {
          p.then(function() {
            document.removeEventListener('pointerdown', onPointerDown, true);
          }).catch(function() {});
        }
      } catch (e) {}
    }
  }

  function notifyPointerLock() {
    var locked = !!document.pointerLockElement;
    try {
      window.parent.postMessage({
        source: 'gatwy-mlw',
        type: 'pointerlock',
        locked: locked
      }, '*');
    } catch (e) {}
  }

  // Belt-and-suspenders for ESC / OS unlock — parent may miss contentDocument
  // listeners if they were attached before iframe navigation finished.
  document.addEventListener('pointerlockchange', notifyPointerLock);
  document.addEventListener('pointerlockerror', notifyPointerLock);

  window.__gatwyMlw = {
    reparentHiddenKeyboard: reparentHiddenKeyboard,
    armPointerLock: armPointerLock,
    patchStreamRect: patchStreamRect,
    setTouchMode: setTouchMode,
    lockMouse: function() {
      reparentHiddenKeyboard();
      armPointerLock();
      return true;
    },
    unlockMouse: function() {
      var app = getApp();
      if (app && typeof app.exitPointerLock === 'function') {
        try { app.exitPointerLock(); notifyPointerLock(); return true; } catch (e) { return false; }
      }
      try { document.exitPointerLock(); notifyPointerLock(); return true; } catch (e) { return false; }
    },
    isPointerLocked: function() {
      return !!document.pointerLockElement;
    },
    showKeyboard: function() {
      reparentHiddenKeyboard();
      var kb = getScreenKeyboard();
      if (!kb) return false;
      try { kb.show(); return true; } catch (e) { return false; }
    },
    hideKeyboard: function() {
      var kb = getScreenKeyboard();
      if (!kb) return false;
      try { kb.hide(); return true; } catch (e) { return false; }
    },
    toggleKeyboard: function() {
      reparentHiddenKeyboard();
      var kb = getScreenKeyboard();
      if (!kb) return false;
      try {
        if (kb.isVisible()) kb.hide();
        else kb.show();
        return true;
      } catch (e) { return false; }
    },
    isKeyboardVisible: function() {
      var kb = getScreenKeyboard();
      try { return !!(kb && kb.isVisible()); } catch (e) { return false; }
    },
    /**
     * Send a Windows VK key (or chord) via StreamInput — never opens MLW FormModal.
     * keys: number | number[]; modifiers applied only for a single key.
     */
    sendKey: function(keys, modifiers) {
      var app = getApp();
      var input = null;
      try {
        var stream = app && typeof app.getStream === 'function' ? app.getStream() : null;
        input = stream && typeof stream.getInput === 'function' ? stream.getInput() : null;
      } catch (e) { input = null; }
      if (!input || typeof input.sendKey !== 'function') return false;
      var mods = typeof modifiers === 'number' ? modifiers : 0;
      var list = Array.isArray(keys) ? keys : [keys];
      var cleaned = [];
      for (var i = 0; i < list.length; i++) {
        var k = Number(list[i]);
        if (!Number.isFinite(k) || k < 0 || k > 0xffff) continue;
        cleaned.push(k | 0);
      }
      if (!cleaned.length) return false;
      try {
        if (cleaned.length === 1) {
          input.sendKey(true, cleaned[0], mods);
          input.sendKey(false, cleaned[0], mods);
        } else {
          for (var d = 0; d < cleaned.length; d++) input.sendKey(true, cleaned[d], 0);
          for (var u = cleaned.length - 1; u >= 0; u--) input.sendKey(false, cleaned[u], 0);
        }
        return true;
      } catch (e) { return false; }
    },
    toggleStats: function() {
      var app = getApp();
      try {
        var stream = app && typeof app.getStream === 'function' ? app.getStream() : null;
        var stats = stream && typeof stream.getStats === 'function' ? stream.getStats() : null;
        if (stats && typeof stats.toggle === 'function') {
          stats.toggle();
          return true;
        }
      } catch (e) {}
      return false;
    }
  };

  function boot() {
    reparentHiddenKeyboard();
    patchStreamRect();
    // Retry — ViewerApp / sidebar / video renderer mount after stream.html modules load.
    var n = 0;
    var t = setInterval(function() {
      reparentHiddenKeyboard();
      patchStreamRect();
      n += 1;
      if (n >= 80) clearInterval(t);
    }, 100);
    try {
      if (typeof MutationObserver !== 'undefined' && document.documentElement && !window.__gatwyRectObserver) {
        var obs = new MutationObserver(function() { patchStreamRect(); });
        obs.observe(document.documentElement, { childList: true, subtree: true });
        window.__gatwyRectObserver = obs;
        setTimeout(function() { try { obs.disconnect(); } catch (e) {} }, 30000);
      }
    } catch (e) {}
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
`;

function mapStatus(s: SessionStatus): 'connecting' | 'connected' | 'disconnected' {
  if (s === 'streaming') return 'connected';
  if (s === 'disconnected') return 'disconnected';
  return 'connecting';
}

/**
 * Measure the visible Gatwy stream pane (surface / iframe client box).
 * Prefer clientWidth×clientHeight (excludes scrollbar gutters); fall back to
 * floored getBoundingClientRect after layout. Never use window size.
 */
function measureClientArea(el: HTMLElement | null): { width: number; height: number } {
  if (!el) return snapStreamSize(1920, 1080);
  const rect = el.getBoundingClientRect();
  const width = Math.floor(el.clientWidth > 0 ? el.clientWidth : rect.width);
  const height = Math.floor(el.clientHeight > 0 ? el.clientHeight : rect.height);
  if (width < 2 || height < 2) return snapStreamSize(1920, 1080);
  return snapStreamSize(width, height);
}

/** True when the Gatwy session (or a descendant) owns the Fullscreen API element. */
function sessionIsFullscreen(session: HTMLElement | null): boolean {
  const fsEl = document.fullscreenElement;
  return !!session && !!fsEl && (fsEl === session || session.contains(fsEl));
}

/**
 * Prefer the fullscreen element (sessionRef / document.fullscreenElement) when
 * ours is fullscreen — iframe/surface boxes can still be the pre-FS size.
 * Fall back to iframe, then the Gatwy surface.
 */
function measureStreamPane(opts: {
  session: HTMLElement | null;
  iframe: HTMLElement | null;
  surface: HTMLElement | null;
}): { width: number; height: number } {
  const { session, iframe, surface } = opts;
  const fsEl = document.fullscreenElement;
  if (session && fsEl && (fsEl === session || session.contains(fsEl))) {
    const target = fsEl instanceof HTMLElement ? fsEl : session;
    return measureClientArea(target);
  }
  return measureClientArea(iframe ?? surface);
}

/** Parent-toggled class so baked/runtime CSS can use object-fit:fill only in FS. */
function syncIframeFullscreenClass(iframe: HTMLIFrameElement | null, fullscreen: boolean): void {
  try {
    const html = iframe?.contentDocument?.documentElement;
    if (!html) return;
    html.classList.toggle('gatwy-fullscreen', fullscreen);
  } catch { /* cross-origin or not ready */ }
}

/** Common VK chords for the Gatwy-native Send key UI (Windows virtual-key codes). */
const ML_SEND_KEY_PRESETS: { value: string; label: string; keys: number[] }[] = [
  { value: 'escape', label: 'Escape', keys: [0x1b] },
  { value: 'tab', label: 'Tab', keys: [0x09] },
  { value: 'win', label: 'Win', keys: [0x5b] },
  { value: 'delete', label: 'Delete', keys: [0x2e] },
  { value: 'f11', label: 'F11', keys: [0x7a] },
  { value: 'alt-f4', label: 'Alt+F4', keys: [0x12, 0x73] },
  { value: 'ctrl-alt-del', label: 'Ctrl+Alt+Del', keys: [0x11, 0x12, 0x2e] },
  { value: 'ctrl-shift-esc', label: 'Ctrl+Shift+Esc', keys: [0x11, 0x10, 0x1b] },
  { value: 'custom', label: 'Custom VK…', keys: [] },
];

/** Parse a custom VK from hex (`0x1B`), decimal (`27`), or a few names. */
function parseCustomVk(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  const named: Record<string, number> = {
    escape: 0x1b, esc: 0x1b, tab: 0x09, win: 0x5b, meta: 0x5b,
    delete: 0x2e, del: 0x2e, return: 0x0d, enter: 0x0d, space: 0x20,
  };
  if (s in named) return named[s];
  if (/^0x[0-9a-f]{1,4}$/.test(s)) {
    const n = Number.parseInt(s, 16);
    return Number.isFinite(n) ? n : null;
  }
  if (/^\d{1,5}$/.test(s)) {
    const n = Number.parseInt(s, 10);
    return Number.isFinite(n) && n <= 0xffff ? n : null;
  }
  return null;
}

/** Write moonlight-web launch settings (bitrate/fps/size/sops/touch) before (re)loading the iframe. */
function applyMlwSettings(
  bitrateKbps: number,
  fps: number,
  resolution: string,
  clientArea: { width: number; height: number } | null,
  touchMode: string,
): { width: number; height: number } {
  const mapped = resolutionToMlwVideoSize(resolution, clientArea);
  const mode = normalizeMlTouchMode(touchMode);
  try {
    const raw = localStorage.getItem('mlSettings');
    const settings = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    settings.dataTransport = 'websocket';
    settings.bitrate = bitrateKbps;
    settings.fps = fps;
    settings.videoSize = mapped.videoSize;
    settings.videoSizeCustom = mapped.videoSizeCustom;
    settings.enterFullscreenOnStreamStart = false;
    // Moonlight Optimize game settings — required for Sunshine client resolution.
    settings.sops = true;
    settings.touchMode = mode;
    if (mode === 'localCursor') {
      const sens = Number(settings.localCursorSensitivity);
      if (!Number.isFinite(sens) || sens <= 0) settings.localCursorSensitivity = 1;
    }
    localStorage.setItem('mlSettings', JSON.stringify(settings));
  } catch { /* ignore */ }
  return mapped.videoSizeCustom;
}

/** Same-origin helpers exposed on the /mlw iframe window. */
type GatwyMlwHelpers = {
  reparentHiddenKeyboard?: () => void;
  armPointerLock?: () => void;
  lockMouse?: () => boolean;
  unlockMouse?: () => boolean;
  isPointerLocked?: () => boolean;
  showKeyboard?: () => boolean;
  hideKeyboard?: () => boolean;
  toggleKeyboard?: () => boolean;
  isKeyboardVisible?: () => boolean;
  sendKey?: (keys: number | number[], modifiers?: number) => boolean;
  toggleStats?: () => boolean;
  patchStreamRect?: () => boolean;
  setTouchMode?: (mode: string) => boolean;
};

function getGatwyMlw(iframe: HTMLIFrameElement | null): GatwyMlwHelpers | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return ((iframe?.contentWindow as any)?.__gatwyMlw as GatwyMlwHelpers) ?? null;
  } catch {
    return null;
  }
}

function injectIframeChrome(iframe: HTMLIFrameElement | null, session?: HTMLElement | null): void {
  try {
    const doc = iframe?.contentDocument;
    if (!doc?.head) return;
    if (!doc.getElementById('gatwy-mlw-chrome-style')) {
      const style = doc.createElement('style');
      style.id = 'gatwy-mlw-chrome-style';
      style.textContent = MLW_CHROME_STYLE;
      doc.head.appendChild(style);
    }
    if (!doc.getElementById('gatwy-mlw-sops-script')) {
      const script = doc.createElement('script');
      script.id = 'gatwy-mlw-sops-script';
      script.textContent = MLW_SOPS_SCRIPT;
      // Prefer earliest execution; head may already have finished parsing.
      doc.documentElement.appendChild(script);
    }
    if (!doc.getElementById('gatwy-mlw-helper-script')) {
      const script = doc.createElement('script');
      script.id = 'gatwy-mlw-helper-script';
      script.textContent = MLW_GATWY_HELPER_SCRIPT;
      doc.documentElement.appendChild(script);
    }
    const oursFs = sessionIsFullscreen(session ?? null)
      || (!!document.fullscreenElement && !!iframe && document.fullscreenElement.contains(iframe));
    syncIframeFullscreenClass(iframe, oursFs);
    // Ensure ScreenKeyboard textarea is outside the hidden sidebar.
    const helpers = getGatwyMlw(iframe);
    helpers?.reparentHiddenKeyboard?.();
    helpers?.patchStreamRect?.();
  } catch { /* cross-origin or not ready */ }
}

async function stopIframeStream(iframe: HTMLIFrameElement | null): Promise<void> {
  try {
    // moonlight-web exposes ViewerApp on window.app
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const app = (iframe?.contentWindow as any)?.app;
    const stream = app?.getStream?.();
    if (stream?.stop) {
      await Promise.race([
        stream.stop(),
        new Promise((r) => setTimeout(r, 400)),
      ]);
    }
  } catch { /* ignore */ }
}

function toggleIframeStats(iframe: HTMLIFrameElement | null): boolean {
  try {
    const helpers = getGatwyMlw(iframe);
    if (helpers?.toggleStats?.()) return true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const app = (iframe?.contentWindow as any)?.app;
    const stats = app?.getStream?.()?.getStats?.();
    if (stats?.toggle) {
      stats.toggle();
      return true;
    }
    const doc = iframe?.contentDocument;
    if (!doc) return false;
    const buttons = Array.from(doc.querySelectorAll('button'));
    const statsBtn = buttons.find((b) => {
      const t = (b.textContent || '').trim().toLowerCase();
      return t === 'stats' || t === '统计' || t.includes('stats');
    });
    if (!statsBtn) return false;
    statsBtn.click();
    return true;
  } catch {
    return false;
  }
}

export function MoonlightSession({
  connectionId,
  connectionName,
  isActive,
  onStatusChange,
  onClose,
}: MoonlightSessionProps) {
  const sessionRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  /** Cleanup for contentDocument pointer-lock listeners (re-bound on iframe load). */
  const pointerLockCleanupRef = useRef<(() => void) | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const autoCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeSizeRef = useRef<{ width: number; height: number } | null>(null);
  const streamBasePathRef = useRef<string | null>(null);
  const resizingRef = useRef(false);
  const bitrateRef = useRef(20000);
  const fpsRef = useRef(60);
  const resolutionRef = useRef(ML_RESOLUTION_AUTO);
  const touchModeRef = useRef<MlTouchMode>(defaultMlTouchMode());

  const [status, setStatus] = useState<SessionStatus>('connecting');
  const [errorMsg, setErrorMsg] = useState('');
  const [pin, setPin] = useState<string | null>(null);
  const [showPairModal, setShowPairModal] = useState(false);
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [streamEpoch, setStreamEpoch] = useState(0);
  const [appTitle, setAppTitle] = useState('Desktop');
  const [hostLabel, setHostLabel] = useState(connectionName);
  const [bitrate, setBitrate] = useState(20000);
  const [fps, setFps] = useState(60);
  const [resolution, setResolution] = useState(ML_RESOLUTION_AUTO);
  const [touchMode, setTouchMode] = useState<MlTouchMode>(defaultMlTouchMode);
  const [activeSizeLabel, setActiveSizeLabel] = useState('');
  const [reconnectCount, setReconnectCount] = useState(0);
  const [panelOpen, setPanelOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [statsOn, setStatsOn] = useState(false);
  const [mouseLocked, setMouseLocked] = useState(false);
  const [keyboardOn, setKeyboardOn] = useState(false);
  const [sendKeyPreset, setSendKeyPreset] = useState(ML_SEND_KEY_PRESETS[0].value);
  const [customVk, setCustomVk] = useState('');
  const [sendKeyHint, setSendKeyHint] = useState('');

  bitrateRef.current = bitrate;
  fpsRef.current = fps;
  resolutionRef.current = resolution;
  touchModeRef.current = touchMode;

  function setAndNotify(s: SessionStatus) {
    setStatus(s);
    onStatusChange?.(mapStatus(s));
  }

  const persistSettings = useCallback(async (patch: {
    bitrateKbps?: number;
    fps?: number;
    resolution?: string;
    touchMode?: string;
  }) => {
    try {
      await fetch(`/api/v1/moonlight/${connectionId}/settings`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
    } catch { /* ignore */ }
  }, [connectionId]);

  const auditDisconnect = useCallback(async () => {
    try {
      await fetch(`/api/v1/moonlight/${connectionId}/disconnect-audit`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionIdRef.current }),
      });
    } catch { /* ignore */ }
  }, [connectionId]);

  const handleDisconnect = useCallback(() => {
    abortRef.current?.abort();
    void auditDisconnect();
    setStreamUrl(null);
    onClose?.(connectionId);
  }, [auditDisconnect, connectionId, onClose]);

  const toggleFullscreen = useCallback(() => {
    const el = sessionRef.current;
    if (!el) return;
    if (document.fullscreenElement === el) {
      void document.exitFullscreen();
    } else if (!document.fullscreenElement) {
      void el.requestFullscreen().catch(() => undefined);
    }
  }, []);

  // Auto-open panel briefly when streaming starts (matches RDP).
  useEffect(() => {
    if (status === 'streaming') {
      setPanelOpen(true);
      if (autoCloseTimer.current) clearTimeout(autoCloseTimer.current);
      autoCloseTimer.current = setTimeout(() => setPanelOpen(false), 3000);
    }
    return () => {
      if (autoCloseTimer.current) clearTimeout(autoCloseTimer.current);
    };
  }, [status]);

  /**
   * Restart the embedded moonlight-web stream with updated launch size.
   * Moonlight/Sunshine set desktop resolution at stream start — mid-session
   * resize requires a clean stream restart (not CSS scaling).
   *
   * Pass intended resolution/bitrate/fps explicitly — do not rely on React
   * state refs synced during render (setState + immediate relaunch leaves them stale).
   */
  const relaunchStream = useCallback(async (opts: {
    width: number;
    height: number;
    resolution: string;
    bitrateKbps?: number;
    fps?: number;
    touchMode?: string;
  }) => {
    const base = streamBasePathRef.current;
    if (!base || resizingRef.current) return;
    resizingRef.current = true;
    const nextSize = { width: opts.width, height: opts.height };
    const resolution = normalizeMlResolution(opts.resolution);
    const bitrateKbps = opts.bitrateKbps ?? bitrateRef.current;
    const fps = opts.fps ?? fpsRef.current;
    const touchMode = normalizeMlTouchMode(opts.touchMode ?? touchModeRef.current);
    // Keep refs aligned before await gaps so Auto resize / concurrent handlers see the intent.
    resolutionRef.current = resolution;
    bitrateRef.current = bitrateKbps;
    fpsRef.current = fps;
    touchModeRef.current = touchMode;
    try {
      await stopIframeStream(iframeRef.current);
      applyMlwSettings(bitrateKbps, fps, resolution, nextSize, touchMode);
      activeSizeRef.current = nextSize;
      setActiveSizeLabel(`${nextSize.width}×${nextSize.height}`);
      const url = appendStreamLaunchParams(base, {
        bitrateKbps,
        fps,
        resolution,
        clientArea: nextSize,
      });
      setStreamUrl(url);
      setStreamEpoch((n) => n + 1);
    } finally {
      // Allow another resize after the new iframe has a chance to start
      setTimeout(() => { resizingRef.current = false; }, 500);
    }
  }, []);

  const statusRef = useRef(status);
  statusRef.current = status;

  /**
   * After enter/exit fullscreen, wait for layout then (Auto only) relaunch so
   * Sunshine’s intrinsic size matches the new pane. Measure the fullscreen
   * element (not a stale iframe box). Longer settle + retries if size is still
   * drifting or resizingRef is locked. Always toggle html.gatwy-fullscreen.
   */
  useEffect(() => {
    let raf1 = 0;
    let raf2 = 0;
    let settleTimer = 0;
    let wasOursFullscreen = false;

    const clearPending = () => {
      if (raf1) cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
      if (settleTimer) window.clearTimeout(settleTimer);
      raf1 = 0;
      raf2 = 0;
      settleTimer = 0;
    };

    const remeasureAutoAfterFullscreen = () => {
      const session = sessionRef.current;
      const oursNow = sessionIsFullscreen(session);
      const oursExiting = !document.fullscreenElement && wasOursFullscreen;
      wasOursFullscreen = oursNow;
      setIsFullscreen(oursNow);

      // Class toggle is independent of Auto — FS object-fit:fill safety net.
      injectIframeChrome(iframeRef.current, session);
      syncIframeFullscreenClass(iframeRef.current, oursNow);

      // Enter (ours) or exit (we were fullscreen) — ignore other elements' fullscreen.
      if (!oursNow && !oursExiting) return;
      if (resolutionRef.current !== ML_RESOLUTION_AUTO) return;
      if (statusRef.current !== 'streaming') return;

      // Drop any mid-transition ResizeObserver debounce that captured the old box.
      if (resizeTimer.current) {
        clearTimeout(resizeTimer.current);
        resizeTimer.current = null;
      }

      const attempt = (retriesLeft: number) => {
        if (resolutionRef.current !== ML_RESOLUTION_AUTO) return;
        if (statusRef.current !== 'streaming') return;
        const next = measureStreamPane({
          session: sessionRef.current,
          iframe: iframeRef.current,
          surface: surfaceRef.current,
        });
        const prev = activeSizeRef.current;
        const differs = !prev || sizesDiffer(prev, next, 2);
        // Another relaunch in flight (e.g. ResizeObserver) — retry after the lock.
        if (resizingRef.current) {
          if (retriesLeft <= 0) return;
          settleTimer = window.setTimeout(() => attempt(retriesLeft - 1), 560);
          return;
        }
        if (differs) {
          void relaunchStream({
            width: next.width,
            height: next.height,
            resolution: ML_RESOLUTION_AUTO,
          });
        }
        // Size can still drift after FS layout / relaunch — remeasure a couple times.
        if (retriesLeft > 0) {
          settleTimer = window.setTimeout(
            () => attempt(retriesLeft - 1),
            differs ? 560 : 180,
          );
        }
      };

      clearPending();
      raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => {
          // 2× rAF + ~200ms so clientWidth matches the fullscreen pane.
          settleTimer = window.setTimeout(() => attempt(3), 200);
        });
      });
    };

    // Document-level (bubbles from session element); single listener avoids double fire.
    document.addEventListener('fullscreenchange', remeasureAutoAfterFullscreen);
    return () => {
      document.removeEventListener('fullscreenchange', remeasureAutoAfterFullscreen);
      clearPending();
    };
  }, [relaunchStream]);

  // Debounced client-area resize → host resolution change (Auto mode only).
  useEffect(() => {
    if (status !== 'streaming' || resolution !== ML_RESOLUTION_AUTO) return;
    const surface = surfaceRef.current;
    if (!surface || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => {
      if (resizeTimer.current) clearTimeout(resizeTimer.current);
      resizeTimer.current = setTimeout(() => {
        if (resolutionRef.current !== ML_RESOLUTION_AUTO) return;
        if (statusRef.current !== 'streaming') return;
        // Prefer FS element when ours is fullscreen; else iframe / surface.
        const next = measureStreamPane({
          session: sessionRef.current,
          iframe: iframeRef.current,
          surface: surfaceRef.current,
        });
        const prev = activeSizeRef.current;
        if (prev && !sizesDiffer(prev, next)) return;
        void relaunchStream({
          width: next.width,
          height: next.height,
          resolution: ML_RESOLUTION_AUTO,
        });
      }, RESIZE_DEBOUNCE_MS);
    });

    observer.observe(surface);
    return () => {
      observer.disconnect();
      if (resizeTimer.current) clearTimeout(resizeTimer.current);
    };
  }, [status, resolution, relaunchStream]);

  const forgetPairing = useCallback(async () => {
    try {
      await fetch(`/api/v1/moonlight/${connectionId}/pairing`, {
        method: 'DELETE',
        credentials: 'include',
      });
    } catch { /* ignore */ }
    setStreamUrl(null);
    setPin(null);
    setStatsOn(false);
    setReconnectCount((n) => n + 1);
  }, [connectionId]);

  const handleToggleStats = useCallback(() => {
    injectIframeChrome(iframeRef.current, sessionRef.current);
    if (toggleIframeStats(iframeRef.current)) {
      setStatsOn((v) => !v);
    }
  }, []);

  const syncIframeInputState = useCallback(() => {
    const iframe = iframeRef.current;
    const helpers = getGatwyMlw(iframe);
    try {
      const docLocked = !!iframe?.contentDocument?.pointerLockElement;
      const helperLocked = !!helpers?.isPointerLocked?.();
      setMouseLocked(docLocked || helperLocked);
      if (helpers) setKeyboardOn(!!helpers.isKeyboardVisible?.());
    } catch { /* ignore */ }
  }, []);

  /**
   * Bind pointer-lock listeners on the iframe contentDocument after load.
   * Attaching in a status effect is too early / lost on navigation — ESC then
   * never flips the Gatwy panel label back to "Lock mouse".
   */
  const bindPointerLockSync = useCallback((iframe: HTMLIFrameElement | null) => {
    pointerLockCleanupRef.current?.();
    pointerLockCleanupRef.current = null;
    if (!iframe) return;
    injectIframeChrome(iframe, sessionRef.current);
    const doc = iframe.contentDocument;
    if (!doc) return;
    const onChange = () => syncIframeInputState();
    doc.addEventListener('pointerlockchange', onChange);
    doc.addEventListener('pointerlockerror', onChange);
    syncIframeInputState();
    pointerLockCleanupRef.current = () => {
      try {
        doc.removeEventListener('pointerlockchange', onChange);
        doc.removeEventListener('pointerlockerror', onChange);
      } catch { /* document already gone */ }
    };
  }, [syncIframeInputState]);

  const handleLockMouse = useCallback(() => {
    injectIframeChrome(iframeRef.current, sessionRef.current);
    const helpers = getGatwyMlw(iframeRef.current);
    if (!helpers) return;
    if (helpers.isPointerLocked?.() || iframeRef.current?.contentDocument?.pointerLockElement) {
      helpers.unlockMouse?.();
      setMouseLocked(false);
      return;
    }
    // Pointer Lock needs user activation in the iframe document. Arm next
    // stream click as fallback, then close the panel so the stream is clickable.
    helpers.lockMouse?.();
    setPanelOpen(false);
    try { iframeRef.current?.contentWindow?.focus(); } catch { /* ignore */ }
    // Poll briefly — lock may complete on this call or the next stream click.
    let n = 0;
    const t = setInterval(() => {
      syncIframeInputState();
      n += 1;
      if (n >= 40) clearInterval(t);
    }, 150);
  }, [syncIframeInputState]);

  const handleToggleKeyboard = useCallback(() => {
    injectIframeChrome(iframeRef.current, sessionRef.current);
    const helpers = getGatwyMlw(iframeRef.current);
    if (!helpers?.toggleKeyboard?.()) return;
    setKeyboardOn(!!helpers.isKeyboardVisible?.());
  }, []);

  const handleSendKey = useCallback(() => {
    injectIframeChrome(iframeRef.current, sessionRef.current);
    const helpers = getGatwyMlw(iframeRef.current);
    if (!helpers?.sendKey) {
      setSendKeyHint('Stream input not ready');
      return;
    }
    const preset = ML_SEND_KEY_PRESETS.find((p) => p.value === sendKeyPreset);
    let keys: number[] = preset?.keys ?? [];
    if (!preset || preset.value === 'custom' || keys.length === 0) {
      const parsed = parseCustomVk(customVk);
      if (parsed == null) {
        setSendKeyHint('Enter a VK as hex (0x1B) or decimal');
        return;
      }
      keys = [parsed];
    }
    const ok = helpers.sendKey(keys);
    setSendKeyHint(ok ? 'Sent' : 'Send failed');
    if (ok) {
      // Brief confirmation, then clear so the panel stays usable.
      window.setTimeout(() => setSendKeyHint((h) => (h === 'Sent' ? '' : h)), 1200);
    }
  }, [customVk, sendKeyPreset]);

  /** After iframe layout, correct Auto size if surface measure drifted (gutters / late layout). */
  const maybeCorrectAutoSize = useCallback(() => {
    if (resolutionRef.current !== ML_RESOLUTION_AUTO) return;
    if (statusRef.current !== 'streaming') return;
    const next = measureStreamPane({
      session: sessionRef.current,
      iframe: iframeRef.current,
      surface: surfaceRef.current,
    });
    const prev = activeSizeRef.current;
    if (prev && !sizesDiffer(prev, next, 2)) return;
    void relaunchStream({
      width: next.width,
      height: next.height,
      resolution: ML_RESOLUTION_AUTO,
    });
  }, [relaunchStream]);

  // Reset lock/keyboard UI when not streaming; real listeners bind on iframe onLoad.
  useEffect(() => {
    if (status !== 'streaming') {
      setMouseLocked(false);
      setKeyboardOn(false);
      pointerLockCleanupRef.current?.();
      pointerLockCleanupRef.current = null;
    }
  }, [status]);

  // __gatwyMlw postMessage bridge (ESC / OS unlock when contentDocument listener is flaky).
  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      const data = ev.data as { source?: string; type?: string; locked?: boolean } | null;
      if (!data || data.source !== 'gatwy-mlw' || data.type !== 'pointerlock') return;
      if (ev.source !== iframeRef.current?.contentWindow) return;
      setMouseLocked(!!data.locked);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // While UI thinks locked, light-poll isPointerLocked so ESC flips the label without
  // requiring the panel to reopen.
  useEffect(() => {
    if (!mouseLocked || status !== 'streaming') return;
    const id = window.setInterval(() => {
      syncIframeInputState();
    }, 300);
    return () => window.clearInterval(id);
  }, [mouseLocked, status, syncIframeInputState]);

  const handleResolutionChange = useCallback((value: string) => {
    const next = normalizeMlResolution(value);
    setResolution(next);
    // Sync immediately — setState alone leaves resolutionRef stale until the next render.
    resolutionRef.current = next;
    void persistSettings({ resolution: next });
    if (status !== 'streaming' || !streamBasePathRef.current) return;
    const area = next === ML_RESOLUTION_AUTO
      ? measureStreamPane({
          session: sessionRef.current,
          iframe: iframeRef.current,
          surface: surfaceRef.current,
        })
      : resolutionToMlwVideoSize(next, null).videoSizeCustom;
    void relaunchStream({
      width: area.width,
      height: area.height,
      resolution: next,
    });
  }, [persistSettings, relaunchStream, status]);

  const handleTouchModeChange = useCallback((value: string) => {
    const next = normalizeMlTouchMode(value);
    setTouchMode(next);
    touchModeRef.current = next;
    void persistSettings({ touchMode: next });
    // Keep mlSettings in sync so Auto relaunch / reconnect does not revert.
    applyMlwSettings(
      bitrateRef.current,
      fpsRef.current,
      resolutionRef.current,
      activeSizeRef.current,
      next,
    );
    if (status !== 'streaming') return;
    injectIframeChrome(iframeRef.current, sessionRef.current);
    const helpers = getGatwyMlw(iframeRef.current);
    if (helpers?.setTouchMode?.(next)) return;
    // ViewerApp.setInputConfig is the live path; if it is not ready, relaunch.
    if (!streamBasePathRef.current) return;
    const area = activeSizeRef.current ?? measureStreamPane({
      session: sessionRef.current,
      iframe: iframeRef.current,
      surface: surfaceRef.current,
    });
    void relaunchStream({
      width: area.width,
      height: area.height,
      resolution: resolutionRef.current,
      touchMode: next,
    });
  }, [persistSettings, relaunchStream, status]);

  const startPairing = useCallback(async (signal: AbortSignal) => {
    setShowPairModal(true);
    setAndNotify('pairing');
    setPin(null);
    setErrorMsg('');

    const res = await fetch(`/api/v1/moonlight/${connectionId}/pair`, {
      method: 'POST',
      credentials: 'include',
      signal,
    });
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(data.error || `Pairing failed (${res.status})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let paired = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        const obj = JSON.parse(line) as {
          pin?: string;
          paired?: boolean;
          error?: string;
          alreadyPaired?: boolean;
        };
        if (obj.pin) setPin(obj.pin);
        if (obj.error) throw new Error(obj.error);
        if (obj.paired) paired = true;
      }
    }

    if (!paired) throw new Error('Pairing did not complete');
    setShowPairModal(false);
    setPin(null);
  }, [connectionId]);

  const startStream = useCallback(async (
    signal: AbortSignal,
    prefs: { bitrateKbps: number; fps: number; resolution: string; touchMode: MlTouchMode },
  ) => {
    // Wait two frames so the session surface has layout before measuring Auto size.
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    let clientArea = measureStreamPane({
      session: sessionRef.current,
      iframe: iframeRef.current,
      surface: surfaceRef.current,
    });
    if (clientArea.width <= 640 && clientArea.height <= 360) {
      await new Promise((r) => setTimeout(r, 50));
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      clientArea = measureStreamPane({
        session: sessionRef.current,
        iframe: iframeRef.current,
        surface: surfaceRef.current,
      });
    }
    const launchSize = applyMlwSettings(
      prefs.bitrateKbps,
      prefs.fps,
      prefs.resolution,
      clientArea,
      prefs.touchMode,
    );

    const res = await fetch(`/api/v1/moonlight/${connectionId}/session`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bitrateKbps: prefs.bitrateKbps,
        fps: prefs.fps,
        resolution: prefs.resolution,
        touchMode: prefs.touchMode,
      }),
      signal,
    });
    const data = await res.json() as SessionResponse;
    if (res.status === 409 || data.needsPairing) {
      return 'needs-pairing' as const;
    }
    if (!res.ok) throw new Error(data.error || `Failed to start stream (${res.status})`);

    sessionIdRef.current = data.sessionId;
    streamBasePathRef.current = data.streamPath;
    setAppTitle(data.appTitle);
    setBitrate(data.bitrateKbps);
    setFps(data.fps);
    const resolvedRes = data.resolution
      ? normalizeMlResolution(data.resolution)
      : prefs.resolution;
    setResolution(resolvedRes);
    const resolvedTouch = data.touchMode
      ? normalizeMlTouchMode(data.touchMode)
      : prefs.touchMode;
    setTouchMode(resolvedTouch);
    touchModeRef.current = resolvedTouch;
    activeSizeRef.current = launchSize;
    setActiveSizeLabel(`${launchSize.width}×${launchSize.height}`);

    const url = appendStreamLaunchParams(data.streamPath, {
      bitrateKbps: data.bitrateKbps,
      fps: data.fps,
      resolution: resolvedRes,
      clientArea: launchSize,
    });
    setStreamUrl(url);
    setStreamEpoch((n) => n + 1);
    setAndNotify('streaming');
    return 'streaming' as const;
  }, [connectionId]);

  useEffect(() => {
    if (!isActive) return;

    const abort = new AbortController();
    abortRef.current = abort;
    let cancelled = false;

    async function run() {
      try {
        setAndNotify('connecting');
        setErrorMsg('');
        setStreamUrl(null);
        setShowPairModal(false);
        setStatsOn(false);
        setMouseLocked(false);
        setKeyboardOn(false);
        activeSizeRef.current = null;
        streamBasePathRef.current = null;

        const statusRes = await fetch(`/api/v1/moonlight/${connectionId}/status`, {
          credentials: 'include',
          signal: abort.signal,
        });
        const st = await statusRes.json() as StatusResponse;
        if (!statusRes.ok) throw new Error(st.error || 'Failed to query Moonlight status');
        if (!st.available) throw new Error('Moonlight runtime is not available. Set ENABLE_MOONLIGHT=1 on the container and restart.');

        setHostLabel(st.host || connectionName);
        const prefs = {
          bitrateKbps: typeof st.bitrateKbps === 'number' ? st.bitrateKbps : bitrateRef.current,
          fps: typeof st.fps === 'number' ? st.fps : fpsRef.current,
          resolution: st.resolution
            ? normalizeMlResolution(st.resolution)
            : resolutionRef.current,
          touchMode: st.touchMode
            ? normalizeMlTouchMode(st.touchMode)
            : defaultMlTouchMode(),
        };
        setBitrate(prefs.bitrateKbps);
        setFps(prefs.fps);
        setResolution(prefs.resolution);
        setTouchMode(prefs.touchMode);
        touchModeRef.current = prefs.touchMode;

        if (!st.paired) {
          await startPairing(abort.signal);
          if (cancelled) return;
        }

        const result = await startStream(abort.signal, prefs);
        if (result === 'needs-pairing') {
          await startPairing(abort.signal);
          if (cancelled) return;
          await startStream(abort.signal, prefs);
        }
      } catch (err) {
        if (cancelled || abort.signal.aborted) return;
        const msg = err instanceof Error ? err.message : 'Connection failed';
        setErrorMsg(msg);
        setShowPairModal((open) => open || msg.toLowerCase().includes('pair'));
        setAndNotify('disconnected');
      }
    }

    void run();

    return () => {
      cancelled = true;
      abort.abort();
      if (sessionIdRef.current) {
        void auditDisconnect();
        sessionIdRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, isActive, reconnectCount]);

  const statusLabel =
    status === 'streaming'
      ? 'Connected'
      : status === 'pairing'
      ? 'Waiting for PIN…'
      : status === 'disconnected'
      ? 'Disconnected'
      : status === 'connecting'
      ? 'Connecting…'
      : status;

  return (
    <div ref={sessionRef} className="absolute inset-0 flex flex-col bg-black overflow-hidden">
      <div ref={surfaceRef} className="flex-1 w-full relative overflow-hidden bg-black touch-none select-none">
        {streamUrl && status === 'streaming' ? (
          <iframe
            key={`${streamUrl}::${streamEpoch}`}
            ref={iframeRef}
            title={`Moonlight ${connectionName}`}
            src={streamUrl}
            className="absolute inset-0 w-full h-full border-0 overflow-hidden touch-none select-none"
            style={{ overflow: 'hidden', touchAction: 'none' }}
            scrolling="no"
            allow="fullscreen; autoplay; clipboard-read; clipboard-write; gamepad"
            onLoad={() => {
              injectIframeChrome(iframeRef.current, sessionRef.current);
              // Attach pointerlock listeners after load (survives streamEpoch remounts).
              bindPointerLockSync(iframeRef.current);
              syncIframeInputState();
              getGatwyMlw(iframeRef.current)?.patchStreamRect?.();
              // Correct Auto WxH once the iframe has a real content box.
              maybeCorrectAutoSize();
              // Restore focus into the stream surface for keyboard input
              try { iframeRef.current?.contentWindow?.focus(); } catch { /* ignore */ }
            }}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-text-secondary">
            {status === 'pairing' ? 'Waiting for Sunshine PIN confirmation…' : 'Preparing Moonlight stream…'}
          </div>
        )}

        {showPairModal && (
          <MoonlightPairModal
            pin={pin}
            hostLabel={hostLabel}
            error={status === 'disconnected' ? errorMsg : undefined}
            onCancel={handleDisconnect}
            onRetry={() => {
              setErrorMsg('');
              setReconnectCount((n) => n + 1);
            }}
          />
        )}
      </div>

      <DisconnectOverlay
        show={status === 'disconnected' && !showPairModal}
        message={errorMsg}
        onExit={() => onClose?.(connectionId)}
        onReconnect={() => {
          setErrorMsg('');
          setReconnectCount((n) => n + 1);
        }}
      />

      {panelOpen && (
        <div
          className="absolute inset-0 z-10"
          onClick={() => setPanelOpen(false)}
        />
      )}

      <div className="absolute right-0 top-1/2 -translate-y-1/2 z-30">
        <button
          type="button"
          onClick={() => setPanelOpen((o) => !o)}
          title="Session controls"
          className="flex flex-col items-center justify-center gap-2 w-7 py-4 bg-black/60 hover:bg-black/80 text-gray-400 hover:text-white transition-colors rounded-l-md"
          style={{ writingMode: 'vertical-rl' }}
        >
          <span
            className={`w-2.5 h-2.5 rounded-full shrink-0 ${
              status === 'disconnected'
                ? 'bg-red-500'
                : status === 'streaming'
                ? 'bg-green-500'
                : 'bg-yellow-500'
            }`}
            style={{ writingMode: 'horizontal-tb' }}
          />
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            style={{ writingMode: 'horizontal-tb' }}
            className={`transition-transform ${panelOpen ? 'rotate-180' : ''}`}
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
      </div>

      <div
        className={`absolute right-5 top-1/2 -translate-y-1/2 z-20 w-56 bg-surface/95 backdrop-blur-xs border border-border rounded-xl shadow-2xl flex flex-col gap-1 p-3 transition-all duration-200 ${
          panelOpen ? 'opacity-100 translate-x-0 pointer-events-auto' : 'opacity-0 translate-x-4 pointer-events-none'
        }`}
      >
        <div className="flex items-center gap-2 px-1 py-1.5 border-b border-border mb-1">
          <span
            className={`w-2.5 h-2.5 rounded-full shrink-0 ${
              status === 'disconnected'
                ? 'bg-red-500'
                : status === 'streaming'
                ? 'bg-green-500'
                : 'bg-yellow-500'
            }`}
          />
          <span className="text-sm text-text-primary font-medium truncate">
            {statusLabel}
          </span>
        </div>

        <div className="px-1 py-0.5">
          <p className="text-xs text-text-secondary truncate">{connectionName}</p>
          {appTitle && status === 'streaming' && (
            <p className="text-[11px] text-text-secondary/80 truncate mt-0.5">{appTitle}</p>
          )}
          {activeSizeLabel && status === 'streaming' && (
            <p className="text-[11px] text-text-secondary/80 truncate mt-0.5 tabular-nums">
              {activeSizeLabel}
              {resolution === ML_RESOLUTION_AUTO ? ' · auto' : ''}
            </p>
          )}
        </div>

        <div className="px-1 pt-1 pb-1.5 border-b border-border mb-1 flex flex-col gap-2">
          <label className="flex flex-col gap-1 text-xs text-text-primary">
            <span>Resolution</span>
            <select
              value={resolution}
              onChange={(e) => handleResolutionChange(e.target.value)}
              className="w-full bg-surface border border-border rounded-md px-1.5 py-1 text-[11px] text-text-primary focus:outline-none focus:border-accent"
              title="Auto uses this pane’s size"
            >
              {ML_RESOLUTION_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-text-primary">
            <span>Touch</span>
            <select
              value={touchMode}
              onChange={(e) => handleTouchModeChange(e.target.value)}
              className="w-full bg-surface border border-border rounded-md px-1.5 py-1 text-[11px] text-text-primary focus:outline-none focus:border-accent"
              title="How fingers control the host mouse"
            >
              {ML_TOUCH_MODE_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
            <span className="text-[10px] text-text-secondary leading-relaxed font-normal">
              {touchModeHelp(touchMode)}
            </span>
          </label>
          <label className="flex items-center justify-between gap-2 text-xs text-text-primary">
            <span>Mbps</span>
            <input
              type="number"
              min={1}
              max={150}
              value={Math.round(bitrate / 1000)}
              onChange={(e) => {
                const next = Math.max(1, parseInt(e.target.value, 10) || 20) * 1000;
                setBitrate(next);
                void persistSettings({ bitrateKbps: next });
              }}
              className="w-14 bg-surface border border-border rounded-md px-1.5 py-1 text-[11px] text-text-primary tabular-nums focus:outline-none focus:border-accent"
              title="Bitrate (applies on reconnect)"
            />
          </label>
          <label className="flex items-center justify-between gap-2 text-xs text-text-primary">
            <span>FPS</span>
            <input
              type="number"
              min={15}
              max={240}
              value={fps}
              onChange={(e) => {
                const next = Math.max(15, parseInt(e.target.value, 10) || 60);
                setFps(next);
                void persistSettings({ fps: next });
              }}
              className="w-14 bg-surface border border-border rounded-md px-1.5 py-1 text-[11px] text-text-primary tabular-nums focus:outline-none focus:border-accent"
              title="FPS (applies on reconnect)"
            />
          </label>
        </div>

        <button
          type="button"
          onClick={() => { toggleFullscreen(); setPanelOpen(false); }}
          className="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-surface-hover text-text-primary text-sm transition-colors text-left w-full"
        >
          {isFullscreen ? (
            <>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
              </svg>
              Exit Fullscreen
            </>
          ) : (
            <>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
              </svg>
              Fullscreen
            </>
          )}
        </button>

        <button
          type="button"
          onClick={handleLockMouse}
          disabled={status !== 'streaming'}
          className="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-surface-hover text-text-primary text-sm transition-colors text-left w-full disabled:opacity-40 disabled:pointer-events-none"
          title={mouseLocked ? 'Release pointer lock' : 'Lock mouse (click stream if prompted)'}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="6" y="3" width="12" height="14" rx="6" />
            <path d="M12 17v4" />
            <path d="M8 21h8" />
            <circle cx="12" cy="9" r="1" fill="currentColor" />
          </svg>
          {mouseLocked ? 'Unlock mouse' : 'Lock mouse'}
        </button>

        <button
          type="button"
          onClick={handleToggleKeyboard}
          disabled={status !== 'streaming'}
          className="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-surface-hover text-text-primary text-sm transition-colors text-left w-full disabled:opacity-40 disabled:pointer-events-none"
          title="Toggle on-screen keyboard"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="2" y="6" width="20" height="12" rx="2" />
            <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8" />
          </svg>
          {keyboardOn ? 'Hide keyboard' : 'On-screen keyboard'}
        </button>

        <button
          type="button"
          onClick={handleToggleStats}
          disabled={status !== 'streaming'}
          className="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-surface-hover text-text-primary text-sm transition-colors text-left w-full disabled:opacity-40 disabled:pointer-events-none"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 19V5" />
            <path d="M4 19h16" />
            <path d="M8 17V10" />
            <path d="M12 17V7" />
            <path d="M16 17v-5" />
          </svg>
          {statsOn ? 'Hide stats' : 'Show stats'}
        </button>

        <div className="px-2 py-2 border-t border-border mt-0.5 flex flex-col gap-1.5">
          <div className="flex items-center gap-2 text-text-primary text-sm">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0">
              <path d="M4 7h16v10H4z" />
              <path d="M8 11h.01M12 11h.01M16 11h.01M9 15h6" />
            </svg>
            <span>Send key</span>
          </div>
          <select
            value={sendKeyPreset}
            onChange={(e) => {
              setSendKeyPreset(e.target.value);
              setSendKeyHint('');
            }}
            disabled={status !== 'streaming'}
            className="w-full bg-surface border border-border rounded-md px-1.5 py-1 text-[11px] text-text-primary focus:outline-none focus:border-accent disabled:opacity-40"
            title="Send a key to the host"
          >
            {ML_SEND_KEY_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
          {sendKeyPreset === 'custom' && (
            <input
              type="text"
              value={customVk}
              onChange={(e) => {
                setCustomVk(e.target.value);
                setSendKeyHint('');
              }}
              disabled={status !== 'streaming'}
              placeholder="0x1B or 27"
              className="w-full bg-surface border border-border rounded-md px-1.5 py-1 text-[11px] text-text-primary tabular-nums focus:outline-none focus:border-accent disabled:opacity-40"
              title="Windows virtual-key code (hex or decimal)"
            />
          )}
          <button
            type="button"
            onClick={handleSendKey}
            disabled={status !== 'streaming'}
            className="w-full py-1.5 px-2 text-[11px] bg-accent/90 hover:bg-accent text-white rounded-md font-medium transition-colors disabled:opacity-40 disabled:pointer-events-none"
          >
            Send
          </button>
          {sendKeyHint && (
            <p className="text-[10px] text-text-secondary leading-relaxed">{sendKeyHint}</p>
          )}
        </div>

        <button
          type="button"
          onClick={() => { void forgetPairing(); setPanelOpen(false); }}
          className="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-surface-hover text-text-primary text-sm transition-colors text-left w-full"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 6h18" />
            <path d="M8 6V4h8v2" />
            <path d="M19 6l-1 14H6L5 6" />
          </svg>
          Forget pairing
        </button>

        <div className="border-t border-border mt-1 pt-1">
          <button
            type="button"
            onClick={() => { handleDisconnect(); setPanelOpen(false); }}
            className="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-red-500/10 text-red-400 text-sm transition-colors text-left w-full"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
              <line x1="12" y1="2" x2="12" y2="12" />
            </svg>
            Disconnect
          </button>
        </div>
      </div>
    </div>
  );
}
