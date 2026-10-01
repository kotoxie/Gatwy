/**
 * Get a short-lived one-time WebSocket ticket from the server.
 * Used in WS URLs instead of the JWT so the token never appears in logs.
 */
export async function getWsTicket(): Promise<string> {
  const res = await fetch('/api/v1/auth/ws-ticket', {
    method: 'POST',
    credentials: 'include',
  });
  if (!res.ok) throw new Error('Failed to obtain WebSocket ticket');
  const { ticket } = await res.json() as { ticket: string };
  return ticket;
}
