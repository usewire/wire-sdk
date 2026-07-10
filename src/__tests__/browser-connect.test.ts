import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WireClient } from '../client.js';

const CONNECTION_PAYLOAD = {
  container_id: 'cont_1',
  container_name: 'Test',
  mcp_endpoint: 'https://acme.mcp.usewire.io/container/cont_1/mcp',
  api_endpoint: 'https://acme.api.usewire.io/container/cont_1',
  api_key: 'key_1',
  is_ephemeral: false,
  created_at: '2026-07-01T00:00:00.000Z',
  app_id: 'test-agent',
  credential_id: 'cred_1',
};

function fakeSessionStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
}

function fakeLocation(href: string) {
  const url = new URL(href);
  return {
    href: url.toString(),
    search: url.search,
    origin: url.origin,
    assign: vi.fn(),
  };
}

describe('connectInBrowser / completeConnectInBrowser', () => {
  const client = new WireClient({ agentId: 'test-agent' });
  let fetchMock: ReturnType<typeof vi.fn>;
  let storage: ReturnType<typeof fakeSessionStorage>;

  beforeEach(() => {
    fetchMock = vi.fn();
    storage = fakeSessionStorage();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('sessionStorage', storage);
    vi.stubGlobal('window', { opener: null });
    vi.stubGlobal('history', { replaceState: vi.fn() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('redirect mode stashes PKCE state and navigates to authorize', async () => {
    const loc = fakeLocation('https://my-agent.example/app');
    vi.stubGlobal('location', loc);

    // Never resolves; give the microtask queue a tick then inspect.
    void client.connectInBrowser({ redirectUri: 'https://my-agent.example/callback' });
    await new Promise((r) => setTimeout(r, 0));

    expect(loc.assign).toHaveBeenCalledTimes(1);
    const target = new URL(loc.assign.mock.calls[0][0] as string);
    expect(target.pathname).toBe('/api/auth/oauth2/authorize');
    expect(target.searchParams.get('client_id')).toBe('test-agent');
    expect(target.searchParams.get('code_challenge_method')).toBe('S256');
    expect(target.searchParams.get('redirect_uri')).toBe(
      'https://my-agent.example/callback'
    );

    const stash = JSON.parse(storage.getItem('wire-sdk:browser-connect')!);
    expect(stash.verifier.length).toBeGreaterThanOrEqual(43);
    expect(stash.state).toBe(target.searchParams.get('state'));
  });

  it('completes a redirect-mode connect: exchanges code, returns Connection', async () => {
    storage.setItem(
      'wire-sdk:browser-connect',
      JSON.stringify({
        verifier: 'v'.repeat(48),
        state: 'state-1',
        redirectUri: 'https://my-agent.example/callback',
        agentId: 'test-agent',
      })
    );
    vi.stubGlobal(
      'location',
      fakeLocation('https://my-agent.example/callback?code=code-1&state=state-1')
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ access_token: 'jwt', connection: CONNECTION_PAYLOAD }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const connection = await client.completeConnectInBrowser();

    expect(connection).not.toBeNull();
    expect(connection!.apiKey).toBe('key_1');
    expect(connection!.orgSlug).toBe('acme');
    expect(connection!.deviceKey).toBeUndefined();
    // Token exchange used the stashed verifier
    const body = fetchMock.mock.calls[0][1].body as URLSearchParams;
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code_verifier')).toBe('v'.repeat(48));
    // Stash cleared, URL scrubbed
    expect(storage.getItem('wire-sdk:browser-connect')).toBeNull();
  });

  it('returns null when the URL has no OAuth params', async () => {
    vi.stubGlobal('location', fakeLocation('https://my-agent.example/callback'));
    expect(await client.completeConnectInBrowser()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a state mismatch', async () => {
    storage.setItem(
      'wire-sdk:browser-connect',
      JSON.stringify({
        verifier: 'v'.repeat(48),
        state: 'expected',
        redirectUri: 'https://my-agent.example/callback',
        agentId: 'test-agent',
      })
    );
    vi.stubGlobal(
      'location',
      fakeLocation('https://my-agent.example/callback?code=code-1&state=forged')
    );
    await expect(client.completeConnectInBrowser()).rejects.toMatchObject({
      code: 'STATE_MISMATCH',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws OAUTH_ERROR when the user denied access', async () => {
    storage.setItem(
      'wire-sdk:browser-connect',
      JSON.stringify({
        verifier: 'v'.repeat(48),
        state: 'state-1',
        redirectUri: 'https://my-agent.example/callback',
        agentId: 'test-agent',
      })
    );
    vi.stubGlobal(
      'location',
      fakeLocation(
        'https://my-agent.example/callback?error=access_denied&error_description=User+denied+access&state=state-1'
      )
    );
    await expect(client.completeConnectInBrowser()).rejects.toMatchObject({
      code: 'OAUTH_ERROR',
    });
  });

  it('throws NO_CONNECTION when the token response lacks the connection object', async () => {
    storage.setItem(
      'wire-sdk:browser-connect',
      JSON.stringify({
        verifier: 'v'.repeat(48),
        state: 'state-1',
        redirectUri: 'https://my-agent.example/callback',
        agentId: 'test-agent',
      })
    );
    vi.stubGlobal(
      'location',
      fakeLocation('https://my-agent.example/callback?code=code-1&state=state-1')
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'jwt' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    await expect(client.completeConnectInBrowser()).rejects.toMatchObject({
      code: 'NO_CONNECTION',
    });
  });

  it('popup child relays code to the opener and closes', async () => {
    const postMessage = vi.fn();
    const close = vi.fn();
    vi.stubGlobal('window', { opener: { postMessage }, close });
    vi.stubGlobal(
      'location',
      fakeLocation('https://my-agent.example/callback?code=code-1&state=state-1')
    );

    const result = await client.completeConnectInBrowser();

    expect(result).toBeNull();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'wire-sdk:browser-connect-result',
        code: 'code-1',
        state: 'state-1',
      }),
      'https://my-agent.example'
    );
    expect(close).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
