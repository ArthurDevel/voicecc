/**
 * React application entry point.
 *
 * Mounts the App component to the #root element and imports global styles.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";

// ============================================================================
// MOUNT
// ============================================================================

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Root element #root not found");
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>
);
