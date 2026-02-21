import { useEffect, useState } from "react";
import { Outlet } from "react-router-dom";
import { get } from "../api";
import { Sidebar } from "./Sidebar";
import { TwilioStatus, BrowserCallStatus } from "../pages/Home";

export interface LayoutContext {
    authStatus: boolean | null;
}

export function Layout() {
    const [twilioStatus, setTwilioStatus] = useState<TwilioStatus>({ running: false, tunnelUrl: null });
    const [browserCallStatus, setBrowserCallStatus] = useState<BrowserCallStatus>({ running: false, tunnelUrl: null });
    const [authStatus, setAuthStatus] = useState<boolean | null>(null);

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

    return (
        <div style={{ display: "flex", height: "100vh" }}>
            <Sidebar twilioStatus={twilioStatus} browserCallStatus={browserCallStatus} authStatus={authStatus} />
            <div className="main" style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden" }}>
                <Outlet context={{ authStatus } satisfies LayoutContext} />
            </div>
        </div>
    );
}
