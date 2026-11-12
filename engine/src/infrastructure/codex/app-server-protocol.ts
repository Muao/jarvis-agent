/** The app server reads and writes one JSON-RPC message per line over stdio. */
export function initializeCodexAppServer(): string {
  return encodeCodexMessage({
    id: 1,
    method: 'initialize',
    params: { clientInfo: { name: 'jarvis', version: '0.0.0' } },
  });
}

export function encodeCodexMessage(message: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(message) + '\n';
}
