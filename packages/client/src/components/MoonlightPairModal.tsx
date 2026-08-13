interface MoonlightPairModalProps {
  pin: string | null;
  hostLabel: string;
  error?: string;
  onCancel: () => void;
  onRetry: () => void;
}

export function MoonlightPairModal({ pin, hostLabel, error, onCancel, onRetry }: MoonlightPairModalProps) {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4">
      <div className="bg-surface border border-border rounded-xl p-6 shadow-2xl flex flex-col items-center gap-4 w-full max-w-sm">
        <div className="w-12 h-12 rounded-full bg-accent/15 flex items-center justify-center">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-accent">
            <rect x="3" y="11" width="18" height="11" rx="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        </div>

        <div className="text-center">
          <h3 className="text-text-primary font-semibold">Enter this PIN in Sunshine</h3>
          <p className="text-text-secondary text-xs mt-1">
            Pairing with <span className="text-text-primary">{hostLabel}</span>
          </p>
        </div>

        {error ? (
          <p className="text-sm text-red-400 text-center break-words max-w-xs">{error}</p>
        ) : (
          <>
            <div className="font-mono text-3xl tracking-[0.35em] text-text-primary bg-surface-alt border border-border rounded-lg px-5 py-3 select-all">
              {pin ?? '····'}
            </div>
            <ol className="text-xs text-text-secondary space-y-1.5 list-decimal list-inside self-stretch text-left">
              <li>Open the Sunshine web UI on the host (usually port 47990).</li>
              <li>Go to PIN / client pairing.</li>
              <li>Enter the 4-digit PIN above and confirm.</li>
              <li>This dialog closes automatically when pairing succeeds.</li>
            </ol>
          </>
        )}

        <div className="flex gap-3 w-full">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 py-2 px-3 text-sm border border-border rounded-lg hover:bg-surface-hover text-text-secondary transition-colors"
          >
            Cancel
          </button>
          {error ? (
            <button
              type="button"
              onClick={onRetry}
              className="flex-1 py-2 px-3 text-sm bg-accent text-white rounded-lg hover:bg-accent-hover font-medium transition-colors"
            >
              Retry
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
