import { useParams } from "react-router-dom";
import { ConversationView } from "../components/ConversationView";

export function Conversation() {
    const { id } = useParams<{ id: string }>();

    if (!id) {
        return (
            <div className="page active" style={{ display: "flex", flexDirection: "column" }}>
                <div className="page-header" style={{ padding: "48px 64px 24px" }}>
                    <div>
                        <h1>Error</h1>
                    </div>
                </div>
                <div className="conversation-messages" style={{ padding: "0 64px 48px" }}>
                    <div className="conversation-empty">No conversation ID provided.</div>
                </div>
            </div>
        );
    }

    return (
        <div className="page active">
            <ConversationView sessionId={id} />
        </div>
    );
}
