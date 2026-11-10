/** Host of the remote engine the dev proxy talks to (`pnpm dev:remote`), or '' — set by vite.config.ts. */
declare const __JARVIS_REMOTE_API__: string;

export interface DeploymentLabel {
  readonly text: string;
  readonly title: string;
}

/**
 * What the header badge says about where this UI and its engine run. The UI served from the
 * server's `tailscale serve` address is the server (ADR-0016: reachable only inside the tailnet,
 * no login of its own); a laptop UI either proxies to that server or to a local engine.
 */
export function deploymentLabel(hostname: string, remoteApiHost: string): DeploymentLabel {
  if (hostname.endsWith('.ts.net')) {
    return {
      text: 'SERVER · TAILNET ONLY',
      title: `Jarvis on ${hostname}: reachable only from devices in your tailnet; no login of its own.`,
    };
  }
  if (remoteApiHost !== '') {
    return {
      text: 'LOCAL UI · SERVER ENGINE',
      title: `This UI runs on your laptop; the agent, its data and runs are on ${remoteApiHost}.`,
    };
  }
  return { text: 'LOCAL · NO AUTH', title: 'Jarvis runs on this machine, on loopback only.' };
}

export function currentDeploymentLabel(): DeploymentLabel {
  const remote = typeof __JARVIS_REMOTE_API__ === 'string' ? __JARVIS_REMOTE_API__ : '';
  return deploymentLabel(window.location.hostname, remote);
}
