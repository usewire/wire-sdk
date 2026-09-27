import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  defineAction,
  defineManifest,
  MemoryReplayStore,
  toNodeHandler,
  WireActionError,
  WireManifestError,
  type ActionContext,
  type DefineActionOptions,
} from '../app/index.js';
import {
  actionRequest,
  makeKey,
  NOW,
  signAction,
  startJwksServer,
  uniqueUrl,
  type JwksServer,
  type TestKey,
} from './helpers/wire-signer.js';

const manifest = defineManifest({
  manifest: 1,
  app: { id: 'geo_app', name: 'Geo App', version: '0.1.0' },
  actions: [
    {
      name: 'geocode',
      description: 'Turns a street address into coordinates. The address is sent to the app; nothing is stored.',
      url: 'https://geo-app.example/geocode',
      input: {
        type: 'object',
        properties: { address: { type: 'string', minLength: 1 } },
        required: ['address'],
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: { lat: { type: 'number' }, lng: { type: 'number' } },
        required: ['lat', 'lng'],
      },
      timeout_ms: 400,
    },
    {
      name: 'reverse_geocode',
      description: 'Turns coordinates into an address.',
      url: 'https://geo-app.example/reverse',
      input: { type: 'object' },
      output: { type: 'object' },
    },
  ],
  tools: [
    {
      name: 'save_place',
      description: 'Save a place.',
      inputSchema: { type: 'object', properties: { address: { type: 'string' } }, required: ['address'] },
      before: { action: 'geocode', args: { address: '{{input.address}}' } },
      tool: { name: 'wire_write', args: { content: '{{input.address}}' } },
    },
  ],
});

const BODY = JSON.stringify({ address: '1 Main St, Springfield' });

let server: JwksServer;
let key: TestKey;

beforeAll(async () => {
  key = await makeKey('wire-2026-09');
  server = await startJwksServer([key.publicJwk]);
});
afterAll(() => server.close());

function options(extra: Partial<DefineActionOptions> = {}): DefineActionOptions {
  return {
    jwksUrl: uniqueUrl(server),
    now: () => NOW,
    replayStore: new MemoryReplayStore(),
    onError: () => {},
    ...extra,
  };
}

async function call(endpoint: { fetch(r: Request): Promise<Response> }, body = BODY, sign: Partial<Parameters<typeof signAction>[0]> = {}) {
  const token = await signAction({ key, body, ...sign });
  const res = await endpoint.fetch(actionRequest(token, body));
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

describe('defineAction', () => {
  it('verifies, runs the handler with the call context, and answers JSON', async () => {
    const handler = vi.fn(async (input: { address: string }, _ctx: ActionContext) => {
      expect(input.address).toBe('1 Main St, Springfield');
      return { lat: 39.8, lng: -89.6 };
    });
    const geocode = defineAction(manifest, 'geocode', handler, options());
    const { status, json } = await call(geocode);
    expect(status).toBe(200);
    expect(json).toEqual({ lat: 39.8, lng: -89.6 });
    const ctx = handler.mock.calls[0]![1];
    expect(ctx).toMatchObject({ connectionId: 'conn_123', containerId: 'ctr_456', action: 'geocode', requestId: 'req_789' });
    expect(ctx.signal).toBeInstanceOf(AbortSignal);
  });

  it('answers 401 on a failed verification without running the handler', async () => {
    const handler = vi.fn();
    const geocode = defineAction(manifest, 'geocode', handler, options());
    const res = await geocode.fetch(actionRequest(null, BODY));
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).error.code).toBe('MISSING_TOKEN');

    const { status, json } = await call(geocode, BODY, { aud: 'someone-else' });
    expect(status).toBe(401);
    expect(json.error.code).toBe('INVALID_AUDIENCE');
    expect(handler).not.toHaveBeenCalled();
  });

  it('refuses a token minted for a different action', async () => {
    const geocode = defineAction(manifest, 'geocode', () => ({ lat: 0, lng: 0 }), options());
    const { status, json } = await call(geocode, BODY, { action: 'reverse_geocode' });
    expect(status).toBe(401);
    expect(json.error.code).toBe('ACTION_MISMATCH');
  });

  it('answers 405 to anything but POST', async () => {
    const geocode = defineAction(manifest, 'geocode', () => ({ lat: 0, lng: 0 }), options());
    const res = await geocode.fetch(actionRequest(null, '', { method: 'GET' }));
    expect(res.status).toBe(405);
  });

  it('answers 400 when input does not match the input schema', async () => {
    const handler = vi.fn();
    const geocode = defineAction(manifest, 'geocode', handler, options());
    const { status, json } = await call(geocode, JSON.stringify({ addr: 'typo' }));
    expect(status).toBe(400);
    expect(json.error.code).toBe('INVALID_INPUT');
    expect(json.error.issues.length).toBeGreaterThan(0);
    expect(handler).not.toHaveBeenCalled();
  });

  it('answers 400 on a body that is not JSON', async () => {
    const geocode = defineAction(manifest, 'geocode', vi.fn(), options());
    const { status, json } = await call(geocode, 'not json');
    expect(status).toBe(400);
    expect(json.error.code).toBe('INVALID_JSON');
  });

  it('answers 500 when the handler returns output that breaks the output schema', async () => {
    const onError = vi.fn();
    const geocode = defineAction(manifest, 'geocode', () => ({ lat: 'north' }) as any, options({ onError }));
    const { status, json } = await call(geocode);
    expect(status).toBe(500);
    expect(json.error.code).toBe('INVALID_OUTPUT');
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_OUTPUT' }));
  });

  it('passes a deliberate WireActionError through to the agent', async () => {
    const geocode = defineAction(
      manifest,
      'geocode',
      () => {
        throw new WireActionError('NOT_FOUND', 'No match for that address', 404);
      },
      options()
    );
    const { status, json } = await call(geocode);
    expect(status).toBe(404);
    expect(json.error).toEqual({ code: 'NOT_FOUND', message: 'No match for that address' });
  });

  it('hides the details of an unexpected handler error', async () => {
    const geocode = defineAction(
      manifest,
      'geocode',
      () => {
        throw new Error('db password is hunter2');
      },
      options()
    );
    const { status, json } = await call(geocode);
    expect(status).toBe(500);
    expect(json.error.code).toBe('HANDLER_ERROR');
    expect(JSON.stringify(json)).not.toContain('hunter2');
  });

  it("answers 504 before Wire's timeout and aborts the handler's signal", async () => {
    let signal: AbortSignal | undefined;
    const geocode = defineAction(
      manifest,
      'geocode',
      async (_input, ctx) => {
        signal = ctx.signal;
        await new Promise((r) => setTimeout(r, 2000));
        return { lat: 0, lng: 0 };
      },
      options({ deadlineMarginMs: 100 })
    );
    const started = Date.now();
    const { status, json } = await call(geocode);
    expect(status).toBe(504);
    expect(json.error.code).toBe('TIMEOUT');
    expect(Date.now() - started).toBeLessThan(400); // timeout_ms 400 minus the margin
    expect(signal?.aborted).toBe(true);
  });

  it('throws at definition time for an action the manifest does not declare', () => {
    expect(() => defineAction(manifest, 'nope', () => ({}))).toThrow(/no action named "nope"/);
  });

  it('checks a manifest that did not come through defineManifest', () => {
    const raw = {
      manifest: 1 as const,
      app: { id: 'geo_app', name: 'Geo', version: '1' },
      actions: [{ name: 'a', description: 'd', url: 'https://x.example', input: {}, output: {}, timeout_ms: Number.NaN }],
    };
    expect(() => defineAction(raw, 'a', () => ({}))).toThrow(WireManifestError);
  });

  it('refuses a bad jwksUrl at definition time', () => {
    expect(() => defineAction(manifest, 'geocode', () => ({ lat: 0, lng: 0 }), { jwksUrl: 'http://wire.example/j' })).toThrow(
      TypeError
    );
  });

  it('answers 500 INVALID_OUTPUT when the handler returns nothing', async () => {
    const geocode = defineAction(manifest, 'geocode', () => undefined as any, options());
    const { status, json } = await call(geocode);
    expect(status).toBe(500);
    expect(json.error.code).toBe('INVALID_OUTPUT');
  });

  it('keeps a WireActionError status inside the error range', async () => {
    const geocode = defineAction(
      manifest,
      'geocode',
      () => {
        throw new WireActionError('ODD', 'odd status', 1234);
      },
      options()
    );
    const { status } = await call(geocode);
    expect(status).toBe(500);
  });

  it('checks wire_url against the url option instead of the request URL', async () => {
    const geocode = defineAction(manifest, 'geocode', () => ({ lat: 1, lng: 2 }), options({ url: 'https://geo-app.example/geocode' }));
    const token = await signAction({ key, body: BODY });
    const res = await geocode.fetch(actionRequest(token, BODY, { url: 'http://internal:8080/v1/geocode' }));
    expect(res.status).toBe(200);
  });

  it('serves through the Hono shape', async () => {
    const geocode = defineAction(manifest, 'geocode', () => ({ lat: 1, lng: 2 }), options());
    const token = await signAction({ key, body: BODY });
    const res = await geocode.hono({ req: { raw: actionRequest(token, BODY) } });
    expect(res.status).toBe(200);
  });

  it('serves through the Node (req, res) adapter, with the public origin given', async () => {
    const geocode = defineAction(manifest, 'geocode', () => ({ lat: 1, lng: 2 }), options());
    // A Node server behind TLS termination sees http://127.0.0.1:port; Wire
    // signed https://geo-app.example/geocode.
    const plain = createServer(toNodeHandler(geocode));
    const http = createServer(toNodeHandler(geocode, { origin: 'https://geo-app.example' }));
    await new Promise<void>((r) => plain.listen(0, '127.0.0.1', r));
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    const { port } = http.address() as AddressInfo;
    const plainPort = (plain.address() as AddressInfo).port;
    try {
      const withoutOrigin = await fetch(`http://127.0.0.1:${plainPort}/geocode`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await signAction({ key, body: BODY })}` },
        body: BODY,
      });
      expect(withoutOrigin.status).toBe(401);
      expect(((await withoutOrigin.json()) as any).error.code).toBe('URL_MISMATCH');

      const token = await signAction({ key, body: BODY });
      const ok = await fetch(`http://127.0.0.1:${port}/geocode`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: BODY,
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ lat: 1, lng: 2 });

      const tampered = await fetch(`http://127.0.0.1:${port}/geocode`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await signAction({ key, body: BODY })}` },
        body: BODY + ' ',
      });
      expect(tampered.status).toBe(401);
    } finally {
      await new Promise<void>((r) => http.close(() => r()));
      await new Promise<void>((r) => plain.close(() => r()));
    }
  });
});

describe('defineManifest', () => {
  const valid = {
    manifest: 1 as const,
    app: { id: 'geo_app', name: 'Geo App', version: '0.1.0' },
    actions: [
      {
        name: 'geocode',
        description: 'Geocodes an address.',
        url: 'https://geo-app.example/geocode',
        input: { type: 'object' },
        output: { type: 'object' },
      },
    ],
  };

  it("returns the engine's normalized manifest, frozen, without touching the input", () => {
    const m = defineManifest(valid);
    expect(m.app).toEqual(valid.app);
    expect(m.actions![0]).toMatchObject({ ...valid.actions[0], method: 'POST', timeout_ms: 8000 });
    expect(Object.isFrozen(m.actions![0]!.input)).toBe(true);
    expect(Object.isFrozen(valid)).toBe(false);
    expect((valid.actions[0] as Record<string, unknown>).timeout_ms).toBeUndefined();
  });

  it.each([
    ['wrong format version', { ...valid, manifest: 2 }, 'manifest'],
    ['missing app', { ...valid, app: undefined }, 'app'],
    ['an action without a description', { ...valid, actions: [{ ...valid.actions[0], description: ' ' }] }, 'actions.0.description'],
    ['a non-https action URL', { ...valid, actions: [{ ...valid.actions[0], url: 'http://geo-app.example/x' }] }, 'actions.0.url'],
    ['a private-address action URL', { ...valid, actions: [{ ...valid.actions[0], url: 'https://10.0.0.1/x' }] }, 'actions.0.url'],
    ['a cloud metadata host as action URL', { ...valid, actions: [{ ...valid.actions[0], url: 'https://metadata.google.internal/x' }] }, 'actions.0.url'],
    ['a timeout over 8 seconds', { ...valid, actions: [{ ...valid.actions[0], timeout_ms: 30_000 }] }, 'actions.0.timeout_ms'],
    ['duplicate action names', { ...valid, actions: [valid.actions[0], valid.actions[0]] }, 'actions.1.name'],
    ['a missing output schema', { ...valid, actions: [{ ...valid.actions[0], output: undefined }] }, 'actions.0.output'],
    [
      'a schema keyword outside the supported subset',
      { ...valid, actions: [{ ...valid.actions[0], input: { type: 'object', patternProperties: { x: {} } } }] },
      'actions.0.input',
    ],
    ['an unknown top-level field', { ...valid, extra: true }, 'extra'],
    [
      'a tool that references an undeclared action',
      {
        ...valid,
        tools: [
          {
            name: 't',
            description: 'd',
            inputSchema: {},
            before: { action: 'missing', args: {} },
            tool: { name: 'wire_write', args: {} },
          },
        ],
      },
      'tools.0',
    ],
  ])('rejects %s', (_label, manifest, path) => {
    let err: unknown;
    try {
      defineManifest(manifest as any);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WireManifestError);
    expect((err as WireManifestError).issues.some((i) => i.path === path || i.path.startsWith(`${path}.`))).toBe(true);
  });
});
