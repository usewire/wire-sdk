import "./diagnostics";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { configureMapLibreWorkers } from "./maplibre-worker";
import { PlacesMapApp } from "./App";
import "./index.css";

// Decide where MapLibre's worker runs before any map exists (see maplibre-worker.ts).
const workerMode = await configureMapLibreWorkers();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PlacesMapApp workerMode={workerMode} />
  </StrictMode>,
);
