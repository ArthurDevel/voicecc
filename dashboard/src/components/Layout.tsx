import { useEffect, useState } from "react";
import { Outlet } from "react-router-dom";
import { get } from "../api";
import { Sidebar } from "./Sidebar";
import { TwilioStatus } from "../pages/Home";

export interface LayoutContext {
    authStatus: boolean | null;
}

export function Layout() {
    const [twilioStatus, setTwilioStatus] = useState<TwilioStatus>({ running: false, webrtcReady: false, ngrokUrl: null });
    const [authStatus, setAuthStatus] = useState<boolean | null>(null);

    useEffect(() => {
        const poll = () => {
            get<TwilioStatus>("/api/twilio/status").then(setTwilioStatus).catch(() => { });
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
            <Sidebar twilioStatus={twilioStatus} authStatus={authStatus} />
            <div className="main" style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden" }}>
                <Outlet context={{ authStatus } satisfies LayoutContext} />
            </div>
        </div>
    );
}
