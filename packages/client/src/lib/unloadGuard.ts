// Browsers reserve Ctrl+W, so a terminal can't swallow it: nano's search closes the tab instead.
// The best we can do is ask for confirmation while an interactive terminal session is live.
const TERMINAL_PROTOCOLS = new Set(['ssh', 'telnet']);

export function hasLiveTerminalSession(tabs: ReadonlyArray<{ protocol: string; status: string }>): boolean {
  return tabs.some((t) => TERMINAL_PROTOCOLS.has(t.protocol) && t.status === 'connected');
}

export function confirmUnload(e: { preventDefault(): void; returnValue?: unknown }): void {
  e.preventDefault();
  e.returnValue = ''; // legacy browsers only show the prompt when this is set
}
