/**
 * AI Voice Twin media bridge: a small local Node service that receives the customer's own leg of screened calls as
 * Twilio Media Streams (Vercel functions can't hold websockets) and stores clean-speech WAV chunks for the twin.
 *
 *   npm run media-bridge
 *
 * - HTTP on MEDIA_BRIDGE_PORT (default 8787): GET /healthz, and websocket upgrades on /media only.
 * - Public URL: MEDIA_BRIDGE_PUBLIC_URL (https:// or wss://) if set, otherwise an ngrok tunnel (needs NGROK_AUTHTOKEN).
 * - Registers itself in media_bridges and heartbeats every 30 s, so the app only starts a stream when a bridge is up.
 * - Runs the AI Voice Twin housekeeping every 60 s (24 h voice expiry, voice deletions, unflagged-call audio).
 * - Ctrl-C / SIGTERM: unregisters, stops accepting connections, closes the streams (each stores its last audio), waits
 *   up to 55 s for clone attempts in flight so no new ElevenLabs voice goes unrecorded, then exits. Ctrl-C again exits
 *   at once.
 * - A peer hanging up mid-write (EPIPE, ECONNRESET) never takes the bridge down.
 * Every stream must carry a valid HMAC stream token (made by startVictimCapture with TOOL_SECRET) and pass the consent
 * check before anything is stored. Audio, tokens and full CallSids are never logged.
 */
import "../../scripts/lib/load-env";
import { createServer, type IncomingMessage } from "node:http";
import os from "node:os";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { serverEnv } from "@/lib/env";
import { validateTwilioSignature } from "@/lib/twilio";
import { bridgeStreamUrl, verifyStreamToken } from "@/lib/voice-twin/capture";
import { voiceTwinSettings } from "@/lib/voice-twin/config";
import { liveVoiceTwinDeps, maybeStartClone, storeAudioChunk, voiceTwinHousekeeping } from "@/lib/voice-twin/service";
import { liveVoiceTwinStore } from "@/lib/voice-twin/store";
import {
  createBridgeShutdown,
  createInFlightWork,
  createMediaSession,
  isStraySocketError,
  type BridgeLogLevel,
  type MediaSession,
} from "./session";

const HEARTBEAT_MS = 30_000;
const HOUSEKEEPING_MS = 60_000;
/** A connection that hasn't sent a valid "start" by then is closed. */
const START_TIMEOUT_MS = 15_000;
const MEDIA_PATH = "/media";
/** A websocket close reason may be at most 123 bytes of UTF-8. */
const MAX_CLOSE_REASON_BYTES = 123;

function fail(message: string): never {
  console.error(`media bridge: ${message}`);
  process.exit(1);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bridgeLog(level: BridgeLogLevel, message: string) {
  console[level](`media bridge: ${message}`);
}

function errorCode(error: Error): string {
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" ? code : error.message;
}

// Node drops its own 'error' listener from a socket it hands to the 'upgrade' event, and an 'error' event with no
// listener is thrown. A peer that hangs up while we write (EPIPE, ECONNRESET) must never kill the bridge; anything else
// is a real bug and still ends the process, as it would without this handler.
process.on("uncaughtException", (error, origin) => {
  if (isStraySocketError(error)) {
    bridgeLog("warn", `ignored a stray socket error (${errorCode(error)}, ${origin})`);
    return;
  }
  console.error("media bridge: fatal error", error);
  process.exit(1);
});

/** Debug-level only: a client hanging up during the handshake or a refusal is routine. */
function onRawSocketError(error: Error) {
  bridgeLog("debug", `connection error during a websocket upgrade (${errorCode(error)})`);
}

/** Answer an upgrade request we won't take with a bare HTTP status, then drop the socket. */
function refuseUpgrade(socket: Duplex, status: string) {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  socket.once("finish", () => socket.destroy());
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** ws.close throws on a reason over 123 bytes. */
function closeReason(reason: string): string {
  let out = reason.slice(0, MAX_CLOSE_REASON_BYTES);
  while (Buffer.byteLength(out, "utf8") > MAX_CLOSE_REASON_BYTES) out = out.slice(0, -1);
  return out;
}

function bridgePort(): number {
  const raw = process.env.MEDIA_BRIDGE_PORT?.trim();
  if (!raw) return 8787;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`MEDIA_BRIDGE_PORT must be a port number (got "${raw}")`);
  return port;
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? "/", "http://bridge.local").pathname;
  } catch {
    return "";
  }
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.from(data).toString("utf8");
}

/** MEDIA_BRIDGE_PUBLIC_URL, or a fresh ngrok tunnel to the port. */
async function openPublicUrl(port: number, ngrokAuthtoken: string | undefined): Promise<{ url: string; close(): Promise<void> }> {
  const configured = process.env.MEDIA_BRIDGE_PUBLIC_URL?.trim();
  if (configured) {
    if (!bridgeStreamUrl(configured)) fail("MEDIA_BRIDGE_PUBLIC_URL must be an https:// or wss:// URL that reaches this port");
    return { url: configured.replace(/\/+$/, ""), close: async () => undefined };
  }
  if (!ngrokAuthtoken) {
    fail(
      "NGROK_AUTHTOKEN is not set. Twilio needs a public wss:// URL to stream the call audio to: add NGROK_AUTHTOKEN " +
        "(https://dashboard.ngrok.com/get-started/your-authtoken) to .env.local, or set MEDIA_BRIDGE_PUBLIC_URL to a " +
        "tunnel you run yourself.",
    );
  }
  const ngrok = await import("@ngrok/ngrok");
  const listener = await ngrok.forward({ addr: port, authtoken: ngrokAuthtoken });
  const url = listener.url();
  if (!url) fail("ngrok opened a tunnel but gave no URL");
  return { url: url.replace(/\/+$/, ""), close: () => listener.close() };
}

async function main() {
  const env = serverEnv(); // fails fast, with every missing variable listed
  const port = bridgePort();
  const store = liveVoiceTwinStore();
  const voiceDeps = liveVoiceTwinDeps();
  const sessions = new Set<MediaSession>();
  /** Clone attempts (and housekeeping, which may clone) the bridge must not exit in the middle of. */
  const inFlight = createInFlightWork();
  let publicUrl = "";
  let stopping = false;

  const server = createServer((req, res) => {
    if (req.method === "GET" && pathOf(req) === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: true, streams: sessions.size }));
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on("upgrade", (req, socket: Duplex, head) => {
    // First, before anything is written to or destroyed on this raw socket (see the uncaughtException handler above).
    socket.on("error", onRawSocketError);
    if (stopping) return refuseUpgrade(socket, "503 Service Unavailable");
    if (pathOf(req) !== MEDIA_PATH) return refuseUpgrade(socket, "404 Not Found");
    // Advisory only: the HMAC stream token in the "start" message is the enforced gate.
    if (publicUrl) {
      const header = req.headers["x-twilio-signature"];
      const signature = typeof header === "string" ? header : null;
      const urls = [bridgeStreamUrl(publicUrl), `${publicUrl.replace(/^wss:\/\//i, "https://")}${MEDIA_PATH}`];
      const valid = urls.some((u) => u !== null && validateTwilioSignature(env.TWILIO_AUTH_TOKEN, signature, u, {}));
      if (!valid) console.warn("media bridge: X-Twilio-Signature missing or not matching on a stream (the stream token is still required)");
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws: WebSocket) => {
    const session = createMediaSession({
      verifyToken: (token) => verifyStreamToken(token, env.TOOL_SECRET, Date.now()),
      getTwin: () => store.getTwin(),
      storeChunk: (input) => storeAudioChunk(input, voiceDeps),
      maybeStartClone: () => inFlight.track("an AI Voice Twin clone attempt", maybeStartClone({}, voiceDeps)),
      minSeconds: () => voiceTwinSettings().minSeconds,
      now: () => Date.now(),
      close: (code, reason) => ws.close(code, closeReason(reason)),
    });
    sessions.add(session);
    const startTimer = setTimeout(() => {
      if (session.stats().phase === "waiting") ws.close(1008, "no stream start");
    }, START_TIMEOUT_MS);
    ws.on("message", (data, isBinary) => {
      if (!isBinary) void session.onMessage(rawToString(data));
    });
    ws.on("close", () => {
      clearTimeout(startTimer);
      void session.onClose().finally(() => sessions.delete(session));
    });
    ws.on("error", (error) => console.warn(`media bridge: websocket error (${error.message})`));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => resolve());
  }).catch((error) => fail(`could not listen on port ${port} (${describe(error)})`));

  const tunnel = await openPublicUrl(port, env.NGROK_AUTHTOKEN).catch((error) =>
    fail(`could not open the ngrok tunnel (${describe(error)})`),
  );
  publicUrl = tunnel.url;

  const bridgeId = `${os.hostname()}-${port}`;
  /** The heartbeat in flight, if any: unregistering waits for it, or it could re-register the bridge just after. */
  let heartbeatRun: Promise<void> | null = null;
  const heartbeat = (): Promise<void> => {
    heartbeatRun ??= store
      .heartbeatBridge({ id: bridgeId, publicUrl })
      .catch((error) => console.error(`media bridge: heartbeat failed (${describe(error)})`))
      .finally(() => {
        heartbeatRun = null;
      });
    return heartbeatRun;
  };
  await heartbeat();
  const heartbeatTimer = setInterval(() => void heartbeat(), HEARTBEAT_MS);

  let housekeepingRunning = false;
  const housekeeping = async () => {
    if (housekeepingRunning) return;
    housekeepingRunning = true;
    try {
      const summary = await inFlight.track("housekeeping (it may be cloning)", voiceTwinHousekeeping(voiceDeps));
      if (summary.expired || summary.voicesDeleted || summary.discardedChunks || summary.clone) {
        console.info(
          `media bridge: housekeeping: expired ${summary.expired ? 1 : 0}, voices deleted ${summary.voicesDeleted}, ` +
            `chunks discarded ${summary.discardedChunks}, clone ${summary.clone?.outcome ?? "not due"}`,
        );
      }
    } catch (error) {
      console.error(`media bridge: housekeeping failed (${describe(error)})`);
    } finally {
      housekeepingRunning = false;
    }
  };
  const housekeepingTimer = setInterval(() => void housekeeping(), HOUSEKEEPING_MS);

  console.info(`media bridge: listening on http://localhost:${port} (GET /healthz)`);
  console.info(`media bridge: Twilio streams the customer's leg to ${bridgeStreamUrl(publicUrl)}`);
  console.info(`media bridge: registered as ${bridgeId}; heartbeat every ${HEARTBEAT_MS / 1000} s. Ctrl-C to stop.`);

  const shutdown = createBridgeShutdown({
    unregister: async () => {
      clearInterval(heartbeatTimer);
      clearInterval(housekeepingTimer);
      if (heartbeatRun) await heartbeatRun;
      await store.removeBridge(bridgeId);
    },
    stopAccepting: () => {
      stopping = true;
      server.close();
    },
    closeSessions: async () => {
      for (const client of wss.clients) client.close(1001, "media bridge shutting down");
      // Each session stores what it has buffered (and may start a clone, which inFlight tracks too).
      await Promise.allSettled([...sessions].map((s) => inFlight.track("a call stream storing its last audio", s.onClose())));
    },
    inFlight,
    release: () => tunnel.close(),
    exit: (code) => process.exit(code),
    log: bridgeLog,
  });
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => fail(describe(error)));
