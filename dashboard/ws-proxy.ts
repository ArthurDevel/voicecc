/**
 * Twilio ↔ Python WebSocket proxy utilities.
 *
 * The `ws` library always delivers message data as a Buffer, even for text
 * frames. If you forward that Buffer via ws.send(Buffer), it emits a binary
 * frame — silently changing the frame type. Twilio ignores binary frames for
 * JSON media messages, so the caller hears nothing.
 *
 * wsForward checks the isBinary flag and converts to string when needed
 * so that text frames stay text and binary frames stay binary.
 */

import { WebSocket, WebSocketServer } from "ws";
import type http from "node:http";
import type { Duplex } from "node:stream";

export function wsForward(
  dest: WebSocket,
  data: Buffer | ArrayBuffer | Buffer[],
  isBinary: boolean,
): void {
  if (dest.readyState !== WebSocket.OPEN) return;
  dest.send(isBinary ? data : (data as Buffer).toString("utf-8"));
}

/**
 * Attach a Twilio media WebSocket proxy to an HTTP server.
 *
 * Intercepts upgrade requests matching /media/<token> and proxies them
 * bidirectionally to the given upstream URL, preserving frame types.
 */
export function attachMediaProxy(
  server: http.Server,
  upstreamBaseUrl: string,
): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = req.url ?? "";
    const match = url.match(/^\/media\/([a-f0-9-]+)(?:\?.*)?$/);
    if (!match) return;

    const targetWsUrl = upstreamBaseUrl.replace(/^http/, "ws") + url;
    const upstream = new WebSocket(targetWsUrl);

    let proxyMsgCount = { fromClient: 0, fromUpstream: 0 };
    upstream.on("open", () => {
      wss.handleUpgrade(req, socket, head, (clientWs) => {
        clientWs.on("message", (data, isBinary) => {
          proxyMsgCount.fromClient++;
          wsForward(upstream, data as Buffer, isBinary);
        });
        upstream.on("message", (data, isBinary) => {
          proxyMsgCount.fromUpstream++;
          wsForward(clientWs, data as Buffer, isBinary);
        });

        clientWs.on("close", () => upstream.close());
        upstream.on("close", () => clientWs.close());
        clientWs.on("error", (e) => { console.error(`[ws-proxy] Twilio WS error: ${e.message}`); upstream.close(); });
        upstream.on("error", (e) => { console.error(`[ws-proxy] Python WS error: ${e.message}`); clientWs.close(); });
      });
    });

    upstream.on("error", (err) => {
      console.error(`[dashboard] Twilio WS proxy error: ${err.message}`);
      socket.destroy();
    });
  });
}
