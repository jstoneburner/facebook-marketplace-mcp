#!/usr/bin/env node

import fs from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FacebookClient } from "./facebook/client.js";
import { buildServer } from "./server.js";
import { startHttp } from "./http.js";

const client = new FacebookClient({
  maxRequestsPerMinute: Number(process.env.FB_MAX_RPM ?? 3),
  chromeProfile: process.env.CHROME_PROFILE ?? "Default",
});

if ((process.env.MCP_TRANSPORT ?? "stdio") === "http") {
  const tokenFile = process.env.MCP_AUTH_TOKEN_FILE;
  const authToken = tokenFile
    ? fs.readFileSync(tokenFile, "utf8").trim()
    : (process.env.MCP_AUTH_TOKEN ?? "");
  const port = Number(process.env.PORT ?? 3939);
  const host = process.env.HOST ?? "127.0.0.1";
  const allowedHosts = (
    process.env.ALLOWED_HOSTS ?? `localhost:${port},127.0.0.1:${port}`
  )
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  startHttp(client, { host, port, authToken, allowedHosts });
} else {
  await buildServer(client).connect(new StdioServerTransport());
}
