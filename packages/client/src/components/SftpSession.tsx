import { useMemo } from 'react';
import { FileBrowser } from './FileBrowser';

interface SftpSessionProps {
  connectionId: string;
  connectionName: string;
  isActive: boolean;
  onStatusChange?: (status: 'connecting' | 'connected' | 'disconnected') => void;
}

export function SftpSession(props: SftpSessionProps) {
  const fileSessionId = useMemo(() => crypto.randomUUID(), []);
  return <FileBrowser {...props} apiBase="/api/v1/sftp" pathSep="/" fileSessionId={fileSessionId} />;
}
