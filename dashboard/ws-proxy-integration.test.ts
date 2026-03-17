/**
 * Integration test for the Twilio ↔ Python WebSocket media proxy.
 *
 * Spins up a mock "Python voice server", attaches the real attachMediaProxy
 * from ws-proxy.ts to an HTTP server, then connects a mock "Twilio" client.
 * Verifies that Twilio media JSON round-trips correctly in both directions
 * and that connections tear down cleanly.
 *
 * Run: npx tsx --test dashboard/ws-proxy-integration.test.ts
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

function waitForClose(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.once("close", () => resolve());
  });
}

// A realistic Twilio media message
const TWILIO_MEDIA_MSG = JSON.stringify({
  event: "media",
  streamSid: "MZ0b4ca5d9cfd2658e5b0934ed835c66d8",
  media: { payload: "PCUgJCIdJlGsrL9ELiooJSY12a+s" },
});

const TWILIO_START_MSG = JSON.stringify({
  event: "start",
  streamSid: "MZ0b4ca5d9cfd2658e5b0934ed835c66d8",
  start: { callSid: "CA123", streamSid: "MZ0b4ca5d9cfd2658e5b0934ed835c66d8" },
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Twilio media proxy (integration)", () => {
  const servers: http.Server[] = [];
  const sockets: WebSocket[] = [];

  after(() => {
    for (const ws of sockets) ws.close();
    for (const srv of servers) srv.close();
  });

  /** Set up mock Python server + proxy + mock Twilio client */
  async function setup() {
    // 1. Mock Python voice server (accepts WebSocket connections)
    const pythonServer = http.createServer();
    const pythonWss = new WebSocketServer({ server: pythonServer });
    servers.push(pythonServer);
    const pythonPort = await listen(pythonServer);

    // 2. Proxy server using the real attachMediaProxy
    const proxyServer = http.createServer();
    attachMediaProxy(proxyServer, `http://127.0.0.1:${pythonPort}`);
    servers.push(proxyServer);
    const proxyPort = await listen(proxyServer);

    // 3. Connect mock Twilio client to the proxy (must match /media/<token>)
    const pythonClientP = new Promise<WebSocket>((resolve) => {
      pythonWss.once("connection", resolve);
    });
    const twilioClient = await connect(`ws://127.0.0.1:${proxyPort}/media/aabbccdd-1234-5678-9900-aabbccddeeff`);
    const pythonClient = await pythonClientP;
    sockets.push(twilioClient, pythonClient);

    return { twilioClient, pythonClient };
  }

  test("Twilio start event reaches Python as parseable JSON text", async () => {
    const { twilioClient, pythonClient } = await setup();

    const received = nextMessage(pythonClient);
    twilioClient.send(TWILIO_START_MSG);
    const { data, isBinary } = await received;

    assert.equal(isBinary, false, "start event must arrive as text frame");
    const parsed = JSON.parse(data.toString("utf-8"));
    assert.equal(parsed.event, "start");
    assert.equal(parsed.start.callSid, "CA123");
  });

  test("Twilio media reaches Python as JSON text with intact payload", async () => {
    const { twilioClient, pythonClient } = await setup();

    const received = nextMessage(pythonClient);
    twilioClient.send(TWILIO_MEDIA_MSG);
    const { data, isBinary } = await received;

    assert.equal(isBinary, false, "media must arrive as text frame");
    const parsed = JSON.parse(data.toString("utf-8"));
    assert.equal(parsed.event, "media");
    assert.equal(parsed.media.payload, "PCUgJCIdJlGsrL9ELiooJSY12a+s");
  });

  test("Python response media reaches Twilio as JSON text", async () => {
    const { twilioClient, pythonClient } = await setup();
    const responseMsg = JSON.stringify({
      event: "media",
      streamSid: "MZ0b4ca5d9cfd2658e5b0934ed835c66d8",
      media: { payload: "Yu/d7OlyenN0+mrt+ubecGdbYO7f" },
    });

    const received = nextMessage(twilioClient);
    pythonClient.send(responseMsg);
    const { data, isBinary } = await received;

    assert.equal(isBinary, false, "response media must arrive as text frame");
    const parsed = JSON.parse(data.toString("utf-8"));
    assert.equal(parsed.event, "media");
    assert.equal(parsed.media.payload, "Yu/d7OlyenN0+mrt+ubecGdbYO7f");
  });

  test("closing Twilio side tears down Python connection", async () => {
    const { twilioClient, pythonClient } = await setup();

    const pythonClosed = waitForClose(pythonClient);
    twilioClient.close();
    await pythonClosed;

    assert.equal(pythonClient.readyState, WebSocket.CLOSED);
  });

  test("multiple messages round-trip without corruption", async () => {
    const { twilioClient, pythonClient } = await setup();
    const messages = Array.from({ length: 10 }, (_, i) =>
      JSON.stringify({
        event: "media",
        streamSid: "MZ123",
        media: { payload: `chunk${i}_` + "A".repeat(200) },
      })
    );

    // Send all from Twilio, collect on Python side
    const allReceived: string[] = [];
    const done = new Promise<void>((resolve) => {
      pythonClient.on("message", (data) => {
        allReceived.push((data as Buffer).toString("utf-8"));
        if (allReceived.length === messages.length) resolve();
      });
    });

    for (const msg of messages) {
      twilioClient.send(msg);
    }
    await done;

    assert.equal(allReceived.length, messages.length);
    for (let i = 0; i < messages.length; i++) {
      assert.equal(allReceived[i], messages[i], `message ${i} should match`);
    }
  });
});
