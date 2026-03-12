/**
 * Root application component with client-side routing.
 *
 * Routes:
 * - / renders the Home (dashboard) page
 * - /call renders the WebRTC browser calling page
 */

import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Home } from "./pages/Home";
import { Settings } from "./pages/Settings";
import { Agents } from "./pages/Agents";
import { AgentDetail } from "./pages/AgentDetail";
import { Conversation } from "./pages/Conversation";
import { Call } from "./pages/Call";
import { Chat } from "./pages/Chat";

// ============================================================================
// COMPONENT
// ============================================================================

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Home />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/agents" element={<Agents />} />
          <Route path="/agents/:id" element={<AgentDetail />} />
          <Route path="/c/:id" element={<Conversation />} />
        </Route>
        <Route path="/call" element={<Call />} />
        <Route path="/chat" element={<Chat />} />
      </Routes>
    </BrowserRouter>
  );
}
