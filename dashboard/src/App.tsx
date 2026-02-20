/**
 * Root application component with client-side routing.
 *
 * Routes:
 * - / renders the Home (dashboard) page
 * - /call renders the WebRTC browser calling page
 */

import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Home } from "./pages/Home";
import { Call } from "./pages/Call";

// ============================================================================
// COMPONENT
// ============================================================================

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/call" element={<Call />} />
      </Routes>
    </BrowserRouter>
  );
}
