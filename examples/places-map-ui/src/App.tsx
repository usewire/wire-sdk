import type { App as McpApp, McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { applyDocumentTheme, useApp, useHostStyles } from "@modelcontextprotocol/ext-apps/react";
import { Crosshair, ExternalLink, MapPin, MessageSquare } from "lucide-react";
import * as maplibregl from "maplibre-gl";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Map, MapControls, MapMarker, MapPopup, MarkerContent, useMap } from "@/components/ui/map";
import { cn } from "@/lib/utils";
import { connectDiagnostics, report } from "./diagnostics";
import type { WorkerMode } from "./maplibre-worker";
import { readPlaces, type Place, type PlacesView } from "./places";

/** OpenFreeMap: free, no key, commercial use allowed, and every request (style, tiles,
 *  sprites, glyphs) goes to one origin, https://tiles.openfreemap.org. */
const MAP_STYLES = {
  light: "https://tiles.openfreemap.org/styles/positron",
  dark: "https://tiles.openfreemap.org/styles/dark",
};

const DEFAULT_MAP_HEIGHT = 340;
const LIST_MAX_HEIGHT = 264;

type Status =
  | { kind: "connecting" }
  | { kind: "waiting"; query: string | null }
  | { kind: "ready" }
  | { kind: "error"; message: string }
  | { kind: "cancelled" };

function systemTheme(): "light" | "dark" {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function formatDistance(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}

function resultErrorText(result: { content?: unknown }): string {
  if (Array.isArray(result.content)) {
    const t = result.content.find((c: { type?: string; text?: unknown }) => c?.type === "text" && typeof c.text === "string");
    if (t) return String((t as { text: string }).text).slice(0, 300);
  }
  return "The tool returned an error.";
}

export function PlacesMapApp({ workerMode }: { workerMode: WorkerMode }) {
  const [view, setView] = useState<PlacesView | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "connecting" });
  const [hostContext, setHostContext] = useState<McpUiHostContext | undefined>();

  const { app, error } = useApp({
    appInfo: { name: "Places map", version: "0.1.0" },
    capabilities: {},
    onAppCreated: (created) => {
      // Registered before connect() so the initial tool input / result are not missed.
      created.ontoolinput = ({ arguments: args }) => {
        const q = args && typeof args.query === "string" && args.query.trim() ? args.query.trim() : null;
        setStatus((s) => (s.kind === "ready" ? s : { kind: "waiting", query: q }));
      };
      created.ontoolresult = (result) => {
        if (result.isError) {
          setStatus({ kind: "error", message: resultErrorText(result) });
          return;
        }
        setView(readPlaces(result));
        setStatus({ kind: "ready" });
      };
      created.ontoolcancelled = () => setStatus((s) => (s.kind === "ready" ? s : { kind: "cancelled" }));
      created.addEventListener("hostcontextchanged", (ctx) => setHostContext((prev) => ({ ...prev, ...ctx })));
      created.onerror = (e) => console.error("[places-map]", e);
    },
  });

  useEffect(() => {
    if (!app) return;
    connectDiagnostics(app);
    report("info", { workerMode });
    setHostContext(app.getHostContext());
    setStatus((s) => (s.kind === "connecting" ? { kind: "waiting", query: null } : s));
  }, [app, workerMode]);

  // Theme, host CSS variables and fonts (data-theme on <html>, which mapcn also watches).
  useHostStyles(app, app?.getHostContext());
  useEffect(() => {
    if (!hostContext?.theme && !document.documentElement.dataset.theme) applyDocumentTheme(systemTheme());
  }, [hostContext?.theme]);

  if (error) return <Shell><Notice tone="error" title="Could not connect to the host" body={error.message} /></Shell>;

  return (
    <Shell insets={hostContext?.safeAreaInsets}>
      {status.kind === "ready" && view ? (
        <PlacesMap app={app} view={view} hostContext={hostContext} workerMode={workerMode} />
      ) : status.kind === "error" ? (
        <Notice tone="error" title="Search failed" body={status.message} />
      ) : status.kind === "cancelled" ? (
        <Notice title="Search cancelled" />
      ) : (
        <Notice title={status.kind === "waiting" && status.query ? `Finding places for “${status.query}”…` : "Finding places…"} loading />
      )}
    </Shell>
  );
}

function Shell({ children, insets }: { children: React.ReactNode; insets?: McpUiHostContext["safeAreaInsets"] }) {
  return (
    <main
      className="bg-background text-foreground text-sm antialiased"
      style={{ paddingTop: insets?.top, paddingRight: insets?.right, paddingBottom: insets?.bottom, paddingLeft: insets?.left }}
    >
      {children}
    </main>
  );
}

function Notice({ title, body, tone, loading }: { title: string; body?: string; tone?: "error"; loading?: boolean }) {
  return (
    <div className="border-border bg-muted/40 flex min-h-32 flex-col items-center justify-center gap-1 rounded-lg border px-4 py-8 text-center">
      {loading ? <span className="bg-pin size-2 animate-pulse rounded-full" /> : <MapPin className="text-muted-foreground size-5" />}
      <p className={cn("font-medium", tone === "error" && "text-red-600 dark:text-red-400")}>{title}</p>
      {body && <p className="text-muted-foreground max-w-md">{body}</p>}
    </div>
  );
}

function PlacesMap({
  app,
  view,
  hostContext,
  workerMode,
}: {
  app: McpApp | null;
  view: PlacesView;
  hostContext?: McpUiHostContext;
  workerMode: WorkerMode;
}) {
  const { places, center } = view;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [flyTarget, setFlyTarget] = useState<FlyTarget | null>(null);
  const [fitNonce, setFitNonce] = useState(0);
  const selected = places.find((p) => p.id === selectedId) ?? null;
  const caps = app?.getHostCapabilities();

  // A host that fixes the iframe height gets a layout that fills it; otherwise the map has a
  // fixed height (bounded by any maxHeight) and the page reports its own size.
  const dims = hostContext?.containerDimensions as { height?: number; maxHeight?: number } | undefined;
  const fixedHeight = dims?.height;
  const mapHeight = fixedHeight ? undefined : Math.max(200, Math.min(DEFAULT_MAP_HEIGHT, dims?.maxHeight ? dims.maxHeight - 180 : DEFAULT_MAP_HEIGHT));

  const openLink = useCallback(
    (url: string) => {
      if (!app) return;
      void app.openLink({ url }).catch((e) => console.error("[places-map] openLink", e));
    },
    [app],
  );

  const askAbout = useCallback(
    (p: Place) => {
      if (!app) return;
      const where = p.address ?? p.area;
      const text = `Tell me more about ${p.name}${where ? ` (${where})` : ""}.`;
      void app.sendMessage({ role: "user", content: [{ type: "text", text }] }).catch((e) => console.error("[places-map] sendMessage", e));
    },
    [app],
  );

  // From the list: fly there and zoom in. From a marker: pan only. Either way the place ends up
  // in the lower part of the map so its popup (anchored above it) has room.
  const focus = (p: Place, zoomIn: boolean) => {
    setSelectedId(p.id);
    setFlyTarget((prev) => ({ place: p, zoomIn, n: (prev?.n ?? 0) + 1 }));
  };

  if (places.length === 0) {
    return (
      <Notice
        title={view.query ? `No saved places match “${view.query}”` : "No saved places here"}
        body={view.skipped ? `${view.skipped} result${view.skipped === 1 ? "" : "s"} had no coordinates to map.` : "Try a wider area or a different search."}
      />
    );
  }

  return (
    <div className="flex flex-col gap-2" style={fixedHeight ? { height: fixedHeight } : undefined}>
      <div
        className="border-border relative overflow-hidden rounded-lg border"
        style={fixedHeight ? { flex: "1 1 60%", minHeight: 180 } : { height: mapHeight }}
      >
        <Map styles={MAP_STYLES} attributionControl={false} dragRotate={false} center={[places[0]!.lng, places[0]!.lat]} zoom={12}>
          <FitToPlaces places={places} nonce={fitNonce} />
          <ReportMapErrors />
          <FlyTo target={flyTarget} />
          {center && (
            <MapMarker longitude={center.lng} latitude={center.lat}>
              <MarkerContent className="cursor-default">
                <span title="Search centre" className="border-pin bg-background/80 block size-3.5 rounded-full border-2 shadow" />
              </MarkerContent>
            </MapMarker>
          )}
          {places.map((p, i) => (
            <MapMarker key={p.id} longitude={p.lng} latitude={p.lat} onClick={(e) => { e.stopPropagation(); focus(p, false); }}>
              <MarkerContent>
                <Pin n={i + 1} active={p.id === selectedId} label={p.name} />
              </MarkerContent>
            </MapMarker>
          ))}
          {selected && (
            <MapPopup
              key={selected.id}
              longitude={selected.lng}
              latitude={selected.lat}
              offset={22}
              anchor="bottom"
              closeButton
              closeOnClick={false}
              onClose={() => setSelectedId((id) => (id === selected.id ? null : id))}
            >
              <PlaceDetails
                place={selected}
                onAsk={caps?.message ? () => askAbout(selected) : undefined}
                onOpenMap={caps?.openLinks ? () => openLink(mapsUrl(selected)) : undefined}
              />
            </MapPopup>
          )}
          <MapControls position="top-right" />
          {places.length > 1 && (
            <button
              type="button"
              onClick={() => { setSelectedId(null); setFitNonce((n) => n + 1); }}
              className="border-border bg-background hover:bg-accent absolute top-2 left-2 z-10 inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium shadow-sm"
            >
              <Crosshair className="size-3.5" /> Show all
            </button>
          )}
        </Map>
      </div>

      <div className="text-muted-foreground flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-0.5 text-xs">
        <span>
          {places.length} saved place{places.length === 1 ? "" : "s"}
          {view.query ? <> for “{view.query}”</> : null}
          {view.skipped ? ` · ${view.skipped} without coordinates` : ""}
        </span>
        <Attribution onOpen={caps?.openLinks ? openLink : undefined} />
      </div>

      <ul
        className="border-border divide-border divide-y overflow-y-auto rounded-lg border"
        style={fixedHeight ? { flex: "1 1 40%", minHeight: 0 } : { maxHeight: LIST_MAX_HEIGHT }}
        data-worker-mode={workerMode}
      >
        {places.map((p, i) => (
          <li key={p.id}>
            <button
              type="button"
              onClick={() => focus(p, true)}
              aria-current={p.id === selectedId ? "true" : undefined}
              className={cn("hover:bg-accent/60 flex w-full items-start gap-3 px-3 py-2 text-left transition-colors", p.id === selectedId && "bg-accent")}
            >
              <span className={cn("mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold", p.id === selectedId ? "bg-pin text-white" : "bg-muted text-muted-foreground")}>
                {i + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-medium">{p.name}</span>
                  {p.distanceKm !== null && <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{formatDistance(p.distanceKm)}</span>}
                </span>
                {(p.address || p.area) && <span className="text-muted-foreground block truncate text-xs">{p.address ?? p.area}</span>}
                {p.tags.length > 0 && <Tags tags={p.tags} max={4} className="mt-1" />}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function mapsUrl(p: Place): string {
  return `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`;
}

function Pin({ n, active, label }: { n: number; active: boolean; label: string }) {
  return (
    <span
      aria-label={label}
      title={label}
      className={cn(
        "bg-pin flex items-center justify-center rounded-full border-2 border-white font-semibold text-white shadow-md transition-transform",
        active ? "size-8 scale-110 text-sm ring-4 ring-[color-mix(in_oklch,var(--pin)_30%,transparent)]" : "size-6 text-[11px] hover:scale-110",
      )}
    >
      {n}
    </span>
  );
}

function Tags({ tags, max, className }: { tags: string[]; max?: number; className?: string }) {
  const shown = max ? tags.slice(0, max) : tags;
  const rest = tags.length - shown.length;
  return (
    <span className={cn("flex flex-wrap gap-1", className)}>
      {shown.map((t) => (
        <span key={t} className="bg-secondary text-secondary-foreground rounded-full px-2 py-0.5 text-[11px] leading-4">
          {t}
        </span>
      ))}
      {rest > 0 && <span className="text-muted-foreground px-1 text-[11px] leading-5">+{rest}</span>}
    </span>
  );
}

function PlaceDetails({ place, onAsk, onOpenMap }: { place: Place; onAsk?: () => void; onOpenMap?: () => void }) {
  return (
    <div className="w-60 space-y-1.5 pr-4">
      <p className="text-sm leading-snug font-semibold">{place.name}</p>
      {place.address && <p className="text-muted-foreground text-xs leading-snug">{place.address}</p>}
      {place.area && <p className="text-muted-foreground text-xs leading-snug">{place.area}</p>}
      {place.distanceKm !== null && <p className="text-muted-foreground text-xs">{formatDistance(place.distanceKm)} away</p>}
      {place.tags.length > 0 && <Tags tags={place.tags} />}
      {(onAsk || onOpenMap) && (
        <div className="flex gap-1.5 pt-1">
          {onAsk && (
            <button type="button" onClick={onAsk} className="bg-primary text-primary-foreground inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium hover:opacity-90">
              <MessageSquare className="size-3.5" /> Tell me more
            </button>
          )}
          {onOpenMap && (
            <button type="button" onClick={onOpenMap} className="border-border hover:bg-accent inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs font-medium">
              <ExternalLink className="size-3.5" /> Maps
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Attribution({ onOpen }: { onOpen?: (url: string) => void }) {
  const link = (label: string, url: string) =>
    onOpen ? (
      <button type="button" className="hover:text-foreground underline-offset-2 hover:underline" onClick={() => onOpen(url)}>
        {label}
      </button>
    ) : (
      <span>{label}</span>
    );
  return (
    <span className="text-[11px]">
      {link("OpenFreeMap", "https://openfreemap.org")} {link("© OpenMapTiles", "https://www.openmaptiles.org/")} · Data{" "}
      {link("© OpenStreetMap contributors", "https://www.openstreetmap.org/copyright")}
    </span>
  );
}

/** Fit the camera to every place as soon as the map exists (camera moves don't wait for the
 *  style or tiles, so this lands before anyone can click), and again when asked. */
function FitToPlaces({ places, nonce }: { places: Place[]; nonce: number }) {
  const { map } = useMap();
  const key = useMemo(() => places.map((p) => `${p.lat},${p.lng}`).join("|"), [places]);
  useEffect(() => {
    if (!map || places.length === 0) return;
    const animate = nonce > 0;
    if (places.length === 1) {
      map.easeTo({ center: [places[0]!.lng, places[0]!.lat], zoom: 14, duration: animate ? 600 : 0 });
      return;
    }
    const bounds = new maplibregl.LngLatBounds();
    for (const p of places) bounds.extend([p.lng, p.lat]);
    map.fitBounds(bounds, { padding: { top: 48, bottom: 32, left: 40, right: 56 }, maxZoom: 15, duration: animate ? 600 : 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, key, nonce]);
  return null;
}

/** MapLibre's own errors (a style, tile or glyph that failed to load) go to the host's log. */
function ReportMapErrors() {
  const { map } = useMap();
  useEffect(() => {
    if (!map) return;
    const onError = (e: { error?: { message?: string } }) => report("error", { maplibre: e.error?.message ?? String(e.error) });
    map.on("error", onError);
    return () => void map.off("error", onError);
  }, [map]);
  return null;
}

type FlyTarget = { place: Place; zoomIn: boolean; n: number };

function FlyTo({ target }: { target: FlyTarget | null }) {
  const { map } = useMap();
  useEffect(() => {
    if (!map || !target) return;
    const { place, zoomIn } = target;
    // Put the place a quarter of the map's height below centre: its popup opens above it.
    const offset: [number, number] = [0, Math.round(map.getContainer().clientHeight / 4)];
    const center: [number, number] = [place.lng, place.lat];
    if (zoomIn) map.flyTo({ center, offset, zoom: Math.max(map.getZoom(), 14), duration: 800, essential: true });
    else map.easeTo({ center, offset, duration: 400 });
  }, [map, target]);
  return null;
}
