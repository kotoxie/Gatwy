// Browsers reserve Ctrl+W, so a terminal can't swallow it: nano's search closes the tab instead.
// The best we can do is ask for confirmation while an interactive terminal session is live.
const TERMINAL_PROTOCOLS = new Set(['ssh', 'telnet']);

// Terminal sessions reattach after a reload, so a reload shortcut must not trigger the prompt.
const RELOAD_WINDOW_MS = 1000;
let reloadShortcutAt = -Infinity;

export function hasLiveTerminalSession(tabs: ReadonlyArray<{ protocol: string; status: string }>): boolean {
  return tabs.some((t) => TERMINAL_PROTOCOLS.has(t.protocol) && t.status === 'connected');
}

interface KeyLike { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; defaultPrevented: boolean }

// A terminal that handled the key (e.g. Ctrl+R reverse search, F5 sent to the remote) calls
// preventDefault(), so the browser does not reload and the prompt must stay armed.
export function isReloadShortcut(e: KeyLike): boolean {
  if (e.defaultPrevented || e.altKey) return false;
  const key = e.key.toLowerCase();
  return key === 'f5' || ((e.ctrlKey || e.metaKey) && key === 'r');
}

export function noteReloadShortcut(e: KeyLike, now = Date.now()): void {
  if (isReloadShortcut(e)) reloadShortcutAt = now;
}

export function confirmUnload(e: { preventDefault(): void; returnValue?: unknown }, now = Date.now()): void {
  if (now - reloadShortcutAt < RELOAD_WINDOW_MS) return;
  e.preventDefault();
  e.returnValue = ''; // legacy browsers only show the prompt when this is set
}
