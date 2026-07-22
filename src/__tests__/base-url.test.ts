import { afterEach, describe, expect, it, vi } from 'vitest';
import { WireClient } from '../client.js';
import { WireProvisionClient } from '../provision.js';

/** baseUrl is honored uniformly by both clients (preview / self-hosted). */

function stubFetch(body: unknown) {
  const fn = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: '200',
    json: async () => body,
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('baseUrl override', () => {
  it('WireClient.getStatus hits the overridden origin (trailing slash stripped)', async () => {
    const fetchMock = stubFetch({
      success: true,
      data: {
        container: {
          id: 'c1',
          name: 'n',
          mcp_endpoint: 'm',
          organization_slug: 'o',
          is_ephemeral: false,
          created_at: '2026-01-01',
          ephemeral_expires_at: null,
        },
        connection: { id: 'x', connected_at: '2026-01-01', last_used_at: null, label: null },
        app: { id: 'a', name: 'n', verified: true },
      },
    });
    const client = new WireClient({ agentId: 'test-agent', baseUrl: 'https://preview.app.usewire.io/' });
    await client.getStatus('key');
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'https://preview.app.usewire.io/api/v1/sdk/status'
    );
  });

  it('WireClient defaults to production', async () => {
    const fetchMock = stubFetch({ success: true, data: {} });
    const client = new WireClient({ agentId: 'test-agent' });
    await client.getStatus('key').catch(() => undefined);
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://app.usewire.io/api/v1/sdk/status');
  });

  it('WireProvisionClient honors the same option', async () => {
    const fetchMock = stubFetch({ success: true, data: { organization_id: 'o', agent_id: 'a' } });
    const wire = new WireProvisionClient({ apiKey: 'k', baseUrl: 'https://preview.app.usewire.io' });
    await wire.whoami();
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'https://preview.app.usewire.io/api/v1/agent/provision/whoami'
    );
  });
});
