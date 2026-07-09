import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WireClient } from '../client.js';
import { WireSdkError } from '../types.js';

const CONNECT_BODY = {
  success: true,
  data: {
    nonce: 'a'.repeat(48),
    user_code: 'BFXR9243',
    expires_in: 600,
    credential_id: 'cred_1',
  },
};

const POLL_READY = {
  status: 'ready',
  container_id: 'cont_1',
  container_name: 'Test',
  mcp_endpoint: 'https://acme.mcp.usewire.io/container/cont_1/mcp',
  api_endpoint: 'https://acme.api.usewire.io/container/cont_1',
  api_key: 'key_1',
  is_ephemeral: true,
  created_at: '2026-07-01T00:00:00.000Z',
  app_id: 'test-agent',
  credential_id: 'cred_1',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('beginConnect / checkConnection / getClaimUrl', () => {
  const client = new WireClient({ agentId: 'test-agent' });
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('beginConnect returns a persistable handle without polling', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(CONNECT_BODY));

    const pending = await client.beginConnect({ label: 'Test box' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/v1/sdk/connect');
    expect(pending.userCode).toBe('BFXR9243');
    expect(pending.url).toContain('/sdk/connect');
    expect(pending.nonce).toBe(CONNECT_BODY.data.nonce);
    expect(pending.deviceKey.credentialId).toBe('cred_1');
    expect(pending.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(pending.label).toBe('Test box');
    // Handle round-trips through JSON (turn-based agents persist it).
    const revived = JSON.parse(JSON.stringify(pending));
    expect(revived.nonce).toBe(pending.nonce);
    expect(revived.deviceKey.privateJwk).toBeDefined();
  });

  it('checkConnection returns null while pending, Connection when ready', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(CONNECT_BODY));
    const pending = await client.beginConnect();

    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'pending' }));
    expect(await client.checkConnection(pending)).toBeNull();

    fetchMock.mockResolvedValueOnce(jsonResponse(POLL_READY));
    const connection = await client.checkConnection(pending);
    expect(connection).not.toBeNull();
    expect(connection!.apiKey).toBe('key_1');
    expect(connection!.orgSlug).toBe('acme');
    expect(connection!.deviceKey).toBe(pending.deviceKey);
    expect(connection!.expiresAt).not.toBeNull();
  });

  it('checkConnection throws NONCE_EXPIRED on a lapsed handshake', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(CONNECT_BODY));
    const pending = await client.beginConnect();

    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'expired' }));
    await expect(client.checkConnection(pending)).rejects.toMatchObject({
      code: 'NONCE_EXPIRED',
    });
  });

  it('getClaimUrl mints without prompting or polling', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: {
          claim_url: 'https://app.usewire.io/onboarding/create-account?claimToken=t1',
          expires_in_seconds: 1800,
        },
      })
    );

    const link = await client.getClaimUrl('key_1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(link.url).toContain('claimToken=t1');
    expect(link.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('getClaimUrl propagates ALREADY_CLAIMED for the caller to handle', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          success: false,
          error: { code: 'ALREADY_CLAIMED', message: 'already claimed' },
        },
        409
      )
    );

    const err = await client.getClaimUrl('key_1').catch((e) => e);
    expect(err).toBeInstanceOf(WireSdkError);
    expect(err.code).toBe('ALREADY_CLAIMED');
  });
});
