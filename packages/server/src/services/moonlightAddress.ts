import dns from 'node:dns/promises';
import net from 'node:net';

/**
 * moonlight-common RTSP setup parses the Sunshine address as an IP literal.
 * Hostnames pair over HTTP, then fail with "rtsp addr: invalid IP address syntax".
 */
export async function resolveMoonlightHostAddress(host: string): Promise<string> {
  const trimmed = host.trim();
  if (!trimmed) {
    throw new Error('Sunshine host is empty');
  }
  if (net.isIP(trimmed)) {
    return trimmed;
  }

  try {
    const { address } = await dns.lookup(trimmed, { family: 4 });
    return address;
  } catch {
    const { address } = await dns.lookup(trimmed);
    if (!net.isIP(address)) {
      throw new Error(`Could not resolve Sunshine host ${trimmed} to an IP address`);
    }
    return address;
  }
}
