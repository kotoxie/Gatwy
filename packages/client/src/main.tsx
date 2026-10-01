import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { AuthProvider } from './hooks/useAuth';
import { ThemeProvider } from './hooks/useTheme';
import { BASE_PATH } from './lib/basePath';
import './styles/globals.css';

// Global fetch intercept:
// (1) prefixes same-origin '/api/...' requests with BASE_PATH so every existing
//     fetch('/api/v1/...') call site keeps working unmodified when Gatwy is served behind a
//     reverse-proxy path prefix (see lib/basePath.ts) — BASE_PATH is '' at root, a no-op.
// (2) fires 'gatwy:unauthorized' whenever any API request comes back with 401.
// Patched once at startup, never re-patched.
const _origFetch = window.fetch.bind(window);
window.fetch = async function patchedFetch(...args: Parameters<typeof fetch>) {
  const [input, init] = args;
  if (BASE_PATH && typeof input === 'string' && input.startsWith('/api/')) {
    args = [`${BASE_PATH}${input}`, init] as Parameters<typeof fetch>;
  }
  const res = await _origFetch(...args);
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('gatwy:unauthorized'));
  }
  return res;
};

// Global WebSocket intercept:
// (1) prefixes same-origin '/ws/...' upgrade URLs with BASE_PATH, same reasoning as the fetch
//     patch above — every existing `new WebSocket('./ws/...')` call site keeps working
//     unmodified. '/mlw' (Moonlight) is mounted and returned by the server already prefixed, so
//     it isn't rewritten again here.
// (2) fires 'gatwy:unauthorized' when any WebSocket closes with code 4001 (session revoked by
//     server).
const _OrigWS = window.WebSocket;
class PatchedWebSocket extends _OrigWS {
  constructor(url: string | URL, protocols?: string | string[]) {
    if (BASE_PATH && typeof url === 'string' && url.includes('/ws/')) {
      url = url.replace('/ws/', `${BASE_PATH}/ws/`);
    }
    super(url, protocols);
    this.addEventListener('close', (e: CloseEvent) => {
      if (e.code === 4001) {
        window.dispatchEvent(new CustomEvent('gatwy:unauthorized'));
      }
    });
  }
}
window.WebSocket = PatchedWebSocket as typeof WebSocket;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <ThemeProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </ThemeProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
