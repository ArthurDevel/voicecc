import { useState, useEffect } from "react";
import { get } from "../api";
import { SettingsPanel } from "../components/SettingsPanel";
import { McpServersPanel } from "../components/McpServersPanel";
import { ClaudeMdEditor } from "../components/ClaudeMdEditor";
import type { TunnelStatus, TwilioStatus, BrowserCallStatus } from "../pages/Home";

export function Settings() {
    const [activeTab, setActiveTab] = useState<"general" | "integrations" | "system">("general");
    const [tunnelStatus, setTunnelStatus] = useState<TunnelStatus>({ running: false, url: null });
    const [twilioStatus, setTwilioStatus] = useState<TwilioStatus>({ running: false, tunnelUrl: null });
    const [browserCallStatus, setBrowserCallStatus] = useState<BrowserCallStatus>({ running: false, tunnelUrl: null });

    useEffect(() => {
        const poll = () => {
            get<TunnelStatus>("/api/tunnel/status").then(setTunnelStatus).catch(() => { });
            get<TwilioStatus>("/api/twilio/status").then(setTwilioStatus).catch(() => { });
            get<BrowserCallStatus>("/api/browser-call/status").then(setBrowserCallStatus).catch(() => { });
        };
        poll();
        const interval = setInterval(poll, 5000);
        return () => clearInterval(interval);
    }, []);

    const tabStyle = (tab: string) => ({
        padding: "6px 14px",
        background: activeTab === tab ? "var(--btn-primary-bg)" : "var(--bg-main)",
        border: "1px solid " + (activeTab === tab ? "transparent" : "var(--border-color)"),
        borderRadius: "0",
        color: activeTab === tab ? "var(--btn-primary-text)" : "var(--text-primary)",
        fontWeight: 500,
        cursor: "pointer",
        fontSize: "13px",
        transition: "all 0.1s ease",
    });

    return (
        <div className="page active" style={{ display: "flex", flexDirection: "column", padding: 0 }}>
            {/* Tabs Row */}
            <div style={{ display: "flex", gap: "8px", padding: "24px 32px 16px", borderBottom: "1px solid var(--border-color)", flexShrink: 0 }}>
                <button style={tabStyle("general")} onClick={() => setActiveTab("general")}>General</button>
                <button style={tabStyle("integrations")} onClick={() => setActiveTab("integrations")}>Integrations & MCP</button>
                <button style={tabStyle("system")} onClick={() => setActiveTab("system")}>System Prompt</button>
            </div>

            {/* Scrollable Content Area */}
            <div style={{ flex: 1, overflowY: "auto", padding: "48px 64px" }}>
                {activeTab === "general" && (
                    <SettingsPanel twilioRunning={twilioStatus.running} />
                )}
                {activeTab === "integrations" && (
                    <McpServersPanel twilioRunning={twilioStatus.running} browserCallRunning={browserCallStatus.running} />
                )}
                {activeTab === "system" && (
                    <ClaudeMdEditor />
                )}
            </div>
        </div>
    );
}
