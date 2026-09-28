/**
 * SUP-958: every connection result carries the install's stable ids,
 * `install_id` / `app_user_id` on the wire, `installId` / `appUserId` here,
 * and null from a server that predates them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WireClient } from '../client.js';

const INSTALL = 'ins_aaaaaaaaaaaaaaaaaaaaaaaa';
const APP_USER = 'au_bbbbbbbbbbbbbbbbbbbbbbbb';

const CONNECTION = {
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

const CONNECT_BODY = {
  success: true,
  data: { nonce: 'a'.repeat(48), user_code: 'BFXR9243', expires_in: 600, credential_id: 'cred_1' },
};

function statusBody(ids: Record<string, unknown>) {
  return {
    success: true,
    data: {
      container: {
        id: 'cont_1',
        name: 'Test',
        mcp_endpoint: CONNECTION.mcp_endpoint,
        organization_slug: 'acme',
        is_ephemeral: false,
        created_at: '2026-07-01T00:00:00.000Z',
        ephemeral_expires_at: null,
      },
      connection: { id: 'conn_1', connected_at: '2026-07-01T00:00:00.000Z', last_used_at: null, label: null, ...ids },
      app: { id: 'test-agent', name: 'Test Agent', verified: true },
    },
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('installId / appUserId on connection results', () => {
  const client = new WireClient({ agentId: 'test-agent' });
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('device flow: checkConnection (and so connect) maps install_id / app_user_id', async () => {
    fetchMock.mockResolvedValueOnce(json(CONNECT_BODY));
    const pending = await client.beginConnect();
    fetchMock.mockResolvedValueOnce(json({ status: 'ready', ...CONNECTION, install_id: INSTALL, app_user_id: APP_USER }));
    const c = (await client.checkConnection(pending))!;
    expect(c.installId).toBe(INSTALL);
    expect(c.appUserId).toBe(APP_USER);
  });

  it('a trial: installId now, appUserId null until claim', async () => {
    fetchMock.mockResolvedValueOnce(json(CONNECT_BODY));
    const pending = await client.beginConnect();
    fetchMock.mockResolvedValueOnce(json({ status: 'ready', ...CONNECTION, is_ephemeral: true, install_id: INSTALL, app_user_id: null }));
    const c = (await client.checkConnection(pending))!;
    expect(c.installId).toBe(INSTALL);
    expect(c.appUserId).toBeNull();
  });

  it('an older server: both null', async () => {
    fetchMock.mockResolvedValueOnce(json(CONNECT_BODY));
    const pending = await client.beginConnect();
    fetchMock.mockResolvedValueOnce(json({ status: 'ready', ...CONNECTION }));
    const c = (await client.checkConnection(pending))!;
    expect(c.installId).toBeNull();
    expect(c.appUserId).toBeNull();
  });

  it('getStatus maps them from connection', async () => {
    fetchMock.mockResolvedValueOnce(json(statusBody({ install_id: INSTALL, app_user_id: APP_USER })));
    const s = await client.getStatus('key_1');
    expect(s.connection.installId).toBe(INSTALL);
    expect(s.connection.appUserId).toBe(APP_USER);

    fetchMock.mockResolvedValueOnce(json(statusBody({})));
    const old = await client.getStatus('key_1');
    expect(old.connection.installId).toBeNull();
    expect(old.connection.appUserId).toBeNull();
  });

  it('browser flow: the token response connection carries them', async () => {
    const store = new Map<string, string>([
      [
        'wire-sdk:browser-connect',
        JSON.stringify({ verifier: 'v'.repeat(48), state: 'state-1', redirectUri: 'https://my-agent.example/callback', agentId: 'test-agent' }),
      ],
    ]);
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    vi.stubGlobal('window', { opener: null });
    vi.stubGlobal('history', { replaceState: vi.fn() });
    const href = 'https://my-agent.example/callback?code=code-1&state=state-1';
    vi.stubGlobal('location', { href, search: new URL(href).search, origin: 'https://my-agent.example', assign: vi.fn() });
    fetchMock.mockResolvedValueOnce(
      json({ access_token: 'jwt', connection: { ...CONNECTION, install_id: INSTALL, app_user_id: APP_USER } })
    );
    const c = (await client.completeConnectInBrowser())!;
    expect(c.installId).toBe(INSTALL);
    expect(c.appUserId).toBe(APP_USER);
  });
});

describe('the agent field names (agent_id, agent_user_id, agent) and the pre-rename ones', () => {
  const client = new WireClient({ agentId: 'test-agent' });
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  async function ready(body: Record<string, unknown>) {
    fetchMock.mockResolvedValueOnce(json(CONNECT_BODY));
    const pending = await client.beginConnect();
    fetchMock.mockResolvedValueOnce(json({ status: 'ready', ...body }));
    return (await client.checkConnection(pending))!;
  }

  it('a server that sends only the agent names', async () => {
    const { app_id: _drop, ...rest } = CONNECTION;
    const c = await ready({ ...rest, agent_id: 'test-agent', install_id: INSTALL, agent_user_id: APP_USER });
    expect(c.agentId).toBe('test-agent');
    expect(c.agentUserId).toBe(APP_USER);
    expect(c.appUserId).toBe(APP_USER);
  });

  it('a server that sends both (the rename window): the agent names win', async () => {
    const c = await ready({ ...CONNECTION, agent_id: 'test-agent', install_id: INSTALL, agent_user_id: APP_USER, app_user_id: 'au_stale' });
    expect(c.agentUserId).toBe(APP_USER);
    expect(c.appUserId).toBe(APP_USER);
  });

  it('a server that sends only the old names: agentUserId still set', async () => {
    const c = await ready({ ...CONNECTION, install_id: INSTALL, app_user_id: APP_USER });
    expect(c.agentId).toBe('test-agent');
    expect(c.agentUserId).toBe(APP_USER);
  });

  it('getStatus reads agent and agent_user_id, falling back to app and app_user_id', async () => {
    const body = statusBody({ install_id: INSTALL, agent_user_id: APP_USER });
    const { app: _app, ...data } = body.data;
    fetchMock.mockResolvedValueOnce(json({ ...body, data: { ...data, agent: { id: 'test-agent', name: 'Test Agent', verified: true } } }));
    const s = await client.getStatus('key_1');
    expect(s.connection.agentUserId).toBe(APP_USER);
    expect(s.agent).toEqual({ id: 'test-agent', name: 'Test Agent', verified: true });

    fetchMock.mockResolvedValueOnce(json(statusBody({ install_id: INSTALL, app_user_id: APP_USER })));
    const old = await client.getStatus('key_1');
    expect(old.connection.agentUserId).toBe(APP_USER);
    expect(old.agent).toEqual({ id: 'test-agent', name: 'Test Agent', verified: true });
  });
});
