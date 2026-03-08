import { useEffect, useState } from "react";
import { Outlet } from "react-router-dom";
import { get } from "../api";
import { Sidebar } from "./Sidebar";
import { TwilioStatus, BrowserCallStatus } from "../pages/Home";

export interface LayoutContext {
    authStatus: boolean | null;
    setAuthStatus: (status: boolean | null) => void;
}

interface VersionInfo {
    current: string;
    latest: string | null;
    updateAvailable: boolean;
}

export function Layout() {
    const [twilioStatus, setTwilioStatus] = useState<TwilioStatus>({ running: false, tunnelUrl: null });
    const [browserCallStatus, setBrowserCallStatus] = useState<BrowserCallStatus>({ running: false, tunnelUrl: null });
    const [authStatus, setAuthStatus] = useState<boolean | null>(null);
    const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
    const [bannerDismissed, setBannerDismissed] = useState(false);

    useEffect(() => {
        const poll = () => {
            get<TwilioStatus>("/api/twilio/status").then(setTwilioStatus).catch(() => { });
            get<BrowserCallStatus>("/api/browser-call/status").then(setBrowserCallStatus).catch(() => { });
        };
        poll();
        const interval = setInterval(poll, 5000);
        return () => clearInterval(interval);
    }, []);

    useEffect(() => {
        get<{ authenticated: boolean }>("/api/auth")
            .then((data) => setAuthStatus(data.authenticated))
            .catch(() => setAuthStatus(false));
    }, []);

    useEffect(() => {
        get<VersionInfo>("/api/version")
            .then(setVersionInfo)
            .catch(() => { });
    }, []);

    const showBanner = versionInfo?.updateAvailable && !bannerDismissed;

    return (
        <div style={{ display: "flex", height: "100vh" }}>
            <Sidebar twilioStatus={twilioStatus} browserCallStatus={browserCallStatus} authStatus={authStatus} />
            <div className="main" style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden" }}>
                {showBanner && (
                    <div style={{
                        padding: "8px 16px",
                        background: "var(--bg-surface)",
                        borderBottom: "1px solid var(--border-color)",
                        fontSize: 12,
                        color: "var(--text-secondary)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        flexShrink: 0,
                    }}>
                        <span>
                            Update available: <strong style={{ color: "var(--text-primary)" }}>v{versionInfo.latest}</strong> (current: v{versionInfo.current}).
                            Run <code style={{
                                background: "var(--bg-main)",
                                padding: "1px 5px",
                                fontFamily: '"SF Mono", "Fira Code", monospace',
                                fontSize: 11,
                                color: "var(--accent-color)",
                            }}>npm install -g voicecc</code> to update.
                        </span>
                        <button
                            onClick={() => setBannerDismissed(true)}
                            style={{
                                background: "none",
                                border: "none",
                                color: "var(--text-secondary)",
                                cursor: "pointer",
                                fontSize: 14,
                                padding: "0 4px",
                                lineHeight: 1,
                            }}
                        >
                            x
                        </button>
                    </div>
                )}
                <Outlet context={{ authStatus, setAuthStatus } satisfies LayoutContext} />
            </div>
        </div>
    );
}
