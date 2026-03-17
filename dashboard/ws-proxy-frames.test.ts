/**
 * Tests that the WebSocket proxy preserves frame types (text vs binary).
 *
 * Twilio sends and expects JSON as text frames. If the proxy silently converts
 * text→binary, Twilio ignores outbound audio and the caller hears nothing.
 *
 * Run: npx tsx --test dashboard/ws-proxy-frames.test.ts
 */

import { test, describe, after } from "node:test";
import { strict as assert } from "node:assert";
import { WebSocketServer, WebSocket } from "ws";
import http from "node:http";

import { attachMediaProxy } from "./ws-proxy.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" ? addr!.port : 0);
    });
  });
}

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function nextMessage(ws: WebSocket): Promise<{ data: Buffer; isBinary: boolean }> {
  return new Promise((resolve) => {
    ws.once("message", (data, isBinary) => {
      resolve({ data: data as Buffer, isBinary });
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WebSocket proxy frame types", () => {
  const servers: http.Server[] = [];
  const sockets: WebSocket[] = [];

  after(() => {
    for (const ws of sockets) ws.close();
    for (const srv of servers) srv.close();
  });

  async function setup() {
    // Mock upstream (stands in for Python voice server)
    const upstreamServer = http.createServer();
    const upstreamWss = new WebSocketServer({ server: upstreamServer });
    servers.push(upstreamServer);
    const upstreamPort = await listen(upstreamServer);

    // Proxy server using real attachMediaProxy from application code
    const proxyServer = http.createServer();
    attachMediaProxy(proxyServer, `http://127.0.0.1:${upstreamPort}`);
    servers.push(proxyServer);
    const proxyPort = await listen(proxyServer);

    // Wait for both sides to connect
    const upstreamClientP = new Promise<WebSocket>((resolve) => {
      upstreamWss.once("connection", resolve);
    });
    const client = await connect(`ws://127.0.0.1:${proxyPort}/media/aabbccdd-1234-5678-9900-aabbccddeeff`);
    const upstreamClient = await upstreamClientP;
    sockets.push(client, upstreamClient);

    return { client, upstreamClient };
  }

  test("client→upstream: text frame arrives as text, not binary", async () => {
    const { client, upstreamClient } = await setup();
    const msg = JSON.stringify({ event: "media", streamSid: "MZ123", media: { payload: "AQID" } });

    const received = nextMessage(upstreamClient);
    client.send(msg); // string → text frame
    const { data, isBinary } = await received;

    assert.equal(isBinary, false, "upstream should receive a text frame");
    assert.equal(data.toString("utf-8"), msg);
  });

  test("upstream→client: text frame arrives as text, not binary", async () => {
    const { client, upstreamClient } = await setup();
    const msg = JSON.stringify({ event: "media", streamSid: "MZ123", media: { payload: "AQID" } });

    const received = nextMessage(client);
    upstreamClient.send(msg); // string → text frame
    const { data, isBinary } = await received;

    assert.equal(isBinary, false, "client should receive a text frame");
    assert.equal(data.toString("utf-8"), msg);
  });

  test("binary frames stay binary through the proxy", async () => {
    const { client, upstreamClient } = await setup();
    const buf = Buffer.from([0x01, 0x02, 0x03, 0x04]);

    const received = nextMessage(upstreamClient);
    client.send(buf); // Buffer → binary frame
    const { isBinary } = await received;

    assert.equal(isBinary, true, "upstream should receive a binary frame");
  });
});
