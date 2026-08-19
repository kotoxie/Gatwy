/**
 * SSH Command Tracker — records commands from the server-side echo stream.
 *
 * Strategy:
 * - Run a minimal VT100 line buffer over the server output
 * - Track "waiting for command" state (set after each prompt is detected)
 * - Each \r\n while waiting = submitted command line → strip prompt → record
 * - Watch for the next prompt to mark command complete and collect output preview
 * - Detect password prompts in output → redact the next \r\n submission
 * - Persist each command to the ssh_commands table
 *
 * Accurately captures: directly typed commands, tab-completed commands,
 * history-recalled commands (Up/Down arrow), pasted commands.
 *
 * Known limitation: multi-line constructs (heredocs, for-loops spanning
 * multiple lines) are stored as separate per-line entries.
 */

import { v4 as uuid } from 'uuid';
import { execute } from '../db/helpers.js';

// Common shell prompt endings: $, #, %, >, »
const PROMPT_RE = /[$#%>»]\s*$/;

// Password prompt patterns — triggers redaction of the next keystroke input.
// Matches prompts like:
//   [sudo] password for user:
//   Password:
//   Enter passphrase for key '...':
//   Enter password:
//   PIN:
const PASSWORD_PROMPT_RE = /\bpassword\b[^:]*:\s*$|enter\s+passphrase\b[^:]*:\s*$|enter\s+password\s*:\s*$|\bpin\s*:\s*$/i;

/**
 * Minimal VT100 line buffer.
 *
 * Maintains the text currently on the active terminal line by processing
 * the server-side echo stream.
 *
 * Handles the ANSI/readline sequences bash/zsh emit for:
 *   - Normal char echo
 *   - History navigation  (\r + \x1b[K + rewrite)
 *   - Tab completion      (\x1b[nD + suffix, or full line rewrite)
 *   - Backspace display   (\x08)
 *   - Cursor movement     (\x1b[nD / \x1b[nC / \x1b[nG)
 *   - Line erase          (\x1b[K / \x1b[2K)
 *   - Char delete/insert  (\x1b[nP / \x1b[n@)
 */
class LineBuf {
  private line = '';
  private col = 0;
  private inEsc = false;
  private escBuf = '';

  /**
   * Feed a chunk of server output.
   * Returns one entry per \r\n: the line content captured just before the break.
   */
  feed(data: string): string[] {
    const completed: string[] = [];
    for (const ch of data) {
      if (this.inEsc) {
        this.escBuf += ch;
        if (/[A-Za-z~]/.test(ch)) {
          this.applyEsc(this.escBuf);
          this.inEsc = false;
          this.escBuf = '';
        }
        continue;
      }
      if (ch === '\x1b') { this.inEsc = true; this.escBuf = ''; continue; }

      if (ch === '\r') {
        // Carriage return: move cursor to col 0 but keep content.
        // A full-line rewrite (history/completion) always follows with \x1b[K.
        this.col = 0;
      } else if (ch === '\n') {
        completed.push(this.line);
        this.line = '';
        this.col = 0;
      } else if (ch === '\x08') {
        if (this.col > 0) this.col--;
      } else if (ch >= ' ') {
        // Printable — overwrite at cursor position
        if (this.col < this.line.length) {
          this.line = this.line.slice(0, this.col) + ch + this.line.slice(this.col + 1);
        } else {
          this.line += ch;
        }
        this.col++;
      }
    }
    return completed;
  }

  private applyEsc(seq: string): void {
    if (!seq.startsWith('[')) return; // Only handle CSI sequences
    const term = seq[seq.length - 1];
    const inner = seq.slice(1, -1);
    const n = Math.max(1, parseInt(inner || '1', 10));
    const n0 = parseInt(inner || '0', 10); // for K where 0 has distinct meaning

    switch (term) {
      case 'K': // Erase in line: 0=to end, 1=to start, 2=whole
        if (n0 === 0) this.line = this.line.slice(0, this.col);
        else if (n0 === 1) this.line = ' '.repeat(this.col) + this.line.slice(this.col);
        else { this.line = ''; this.col = 0; }
        break;
      case 'D': this.col = Math.max(0, this.col - n); break;                                // cursor back
      case 'C': this.col = Math.min(this.line.length, this.col + n); break;                  // cursor forward
      case 'G': this.col = Math.max(0, n - 1); break;                                        // cursor to column (1-based)
      case 'P': this.line = this.line.slice(0, this.col) + this.line.slice(this.col + n); break; // delete n chars
      case '@': this.line = this.line.slice(0, this.col) + ' '.repeat(n) + this.line.slice(this.col); break; // insert n blanks
    }
  }
}

export class CommandTracker {
  private sessionDbId: string;
  private castStart: number;
  private lineBuf = new LineBuf();

  // Last command that was submitted (Enter pressed) but not yet stored
  private pendingCommand: string | null = null;
  private pendingTimestamp: string | null = null;
  private pendingElapsed = 0;

  // Collect output after the command is sent
  private outputBuf = '';
  private outputLines = 0;
  private static readonly MAX_OUTPUT_PREVIEW_LINES = 10;
  private static readonly MAX_OUTPUT_PREVIEW_CHARS = 2000;

  // Track whether we've seen the first prompt (skip login banner)
  private seenFirstPrompt = false;

  // True after a prompt is detected — next \r\n in echo stream is a command
  private waitingForCommand = false;

  // Password prompt detection — next \r\n will be redacted
  private awaitingPassword = false;

  // Flush timer — if no prompt detected within a timeout, store command anyway
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly FLUSH_TIMEOUT_MS = 10_000;

  constructor(sessionDbId: string, castStart: number) {
    this.sessionDbId = sessionDbId;
    this.castStart = castStart;
  }

  /**
   * Feed user keystrokes heading to the SSH server.
   * Command detection is now driven by the server echo stream;
   * only Ctrl+C needs handling here.
   */
  feedInput(data: string): void {
    if (data.includes('\x03')) {
      // Ctrl+C — cancel any pending command and return to waiting state
      if (this.pendingCommand !== null) {
        this.storeCommand('^C');
      }
      this.waitingForCommand = true;
    }
  }

  /** Feed shell output data (arriving from the remote SSH server). */
  feedOutput(data: string): void {
    // Step 1: run through the VT100 line buffer.
    // completedLines contains the echo of each submitted command line.
    const completedLines = this.lineBuf.feed(data);
    for (const line of completedLines) {
      this.onLineCompleted(line);
    }

    // Step 2: accumulate output preview for the active pending command.
    // Done AFTER lineBuf processing so setPending() has already reset outputBuf.
    if (this.pendingCommand !== null) {
      this.outputBuf += data;
      this.outputLines += (data.match(/\n/g) || []).length;
    }

    // Step 3: detect next prompt or password prompt in the output tail
    const tail = (this.pendingCommand !== null ? this.outputBuf : data).slice(-400);
    const lastLine = tail.split('\n').pop() || '';
    // Strip ANSI CSI and OSC sequences before regex matching — shells like Kali zsh
    // wrap the prompt character in color codes (e.g. \x1b[34m$\x1b[0m), which would
    // otherwise prevent PROMPT_RE from seeing the trailing $ / #.
    const strippedLastLine = lastLine
      .replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')   // CSI sequences
      .replace(/\x1B\][^\x07]*\x07/g, '');       // OSC sequences (e.g. window title)

    if (PASSWORD_PROMPT_RE.test(strippedLastLine)) {
      this.awaitingPassword = true;
      return;
    }

    if (PROMPT_RE.test(strippedLastLine)) {
      if (!this.seenFirstPrompt) {
        this.seenFirstPrompt = true;
        this.waitingForCommand = true;
        return;
      }
      if (this.pendingCommand !== null) {
        this.storeCommand();
      }
      this.waitingForCommand = true;
    }
  }

  /** Called when the session ends — flush any pending command. */
  flush(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (this.pendingCommand !== null) this.storeCommand();
  }

  /**
   * Called for each \r\n completed line in the server output.
   * When waitingForCommand is true, this line is the echo of what the user submitted.
   */
  private onLineCompleted(line: string): void {
    if (!this.seenFirstPrompt) return;

    // Password submission takes priority — the echoed line is blank/masked
    if (this.awaitingPassword) {
      this.awaitingPassword = false;
      this.waitingForCommand = false;
      if (this.pendingCommand !== null) this.storeCommand();
      this.setPending('[password]');
      return;
    }

    if (!this.waitingForCommand) return;

    const command = this.extractCommand(line);
    if (!command) return;

    this.waitingForCommand = false;
    if (this.pendingCommand !== null) this.storeCommand();
    this.setPending(command);
  }

  /**
   * Strip the shell prompt prefix from an echoed input line.
   * e.g. "user@host:~$ ./install.sh" → "./install.sh"
   *      "root@box:/# ls -la"        → "ls -la"
   * Returns empty string if no prompt pattern is found (not a command echo).
   */
  private extractCommand(line: string): string {
    // Non-greedy match: anything up to and including the first prompt-ender + space
    const m = line.match(/^.*?[$#%>»]\s+/);
    if (!m) return '';
    return line.slice(m[0].length).trim();
  }

  private setPending(command: string): void {
    this.pendingCommand = command;
    this.pendingTimestamp = new Date().toISOString();
    this.pendingElapsed = (Date.now() - this.castStart) / 1000;
    this.outputBuf = '';
    this.outputLines = 0;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      if (this.pendingCommand !== null) this.storeCommand();
    }, CommandTracker.FLUSH_TIMEOUT_MS);
  }

  private storeCommand(override?: string): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }

    const command = override ?? this.pendingCommand;
    if (!command) { this.resetPending(); return; }

    // Build output preview — strip the first line (echo of the command itself)
    let preview = this.outputBuf;
    if (command === '[password]') {
      preview = '';
    } else {
      const firstNewline = preview.indexOf('\n');
      if (firstNewline !== -1) preview = preview.slice(firstNewline + 1);
      const lines = preview.split('\n');
      if (lines.length > CommandTracker.MAX_OUTPUT_PREVIEW_LINES) {
        preview = lines.slice(0, CommandTracker.MAX_OUTPUT_PREVIEW_LINES).join('\n') + '\n...';
      }
      if (preview.length > CommandTracker.MAX_OUTPUT_PREVIEW_CHARS) {
        preview = preview.slice(0, CommandTracker.MAX_OUTPUT_PREVIEW_CHARS) + '...';
      }
      // Strip ANSI escape codes for cleaner storage
      preview = preview.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').trim();
    }

    const timestamp = this.pendingTimestamp || new Date().toISOString();
    const elapsed = this.pendingElapsed || (Date.now() - this.castStart) / 1000;

    try {
      execute(
        'INSERT INTO ssh_commands (id, session_id, timestamp, elapsed, command, output_preview) VALUES (?, ?, ?, ?, ?, ?)',
        [uuid(), this.sessionDbId, timestamp, elapsed, command, preview || null],
      );
    } catch (err) {
      console.error('[CommandTracker] Failed to store command:', err);
    }

    this.resetPending();
  }

  private resetPending(): void {
    this.pendingCommand = null;
    this.pendingTimestamp = null;
    this.pendingElapsed = 0;
    this.outputBuf = '';
    this.outputLines = 0;
  }
}
