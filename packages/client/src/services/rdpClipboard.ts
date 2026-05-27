/**
 * RDP Clipboard Service — adapted from IronRDP's official ClipboardService pattern.
 *
 * Uses a 100ms polling loop to detect local clipboard changes and sync them to the
 * remote RDP session. Supports text and image (PNG) clipboard data on Chromium, with
 * graceful text-only fallback for Firefox.
 */

type ClipboardDataCtor = new () => {
  addText(mimeType: string, text: string): void;
  addBinary(mimeType: string, binary: Uint8Array): void;
  isEmpty(): boolean;
  items(): Array<{ mimeType(): string; value(): unknown }>;
};

type SessionLike = {
  onClipboardPaste(data: unknown): Promise<void>;
};

enum ClipboardApiSupport {
  None = 0,
  TextOnly = 1,
  Full = 2,
}

export interface RdpClipboardServiceOptions {
  ClipboardData: ClipboardDataCtor;
  onWarning?: (msg: string) => void;
}

export class RdpClipboardService {
  private ClipboardData: ClipboardDataCtor;
  private onWarning?: (msg: string) => void;

  private session: SessionLike | null = null;
  private apiSupport: ClipboardApiSupport = ClipboardApiSupport.None;
  private monitorTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private monitoringSuppressed = false;

  private lastClientClipboardItems: Record<string, string | Uint8Array> = {};
  private lastReceivedClipboardData: Record<string, string | Uint8Array> = {};
  private lastSentClipboardData: unknown = null;
  private lastMonitorError: string | null = null;

  constructor(options: RdpClipboardServiceOptions) {
    this.ClipboardData = options.ClipboardData;
    this.onWarning = options.onWarning;
  }

  async init(): Promise<void> {
    if (!window.isSecureContext) {
      this.onWarning?.('Clipboard is available only in secure contexts (HTTPS).');
      return;
    }

    if (!navigator.clipboard) {
      this.onWarning?.('Clipboard API not available.');
      return;
    }

    if (typeof navigator.clipboard.read === 'function' && typeof navigator.clipboard.write === 'function') {
      this.apiSupport = ClipboardApiSupport.Full;
    } else if (typeof navigator.clipboard.readText === 'function') {
      this.apiSupport = ClipboardApiSupport.TextOnly;
    } else if (typeof navigator.clipboard.writeText === 'function') {
      this.apiSupport = ClipboardApiSupport.TextOnly;
    }

    if (this.apiSupport === ClipboardApiSupport.Full) {
      try {
        const status = await navigator.permissions.query({
          name: 'clipboard-read' as PermissionName,
        });
        if (status.state === 'denied') {
          this.apiSupport = ClipboardApiSupport.TextOnly;
        }
      } catch {
        try {
          await navigator.clipboard.read();
        } catch {
          this.apiSupport = ClipboardApiSupport.TextOnly;
        }
      }
    }

    if (this.apiSupport === ClipboardApiSupport.None) {
      this.onWarning?.('Clipboard not supported in this browser.');
    }
  }

  setSession(session: SessionLike): void {
    this.session = session;
  }

  suppressMonitoring(): void {
    this.monitoringSuppressed = true;
  }

  resumeMonitoring(): void {
    this.monitoringSuppressed = false;
  }

  startMonitoring(): void {
    if (this.apiSupport === ClipboardApiSupport.Full) {
      this.scheduleMonitor();
    }
  }

  dispose(): void {
    this.destroyed = true;
    if (this.monitorTimer !== null) {
      clearTimeout(this.monitorTimer);
      this.monitorTimer = null;
    }
    this.session = null;
  }

  /**
   * Called by IronRDP's `forceClipboardUpdateCallback`.
   * Sends the last known clipboard state to the remote (or empty if none).
   */
  onForceClipboardUpdate = (): void => {
    if (!this.session) return;
    try {
      if (this.lastSentClipboardData) {
        this.session.onClipboardPaste(this.lastSentClipboardData).catch(() => {});
      } else {
        const empty = new this.ClipboardData();
        this.session.onClipboardPaste(empty).catch(() => {});
      }
    } catch {
      // Swallow — never let forceClipboardUpdate throw
    }
  };

  /**
   * Called by IronRDP's `remoteClipboardChangedCallback`.
   * Writes the remote clipboard data to the local clipboard.
   */
  onRemoteClipboardChanged = (clipData: { items(): Array<{ mimeType(): string; value(): unknown }> }): void => {
    const items = clipData.items() ?? [];
    if (items.length === 0) return;

    if (this.apiSupport === ClipboardApiSupport.Full) {
      this.writeFullClipboard(items);
    } else {
      this.writeTextClipboard(items);
    }
  };

  private writeFullClipboard(items: Array<{ mimeType(): string; value(): unknown }>): void {
    const record: Record<string, Blob> = {};
    const cacheRecord: Record<string, string | Uint8Array> = {};

    for (const item of items) {
      const mime = item.mimeType();
      const value = item.value();

      if (mime.startsWith('text/') && typeof value === 'string') {
        const decoded = this.decodeCfHtmlBlob(value) ?? value;
        record[mime] = new Blob([decoded], { type: mime });
        cacheRecord[mime] = decoded;
      } else if (mime.startsWith('image/') && value instanceof Uint8Array) {
        record[mime] = new Blob([value as BlobPart], { type: mime });
        cacheRecord[mime] = value;
      }
    }

    if (Object.keys(record).length === 0) return;

    this.lastReceivedClipboardData = cacheRecord;

    const writeClipboard = () => {
      const clipboardItem = new ClipboardItem(record);
      navigator.clipboard.write([clipboardItem]).catch(() => {});
    };

    if (document.hasFocus()) {
      writeClipboard();
    } else {
      const handler = () => {
        writeClipboard();
        window.removeEventListener('focus', handler);
      };
      window.addEventListener('focus', handler);
    }
  }

  private writeTextClipboard(items: Array<{ mimeType(): string; value(): unknown }>): void {
    for (const item of items) {
      const mime = item.mimeType();
      if (mime.startsWith('text/')) {
        const value = item.value();
        if (typeof value === 'string' && value.length > 0) {
          const decoded = this.decodeCfHtmlBlob(value) ?? value;
          this.lastReceivedClipboardData = { [mime]: decoded };
          navigator.clipboard.writeText(decoded).catch(() => {});
          return;
        }
      }
    }
  }

  /**
   * Windows CF_HTML clipboard format arrives via IronRDP under text/plain MIME
   * with UTF-8 bytes packed into UTF-16 code units (low byte first, high byte
   * second). The first char of a CF_HTML blob is always U+6556 ("Ve" of
   * "Version:"). This decodes it back to plain text, extracting the inner
   * fragment content.
   */
  private decodeCfHtmlBlob(s: string): string | null {
    if (s.charCodeAt(0) !== 0x6556) return null;
    const bytes: number[] = [];
    for (let i = 0; i < s.length; i++) {
      const cp = s.charCodeAt(i);
      bytes.push(cp & 0xff);
      bytes.push((cp >> 8) & 0xff);
    }
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0) end--;
    const decoded = new TextDecoder('utf-8').decode(new Uint8Array(bytes.slice(0, end)));
    const fragMatch = decoded.match(/<!--StartFragment-->([\s\S]*?)<!--EndFragment-->/);
    const html = fragMatch
      ? fragMatch[1]
      : decoded.replace(/^Version:[\s\S]*?<body[^>]*>/i, '').replace(/<\/body[\s\S]*$/i, '');
    // If the fragment is a single anchor, prefer the href
    const hrefMatch = html.match(/<a\s[^>]*href="([^"]+)"[^>]*>/i);
    if (hrefMatch) return hrefMatch[1].trim() || null;
    return html.replace(/<[^>]+>/g, '').trim() || null;
  }

  private scheduleMonitor(): void {
    if (this.destroyed) return;
    this.monitorTimer = setTimeout(() => this.monitorClipboard(), 100);
  }

  private async monitorClipboard(): Promise<void> {
    let stopped = false;
    try {
      if (this.monitoringSuppressed || !document.hasFocus()) return;

      const clipboardItems = await navigator.clipboard.read();
      if (clipboardItems.length === 0) return;

      const item = clipboardItems[0];
      if (!item.types.some((t: string) => t.startsWith('text/') || t === 'image/png')) return;

      const values: Record<string, string | Uint8Array> = {};
      let changed = false;

      for (const kind of item.types) {
        const isText = kind.startsWith('text/');
        const blob = await item.getType(kind);
        const value: string | Uint8Array = isText
          ? await blob.text()
          : new Uint8Array(await blob.arrayBuffer());

        const prev = this.lastClientClipboardItems[kind];
        if (!this.isEqual(prev, value)) {
          if (this.isEqual(this.lastReceivedClipboardData[kind], value)) {
            this.lastClientClipboardItems[kind] = this.lastReceivedClipboardData[kind];
          } else {
            changed = true;
          }
        }

        values[kind] = value;
      }

      if (changed && this.session) {
        this.lastClientClipboardItems = values;
        const clipData = new this.ClipboardData();

        for (const [key, value] of Object.entries(values)) {
          if (value == null) continue;
          if (key.startsWith('text/') && typeof value === 'string') {
            clipData.addText(key, value);
          } else if (key.startsWith('image/') && value instanceof Uint8Array) {
            clipData.addBinary(key, value);
          }
        }

        if (!clipData.isEmpty()) {
          this.lastSentClipboardData = clipData;
          await this.session.onClipboardPaste(clipData);
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        this.apiSupport = ClipboardApiSupport.TextOnly;
        stopped = true;
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== this.lastMonitorError) {
        this.lastMonitorError = msg;
      }
    } finally {
      if (!stopped && !this.destroyed) {
        this.scheduleMonitor();
      }
    }
  }

  private isEqual(a: string | Uint8Array | undefined, b: string | Uint8Array | undefined): boolean {
    if (a === b) return true;
    if (a === undefined || b === undefined) return false;
    if (typeof a === 'string' || typeof b === 'string') return a === b;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }
}
