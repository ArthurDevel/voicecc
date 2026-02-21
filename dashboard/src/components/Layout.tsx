import { useEffect, useState } from "react";
import { Outlet } from "react-router-dom";
import { get } from "../api";
import { Sidebar } from "./Sidebar";
import { TwilioStatus, BrowserCallStatus } from "../pages/Home";

export function Layout() {
    const [twilioStatus, setTwilioStatus] = useState<TwilioStatus>({ running: false, ngrokUrl: null });
    const [browserCallStatus, setBrowserCallStatus] = useState<BrowserCallStatus>({ running: false, ngrokUrl: null });

    useEffect(() => {
        const poll = () => {
            get<TwilioStatus>("/api/twilio/status").then(setTwilioStatus).catch(() => { });
            get<BrowserCallStatus>("/api/browser-call/status").then(setBrowserCallStatus).catch(() => { });
        };
        poll();
        const interval = setInterval(poll, 5000);
        return () => clearInterval(interval);
    }, []);

    return (
        <div style={{ display: "flex", height: "100vh" }}>
            <Sidebar twilioStatus={twilioStatus} browserCallStatus={browserCallStatus} />
            <div className="main" style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden" }}>
                <Outlet />
            </div>
        </div>
    );
}
