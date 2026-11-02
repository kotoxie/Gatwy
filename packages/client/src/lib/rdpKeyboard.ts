// PS/2 Set-1 scancode → KeyboardEvent.code mapping
export const SCANCODE_TO_CODE: Record<number, string> = {
  0x0001:'Escape',0x0002:'Digit1',0x0003:'Digit2',0x0004:'Digit3',0x0005:'Digit4',
  0x0006:'Digit5',0x0007:'Digit6',0x0008:'Digit7',0x0009:'Digit8',0x000A:'Digit9',
  0x000B:'Digit0',0x000C:'Minus',0x000D:'Equal',0x000E:'Backspace',0x000F:'Tab',
  0x0010:'KeyQ',0x0011:'KeyW',0x0012:'KeyE',0x0013:'KeyR',0x0014:'KeyT',
  0x0015:'KeyY',0x0016:'KeyU',0x0017:'KeyI',0x0018:'KeyO',0x0019:'KeyP',
  0x001A:'BracketLeft',0x001B:'BracketRight',0x001C:'Enter',0x001D:'ControlLeft',
  0x001E:'KeyA',0x001F:'KeyS',0x0020:'KeyD',0x0021:'KeyF',0x0022:'KeyG',
  0x0023:'KeyH',0x0024:'KeyJ',0x0025:'KeyK',0x0026:'KeyL',0x0027:'Semicolon',
  0x0028:'Quote',0x0029:'Backquote',0x002A:'ShiftLeft',0x002B:'Backslash',
  0x002C:'KeyZ',0x002D:'KeyX',0x002E:'KeyC',0x002F:'KeyV',0x0030:'KeyB',
  0x0031:'KeyN',0x0032:'KeyM',0x0033:'Comma',0x0034:'Period',0x0035:'Slash',
  0x0036:'ShiftRight',0x0037:'NumpadMultiply',0x0038:'AltLeft',0x0039:'Space',
  0x003A:'CapsLock',0x003B:'F1',0x003C:'F2',0x003D:'F3',0x003E:'F4',
  0x003F:'F5',0x0040:'F6',0x0041:'F7',0x0042:'F8',0x0043:'F9',0x0044:'F10',
  0x0045:'Pause',0x0046:'ScrollLock',0x0047:'Numpad7',0x0048:'Numpad8',
  0x0049:'Numpad9',0x004A:'NumpadSubtract',0x004B:'Numpad4',0x004C:'Numpad5',
  0x004D:'Numpad6',0x004E:'NumpadAdd',0x004F:'Numpad1',0x0050:'Numpad2',
  0x0051:'Numpad3',0x0052:'Numpad0',0x0053:'NumpadDecimal',0x0056:'IntlBackslash',
  0x0057:'F11',0x0058:'F12',0x0059:'NumpadEqual',
  0x0064:'F13',0x0065:'F14',0x0066:'F15',0x0067:'F16',0x0068:'F17',
  0x0069:'F18',0x006A:'F19',0x006B:'F20',0x006C:'F21',0x006D:'F22',
  0x006E:'F23',0x0070:'KanaMode',0x0071:'Lang2',0x0072:'Lang1',0x0073:'IntlRo',
  0x0076:'F24',0x0079:'Convert',0x007B:'NonConvert',0x007D:'IntlYen',0x007E:'NumpadComma',
  0xE010:'MediaTrackPrevious',0xE019:'MediaTrackNext',0xE01C:'NumpadEnter',
  0xE01D:'ControlRight',0xE022:'MediaPlayPause',0xE024:'MediaStop',
  0xE032:'BrowserHome',0xE035:'NumpadDivide',0xE037:'PrintScreen',
  0xE038:'AltRight',0xE045:'NumLock',0xE047:'Home',0xE048:'ArrowUp',
  0xE049:'PageUp',0xE04B:'ArrowLeft',0xE04D:'ArrowRight',0xE04F:'End',
  0xE050:'ArrowDown',0xE051:'PageDown',0xE052:'Insert',0xE053:'Delete',
  0xE05B:'MetaLeft',0xE05C:'MetaRight',0xE05D:'ContextMenu',
  0xE06C:'LaunchMail',0xE020:'AudioVolumeMute',0xE02E:'AudioVolumeDown',0xE030:'AudioVolumeUp',
};
export const CODE_TO_SCANCODE: Record<string, number> = Object.fromEntries(
  Object.entries(SCANCODE_TO_CODE).map(([sc, code]) => [code, Number(sc)])
);

// Held modifiers must not forward browser auto-repeat: IronRDP turns a press of
// an already-pressed key into release+press, so the remote sees rapid taps
// (Sticky Keys prompt, IME Shift toggles).
export const NO_REPEAT_CODES = new Set([
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight',
  'MetaLeft', 'MetaRight',
]);

// Lock key state reaches the remote only through RdpSession's syncLockKeys. Forwarding the key
// as well toggles it a second time whenever the browser already reports the new
// state on keydown (Chrome on Windows), leaving the remote inverted.
export const LOCK_CODES = new Set(['CapsLock', 'NumLock', 'ScrollLock']);

export type RdpKeyEvent =
  Pick<KeyboardEvent, 'type' | 'code' | 'key' | 'repeat' | 'ctrlKey' | 'altKey' | 'metaKey'> &
  Partial<Pick<KeyboardEvent, 'getModifierState'>>;

export type RdpKeyAction =
  | { kind: 'scancode'; pressed: boolean; scancode: number }
  | { kind: 'unicode'; pressed: boolean; key: string };

/**
 * What to send to the RDP session for a browser key event, or null to send nothing.
 * With `unicodeMode`, printable characters are sent as characters rather than scancodes, so the
 * result no longer depends on the keyboard layout active on the remote machine.
 */
export function rdpKeyAction(e: RdpKeyEvent, unicodeMode = false): RdpKeyAction | null {
  if (LOCK_CODES.has(e.code)) return null;
  if (e.repeat && NO_REPEAT_CODES.has(e.code)) return null;

  const pressed = e.type === 'keydown';
  if (unicodeMode && e.key.length === 1 && !e.metaKey) {
    // AltGr is reported as Ctrl+Alt on Windows; it still produces a printable character.
    const altGr = e.getModifierState?.('AltGraph') === true;
    if (altGr || (!e.ctrlKey && !e.altKey)) return { kind: 'unicode', pressed, key: e.key };
  }
  const scancode = CODE_TO_SCANCODE[e.code];
  if (scancode !== undefined) return { kind: 'scancode', pressed, scancode };
  // Keys with no scancode mapping fall back to sending the character itself.
  if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) return { kind: 'unicode', pressed, key: e.key };
  return null;
}
