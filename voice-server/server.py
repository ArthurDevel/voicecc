"""
FastAPI server for the Python voice server.

Hosts text chat, Twilio media WebSocket, call registration, heartbeat status,
health check, and config update endpoints. Runs alongside Pipecat's SmallWebRTC
server (port 7860) on a separate port (7861).

Responsibilities:
- Health check endpoint
- Text chat SSE streaming (proxied from dashboard)
- Chat stop/close endpoints
- Twilio incoming-call webhook (returns TwiML)
- Twilio media WebSocket handler
- Call registration for outbound calls
- Heartbeat status endpoint
- Heartbeat start/stop on server lifecycle
- Tunnel URL config update (called by dashboard after tunnel starts)
- Start both SmallWebRTC and FastAPI on server run
"""

import asyncio
import json
import logging

import uvicorn
from fastapi import FastAPI, Request, WebSocket
from fastapi.responses import JSONResponse, PlainTextResponse, StreamingResponse

from claude_session import (
    close_session,
    get_or_create_session,
    interrupt_session,
    start_cleanup_timer,
    stream_message,
)
from config import VoiceServerConfig, load_config
from heartbeat import (
    get_heartbeat_status,
    get_pending_client,
    register_pending_call,
    start_heartbeat,
    stop_heartbeat,
)
from twilio_pipeline import handle_twilio_websocket

logger = logging.getLogger(__name__)

# ============================================================================
# STATE
# ============================================================================

# Mutable tunnel URL, updated by dashboard via POST /config/tunnel-url
_tunnel_url: str | None = None


def get_tunnel_url() -> str | None:
    """Get the current tunnel URL."""
    return _tunnel_url


# ============================================================================
# MAIN HANDLERS
# ============================================================================

app = FastAPI(title="VoiceCC Python Server")


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "ok"}


@app.post("/chat/send")
async def chat_send(request: Request):
    """Send a message and stream Claude's response as SSE.

    Body: { session_key: str, agent_id?: str, text: str }
    Returns: SSE stream of ChatSseEvent
    """
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "Invalid JSON body"}, status_code=400)

    session_key = body.get("session_key")
    text = body.get("text", "").strip()
    agent_id = body.get("agent_id")

    if not session_key or not isinstance(session_key, str):
        return JSONResponse({"error": "Missing 'session_key' field"}, status_code=400)
    if not text:
        return JSONResponse({"error": "Missing or empty 'text' field"}, status_code=400)

    # Get or create the chat session
    try:
        await get_or_create_session(session_key, agent_id)
    except RuntimeError as e:
        logger.error(f"[server] Failed to create chat session: {e}")
        return JSONResponse({"error": str(e)}, status_code=503)

    # Stream response as SSE
    try:

        async def event_generator():
            async for event in stream_message(session_key, text):
                data = json.dumps(event.to_dict())
                yield f"data: {data}\n\n"

        return StreamingResponse(
            event_generator(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )
    except RuntimeError as e:
        if "ALREADY_STREAMING" in str(e):
            return JSONResponse(
                {"error": "Already streaming a response. Wait for it to complete."},
                status_code=409,
            )
        return JSONResponse({"error": str(e)}, status_code=500)


@app.post("/chat/stop")
async def chat_stop(request: Request):
    """Interrupt the current streaming response.

    Body: { session_key: str }
    Returns: { ok: true, interrupted: bool }
    """
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "Invalid JSON body"}, status_code=400)

    session_key = body.get("session_key")
    if not session_key or not isinstance(session_key, str):
        return JSONResponse({"error": "Missing 'session_key' field"}, status_code=400)

    interrupted = await interrupt_session(session_key)
    return {"ok": True, "interrupted": interrupted}


@app.post("/chat/close")
async def chat_close(request: Request):
    """Close a chat session.

    Body: { session_key: str }
    Returns: { ok: true }
    """
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "Invalid JSON body"}, status_code=400)

    session_key = body.get("session_key")
    if not session_key or not isinstance(session_key, str):
        return JSONResponse({"error": "Missing 'session_key' field"}, status_code=400)

    await close_session(session_key)
    return {"ok": True}


@app.post("/register-call")
async def register_call(request: Request):
    """Register a pending outbound call.

    Body: { token: str, agent_id: str, initial_prompt?: str }
    Returns: { ok: true }
    """
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "Invalid JSON body"}, status_code=400)

    token = body.get("token")
    agent_id = body.get("agent_id")

    if not token or not isinstance(token, str):
        return JSONResponse({"error": "Missing 'token' field"}, status_code=400)
    if not agent_id or not isinstance(agent_id, str):
        return JSONResponse({"error": "Missing 'agent_id' field"}, status_code=400)

    initial_prompt = body.get("initial_prompt")
    register_pending_call(token, agent_id, initial_prompt)

    logger.info(f"[server] Registered outbound call token: {token}, agentId: {agent_id}")
    return {"ok": True}


@app.post("/twilio/incoming-call")
async def twilio_incoming_call(request: Request):
    """Handle Twilio incoming call webhook. Returns TwiML for media stream.

    The TwiML tells Twilio to connect a media stream WebSocket to our
    /media/{token} endpoint via the tunnel URL.

    Returns: TwiML XML response
    """
    tunnel_url = get_tunnel_url()
    if not tunnel_url:
        logger.error("[server] Rejected incoming call: no tunnel URL available")
        return PlainTextResponse("Server misconfigured", status_code=500)

    tunnel_host = tunnel_url.replace("https://", "").replace("http://", "")

    # Generate a token for this call and register it
    from uuid import uuid4

    token = str(uuid4())
    register_pending_call(token, agent_id="", initial_prompt=None)

    logger.info(f"[server] Incoming call accepted, token: {token}")

    # Respond with TwiML to connect a media stream
    twiml = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        "<Response>"
        "  <Connect>"
        f'    <Stream url="wss://{tunnel_host}/media/{token}" />'
        "  </Connect>"
        "</Response>"
    )

    return PlainTextResponse(twiml, media_type="text/xml")


@app.websocket("/media/{token}")
async def media_websocket(websocket: WebSocket, token: str):
    """Handle Twilio media stream WebSocket connection.

    Delegates to handle_twilio_websocket which manages the full pipeline lifecycle.

    Args:
        websocket: FastAPI WebSocket connection
        token: Per-call UUID token from the URL path
    """
    logger.info(f"[server] Twilio media WebSocket connected, token: {token}")
    await handle_twilio_websocket(websocket, token)


@app.get("/heartbeat/status")
async def heartbeat_status():
    """Get the last heartbeat results per agent.

    Returns: Dict of agent_id -> HeartbeatResult
    """
    return get_heartbeat_status()


@app.post("/config/tunnel-url")
async def config_tunnel_url(request: Request):
    """Update the tunnel URL (called by dashboard after tunnel starts).

    Body: { url: str }
    Returns: { ok: true }
    """
    global _tunnel_url

    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "Invalid JSON body"}, status_code=400)

    url = body.get("url")
    if not url or not isinstance(url, str):
        return JSONResponse({"error": "Missing 'url' field"}, status_code=400)

    _tunnel_url = url
    logger.info(f"[server] Tunnel URL updated: {url}")
    return {"ok": True}


# ============================================================================
# ENTRY POINT
# ============================================================================

@app.on_event("startup")
async def on_startup():
    """Start cleanup timer and heartbeat on FastAPI startup."""
    start_cleanup_timer()

    config = load_config()
    start_heartbeat(config, get_tunnel_url)


@app.on_event("shutdown")
async def on_shutdown():
    """Stop heartbeat on FastAPI shutdown."""
    stop_heartbeat()


async def start_fastapi(config: VoiceServerConfig) -> None:
    """Start the FastAPI server on the configured API port.

    Args:
        config: Voice server configuration
    """
    server_config = uvicorn.Config(
        app,
        host="127.0.0.1",
        port=config.api_port,
        log_level="info",
    )
    server = uvicorn.Server(server_config)
    await server.serve()


async def start_all() -> None:
    """Start both the SmallWebRTC server and FastAPI server concurrently."""
    config = load_config()

    # Import here to avoid circular imports
    from voice_pipeline import main as start_webrtc

    logger.info(
        f"[server] Starting SmallWebRTC on :{config.webrtc_port}, "
        f"FastAPI on :{config.api_port}"
    )

    # Run both servers concurrently
    await asyncio.gather(
        start_fastapi(config),
        # SmallWebRTC's main() is a blocking call that starts its own server
        asyncio.to_thread(start_webrtc),
    )


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(start_all())
