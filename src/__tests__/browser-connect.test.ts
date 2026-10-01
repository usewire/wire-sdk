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

function fakeStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
    keys: () => [...store.keys()],
  };
}

const LEGACY_KEY = 'wire-sdk:browser-connect';
const stashKey = (state: string) => `wire-sdk:browser-connect:${state}`;

function stashFor(state: string, createdAt = Date.now()) {
  return JSON.stringify({
    verifier: 'v'.repeat(48),
    state,
    redirectUri: 'https://my-agent.example/callback',
    agentId: 'test-agent',
    createdAt,
  });
}

function tokenResponse() {
  return new Response(
    JSON.stringify({ access_token: 'jwt', connection: CONNECTION_PAYLOAD }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
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
  // `storage` is this tab's sessionStorage; `local` is shared by every tab.
  let storage: ReturnType<typeof fakeStorage>;
  let local: ReturnType<typeof fakeStorage>;

  beforeEach(() => {
    fetchMock = vi.fn();
    storage = fakeStorage();
    local = fakeStorage();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('sessionStorage', storage);
    vi.stubGlobal('localStorage', local);
    vi.stubGlobal('window', { opener: null });
    vi.stubGlobal('history', { replaceState: vi.fn() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('redirect mode stashes PKCE state and navigates to authorize', async () => {
    const loc = fakeLocation('https://my-agent.example/app');
    vi.stubGlobal('location', loc);

    // Never resolves. Wait for the navigation itself: one timer tick is not
    // always enough for the PKCE digest, and a navigation that lands after
    // afterEach has unstubbed `location` fails the run.
    void client.connectInBrowser({ redirectUri: 'https://my-agent.example/callback' });
    await vi.waitFor(() => expect(loc.assign).toHaveBeenCalled());

    expect(loc.assign).toHaveBeenCalledTimes(1);
    const target = new URL(loc.assign.mock.calls[0][0] as string);
    expect(target.pathname).toBe('/api/auth/oauth2/authorize');
    expect(target.searchParams.get('client_id')).toBe('test-agent');
    expect(target.searchParams.get('code_challenge_method')).toBe('S256');
    expect(target.searchParams.get('redirect_uri')).toBe(
      'https://my-agent.example/callback'
    );

    // In localStorage under its state, so another tab's callback finds it.
    const state = target.searchParams.get('state')!;
    const stash = JSON.parse(local.getItem(stashKey(state))!);
    expect(stash.verifier.length).toBeGreaterThanOrEqual(43);
    expect(stash.state).toBe(state);
    expect(typeof stash.createdAt).toBe('number');
    expect(storage.keys()).toEqual([]);
  });

  it('redirect mode sweeps expired stashes and keeps live ones', async () => {
    local.setItem(stashKey('old'), stashFor('old', Date.now() - 11 * 60 * 1000));
    local.setItem(stashKey('live'), stashFor('live'));
    local.setItem('unrelated', 'x');
    const loc = fakeLocation('https://my-agent.example/app');
    vi.stubGlobal('location', loc);

    void client.connectInBrowser({ redirectUri: 'https://my-agent.example/callback' });
    await vi.waitFor(() => expect(loc.assign).toHaveBeenCalled());

    expect(local.getItem(stashKey('old'))).toBeNull();
    expect(local.getItem(stashKey('live'))).not.toBeNull();
    expect(local.getItem('unrelated')).toBe('x');
  });

  it('redirect mode falls back to sessionStorage when localStorage is blocked', async () => {
    vi.stubGlobal('localStorage', {
      ...local,
      setItem: () => {
        throw new Error('SecurityError');
      },
    });
    const loc = fakeLocation('https://my-agent.example/app');
    vi.stubGlobal('location', loc);

    void client.connectInBrowser({ redirectUri: 'https://my-agent.example/callback' });
    await vi.waitFor(() => expect(loc.assign).toHaveBeenCalled());

    const state = new URL(loc.assign.mock.calls[0][0] as string).searchParams.get('state')!;
    expect(JSON.parse(storage.getItem(stashKey(state))!).state).toBe(state);
  });

  it('completes in a new tab: empty sessionStorage, stash in localStorage', async () => {
    local.setItem(stashKey('state-1'), stashFor('state-1'));
    vi.stubGlobal(
      'location',
      fakeLocation('https://my-agent.example/callback?code=code-1&state=state-1')
    );
    fetchMock.mockResolvedValueOnce(tokenResponse());

    const connection = await client.completeConnectInBrowser();

    expect(connection!.apiKey).toBe('key_1');
    const body = fetchMock.mock.calls[0][1].body as URLSearchParams;
    expect(body.get('code')).toBe('code-1');
    expect(body.get('code_verifier')).toBe('v'.repeat(48));
    expect(body.get('redirect_uri')).toBe('https://my-agent.example/callback');
    // Spent: removed after use.
    expect(local.getItem(stashKey('state-1'))).toBeNull();
  });

  it('exchanges a redirect callback even in a window that has an opener', async () => {
    const postMessage = vi.fn();
    vi.stubGlobal('window', { opener: { postMessage }, close: vi.fn() });
    local.setItem(stashKey('state-1'), stashFor('state-1'));
    vi.stubGlobal(
      'location',
      fakeLocation('https://my-agent.example/callback?code=code-1&state=state-1')
    );
    fetchMock.mockResolvedValueOnce(tokenResponse());

    expect((await client.completeConnectInBrowser())!.apiKey).toBe('key_1');
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('removes the stash when the token exchange fails', async () => {
    local.setItem(stashKey('state-1'), stashFor('state-1'));
    vi.stubGlobal(
      'location',
      fakeLocation('https://my-agent.example/callback?code=code-1&state=state-1')
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
    );

    await expect(client.completeConnectInBrowser()).rejects.toMatchObject({
      code: 'OAUTH_ERROR',
    });
    expect(local.getItem(stashKey('state-1'))).toBeNull();
  });

  it('throws CONNECT_STATE_LOST for an expired stash, and removes it', async () => {
    local.setItem(stashKey('state-1'), stashFor('state-1', Date.now() - 11 * 60 * 1000));
    vi.stubGlobal(
      'location',
      fakeLocation('https://my-agent.example/callback?code=code-1&state=state-1')
    );

    await expect(client.completeConnectInBrowser()).rejects.toMatchObject({
      code: 'CONNECT_STATE_LOST',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(local.getItem(stashKey('state-1'))).toBeNull();
  });

  it('throws CONNECT_STATE_LOST for a code with no stash anywhere', async () => {
    vi.stubGlobal(
      'location',
      fakeLocation('https://my-agent.example/callback?code=code-1&state=state-1')
    );

    await expect(client.completeConnectInBrowser()).rejects.toMatchObject({
      code: 'CONNECT_STATE_LOST',
      message: expect.stringContaining('Start connecting again'),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never exchanges a code whose state names no stash, and leaves other flows alone', async () => {
    local.setItem(stashKey('expected'), stashFor('expected'));
    vi.stubGlobal(
      'location',
      fakeLocation('https://my-agent.example/callback?code=code-1&state=forged')
    );

    await expect(client.completeConnectInBrowser()).rejects.toMatchObject({
      code: 'CONNECT_STATE_LOST',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(local.getItem(stashKey('expected'))).not.toBeNull();
  });

  it('still works when storage is unreadable: a code is CONNECT_STATE_LOST, not a crash', async () => {
    const blocked = {
      getItem: () => {
        throw new Error('SecurityError');
      },
    };
    vi.stubGlobal('localStorage', blocked);
    vi.stubGlobal('sessionStorage', blocked);
    vi.stubGlobal(
      'location',
      fakeLocation('https://my-agent.example/callback?code=code-1&state=state-1')
    );

    await expect(client.completeConnectInBrowser()).rejects.toMatchObject({
      code: 'CONNECT_STATE_LOST',
    });
  });

  it('completes a legacy (pre-0.15.2) sessionStorage stash', async () => {
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

  it('rejects a state mismatch against the flow this tab started', async () => {
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

  it('throws OAUTH_ERROR for a denial in a new tab, and removes the stash', async () => {
    local.setItem(stashKey('state-1'), stashFor('state-1'));
    vi.stubGlobal(
      'location',
      fakeLocation('https://my-agent.example/callback?error=access_denied&state=state-1')
    );
    await expect(client.completeConnectInBrowser()).rejects.toMatchObject({
      code: 'OAUTH_ERROR',
      message: 'access_denied',
    });
    expect(local.getItem(stashKey('state-1'))).toBeNull();
  });

  it('throws OAUTH_ERROR, not CONNECT_STATE_LOST, for a denial with no stash', async () => {
    // The authorization server's answer is the more useful one to show.
    vi.stubGlobal(
      'location',
      fakeLocation('https://my-agent.example/callback?error=access_denied&state=state-1')
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

  it('popup child relays even with other flows stashed in shared storage', async () => {
    // Another tab's redirect flow (localStorage), and an older flow's legacy
    // stash copied into the popup's sessionStorage from its opener.
    local.setItem(stashKey('other-tab'), stashFor('other-tab'));
    storage.setItem(LEGACY_KEY, stashFor('older-flow'));
    const postMessage = vi.fn();
    const close = vi.fn();
    vi.stubGlobal('window', { opener: { postMessage }, close });
    vi.stubGlobal(
      'location',
      fakeLocation('https://my-agent.example/callback?code=code-1&state=state-1')
    );

    expect(await client.completeConnectInBrowser()).toBeNull();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'code-1', state: 'state-1' }),
      'https://my-agent.example'
    );
    expect(close).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(local.getItem(stashKey('other-tab'))).not.toBeNull();
  });

  it('popup mode end to end: the opener resolves from the relayed code', async () => {
    const listeners: Array<(e: MessageEvent) => void> = [];
    const popup = { closed: false, close: vi.fn() };
    const open = vi.fn((_url: string) => popup);
    vi.stubGlobal('window', {
      opener: null,
      open,
      addEventListener: (type: string, fn: (e: MessageEvent) => void) => {
        if (type === 'message') listeners.push(fn);
      },
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal('location', fakeLocation('https://my-agent.example/app'));
    fetchMock.mockResolvedValueOnce(tokenResponse());

    const pending = client.connectInBrowser({
      redirectUri: 'https://my-agent.example/callback',
      popup: true,
    });
    await vi.waitFor(() => expect(listeners).toHaveLength(1));
    // Popup mode writes no stash: that is how its callback page knows to relay.
    expect(local.keys()).toEqual([]);
    expect(storage.keys()).toEqual([]);

    const state = new URL(open.mock.calls[0][0]).searchParams.get('state');
    listeners[0]({
      origin: 'https://my-agent.example',
      data: { type: 'wire-sdk:browser-connect-result', code: 'code-1', state },
    } as MessageEvent);

    expect((await pending).apiKey).toBe('key_1');
    const body = fetchMock.mock.calls[0][1].body as URLSearchParams;
    expect(body.get('code')).toBe('code-1');
  });
});
