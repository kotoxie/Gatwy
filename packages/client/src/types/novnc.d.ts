declare module '@novnc/novnc' {
  interface RFBOptions {
    credentials?: {
      username?: string;
      password?: string;
      target?: string;
    };
    shared?: boolean;
    repeaterID?: string;
    wsProtocols?: string | string[];
  }

  interface RFBEventMap {
    connect: CustomEvent<{ securityResult: unknown }>;
    disconnect: CustomEvent<{ clean: boolean; reason?: string }>;
    securityfailure: CustomEvent<{ status: number; reason?: string }>;
    credentialsrequired: CustomEvent<{ types: string[] }>;
    clippingviewport: CustomEvent<{ detail: boolean }>;
    bell: Event;
    desktopname: CustomEvent<{ name: string }>;
    clipboard: CustomEvent<{ text: string }>;
    capabilities: CustomEvent<{ capabilities: Record<string, boolean> }>;
  }

  class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: RFBOptions);

    scaleViewport: boolean;
    resizeSession: boolean;
    showDotCursor: boolean;
    background: string;
    readonly capabilities: Record<string, boolean>;
    viewOnly: boolean;
    clipViewport: boolean;
    dragViewport: boolean;
    qualityLevel: number;
    compressionLevel: number;
    focusOnClick: boolean;
    /** Internal noVNC Display; used to remap pointer coords. */
    _display?: {
      absX: (n: number) => number;
      absY: (n: number) => number;
    };

    disconnect(): void;
    sendCredentials(creds: { username?: string; password?: string; target?: string }): void;
    sendKey(keysym: number, code: string, down?: boolean): void;
    sendCtrlAltDel(): void;
    machineShutdown(): void;
    machineReboot(): void;
    machineReset(): void;
    clipboardPasteFrom(text: string): void;
    getImageData(): ImageData | undefined;
    toDataURL(type?: string, encoderOptions?: number): string | undefined;
    toBlob(callback: BlobCallback, type?: string, quality?: number): void;

    addEventListener<K extends keyof RFBEventMap>(
      type: K,
      listener: (ev: RFBEventMap[K]) => void,
      options?: boolean | AddEventListenerOptions,
    ): void;
    removeEventListener<K extends keyof RFBEventMap>(
      type: K,
      listener: (ev: RFBEventMap[K]) => void,
      options?: boolean | EventListenerOptions,
    ): void;
  }

  export default RFB;
}
