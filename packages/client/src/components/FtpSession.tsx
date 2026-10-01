import { useMemo } from 'react';
import { FileBrowser } from './FileBrowser';

interface FtpSessionProps {
  connectionId: string;
  connectionName: string;
  isActive: boolean;
  onStatusChange?: (status: 'connecting' | 'connected' | 'disconnected') => void;
}

export function FtpSession(props: FtpSessionProps) {
  const fileSessionId = useMemo(() => crypto.randomUUID(), []);
  return <FileBrowser {...props} apiBase="/api/v1/ftp" pathSep="/" fileSessionId={fileSessionId} />;
}
