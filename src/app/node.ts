/**
 * Node `http` adapter: serve a WireActionEndpoint from `http.createServer`,
 * Express, Fastify's raw handler, or anything else that hands you Node's
 * (req, res). No `node:` imports, so the app entry stays runtime-neutral.
 *
 * The body hash is over the exact bytes Wire sent, so this reads the raw
 * stream itself. Mount it BEFORE any body parser (express.json() and friends
 * consume the stream and re-serializing their result would not hash the same).
 * If a raw-body middleware already ran, a Buffer/Uint8Array `req.body` is used.
 */
import type { WireActionEndpoint } from './action.js';

/** The parts of http.IncomingMessage this adapter uses. */
export interface NodeRequestLike extends AsyncIterable<Uint8Array | string> {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

/** The parts of http.ServerResponse this adapter uses. */
export interface NodeResponseLike {
  statusCode: number;
  setHeader(name: string, value: string | string[]): unknown;
  end(chunk?: Uint8Array | string): unknown;
}

export interface NodeHandlerOptions {
  /** Largest body read (default 1 MiB, matching verification's default). */
  maxBodyBytes?: number;
}

/** Wrap an endpoint as a Node `(req, res)` handler. */
export function toNodeHandler(
  endpoint: Pick<WireActionEndpoint, 'fetch'>,
  options: NodeHandlerOptions = {}
): (req: NodeRequestLike, res: NodeResponseLike) => Promise<void> {
  const maxBytes = options.maxBodyBytes ?? 1024 * 1024;

  return async (req, res) => {
    let response: Response;
    try {
      const body = await readNodeBody(req, maxBytes);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined) continue;
        if (Array.isArray(v)) for (const item of v) headers.append(k, item);
        else headers.set(k, v);
      }
      const host = headers.get('host') ?? 'localhost';
      const method = req.method ?? 'GET';
      response = await endpoint.fetch(
        new Request(`http://${host}${req.url ?? '/'}`, {
          method,
          headers,
          body: method === 'GET' || method === 'HEAD' ? undefined : body,
        })
      );
    } catch (err) {
      const known = err instanceof BodyError;
      const status = known ? err.status : 500;
      const code = known ? err.code : 'INTERNAL_ERROR';
      const message = known ? err.message : 'The request could not be read';
      response = new Response(JSON.stringify({ error: { code, message } }), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }

    res.statusCode = response.status;
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });
    res.end(new Uint8Array(await response.arrayBuffer()));
  };
}

class BodyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

async function readNodeBody(req: NodeRequestLike, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  if (req.body instanceof Uint8Array) {
    if (req.body.byteLength > maxBytes) throw new BodyError(413, 'BODY_TOO_LARGE', `Body exceeds ${maxBytes} bytes`);
    return new Uint8Array(req.body);
  }
  if (req.body !== undefined && req.body !== null && !isEmptyObject(req.body)) {
    throw new BodyError(
      500,
      'BODY_ALREADY_PARSED',
      'The request body was already parsed by middleware; mount the Wire action before any JSON body parser'
    );
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of req) {
    const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
    total += bytes.byteLength;
    if (total > maxBytes) throw new BodyError(413, 'BODY_TOO_LARGE', `Body exceeds ${maxBytes} bytes`);
    chunks.push(bytes);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function isEmptyObject(v: unknown): boolean {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0;
}
