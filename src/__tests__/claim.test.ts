import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WireClient } from '../client.js';
import { WireSdkError } from '../types.js';

const STATUS_BODY = (isEphemeral: boolean) => ({
  success: true,
  data: {
    container: {
      id: 'cont_1',
      name: 'Test',
      mcp_endpoint: 'https://acme.mcp.usewire.io/container/cont_1/mcp',
      organization_slug: 'acme',
      is_ephemeral: isEphemeral,
      created_at: '2026-07-01T00:00:00.000Z',
      ephemeral_expires_at: isEphemeral ? '2026-07-08T00:00:00.000Z' : null,
    },
    connection: {
      id: 'conn_1',
      connected_at: '2026-07-01T00:00:00.000Z',
      last_used_at: null,
      label: null,
    },
    app: { id: 'test-agent', name: 'Test Agent', verified: true },
  },
});

const CLAIM_BODY = {
  success: true,
  data: {
    claim_url:
      'https://app.usewire.io/onboarding/create-account?claimToken=abc123',
    expires_in_seconds: 1800,
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('WireClient.claim', () => {
  const client = new WireClient({ agentId: 'test-agent' });
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('mints a URL, prompts, polls until the container is permanent', async () => {
    let statusCalls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/api/v1/sdk/claim')) return jsonResponse(CLAIM_BODY);
      statusCalls += 1;
      // Still ephemeral on the first two polls, claimed on the third.
      return jsonResponse(STATUS_BODY(statusCalls < 3));
    });

    const prompted: string[] = [];
    const resultPromise = client.claim('key_1', {
      onUserPrompt: ({ url }) => {
        prompted.push(url);
      },
    });
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await resultPromise;

    expect(prompted).toEqual([CLAIM_BODY.data.claim_url]);
    expect(result.expiresAt).toBeNull();
    expect(result.container.isEphemeral).toBe(false);
    expect(result.container.ephemeralExpiresAt).toBeNull();
    expect(statusCalls).toBe(3);
  });

  it('short-circuits when the container is already claimed', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/api/v1/sdk/claim')) {
        return jsonResponse(
          {
            success: false,
            error: { code: 'ALREADY_CLAIMED', message: 'already claimed' },
          },
          409
        );
      }
      return jsonResponse(STATUS_BODY(false));
    });

    const onUserPrompt = vi.fn();
    const result = await client.claim('key_1', { onUserPrompt });

    expect(onUserPrompt).not.toHaveBeenCalled();
    expect(result.expiresAt).toBeNull();
    expect(result.container.isEphemeral).toBe(false);
  });

  it('throws CLAIM_TIMEOUT when the user never completes sign-up', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/api/v1/sdk/claim')) return jsonResponse(CLAIM_BODY);
      return jsonResponse(STATUS_BODY(true));
    });

    const resultPromise = client.claim('key_1', {
      onUserPrompt: () => {},
      timeoutMs: 6_000,
    });
    const expectation = expect(resultPromise).rejects.toMatchObject({
      code: 'CLAIM_TIMEOUT',
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await expectation;
  });

  it('propagates a revoked-key 401 from the status poll', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/api/v1/sdk/claim')) return jsonResponse(CLAIM_BODY);
      return jsonResponse(
        {
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Invalid or revoked apiKey' },
        },
        401
      );
    });

    const resultPromise = client.claim('key_1', { onUserPrompt: () => {} });
    const expectation = expect(resultPromise).rejects.toBeInstanceOf(WireSdkError);
    await vi.advanceTimersByTimeAsync(1_000);
    await expectation;
  });

  it('requires an apiKey', async () => {
    await expect(client.claim('')).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  });
});
