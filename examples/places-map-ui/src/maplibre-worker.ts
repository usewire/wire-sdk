// Where MapLibre's tile worker runs, decided once before the first map is created.
//
// MapLibre GL JS 6 parses tiles in a module Web Worker, `maplibre-gl-worker.mjs`, which this page
// loads from jsDelivr. Three host policies matter, and each one breaks a naive setup:
//
//   1. A browser never starts a Worker straight from a cross-origin URL.
//   2. ChatGPT: `worker-src blob:` only. A blob: worker may start, but a STATIC `import` inside a
//      module worker is fetched as part of the worker's own script graph (request destination
//      "worker"), so it is checked against worker-src too, and https://cdn.jsdelivr.net is
//      refused. That is MapLibre's own cross-origin wrapper (`import "<cdn url>"` in a blob), and
//      it fails in ChatGPT with "Creating a worker from 'https://cdn.jsdelivr.net/…/
//      maplibre-gl-worker.mjs' violates … worker-src blob:" / "Worker failed to load".
//   3. The MCP Apps spec's reference CSP: no blob: workers at all (`script-src 'self'
//      'unsafe-inline' <resourceDomains>`, no worker-src), and a Wire manifest's `csp` can only
//      add https origins.
//
// So MapLibre is pointed at OUR blob: wrapper (setWorkerUrl; a blob: URL is same-origin to the
// document, so MapLibre starts it directly, as a module worker). The wrapper loads the worker
// with a DYNAMIC `import()`, which is fetched as a script (destination "script"), so it is
// checked against script-src, where the manifest's resourceDomains put jsDelivr. It buffers
// MapLibre's first messages until the module has attached its listener, then replays them.
//
// Before any map exists we PROBE that exact path: a worker from the same wrapper that says so once
// the worker module has loaded. If it does (basic-host, ChatGPT), MapLibre gets real workers. If
// it fails for any reason (blob: workers refused, the import refused, a timeout), `Worker` is
// replaced, for this page only, by an in-thread stand-in: the same maplibre-gl-worker.mjs,
// imported on the main thread (script-src again), talking to MapLibre over a MessageChannel, so
// messages are still structured-cloned and transferred as with a real worker. Tiles then parse on
// the main thread: slower on big maps, fine for a page of saved places.
//
// SRI: the page's import map pins every module the MAIN thread imports (including this worker
// module, for the in-thread path). Import maps don't apply inside workers, and `import()` takes no
// integrity, so in a real worker the module comes from the same pinned, immutable jsDelivr version
// without a digest check.

import * as maplibregl from "maplibre-gl";

declare const __MAPLIBRE_VERSION__: string;

export const MAPLIBRE_CDN = `https://cdn.jsdelivr.net/npm/maplibre-gl@${__MAPLIBRE_VERSION__}/dist`;
const WORKER_URL = `${MAPLIBRE_CDN}/maplibre-gl-worker.mjs`;

/** The worker entry: dynamic-import MapLibre's worker, holding messages until it listens. With
 *  `probe`, it also reports "loaded" (or the import's failure) to its creator: the probe worker
 *  only, never one MapLibre talks to. */
function wrapperSource(probe: boolean): string {
  return [
    "const held = [];",
    "const hold = (e) => held.push(e);",
    "self.addEventListener('message', hold);",
    `import(${JSON.stringify(WORKER_URL)}).then(() => {`,
    "  self.removeEventListener('message', hold);",
    "  for (const e of held) self.dispatchEvent(new MessageEvent('message', { data: e.data }));",
    probe ? "  self.postMessage({ placesMapProbe: 'loaded' });" : "",
    "}, (err) => {",
    probe ? "  self.postMessage({ placesMapProbe: 'failed', error: String(err) });" : "  setTimeout(() => { throw err; });",
    "});",
  ].join("\n");
}

const blobUrl = (src: string) => URL.createObjectURL(new Blob([src], { type: "text/javascript" }));

/** The URL MapLibre starts its workers from. Kept for the page's lifetime: MapLibre may start
 *  several workers (Safari) and starts them again after the last map is removed. */
const WRAPPER_URL = blobUrl(wrapperSource(false));

// At module evaluation, so it is set before mapcn's map.tsx evaluates (main.tsx imports this
// module first) and mapcn's unpkg default is never taken: jsDelivr is the one script origin.
maplibregl.setWorkerUrl(WRAPPER_URL);

export type WorkerMode = "worker" | "main-thread";

/** Does the real path work here: a module worker from a blob: wrapper that dynamic-imports the
 *  MapLibre worker from jsDelivr? Chrome throws on construction when CSP refuses the blob:
 *  worker; a refused or failed import is reported by the wrapper (or surfaces as `error`); a
 *  worker that never answers counts as no. */
function realWorkerPathWorks(timeoutMs = 8000): Promise<{ ok: boolean; why?: string }> {
  return new Promise((resolve) => {
    let url = "";
    let worker: Worker | undefined;
    const done = (ok: boolean, why?: string) => {
      clearTimeout(timer);
      worker?.terminate();
      if (url) URL.revokeObjectURL(url);
      resolve({ ok, ...(why ? { why } : {}) });
    };
    const timer = setTimeout(() => done(false, `no answer in ${timeoutMs} ms`), timeoutMs);
    try {
      url = blobUrl(wrapperSource(true));
      worker = new Worker(url, { type: "module" });
      worker.onmessage = (e: MessageEvent) => {
        const r = (e.data as { placesMapProbe?: string; error?: string } | null)?.placesMapProbe;
        if (r === "loaded") done(true);
        else if (r === "failed") done(false, (e.data as { error?: string }).error ?? "import failed");
      };
      worker.onerror = (e) => done(false, (e as ErrorEvent).message || "worker error");
    } catch (e) {
      done(false, String(e));
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

let decided: Promise<{ mode: WorkerMode; why?: string }> | undefined;

/** Pick real workers or the in-thread stand-in. Starts at once; await it before the first map
 *  is created (the rest of the page need not wait). Idempotent. */
export function configureMapLibreWorkers(): Promise<{ mode: WorkerMode; why?: string }> {
  decided ??= (async () => {
    const probe = await realWorkerPathWorks();
    if (probe.ok) return { mode: "worker" as const };
    maplibregl.setWorkerCount(1);
    (globalThis as { Worker: unknown }).Worker = InThreadWorker;
    console.info("[places-map] MapLibre's worker can't start here; running it on the main thread:", probe.why);
    return { mode: "main-thread" as const, why: probe.why };
  })();
  return decided;
}
