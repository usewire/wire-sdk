/**
 * WireAgentEndpoint: an agent's own endpoint over REST (`GET /tools`,
 * `POST /tools/{name}`), behind an injected fetch.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { WireAgentEndpoint, WireEndpointError } from '../app/index.js';

const TOKEN = 'opaque-access-token';

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: string | undefined;
  redirect: string | undefined;
}
let calls: Call[];
let answer: () => Response;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const fetchStub: typeof fetch = async (input, init) => {
  calls.push({ url: String(input), method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: typeof init?.body === 'string' ? init.body : undefined, redirect: init?.redirect });
  return answer();
};
const endpoint = (over: Record<string, unknown> = {}) => new WireAgentEndpoint({ agentId: 'someday', fetch: fetchStub, ...over } as never);
const err = async (p: Promise<unknown>): Promise<WireEndpointError> => {
  const e = await p.then(
    () => null,
    (x) => x,
  );
  expect(e).toBeInstanceOf(WireEndpointError);
  return e as WireEndpointError;
};

beforeEach(() => {
  calls = [];
  answer = () => json({ tools: [] });
});

describe('where it calls', () => {
  it('the agent’s own hostname by default, a custom hostname or preview when told', () => {
    expect(endpoint().origin).toBe('https://someday.agent.usewire.io');
    expect(endpoint({ endpoint: 'https://mcp.someday.example' }).origin).toBe('https://mcp.someday.example');
    expect(endpoint({ endpoint: 'https://someday.agent-preview.usewire.io/' }).origin).toBe('https://someday.agent-preview.usewire.io');
  });

  it('refuses a bad agent id, plain http, an endpoint with a path, with credentials, or with a trailing-dot host', () => {
    for (const bad of [
      { agentId: 'Some Day' },
      { endpoint: 'http://someday.agent.usewire.io' },
      { endpoint: 'https://someday.agent.usewire.io/mcp' },
      { endpoint: 'https://x.example/?a=1' },
      { endpoint: 'nonsense' },
      { endpoint: 'https://user:pw@mcp.someday.example' },
      { endpoint: 'https://someday.agent.usewire.io@evil.example' },
      { endpoint: 'https://mcp.someday.example.' },
    ]) {
      expect(() => endpoint(bad), JSON.stringify(bad)).toThrow(WireEndpointError);
    }
    expect(() => endpoint({ endpoint: 'http://localhost:8787' })).not.toThrow();
  });
});

describe('listTools', () => {
  it('GETs /tools with the person’s access token and answers the list', async () => {
    const tools = [
      { name: 'find_places', description: 'Find saved places.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
      { name: 'save_place', description: 'Save a place.', inputSchema: { type: 'object' } },
    ];
    answer = () => json({ tools });
    expect(await endpoint().listTools(TOKEN)).toEqual(tools);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: 'https://someday.agent.usewire.io/tools', method: 'GET', body: undefined, redirect: 'manual' });
    expect(calls[0]!.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('an empty list is an answer (access level none), not an error', async () => {
    expect(await endpoint().listTools(TOKEN)).toEqual([]);
  });

  it('an answer that is not a tool list is refused', async () => {
    for (const body of [{}, { tools: 'x' }, { tools: [{ description: 'no name' }] }, [1]]) {
      answer = () => json(body);
      expect((await err(endpoint().listTools(TOKEN))).code).toBe('UNEXPECTED_RESPONSE');
    }
  });
});

describe('callTool', () => {
  it('POSTs the arguments as JSON to /tools/{name} and answers the tool’s data', async () => {
    answer = () => json({ ok: true, data: { places: [{ name: 'Ramen Ya' }] }, resultIds: ['e1'] });
    const result = await endpoint().callTool<{ places: { name: string }[] }>(TOKEN, 'find_places', { q: 'ramen' });
    expect(result).toEqual({ data: { places: [{ name: 'Ramen Ya' }] }, resultIds: ['e1'] });
    expect(calls[0]).toMatchObject({ url: 'https://someday.agent.usewire.io/tools/find_places', method: 'POST', body: '{"q":"ramen"}' });
    expect(calls[0]!.headers.get('content-type')).toBe('application/json');
    expect(calls[0]!.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('view-only data comes back beside the data, never inside it', async () => {
    answer = () => json({ ok: true, data: { saved: true }, _meta: { view: { pin: [1, 2] } } });
    expect(await endpoint().callTool(TOKEN, 'save_place', { name: 'x' })).toEqual({ data: { saved: true }, viewMeta: { pin: [1, 2] } });
  });

  it('a tool with no arguments sends an empty object', async () => {
    answer = () => json({ ok: true, data: null });
    await endpoint().callTool(TOKEN, 'keep_my_places');
    expect(calls[0]!.body).toBe('{}');
  });

  it('a refusal by the tool is TOOL_REFUSED with the tool’s own words, and is not retryable', async () => {
    answer = () => json({ ok: false, error: 'this app may read your records, not change them' }, 400);
    const e = await err(endpoint().callTool(TOKEN, 'save_place', { name: 'x' }));
    expect(e).toMatchObject({ code: 'TOOL_REFUSED', status: 400, retryable: false, message: 'this app may read your records, not change them' });
  });

  it('maps the other answers: a stale token, no credits, not found, a blip with Retry-After', async () => {
    const cases: Array<[() => Response, string, boolean]> = [
      [() => json({ error: 'unauthorized' }, 401), 'UNAUTHORIZED', false],
      [() => json({ error: 'Insufficient credits' }, 402), 'INSUFFICIENT_CREDITS', false],
      [() => json({ error: 'not_found', message: 'This agent endpoint serves /mcp, GET /tools and POST /tools/{name}.' }, 404), 'NOT_FOUND', false],
      [() => json({ error: 'agent_endpoint_unavailable', message: 'Try again in a moment' }, 503, { 'retry-after': '5' }), 'UNAVAILABLE', true],
      [() => json({ error: 'too_many' }, 429), 'UNAVAILABLE', true],
      [() => new Response('<html>bad gateway</html>', { status: 502 }), 'UNAVAILABLE', true],
      [() => json({ ok: 'yes' }), 'UNEXPECTED_RESPONSE', false],
    ];
    for (const [a, code, retryable] of cases) {
      answer = a;
      const e = await err(endpoint().callTool(TOKEN, 'find_places', {}));
      expect(e.code, code).toBe(code);
      expect(e.retryable, code).toBe(retryable);
    }
    answer = () => json({ error: 'x' }, 503, { 'retry-after': '5' });
    expect((await err(endpoint().callTool(TOKEN, 'find_places', {}))).retryAfterSec).toBe(5);
  });

  it('refuses a name that is not one tool name before anything is sent', async () => {
    for (const name of ['', 'a/b', '../audit', 'save place', 'a?b', 'mcp', 'x'.repeat(129)]) {
      expect((await err(endpoint().callTool(TOKEN, name, {}))).code).toBe('INVALID_ARGUMENT');
    }
    expect((await err(endpoint().callTool(TOKEN, 'find_places', [] as never))).code).toBe('INVALID_ARGUMENT');
    expect((await err(endpoint().callTool('', 'find_places', {}))).code).toBe('INVALID_ARGUMENT');
    expect((await err(endpoint().callTool('two words', 'find_places', {}))).code).toBe('INVALID_ARGUMENT');
    expect(calls).toHaveLength(0);
  });

  it('a request that never reaches Wire is NETWORK_ERROR, retryable', async () => {
    const e = await err(new WireAgentEndpoint({ agentId: 'someday', fetch: (async () => { throw new TypeError('fetch failed'); }) as never }).listTools(TOKEN));
    expect(e).toMatchObject({ code: 'NETWORK_ERROR', retryable: true });
  });

  it('a redirect is never followed: the access token goes to this origin and nowhere else', async () => {
    for (const status of [301, 302, 307, 308]) {
      answer = () => new Response(null, { status, headers: { location: 'https://evil.example/tools' } });
      calls = [];
      const e = await err(endpoint().listTools(TOKEN));
      expect(e, String(status)).toMatchObject({ code: 'UNEXPECTED_RESPONSE', retryable: false });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe('https://someday.agent.usewire.io/tools');
    }
    const opaque = { type: 'opaqueredirect', status: 0, ok: false, headers: new Headers(), json: async () => null } as unknown as Response;
    const e = await err(new WireAgentEndpoint({ agentId: 'someday', fetch: (async () => opaque) as never }).callTool(TOKEN, 'find_places', {}));
    expect(e.code).toBe('UNEXPECTED_RESPONSE');
  });

  it('the access token is never in an error', async () => {
    answer = () => json({ error: 'unauthorized' }, 401);
    const e = await err(endpoint().listTools(TOKEN));
    expect(JSON.stringify({ m: e.message, d: e.details })).not.toContain(TOKEN);
  });
});
