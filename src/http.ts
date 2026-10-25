import http from "node:http";
import crypto from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FacebookClient } from "./facebook/client.js";
import { buildServer } from "./server.js";

const MAX_BODY_BYTES = 64 * 1024;
const MIN_TOKEN_LENGTH = 32;
const AUTH_FAIL_WINDOW_MS = 60_000;
const AUTH_FAIL_LIMIT = 10;

function sha256(s: string): Buffer {
  return crypto.createHash("sha256").update(s).digest();
}

/** Constant-time comparison that doesn't leak token length. */
function tokenMatches(presented: string, expected: Buffer): boolean {
  return crypto.timingSafeEqual(sha256(presented), expected);
}

function send(res: http.ServerResponse, status: number, message: string) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify({ error: message }));
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export interface HttpOptions {
  host: string;
  port: number;
  authToken: string;
  /** Host header values accepted (DNS-rebinding defense), e.g. "nas:3939". */
  allowedHosts: string[];
}

export function startHttp(client: FacebookClient, opts: HttpOptions) {
  if (opts.authToken.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `MCP_AUTH_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters (try: openssl rand -hex 32)`
    );
  }
  const expected = sha256(opts.authToken);
  const allowedHosts = new Set(opts.allowedHosts.map((h) => h.toLowerCase()));
  const failures = new Map<string, number[]>();

  const tooManyFailures = (ip: string) => {
    const now = Date.now();
    const recent = (failures.get(ip) ?? []).filter(
      (t) => now - t < AUTH_FAIL_WINDOW_MS
    );
    failures.set(ip, recent);
    return recent.length >= AUTH_FAIL_LIMIT;
  };

  const server = http.createServer(async (req, res) => {
    const ip = req.socket.remoteAddress ?? "unknown";
    try {
      if (req.url === "/healthz" && req.method === "GET") {
        res.writeHead(200).end("ok");
        return;
      }

      // Reject browser-originated requests outright; MCP clients don't send
      // Origin, and this blocks CSRF / DNS rebinding from web pages.
      if (req.headers.origin) return send(res, 403, "forbidden");

      const host = (req.headers.host ?? "").toLowerCase();
      if (!allowedHosts.has(host)) return send(res, 403, "forbidden");

      if (tooManyFailures(ip)) return send(res, 429, "too many attempts");

      const auth = req.headers.authorization ?? "";
      const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!presented || !tokenMatches(presented, expected)) {
        failures.set(ip, [...(failures.get(ip) ?? []), Date.now()]);
        res.setHeader("WWW-Authenticate", "Bearer");
        return send(res, 401, "unauthorized");
      }

      if (req.url?.split("?")[0] !== "/mcp") return send(res, 404, "not found");
      // Stateless: GET (SSE stream) and DELETE (session end) don't apply.
      if (req.method !== "POST") return send(res, 405, "method not allowed");

      let body: unknown;
      try {
        body = await readBody(req);
      } catch {
        return send(res, 400, "bad request");
      }

      const mcp = buildServer(client);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on("close", () => {
        transport.close();
        mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      // Never echo internals (could include cookie/token fragments)
      console.error("request failed:", (err as Error).message);
      if (!res.headersSent) send(res, 500, "internal error");
    }
  });

  server.headersTimeout = 10_000;
  server.requestTimeout = 120_000;
  server.listen(opts.port, opts.host, () => {
    console.error(`facebook-marketplace MCP listening on ${opts.host}:${opts.port}/mcp`);
  });
  return server;
}
