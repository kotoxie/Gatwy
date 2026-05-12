import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useTimezone } from '../../hooks/useTimezone';
import { formatDate as formatDateTz } from '../../utils/formatDate';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { RecordingSettings } from './RecordingSettings';

interface SessionRow {
  id: string;
  protocol: string;
  startedAt: string;
  endedAt: string | null;
  hasRecording: boolean;
  fileSize: number | null;
  connectionName: string | null;
  username: string | null;
}

function formatDuration(start: string, end: string | null): string {
  if (!end) return 'Active';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function formatTime(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

interface CastEvent { time: number; data: string; }
interface CastHeader { width: number; height: number; title?: string; }

function parseCast(text: string): { header: CastHeader; events: CastEvent[] } {
  const lines = text.trim().split('\n');
  const header = JSON.parse(lines[0]) as CastHeader;
  const events: CastEvent[] = [];
  for (let i = 1; i < lines.length; i++) {
    try {
      const [time, type, data] = JSON.parse(lines[i]) as [number, string, string];
      if (type === 'o') events.push({ time, data });
    } catch { /* skip bad lines */ }
  }
  return { header, events };
}

function VideoPlayer({
  sessionId, onClose,
}: { sessionId: string; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [currentTime, setCurrentTime] = useState(0);
  const [totalTime, setTotalTime] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const [activityBuckets, setActivityBuckets] = useState<{ click: number; key: number; move: number }[]>([]);
  // Tracks whether we've done the duration-probe seek (seek to 1e101 to force
  // the browser to discover the real duration of a MediaRecorder WebM file).
  const durationProbed = useRef(false);
  const pendingPlay = useRef(false);
  const [rawEvents, setRawEvents] = useState<{ elapsed: number; event_type: string }[]>([]);

  // Fetch recording blob
  useEffect(() => {
    let url: string | null = null;
    async function load() {
      try {
        const res = await fetch(`/api/v1/sessions/${sessionId}/recording`, {
          credentials: 'include',
        });
        if (!res.ok) throw new Error('Recording not found');
        const blob = await res.blob();
        const typedBlob = blob.type === 'video/webm' ? blob : new Blob([blob], { type: 'video/webm' });
        url = URL.createObjectURL(typedBlob);
        setBlobUrl(url);
        setLoading(false);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load');
        setLoading(false);
      }
    }
    load();
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [sessionId]);

  // Fetch activity events
  useEffect(() => {
    fetch(`/api/v1/sessions/${sessionId}/recording/events`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.events) setRawEvents(d.events); })
      .catch(() => {});
  }, [sessionId]);

  // Recompute activity buckets when totalTime or events change
  useEffect(() => {
    if (totalTime <= 0 || rawEvents.length === 0) { setActivityBuckets([]); return; }
    const BUCKET_COUNT = 200;
    const bucketDur = totalTime / BUCKET_COUNT;
    const buckets = Array.from({ length: BUCKET_COUNT }, () => ({ click: 0, key: 0, move: 0 }));
    for (const evt of rawEvents) {
      const idx = Math.min(Math.floor(evt.elapsed / bucketDur), BUCKET_COUNT - 1);
      if (evt.event_type === 'click') buckets[idx].click++;
      else if (evt.event_type === 'key') buckets[idx].key++;
      else if (evt.event_type === 'move') buckets[idx].move++;
    }
    setActivityBuckets(buckets);
  }, [totalTime, rawEvents]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  async function handleDownload() {
    if (downloading) return;
    setDownloading(true);
    try {
      const res = await fetch(`/api/v1/sessions/${sessionId}/recording`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error();
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `rdp-recording-${sessionId}.webm`; a.click();
      URL.revokeObjectURL(url);
    } catch { /* ignore */ }
    setDownloading(false);
  }

  function onVideoMeta() {
    const v = videoRef.current;
    if (!v) return;
    if (isFinite(v.duration)) {
      setTotalTime(v.duration);
    } else if (!durationProbed.current) {
      // MediaRecorder WebM has no Duration header → duration=Infinity.
      // Seeking to an enormous time forces the browser to scan to the actual
      // last cluster and fire durationchange with the real finite duration.
      durationProbed.current = true;
      pendingPlay.current = true;
      v.currentTime = 1e101;
    }
  }

  function onCanPlay() {
    const v = videoRef.current;
    if (!v) return;
    if (isFinite(v.duration)) setTotalTime(v.duration);
    // Don't auto-play until after the duration probe seek completes
    if (!durationProbed.current || !isFinite(v.duration)) return;
    v.play().catch(() => {});
  }

  function onDurationChange() {
    const v = videoRef.current;
    if (!v || !isFinite(v.duration)) return;
    setTotalTime(v.duration);
    // After the probe seek resolved the duration, rewind and start playing
    if (pendingPlay.current) {
      pendingPlay.current = false;
      v.currentTime = 0;
    }
  }

  function onSeeked() {
    const v = videoRef.current;
    if (!v) return;
    if (isFinite(v.duration)) setTotalTime(v.duration);
    // After probe rewind to 0, begin playback
    if (pendingPlay.current && v.currentTime === 0) {
      pendingPlay.current = false;
      v.play().catch(() => {});
    }
  }

  function onVideoError() {
    const v = videoRef.current;
    const code = v?.error?.code ?? 0;
    console.error('[VideoPlayer] media error code', code, v?.error?.message);
    if (code === 4) setError('Format not supported');
  }

  function onTimeUpdate() {
    const v = videoRef.current;
    if (!v) return;
    setCurrentTime(v.currentTime);
    if (isFinite(v.duration)) setTotalTime(v.duration);
  }

  function onPlayPause() {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) { v.play().catch(() => {}); } else { v.pause(); }
  }

  function onSeek(val: number) {
    const v = videoRef.current;
    if (v) { v.currentTime = val; setCurrentTime(val); }
  }

  function setPlaybackSpeed(s: number) {
    const v = videoRef.current;
    setSpeed(s);
    if (v) v.playbackRate = s;
  }

  const progress = totalTime > 0 ? (currentTime / totalTime) * 100 : 0;

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-[#0a0a0a]">
      <div className="flex items-center gap-3 px-4 py-2 bg-[#141414] border-b border-[#2e2e2e] shrink-0">
        <span className="text-sm font-semibold text-[#efefef]">RDP Recording</span>
        <div className="flex-1" />
        <button
          onClick={() => void handleDownload()}
          disabled={downloading || !!error}
          className="p-1.5 rounded hover:bg-[#272727] text-[#888] hover:text-[#efefef] disabled:opacity-40 flex items-center gap-1.5 text-xs"
          title="Download .webm"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          Download
        </button>
        <button onClick={onClose} className="p-1.5 rounded hover:bg-[#272727] text-[#888] hover:text-[#efefef]" title="Close (Esc)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      <div className="flex-1 flex items-center justify-center overflow-hidden bg-black relative">
        {loading && <p className="text-[#888] text-sm absolute">Loading recording...</p>}
        {error && <p className="text-red-400 text-sm absolute top-4">{error}</p>}
        {blobUrl && (
          <video
            ref={videoRef}
            src={blobUrl}
            className="max-w-full max-h-full"
            preload="auto"
            onLoadedMetadata={onVideoMeta}
            onDurationChange={onDurationChange}
            onCanPlay={onCanPlay}
            onSeeked={onSeeked}
            onTimeUpdate={onTimeUpdate}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
            onError={onVideoError}
          />
        )}
      </div>
      <div className="shrink-0 px-4 py-3 bg-[#141414] border-t border-[#2e2e2e] space-y-2">
        <div className="flex items-center justify-between text-xs font-mono">
          <span className="text-[#888]">{formatTime(currentTime)}</span>
          <span className="text-[#555]">
            {playing ? (
              <span className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse inline-block" />
                PLAYING {speed !== 1 ? `(${speed}×)` : ''}
              </span>
            ) : currentTime >= totalTime && totalTime > 0 ? (
              <span className="text-green-500/70">FINISHED</span>
            ) : 'PAUSED'}
          </span>
          <span className="text-[#888]">{totalTime > 0 ? formatTime(totalTime) : '--:--'}</span>
        </div>
        <div className="relative">
          <div className="absolute top-1/2 left-0 h-1 rounded-full bg-blue-500/60 pointer-events-none -translate-y-1/2" style={{ width: `${progress}%` }} />
          <input
            type="range" min={0} max={totalTime || 1} step={0.1} value={currentTime}
            onChange={(e) => onSeek(parseFloat(e.target.value))}
            disabled={!!error || totalTime === 0}
            className="w-full h-1 appearance-none bg-[#2e2e2e] rounded-full cursor-pointer disabled:opacity-40
              [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5
              [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-blue-500 [&::-webkit-slider-thumb]:cursor-pointer
              [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full
              [&::-moz-range-thumb]:bg-blue-500 [&::-moz-range-thumb]:border-none [&::-moz-range-thumb]:cursor-pointer"
            style={{ background: 'transparent' }}
          />
        </div>
        {activityBuckets.length > 0 && (
          <div className="flex items-end h-8 rounded overflow-hidden bg-[#1a1a1a] border border-[#2e2e2e]/50 relative group cursor-pointer"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const pct = (e.clientX - rect.left) / rect.width;
              onSeek(pct * totalTime);
            }}
            title="Activity — Blue: clicks, Green: keyboard, Gray: mouse movement"
          >
            {/* Playhead */}
            <div className="absolute top-0 bottom-0 w-px bg-blue-400/80 z-10 pointer-events-none" style={{ left: `${progress}%` }} />
            {(() => {
              const maxPerBucket = Math.max(...activityBuckets.map(bk => bk.click + bk.key + bk.move));
              return activityBuckets.map((b, i) => {
                const total = b.click + b.key + b.move;
                if (total === 0) return <div key={i} style={{ flex: 1 }} />;
                const h = Math.max(3, Math.round((total / maxPerBucket) * 32));
                const clickRatio = b.click / total;
                const keyRatio = b.key / total;
                const bg = clickRatio > 0.5
                  ? `rgba(59,130,246,${0.3 + 0.5 * (total / maxPerBucket)})`
                  : keyRatio > 0.5
                    ? `rgba(34,197,94,${0.3 + 0.5 * (total / maxPerBucket)})`
                    : `rgba(148,163,184,${0.2 + 0.4 * (total / maxPerBucket)})`;
                return (
                  <div key={i} style={{ flex: 1, display: 'flex', alignItems: 'flex-end', height: '100%' }}>
                    <div style={{ width: '100%', height: `${h}px`, background: bg, borderRadius: '1px 1px 0 0' }} />
                  </div>
                );
              });
            })()}
            {/* Legend overlay on hover */}
            <div className="absolute top-0.5 right-1 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-2 text-[9px] text-[#888] pointer-events-none">
              <span className="flex items-center gap-0.5"><span className="w-1.5 h-1.5 rounded-full bg-blue-500 inline-block" />clicks</span>
              <span className="flex items-center gap-0.5"><span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />keys</span>
              <span className="flex items-center gap-0.5"><span className="w-1.5 h-1.5 rounded-full bg-slate-400 inline-block" />mouse</span>
            </div>
          </div>
        )}
        <div className="flex items-center justify-center gap-2 pt-0.5">
          <button
            onClick={onPlayPause}
            disabled={!!error}
            className="px-3 py-1.5 text-xs border border-[#2e2e2e] rounded text-[#efefef] hover:bg-[#1c1c1c] disabled:opacity-40 flex items-center gap-1.5"
          >
            {playing
              ? (<><svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>Pause</>)
              : (<><svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>{currentTime > 0 ? 'Resume' : 'Play'}</>)
            }
          </button>
          <button
            onClick={() => onSeek(0)}
            disabled={loading || !!error}
            className="px-3 py-1.5 text-xs border border-[#2e2e2e] rounded text-[#888] hover:text-[#efefef] hover:bg-[#1c1c1c] disabled:opacity-40"
          >
            ↺ Replay
          </button>
          <div className="w-px h-4 bg-[#2e2e2e] mx-1" />
          <span className="text-xs text-[#555]">Speed:</span>
          {[0.25, 0.5, 1, 2, 4, 8].map((s) => (
            <button
              key={s}
              onClick={() => setPlaybackSpeed(s)}
              className={`px-2 py-0.5 text-xs rounded transition-colors ${speed === s ? 'bg-blue-500 text-white' : 'border border-[#2e2e2e] text-[#888] hover:border-[#444] hover:text-[#efefef]'}`}
            >
              {s}×
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function RecordingPlayer({
  sessionId, onClose,
}: { sessionId: string; onClose: () => void }) {const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [currentTime, setCurrentTime] = useState(0);
  const [totalTime, setTotalTime] = useState(0);
  const [title, setTitle] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [showCommands, setShowCommands] = useState(true);
  const [commands, setCommands] = useState<{ id: string; timestamp: string; elapsed: number; command: string; output_preview: string | null }[]>([]);

  const eventsRef = useRef<CastEvent[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playingRef = useRef(false);
  const speedRef = useRef(1);
  const isSeeking = useRef(false);

  async function handleDownload() {
    if (downloading) return;
    setDownloading(true);
    try {
      const res = await fetch(`/api/v1/sessions/${sessionId}/recording`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error();
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `ssh-recording-${sessionId}.cast`; a.click();
      URL.revokeObjectURL(url);
    } catch { /* ignore */ }
    setDownloading(false);
  }

  const cancelPlayback = useCallback(() => {
    playingRef.current = false;
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
  }, []);

  const scheduleFrom = useCallback((startIdx: number) => {
    const events = eventsRef.current;
    if (startIdx >= events.length) { setPlaying(false); return; }
    playingRef.current = true;
    setPlaying(true);
    let i = startIdx;
    function next() {
      if (!playingRef.current) return;
      if (i >= events.length) { setPlaying(false); return; }
      const ev = events[i];
      const prevTime = i > 0 ? events[i - 1].time : ev.time;
      const delay = i === startIdx ? 0 : Math.max(0, Math.min(2000, (ev.time - prevTime) * 1000 / speedRef.current));
      timerRef.current = setTimeout(() => {
        if (!playingRef.current) return;
        termRef.current?.write(ev.data);
        setCurrentTime(ev.time);
        i++;
        next();
      }, delay);
    }
    next();
  }, []);

  const seekTo = useCallback((targetTime: number, resume = true) => {
    cancelPlayback();
    if (!termRef.current) return;
    const events = eventsRef.current;
    termRef.current.reset();
    let nextIdx = 0;
    for (let i = 0; i < events.length; i++) {
      if (events[i].time <= targetTime) {
        termRef.current.write(events[i].data);
        nextIdx = i + 1;
      } else { break; }
    }
    setCurrentTime(targetTime);
    if (resume && nextIdx < events.length) scheduleFrom(nextIdx);
    else setPlaying(false);
  }, [cancelPlayback, scheduleFrom]);

  useEffect(() => {
    return () => { cancelPlayback(); termRef.current?.dispose(); };
  }, [cancelPlayback]);

  useEffect(() => {
    if (!containerRef.current) return;
    const term = new Terminal({
      fontSize: 14,
      fontFamily: 'Cascadia Code, Fira Code, Menlo, Monaco, Courier New, monospace',
      theme: { background: '#0a0a0a', foreground: '#efefef', cursor: '#3b82f6' },
      convertEol: true,
      disableStdin: true,
      scrollback: 0,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;
    async function load() {
      try {
        const res = await fetch(`/api/v1/sessions/${sessionId}/recording`, {
          credentials: 'include',
        });
        if (!res.ok) throw new Error('Recording not found or unavailable');
        const text = await res.text();
        const { header, events } = parseCast(text);
        eventsRef.current = events;
        const duration = events.length > 0 ? events[events.length - 1].time : 0;
        setTotalTime(duration);
        setTitle(header.title ?? '');
        setLoading(false);
        scheduleFrom(0);
        // Fetch SSH commands in parallel
        fetch(`/api/v1/sessions/${sessionId}/commands`, { credentials: 'include' })
          .then(r => r.ok ? r.json() : null)
          .then(data => { if (data?.commands?.length) setCommands(data.commands); })
          .catch(() => {});
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load');
        setLoading(false);
      }
    }
    load();
    const observer = new ResizeObserver(() => { fitRef.current?.fit(); });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const progress = totalTime > 0 ? (currentTime / totalTime) * 100 : 0;

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-[#0a0a0a]">
      <div className="flex items-center gap-3 px-4 py-2 bg-[#141414] border-b border-[#2e2e2e] shrink-0">
        <span className="text-sm font-semibold text-[#efefef] truncate">{title || 'Session Recording'}</span>
        <div className="flex-1" />
        <button
          onClick={() => void handleDownload()}
          disabled={downloading || loading || !!error}
          className="p-1.5 rounded hover:bg-[#272727] text-[#888] hover:text-[#efefef] disabled:opacity-40 flex items-center gap-1.5 text-xs"
          title="Download .cast"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          Download
        </button>
        {commands.length > 0 && (
          <button
            onClick={() => setShowCommands(v => !v)}
            className={`p-1.5 rounded flex items-center gap-1.5 text-xs transition-colors ${showCommands ? 'bg-blue-500/20 text-blue-400' : 'hover:bg-[#272727] text-[#888] hover:text-[#efefef]'}`}
            title="Toggle command log"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
            </svg>
            Commands ({commands.length})
          </button>
        )}
        <button onClick={onClose} className="p-1.5 rounded hover:bg-[#272727] text-[#888] hover:text-[#efefef]" title="Close (Esc)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      <div className="flex-1 overflow-hidden flex">
        <div className={`flex-1 overflow-hidden p-3 ${showCommands ? '' : ''}`}>
          {loading && <div className="flex items-center justify-center h-full text-[#888] text-sm">Loading recording...</div>}
          {error && <div className="flex items-center justify-center h-full text-red-400 text-sm">{error}</div>}
          <div ref={containerRef} className="w-full h-full" style={{ display: loading || error ? 'none' : 'block' }} />
        </div>
        {showCommands && (
          <div className="w-80 shrink-0 border-l border-[#2e2e2e] bg-[#111] flex flex-col overflow-hidden">
            <div className="px-3 py-2 border-b border-[#2e2e2e] text-xs font-semibold text-[#888] flex items-center gap-1.5">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
              </svg>
              Command Log
            </div>
            <div className="flex-1 overflow-y-auto">
              {commands.map((cmd, idx) => {
                const isCurrent = currentTime >= cmd.elapsed && (idx === commands.length - 1 || currentTime < commands[idx + 1].elapsed);
                return (
                  <button
                    key={cmd.id}
                    onClick={() => seekTo(Math.max(0, cmd.elapsed - 0.5), true)}
                    className={`w-full text-left px-3 py-2 border-b border-[#1e1e1e] hover:bg-[#1a1a1a] transition-colors group ${isCurrent ? 'bg-blue-500/10 border-l-2 border-l-blue-500' : ''}`}
                  >
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-[10px] font-mono text-[#555] shrink-0">{formatTime(cmd.elapsed)}</span>
                      {cmd.command === '[password]' ? (
                        <span className="flex items-center gap-1 text-xs font-mono text-yellow-600/70 italic">
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="shrink-0">
                            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                            <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                          </svg>
                          password entered
                        </span>
                      ) : (
                        <span className="text-xs font-mono text-green-400 truncate">{cmd.command}</span>
                      )}
                    </div>
                    {cmd.command !== '[password]' && cmd.output_preview && (
                      <div className="text-[10px] font-mono text-[#444] truncate mt-0.5 pl-10 group-hover:text-[#555]">
                        {cmd.output_preview.split('\n')[0]}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
      <div className="shrink-0 px-4 py-3 bg-[#141414] border-t border-[#2e2e2e] space-y-2">
        <div className="flex items-center justify-between text-xs font-mono">
          <span className="text-[#888]">{formatTime(currentTime)}</span>
          <span className="text-[#555]">
            {playing ? (
              <span className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse inline-block" />
                PLAYING {speed !== 1 ? `(${speed}×)` : ''}
              </span>
            ) : currentTime >= totalTime && totalTime > 0 ? (
              <span className="text-green-500/70">FINISHED</span>
            ) : 'PAUSED'}
          </span>
          <span className="text-[#888]">{formatTime(totalTime)}</span>
        </div>
        <div className="relative">
          <div className="absolute top-1/2 left-0 h-1 rounded-full bg-blue-500/60 pointer-events-none -translate-y-1/2" style={{ width: `${progress}%` }} />
          <input type="range" min={0} max={totalTime || 1} step={0.1} value={currentTime}
            onChange={(e) => { isSeeking.current = true; seekTo(parseFloat(e.target.value), false); }}
            onMouseUp={(e) => { isSeeking.current = false; seekTo(parseFloat((e.target as HTMLInputElement).value), true); }}
            onTouchEnd={(e) => { isSeeking.current = false; seekTo(parseFloat((e.target as HTMLInputElement).value), true); }}
            disabled={loading || !!error || totalTime === 0}
            className="w-full h-1 appearance-none bg-[#2e2e2e] rounded-full cursor-pointer disabled:opacity-40
              [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5
              [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-blue-500 [&::-webkit-slider-thumb]:cursor-pointer
              [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full
              [&::-moz-range-thumb]:bg-blue-500 [&::-moz-range-thumb]:border-none [&::-moz-range-thumb]:cursor-pointer"
            style={{ background: 'transparent' }} />
        </div>
        <div className="flex items-center justify-center gap-2 pt-0.5">
          <button onClick={() => playing ? (cancelPlayback(), setPlaying(false)) : seekTo(currentTime, true)}
            disabled={loading || !!error}
            className="px-3 py-1.5 text-xs border border-[#2e2e2e] rounded text-[#efefef] hover:bg-[#1c1c1c] disabled:opacity-40 flex items-center gap-1.5">
            {playing ? (<><svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>Pause</>) : (<><svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>{currentTime > 0 ? 'Resume' : 'Play'}</>)}
          </button>
          <button onClick={() => seekTo(0, true)} disabled={loading || !!error}
            className="px-3 py-1.5 text-xs border border-[#2e2e2e] rounded text-[#888] hover:text-[#efefef] hover:bg-[#1c1c1c] disabled:opacity-40">
            ↺ Replay
          </button>
          <div className="w-px h-4 bg-[#2e2e2e] mx-1" />
          <span className="text-xs text-[#555]">Speed:</span>
          {[0.25, 0.5, 1, 2, 4, 8].map((s) => (
            <button key={s} onClick={() => { setSpeed(s); speedRef.current = s; if (playingRef.current) seekTo(currentTime, true); }}
              className={`px-2 py-0.5 text-xs rounded transition-colors ${speed === s ? 'bg-blue-500 text-white' : 'border border-[#2e2e2e] text-[#888] hover:border-[#444] hover:text-[#efefef]'}`}>
              {s}×
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

const PROTOCOLS = ['ssh', 'rdp'] as const;

interface FileSessionRow {
  id: string;
  protocol: string;
  startedAt: string;
  endedAt: string | null;
  connectionName: string | null;
  username: string | null;
  eventCount: number;
}

interface FileEvent {
  id: string;
  timestamp: string;
  action: string;
  path: string;
  detail: Record<string, unknown> | null;
}

const FILE_ACTION_LABELS: Record<string, string> = {
  browse: 'Browse',
  download: 'Download',
  upload: 'Upload',
  mkdir: 'New Folder',
  delete: 'Delete',
};

function FileActionIcon({ action }: { action: string }) {
  switch (action) {
    case 'browse':
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="text-amber-400 shrink-0 mt-0.5">
          <path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z" />
        </svg>
      );
    case 'download':
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-blue-400 shrink-0 mt-0.5">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
        </svg>
      );
    case 'upload':
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-green-400 shrink-0 mt-0.5">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
        </svg>
      );
    case 'mkdir':
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-purple-400 shrink-0 mt-0.5">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /><line x1="12" y1="11" x2="12" y2="17" /><line x1="9" y1="14" x2="15" y2="14" />
        </svg>
      );
    case 'delete':
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-red-400 shrink-0 mt-0.5">
          <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4h6v2" />
        </svg>
      );
    default:
      return <span className="inline-block w-3.5 h-3.5 text-text-secondary shrink-0">·</span>;
  }
}

function FileSessionTimeline({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const timezone = useTimezone();
  const [events, setEvents] = useState<FileEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  useEffect(() => {
    fetch(`/api/v1/file-sessions/${sessionId}/events`, { credentials: 'include' })
      .then((r) => r.json())
      .then((d: { events: FileEvent[] }) => { setEvents(d.events); setLoading(false); })
      .catch(() => { setError('Failed to load events'); setLoading(false); });
  }, [sessionId]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-surface rounded-xl border border-border w-full max-w-2xl max-h-[80vh] flex flex-col shadow-2xl mx-4">
        <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
          <h3 className="text-base font-semibold text-text-primary">Session Timeline</h3>
          <button onClick={onClose}
            className="text-text-secondary hover:text-text-primary p-1 rounded hover:bg-surface-hover">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="overflow-y-auto flex-1 p-4">
          {loading && <p className="text-text-secondary text-sm">Loading events...</p>}
          {error && <p className="text-red-400 text-sm">{error}</p>}
          {!loading && !error && events.length === 0 && (
            <p className="text-text-secondary text-sm">No events recorded for this session.</p>
          )}
          {!loading && events.length > 0 && (
            <div className="space-y-0.5">
              {events.map((e) => (
                <div key={e.id} className="flex items-start gap-3 py-2 border-b border-border/40 last:border-b-0">
                  <FileActionIcon action={e.action} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-text-primary">{FILE_ACTION_LABELS[e.action] ?? e.action}</span>
                      {e.detail?.count !== undefined && (
                        <span className="text-xs text-text-secondary">{String(e.detail.count)} items</span>
                      )}
                      {e.detail?.size !== undefined && (
                        <span className="text-xs text-text-secondary">{formatBytes(e.detail.size as number)}</span>
                      )}
                    </div>
                    <div className="text-xs text-text-secondary font-mono truncate">{e.path}</div>
                  </div>
                  <span className="text-xs text-text-secondary shrink-0">{formatDateTz(e.timestamp, timezone)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FileActivity() {
  const timezone = useTimezone();
  const [sessions, setSessions] = useState<FileSessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [protocolFilter, setProtocolFilter] = useState('all');
  const [downloadMenuId, setDownloadMenuId] = useState<string | null>(null);

  async function downloadFileSession(s: FileSessionRow, format: 'json' | 'csv') {
    setDownloadMenuId(null);
    try {
      const res = await fetch(`/api/v1/file-sessions/${s.id}/export?format=${format}`, { credentials: 'include' });
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const ts = s.startedAt.replace(/[^0-9]/g, '').slice(0, 14);
      const conn = (s.connectionName ?? 'unknown').replace(/[^a-z0-9]/gi, '_');
      a.download = `file-activity_${conn}_${ts}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch { /* ignore */ }
  }

  const load = useCallback(() => {
    setLoading(true);
    fetch('/api/v1/file-sessions?limit=2000', { credentials: 'include' })
      .then((r) => r.json())
      .then((d: { sessions: FileSessionRow[] }) => { setSessions(d.sessions); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => sessions.filter((s) => {
    if (search && !s.connectionName?.toLowerCase().includes(search.toLowerCase())) return false;
    if (protocolFilter !== 'all' && s.protocol !== protocolFilter) return false;
    return true;
  }), [sessions, search, protocolFilter]);

  const inputCls = 'px-2.5 py-1.5 bg-surface border border-border rounded text-text-primary text-xs focus:outline-none focus:ring-1 focus:ring-accent';

  if (loading) return <p className="text-text-secondary text-sm">Loading file activity...</p>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 items-center p-3 bg-surface-alt rounded-lg border border-border">
        <div className="flex items-center gap-1.5 flex-1 min-w-36">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-text-secondary shrink-0">
            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
          </svg>
          <input
            type="text" placeholder="Search connection…"
            value={search} onChange={(e) => setSearch(e.target.value)}
            className={`${inputCls} flex-1`}
          />
        </div>
        <select value={protocolFilter} onChange={(e) => setProtocolFilter(e.target.value)} className={inputCls}>
          <option value="all">All protocols</option>
          <option value="sftp">SFTP</option>
          <option value="smb">SMB</option>
          <option value="ftp">FTP</option>
        </select>
        <button onClick={load}
          className="text-xs text-text-secondary hover:text-text-primary px-2 py-1 rounded hover:bg-surface-hover">
          ↻ Refresh
        </button>
      </div>

      {sessions.length === 0 && (
        <p className="text-text-secondary text-sm">No file browser sessions recorded yet. File activity is captured automatically when using SFTP, SMB, or FTP connections.</p>
      )}

      {filtered.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-text-secondary">
                <th className="pb-2 pr-4 font-medium">Connection</th>
                <th className="pb-2 pr-4 font-medium">User</th>
                <th className="pb-2 pr-4 font-medium">Protocol</th>
                <th className="pb-2 pr-4 font-medium">Started</th>
                <th className="pb-2 pr-4 font-medium">Duration</th>
                <th className="pb-2 pr-4 font-medium">Events</th>
                <th className="pb-2 pr-4 font-medium">Timeline</th>
                <th className="pb-2 font-medium">Download</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => (
                <tr key={s.id} className="border-b border-border last:border-b-0">
                  <td className="py-2 pr-4 text-text-primary">{s.connectionName ?? '—'}</td>
                  <td className="py-2 pr-4 text-text-secondary">{s.username ?? '—'}</td>
                  <td className="py-2 pr-4">
                    <span className="px-1.5 py-0.5 rounded text-xs bg-surface-hover text-text-secondary uppercase font-mono">
                      {s.protocol}
                    </span>
                  </td>
                  <td className="py-2 pr-4 text-text-secondary text-xs">{formatDateTz(s.startedAt, timezone)}</td>
                  <td className="py-2 pr-4 text-xs text-text-secondary">{formatDuration(s.startedAt, s.endedAt)}</td>
                  <td className="py-2 pr-4 text-xs text-text-secondary">{s.eventCount}</td>
                  <td className="py-2 pr-4">
                    <button onClick={() => setViewingId(s.id)}
                      className="px-2 py-1 text-xs bg-accent/10 text-accent rounded hover:bg-accent/20 border border-accent/20 flex items-center gap-1">
                      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" />
                      </svg>
                      View Timeline
                    </button>
                  </td>
                  <td className="py-2">
                    <div className="relative">
                      <button
                        onClick={() => setDownloadMenuId(downloadMenuId === s.id ? null : s.id)}
                        className="px-2 py-1 text-xs bg-surface border border-border rounded hover:bg-surface-hover text-text-secondary flex items-center gap-1"
                      >
                        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
                        </svg>
                        ▾
                      </button>
                      {downloadMenuId === s.id && (
                        <div className="absolute right-0 top-full mt-1 z-50 bg-surface border border-border rounded shadow-lg min-w-[90px]">
                          <button onClick={() => downloadFileSession(s, 'json')}
                            className="block w-full text-left px-3 py-1.5 text-xs text-text-primary hover:bg-surface-hover">
                            JSON
                          </button>
                          <button onClick={() => downloadFileSession(s, 'csv')}
                            className="block w-full text-left px-3 py-1.5 text-xs text-text-primary hover:bg-surface-hover">
                            CSV
                          </button>
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {viewingId && <FileSessionTimeline sessionId={viewingId} onClose={() => setViewingId(null)} />}
    </div>
  );
}

function FilterBar({
  search, setSearch,
  protocol, setProtocol,
  userFilter, setUserFilter,
  dateFrom, setDateFrom,
  dateTo, setDateTo,
  userOptions,
  onReset,
}: {
  search: string; setSearch: (v: string) => void;
  protocol: string; setProtocol: (v: string) => void;
  userFilter: string; setUserFilter: (v: string) => void;
  dateFrom: string; setDateFrom: (v: string) => void;
  dateTo: string; setDateTo: (v: string) => void;
  userOptions: string[];
  onReset: () => void;
}) {
  const hasFilters = search || protocol !== 'all' || userFilter !== 'all' || dateFrom || dateTo;
  const inputCls = 'px-2.5 py-1.5 bg-surface border border-border rounded text-text-primary text-xs focus:outline-none focus:ring-1 focus:ring-accent';

  return (
    <div className="flex flex-wrap gap-2 items-center p-3 bg-surface-alt rounded-lg border border-border">
      {/* Search */}
      <div className="flex items-center gap-1.5 flex-1 min-w-36">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-text-secondary shrink-0">
          <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
        </svg>
        <input
          type="text"
          placeholder="Search connection…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className={`${inputCls} flex-1`}
        />
      </div>

      {/* Protocol */}
      <select value={protocol} onChange={(e) => setProtocol(e.target.value)} className={inputCls}>
        <option value="all">All protocols</option>
        {PROTOCOLS.map((p) => <option key={p} value={p}>{p.toUpperCase()}</option>)}
      </select>

      {/* User (only shown if there are multiple users) */}
      {userOptions.length > 1 && (
        <select value={userFilter} onChange={(e) => setUserFilter(e.target.value)} className={inputCls}>
          <option value="all">All users</option>
          {userOptions.map((u) => <option key={u} value={u}>{u}</option>)}
        </select>
      )}

      {/* Date range */}
      <div className="flex items-center gap-1">
        <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
          className={inputCls} title="From date" />
        <span className="text-text-secondary text-xs">–</span>
        <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
          className={inputCls} title="To date" />
      </div>

      {/* Reset */}
      {hasFilters && (
        <button onClick={onReset}
          className="px-2.5 py-1.5 text-xs border border-border rounded text-text-secondary hover:bg-surface-hover flex items-center gap-1">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
          Clear filters
        </button>
      )}
    </div>
  );
}

export function SessionsHistory() {
  const timezone = useTimezone();
  const [activeTab, setActiveTab] = useState<'recordings' | 'file-activity' | 'settings'>('recordings');
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [playingProtocol, setPlayingProtocol] = useState<string>('ssh');
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  // Filters
  const [search, setSearch] = useState('');
  const [protocol, setProtocol] = useState('all');
  const [userFilter, setUserFilter] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  async function loadSessions() {
    setLoading(true);
    try {
      const res = await fetch('/api/v1/sessions?limit=2000', { credentials: 'include' });
      if (res.ok) {
        const d = await res.json() as { sessions: SessionRow[] };
        // Only keep sessions that have a recording
        setSessions(d.sessions.filter((s) => s.hasRecording));
      }
    } catch { /* ignore */ }
    setLoading(false);
  }

  async function downloadRecording(s: SessionRow) {
    if (downloadingId) return;
    setDownloadingId(s.id);
    try {
      const res = await fetch(`/api/v1/sessions/${s.id}/recording`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      const ext = s.protocol === 'rdp' ? 'webm' : 'cast';
      const name = `${s.connectionName ?? 'session'}_${s.startedAt.replace(/[: ]/g, '-').slice(0, 19)}.${ext}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    } catch { /* ignore */ }
    setDownloadingId(null);
  }

  useEffect(() => { void loadSessions(); }, []);

  // Distinct user list for filter dropdown
  const userOptions = useMemo(() => {
    const names = [...new Set(sessions.map((s) => s.username).filter(Boolean) as string[])].sort();
    return names;
  }, [sessions]);

  // Client-side filtered view
  const filtered = useMemo(() => {
    return sessions.filter((s) => {
      if (search && !s.connectionName?.toLowerCase().includes(search.toLowerCase())) return false;
      if (protocol !== 'all' && s.protocol !== protocol) return false;
      if (userFilter !== 'all' && s.username !== userFilter) return false;
      if (dateFrom) {
        const from = new Date(dateFrom + 'T00:00:00Z').getTime();
        if (new Date(s.startedAt.replace(' ', 'T') + 'Z').getTime() < from) return false;
      }
      if (dateTo) {
        const to = new Date(dateTo + 'T23:59:59Z').getTime();
        if (new Date(s.startedAt.replace(' ', 'T') + 'Z').getTime() > to) return false;
      }
      return true;
    });
  }, [sessions, search, protocol, userFilter, dateFrom, dateTo]);

  function resetFilters() {
    setSearch('');
    setProtocol('all');
    setUserFilter('all');
    setDateFrom('');
    setDateTo('');
  }

  return (
    <div className="space-y-4">
      {/* Tab bar */}
      <div className="flex border-b border-border">
        <button
          onClick={() => setActiveTab('recordings')}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${activeTab === 'recordings' ? 'border-accent text-accent' : 'border-transparent text-text-secondary hover:text-text-primary'}`}
        >
          Terminal Recordings
        </button>
        <button
          onClick={() => setActiveTab('file-activity')}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${activeTab === 'file-activity' ? 'border-accent text-accent' : 'border-transparent text-text-secondary hover:text-text-primary'}`}
        >
          File Activity
        </button>
        <button
          onClick={() => setActiveTab('settings')}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${activeTab === 'settings' ? 'border-accent text-accent' : 'border-transparent text-text-secondary hover:text-text-primary'}`}
        >
          Settings
        </button>
      </div>

      {activeTab === 'recordings' && (loading ? (
        <p className="text-text-secondary text-sm">Loading recordings...</p>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-text-primary">Session Recordings</h2>
            <button onClick={() => void loadSessions()}
              className="text-xs text-text-secondary hover:text-text-primary px-2 py-1 rounded hover:bg-surface-hover">
              ↻ Refresh
            </button>
          </div>

          <FilterBar
            search={search} setSearch={setSearch}
            protocol={protocol} setProtocol={setProtocol}
            userFilter={userFilter} setUserFilter={setUserFilter}
            dateFrom={dateFrom} setDateFrom={setDateFrom}
            dateTo={dateTo} setDateTo={setDateTo}
            userOptions={userOptions}
            onReset={resetFilters}
          />

          {(filtered.length !== sessions.length || sessions.length > 0) && (
            <p className="text-xs text-text-secondary">
              Showing <span className="font-medium text-text-primary">{filtered.length}</span> of {sessions.length} recordings
            </p>
          )}

          {filtered.length === 0 && sessions.length > 0 && (
            <p className="text-text-secondary text-sm py-4 text-center">No recordings match the current filters.</p>
          )}
          {sessions.length === 0 && (
            <p className="text-text-secondary text-sm">No recordings yet. Enable session recording in Settings › Recordings › Settings.</p>
          )}

          {filtered.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-text-secondary">
                    <th className="pb-2 pr-4 font-medium">Connection</th>
                    <th className="pb-2 pr-4 font-medium">User</th>
                    <th className="pb-2 pr-4 font-medium">Protocol</th>
                    <th className="pb-2 pr-4 font-medium">Started</th>
                    <th className="pb-2 pr-4 font-medium">Duration</th>
                    <th className="pb-2 pr-4 font-medium">File Size</th>
                    <th className="pb-2 pr-4 font-medium">Play</th>
                    <th className="pb-2 font-medium">Download</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((s) => (
                    <tr key={s.id} className="border-b border-border last:border-b-0">
                      <td className="py-2 pr-4 text-text-primary">{s.connectionName ?? '—'}</td>
                      <td className="py-2 pr-4 text-text-secondary">{s.username ?? '—'}</td>
                      <td className="py-2 pr-4">
                        <span className="px-1.5 py-0.5 rounded text-xs bg-surface-hover text-text-secondary uppercase font-mono">
                          {s.protocol}
                        </span>
                      </td>
                      <td className="py-2 pr-4 text-text-secondary text-xs">{formatDateTz(s.startedAt, timezone)}</td>
                      <td className="py-2 pr-4 text-xs text-text-secondary">{formatDuration(s.startedAt, s.endedAt)}</td>
                      <td className="py-2 pr-4 text-xs text-text-secondary font-mono">{formatBytes(s.fileSize)}</td>
                      <td className="py-2 pr-4">
                        <button onClick={() => { setPlayingId(s.id); setPlayingProtocol(s.protocol); }}
                          className="px-2 py-1 text-xs bg-accent/10 text-accent rounded hover:bg-accent/20 border border-accent/20 flex items-center gap-1">
                          <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>
                          Play
                        </button>
                      </td>
                      <td className="py-2">
                        <button
                          onClick={() => void downloadRecording(s)}
                          disabled={downloadingId === s.id}
                          className="px-2 py-1 text-xs border border-border text-text-secondary rounded hover:bg-surface-hover hover:text-text-primary disabled:opacity-50 flex items-center gap-1"
                          title={`Download as .${s.protocol === 'rdp' ? 'webm' : 'cast'}`}
                        >
                          {downloadingId === s.id ? (
                            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="animate-spin"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
                          ) : (
                            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
                          )}
                          {downloadingId === s.id ? '…' : 'Download'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {playingId && playingProtocol === 'rdp' && (
            <VideoPlayer sessionId={playingId} onClose={() => setPlayingId(null)} />
          )}
          {playingId && playingProtocol !== 'rdp' && (
            <RecordingPlayer sessionId={playingId} onClose={() => setPlayingId(null)} />
          )}
        </>
      ))}

      {activeTab === 'file-activity' && <FileActivity />}
      {activeTab === 'settings' && <RecordingSettings />}
    </div>
  );
}
