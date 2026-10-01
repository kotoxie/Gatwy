export type CredentialType = 'password' | 'key';

export interface CredentialSummary {
  id: string;
  name: string;
  type: CredentialType;
  username: string | null;
  domain: string | null;
  shared: boolean;
  hasPassword: boolean;
  hasPrivateKey: boolean;
  hasPassphrase: boolean;
  isOwner: boolean;
  ownerUsername: string | null;
  canEdit: boolean;
  usageCount: number;
}

/** Protocols whose connections can authenticate with a library credential. */
export const CREDENTIAL_PROTOCOLS = ['ssh', 'rdp', 'smb', 'vnc', 'sftp', 'ftp', 'telnet', 'postgres', 'mysql'] as const;

/** Which credential types a protocol can use — only SSH/SFTP understand keys. */
export function credentialTypesFor(protocol: string): CredentialType[] {
  return protocol === 'ssh' || protocol === 'sftp' ? ['password', 'key'] : ['password'];
}

export async function fetchCredentials(): Promise<CredentialSummary[]> {
  const res = await fetch('/api/v1/credentials', { credentials: 'include' });
  if (!res.ok) throw new Error(`Failed to load credentials (${res.status})`);
  return res.json() as Promise<CredentialSummary[]>;
}
