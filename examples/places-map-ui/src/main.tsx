import "./diagnostics";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { configureMapLibreWorkers } from "./maplibre-worker";
import { PlacesMapApp } from "./App";
import "./index.css";

// Decide where MapLibre's worker runs (see maplibre-worker.ts). The page connects to the host and
// renders the list at once; only the map itself waits for this.
const workerReady = configureMapLibreWorkers();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PlacesMapApp workerReady={workerReady} />
  </StrictMode>,
);
