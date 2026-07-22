import { afterEach, describe, expect, it, vi } from 'vitest';
import { WireProvisionClient } from '../provision.js';
import { WireSdkError } from '../types.js';

/**
 * SUP-546 — the case surface on provisioned containers: container.case(id)
 * data ops against the container endpoint, container.cases.list()/get()
 * against the provision API.
 */

const CONTAINER_WIRE = {
  id: 'ctr_1',
  name: 'returns-agent',
  description: null,
  mcp_endpoint: 'https://acme.mcp.usewire.io/container/ctr_1/mcp',
  api_endpoint: 'https://acme.api.usewire.io/container/ctr_1',
};

const CASE_WIRE = {
  id: 'return-4821',
  status: 'active',
  entry_count: 3,
  size_bytes: 4096,
  created_at: 1752000000000,
  last_active_at: 1752000500000,
  closed_at: null,
  retention_class: 'keep',
};

function mockFetchSequence(...responses: Array<{ status: number; body: unknown }>) {
  const fn = vi.fn();
  for (const r of responses) {
    fn.mockResolvedValueOnce({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      statusText: String(r.status),
      json: async () => r.body,
    });
  }
  vi.stubGlobal('fetch', fn);
  return fn;
}

async function makeContainer(fetchMock?: ReturnType<typeof vi.fn>) {
  const fn =
    fetchMock ?? mockFetchSequence({ status: 201, body: { success: true, data: CONTAINER_WIRE } });
  const wire = new WireProvisionClient({ apiKey: 'wire_test_key' });
  const container = await wire.containers.create();
  return { container, fetchMock: fn };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('container.case() data ops', () => {
  it('writes to the case path on the container endpoint with the org key', async () => {
    const fetchMock = mockFetchSequence(
      { status: 201, body: { success: true, data: CONTAINER_WIRE } },
      { status: 200, body: { ok: true, entryId: 'e1', status: 'stored' } }
    );
    const { container } = await makeContainer(fetchMock);

    const result = await container.case('return-4821').write({ content: { request: 'refund' } });
    expect(result.entryId).toBe('e1');

    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe(
      'https://acme.api.usewire.io/container/ctr_1/s/return-4821/api/tools/write'
    );
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer wire_test_key');
    expect(JSON.parse(init.body)).toEqual({ content: { request: 'refund' } });
  });

  it('search hits the case-scoped search tool', async () => {
    const fetchMock = mockFetchSequence(
      { status: 201, body: { success: true, data: CONTAINER_WIRE } },
      { status: 200, body: { ok: true, matches: [] } }
    );
    const { container } = await makeContainer(fetchMock);

    await container.case('return-4821').search({ query: 'refund window' });
    const [url] = fetchMock.mock.calls[1]!;
    expect(url).toBe(
      'https://acme.api.usewire.io/container/ctr_1/s/return-4821/api/tools/search'
    );
  });

  it('surfaces tool errors as WireSdkError with the container message', async () => {
    const fetchMock = mockFetchSequence(
      { status: 201, body: { success: true, data: CONTAINER_WIRE } },
      { status: 403, body: { error: 'states are not enabled on this container' } }
    );
    const { container } = await makeContainer(fetchMock);

    await expect(container.case('c1').write({ content: 'x' })).rejects.toThrowError(
      /states are not enabled/
    );
  });

  it('rejects unsafe case ids locally', async () => {
    const { container } = await makeContainer();
    expect(() => container.case('..')).toThrow(WireSdkError);
    expect(() => container.case('a/b')).toThrow(WireSdkError);
    expect(() => container.case('a'.repeat(129))).toThrow(WireSdkError);
    expect(() => container.case('return-4821')).not.toThrow();
  });
});

describe('container.cases', () => {
  it('lists cases with filters and maps summaries', async () => {
    const fetchMock = mockFetchSequence(
      { status: 201, body: { success: true, data: CONTAINER_WIRE } },
      {
        status: 200,
        body: {
          success: true,
          data: { cases: [CASE_WIRE], total: 1, counts: { active: 1, closed: 0, all: 1 } },
        },
      }
    );
    const { container } = await makeContainer(fetchMock);

    const result = await container.cases.list({ status: 'active', limit: 10 });

    const [url] = fetchMock.mock.calls[1]!;
    expect(url).toBe(
      'https://app.usewire.io/api/v1/agent/provision/containers/ctr_1/cases?status=active&limit=10'
    );
    expect(result.total).toBe(1);
    expect(result.counts.all).toBe(1);
    expect(result.cases[0]).toMatchObject({
      id: 'return-4821',
      status: 'active',
      entryCount: 3,
      retentionClass: 'keep',
    });
    expect(result.cases[0]!.createdAt).toEqual(new Date(1752000000000));
  });

  it('gets one case summary', async () => {
    const fetchMock = mockFetchSequence(
      { status: 201, body: { success: true, data: CONTAINER_WIRE } },
      { status: 200, body: { success: true, data: CASE_WIRE } }
    );
    const { container } = await makeContainer(fetchMock);

    const summary = await container.cases.get('return-4821');
    const [url] = fetchMock.mock.calls[1]!;
    expect(url).toBe(
      'https://app.usewire.io/api/v1/agent/provision/containers/ctr_1/cases/return-4821'
    );
    expect(summary.id).toBe('return-4821');
    expect(summary.lastActiveAt).toEqual(new Date(1752000500000));
  });

  it('propagates API errors from the provision surface', async () => {
    const fetchMock = mockFetchSequence(
      { status: 201, body: { success: true, data: CONTAINER_WIRE } },
      { status: 404, body: { success: false, error: { code: 'NOT_FOUND', message: 'Case not found' } } }
    );
    const { container } = await makeContainer(fetchMock);

    await expect(container.cases.get('nope')).rejects.toThrowError(/Case not found/);
  });
});
