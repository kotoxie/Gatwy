interface MoonlightPairModalProps {
  pin: string | null;
  hostLabel: string;
  error?: string;
  onCancel: () => void;
  onRetry: () => void;
}

export function MoonlightPairModal({ pin, hostLabel, error, onCancel, onRetry }: MoonlightPairModalProps) {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-md bg-surface border border-border rounded-xl shadow-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-border/60">
          <h2 className="text-base font-semibold text-text-primary">Enter this PIN in Sunshine</h2>
          <p className="text-xs text-text-secondary mt-1">
            Pairing with <span className="text-text-primary font-medium">{hostLabel}</span>
          </p>
        </div>

        <div className="px-5 py-6 flex flex-col items-center gap-4">
          {error ? (
            <p className="text-sm text-red-400 text-center">{error}</p>
          ) : (
            <>
              <div className="font-mono text-4xl tracking-[0.35em] text-text-primary bg-surface-alt border border-border rounded-lg px-6 py-4 select-all">
                {pin ?? '····'}
              </div>
              <ol className="text-xs text-text-secondary space-y-1.5 list-decimal list-inside self-stretch">
                <li>Open the Sunshine web UI on the host (usually port 47990).</li>
                <li>Go to <span className="text-text-primary">PIN</span> / client pairing.</li>
                <li>Enter the 4-digit PIN above and confirm.</li>
                <li>This dialog closes automatically when pairing succeeds.</li>
              </ol>
            </>
          )}
        </div>

        <div className="px-5 py-3 border-t border-border/60 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 text-xs rounded-md border border-border text-text-secondary hover:bg-surface-alt"
          >
            Cancel
          </button>
          {error && (
            <button
              type="button"
              onClick={onRetry}
              className="px-3 py-1.5 text-xs rounded-md bg-accent text-white hover:opacity-90"
            >
              Retry
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
