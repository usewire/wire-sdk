import { afterEach, describe, expect, it, vi } from 'vitest';
import { WireProvisionClient } from '../provision.js';
import { WireSdkError } from '../types.js';

const CONTAINER_WIRE = {
  id: 'ctr_1',
  name: 'customer-1234',
  description: null,
  mcp_endpoint: 'https://acme.mcp.usewire.io/container/ctr_1/mcp',
  api_endpoint: 'https://acme.api.usewire.io/container/ctr_1',
};

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WireProvisionClient', () => {
  it('requires an apiKey', () => {
    expect(() => new WireProvisionClient({ apiKey: '' })).toThrow(/apiKey is required/);
  });

  it('creates a container and maps the wire shape', async () => {
    const fetchMock = mockFetch(201, { success: true, data: CONTAINER_WIRE });
    const wire = new WireProvisionClient({ apiKey: 'wire_test_key' });

    const container = await wire.containers.create({ name: 'customer-1234' });

    expect(container).toMatchObject({
      id: 'ctr_1',
      name: 'customer-1234',
      mcpUrl: CONTAINER_WIRE.mcp_endpoint,
      apiUrl: CONTAINER_WIRE.api_endpoint,
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://app.usewire.io/api/v1/agent/provision/containers');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer wire_test_key');
    expect(JSON.parse(init.body)).toEqual({ name: 'customer-1234' });
  });

  it('lists containers', async () => {
    mockFetch(200, { success: true, data: [CONTAINER_WIRE, { ...CONTAINER_WIRE, id: 'ctr_2' }] });
    const wire = new WireProvisionClient({ apiKey: 'wire_test_key' });

    const list = await wire.containers.list();
    expect(list.map((c) => c.id)).toEqual(['ctr_1', 'ctr_2']);
  });

  it('updates name/description via PATCH', async () => {
    const fetchMock = mockFetch(200, {
      success: true,
      data: { id: 'ctr_1', name: 'renamed', description: 'desc' },
    });
    const wire = new WireProvisionClient({ apiKey: 'wire_test_key' });

    const updated = await wire.containers.update('ctr_1', { name: 'renamed', description: 'desc' });
    expect(updated).toMatchObject({ id: 'ctr_1', name: 'renamed', description: 'desc' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://app.usewire.io/api/v1/agent/provision/containers/ctr_1');
    expect(init.method).toBe('PATCH');
  });

  it('deletes a container', async () => {
    const fetchMock = mockFetch(200, { success: true, data: { id: 'ctr_1', status: 'deleted' } });
    const wire = new WireProvisionClient({ apiKey: 'wire_test_key' });

    await wire.containers.delete('ctr_1');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://app.usewire.io/api/v1/agent/provision/containers/ctr_1');
    expect(init.method).toBe('DELETE');
  });

  it('resolves whoami', async () => {
    mockFetch(200, { success: true, data: { organization_id: 'org_1', agent_id: 'agent_1' } });
    const wire = new WireProvisionClient({ apiKey: 'wire_test_key' });

    expect(await wire.whoami()).toEqual({ organizationId: 'org_1', agentId: 'agent_1' });
  });

  it('surfaces API errors as WireSdkError with the server code', async () => {
    mockFetch(401, {
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Invalid or revoked provision key' },
    });
    const wire = new WireProvisionClient({ apiKey: 'wire_revoked' });

    await expect(wire.containers.list()).rejects.toMatchObject({
      name: 'WireSdkError',
      code: 'UNAUTHORIZED',
      status: 401,
    });
  });

  it('honors baseUrl override', async () => {
    const fetchMock = mockFetch(200, { success: true, data: [] });
    const wire = new WireProvisionClient({
      apiKey: 'wire_test_key',
      baseUrl: 'https://preview.server.usewire.io/',
    });

    await wire.containers.list();
    expect(fetchMock.mock.calls[0]![0]).toBe(
      'https://preview.server.usewire.io/api/v1/agent/provision/containers'
    );
  });

  it('wraps network failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const wire = new WireProvisionClient({ apiKey: 'wire_test_key' });

    await expect(wire.whoami()).rejects.toBeInstanceOf(WireSdkError);
    await expect(wire.whoami()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });
});
