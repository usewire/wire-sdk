// What the page tells the host about itself, through MCP logging (`app.sendLog`, which a host
// may surface in its own console or logs). The sandboxed iframe's console is often out of
// reach, so the facts that matter when a map comes up blank go here: CSP violations (an origin
// missing from the resource's csp), MapLibre errors, and where the tile worker runs.

import type { App } from "@modelcontextprotocol/ext-apps";
import { config as zodConfig } from "zod";

type Level = "info" | "warning" | "error";
const pending: Array<[Level, unknown]> = [];
let sink: ((level: Level, data: unknown) => void) | null = null;

export function report(level: Level, data: unknown): void {
  if (level !== "info") console[level === "warning" ? "warn" : "error"]("[places-map]", data);
  if (sink) sink(level, data);
  else if (pending.length < 50) pending.push([level, data]);
}

export function connectDiagnostics(app: App): void {
  sink = (level, data) => void app.sendLog({ level, logger: "places-map", data }).catch(() => {});
  for (const [level, data] of pending.splice(0)) sink(level, data);
}

// The MCP Apps SDK validates messages with zod, whose JIT probes `new Function("")` on first
// use. Under the spec's CSP (no 'unsafe-eval') that probe is a CSP violation (caught, but
// reported). jitless skips the probe; parsing is unchanged.
zodConfig({ jitless: true });

// Registered at module load, before any script or tile request can be refused.
document.addEventListener("securitypolicyviolation", (e) => {
  const directive = e.effectiveDirective || e.violatedDirective;
  // maplibre-worker.ts probes for blob: workers on purpose; a refusal there is the answer, not a fault.
  const expected = e.blockedURI === "blob" && /^(worker|script)-src/.test(directive);
  report(expected ? "info" : "warning", { csp: directive, blocked: e.blockedURI, ...(expected ? { expected: "blob: worker probe" } : {}) });
});
