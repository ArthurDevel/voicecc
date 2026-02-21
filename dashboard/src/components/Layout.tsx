import { useEffect, useState } from "react";
import { Outlet } from "react-router-dom";
import { get } from "../api";
import { Sidebar } from "./Sidebar";
import { TwilioStatus } from "../pages/Home";

export function Layout() {
    const [twilioStatus, setTwilioStatus] = useState<TwilioStatus>({ running: false, webrtcReady: false, ngrokUrl: null });

    useEffect(() => {
        const poll = () => {
            get<TwilioStatus>("/api/twilio/status").then(setTwilioStatus).catch(() => { });
        };
        poll();
        const interval = setInterval(poll, 5000);
        return () => clearInterval(interval);
    }, []);

    return (
        <div style={{ display: "flex", height: "100vh" }}>
            <Sidebar twilioStatus={twilioStatus} />
            <div className="main" style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden" }}>
                <Outlet />
            </div>
        </div>
    );
}
