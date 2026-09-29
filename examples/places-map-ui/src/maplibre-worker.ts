// Where MapLibre's tile worker runs, decided once before the first map is created.
//
// MapLibre GL JS 6 parses tiles in a module Web Worker, `maplibre-gl-worker.mjs`. This page
// loads MapLibre from jsDelivr, a different origin than the sandbox iframe, and a browser will
// not construct a Worker from a cross-origin URL. So MapLibre wraps it: it creates a `blob:`
// URL whose only line is `import "<worker url>"` and starts the worker from that. That needs
// the host's CSP to allow `blob:` workers (`worker-src blob:`, or `script-src blob:` when the
// host sets no worker-src). Some hosts do (the ext-apps basic-host does). The MCP Apps spec's
// reference CSP does not: its `script-src` is `'self' 'unsafe-inline' <resourceDomains>`, and
// a Wire manifest's `csp` can only add https origins, never `blob:`.
//
// So we probe. If a blob module worker starts, MapLibre gets real workers. If it does not,
// `Worker` is replaced (for this page only) by an in-thread stand-in: the same
// maplibre-gl-worker.mjs, imported as a module on the main thread (an https import from an
// origin in resourceDomains, which every CSP here allows), talking to MapLibre over a
// MessageChannel, so messages are still structured-cloned and transferred exactly as they
// would be with a real worker. Tiles then parse on the main thread: slower on big maps, and
// fine for a page of saved places.

import * as maplibregl from "maplibre-gl";

declare const __MAPLIBRE_VERSION__: string;

export const MAPLIBRE_CDN = `https://cdn.jsdelivr.net/npm/maplibre-gl@${__MAPLIBRE_VERSION__}/dist`;
const WORKER_URL = `${MAPLIBRE_CDN}/maplibre-gl-worker.mjs`;

// At module evaluation, so it is set before mapcn's map.tsx evaluates (main.tsx imports this
// module first) and mapcn's unpkg default is never taken: jsDelivr is the one script origin.
maplibregl.setWorkerUrl(WORKER_URL);

export type WorkerMode = "worker" | "main-thread";

/** Can this document start a module worker from a `blob:` URL (what MapLibre does for a
 *  cross-origin worker)? Chrome throws on construction when CSP forbids it; other engines
 *  fire `error` instead; a worker that never answers counts as no. */
function blobModuleWorkersAllowed(timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    let url = "";
    let worker: Worker | undefined;
    const done = (ok: boolean) => {
      clearTimeout(timer);
      worker?.terminate();
      if (url) URL.revokeObjectURL(url);
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    try {
      url = URL.createObjectURL(new Blob(["postMessage(1)"], { type: "text/javascript" }));
      worker = new Worker(url, { type: "module" });
      worker.onmessage = () => done(true);
      worker.onerror = () => done(false);
    } catch {
      done(false);
    }
  });
}

/** The scope object a MapLibre worker is constructed with, backed by one end of a
 *  MessageChannel instead of a WorkerGlobalScope. MapLibre's worker only needs
 *  add/removeEventListener("message") and postMessage from it, and hangs its
 *  registration hooks (registerWorkerSource, addProtocol, ...) on it. */
class InThreadScope {
  constructor(private readonly port: MessagePort) {}
  addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) {
    this.port.addEventListener(type, listener, options);
  }
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) {
    this.port.removeEventListener(type, listener, options);
  }
  postMessage(message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) {
    this.port.postMessage(message, transfer as StructuredSerializeOptions);
  }
}

/** A `Worker` look-alike that runs MapLibre's worker module on the main thread. The URL it is
 *  constructed with is ignored (MapLibre passes its blob wrapper); it always loads WORKER_URL. */
class InThreadWorker extends EventTarget {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  private readonly port: MessagePort;

  constructor() {
    super();
    const channel = new MessageChannel();
    this.port = channel.port1;
    this.port.onmessage = (e) => {
      const ev = new MessageEvent("message", { data: e.data });
      this.dispatchEvent(ev);
      this.onmessage?.(ev);
    };
    const inner = channel.port2;
    import(/* @vite-ignore */ WORKER_URL)
      .then((mod: { default: new (scope: unknown) => unknown }) => {
        new mod.default(new InThreadScope(inner));
        // Messages MapLibre posted before the module loaded were queued on the port; start
        // delivering them now that the worker's listener is attached.
        inner.start();
      })
      .catch((err) => {
        console.error("[places-map] could not load the MapLibre worker module", err);
        const ev = new ErrorEvent("error", { error: err, message: String(err) });
        this.dispatchEvent(ev);
        this.onerror?.(ev);
      });
  }

  postMessage(message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) {
    this.port.postMessage(message, transfer as StructuredSerializeOptions);
  }

  terminate() {
    this.port.close();
  }
}

let decided: Promise<WorkerMode> | undefined;

/** Pick real workers or the in-thread stand-in. Call (and await) before the first map is
 *  created. Idempotent. */
export function configureMapLibreWorkers(): Promise<WorkerMode> {
  decided ??= (async () => {
    if (await blobModuleWorkersAllowed()) return "worker";
    maplibregl.setWorkerCount(1);
    (globalThis as { Worker: unknown }).Worker = InThreadWorker;
    console.info("[places-map] blob: workers are blocked by this host's CSP; MapLibre runs its worker on the main thread");
    return "main-thread";
  })();
  return decided;
}
