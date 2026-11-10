import { describe, expect, it } from 'vitest';
import { deploymentLabel } from './deployment-label';

describe('deploymentLabel', () => {
  it('names the server when the UI is served from the tailnet address', () => {
    expect(deploymentLabel('jarvis-01.tail1234.ts.net', '').text).toBe('SERVER · TAILNET ONLY');
  });

  it('names a laptop UI that proxies to the server engine', () => {
    const label = deploymentLabel('127.0.0.1', 'jarvis-01.tail1234.ts.net');
    expect(label.text).toBe('LOCAL UI · SERVER ENGINE');
    expect(label.title).toContain('jarvis-01.tail1234.ts.net');
  });

  it('stays local when both run on this machine', () => {
    expect(deploymentLabel('127.0.0.1', '').text).toBe('LOCAL · NO AUTH');
  });
});
