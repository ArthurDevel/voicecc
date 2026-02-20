/**
 * Vite configuration for the Claude Voice dashboard frontend.
 *
 * - Uses @vitejs/plugin-react for JSX transform
 * - Proxies /api requests to the Hono backend server during development
 * - Outputs production build to dashboard/dist/
 */

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// ============================================================================
// CONFIG
// ============================================================================

const API_PROXY_TARGET = "http://localhost:3456";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": API_PROXY_TARGET,
    },
  },
  build: {
    outDir: "dist",
  },
});
