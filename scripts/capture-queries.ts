#!/usr/bin/env tsx

/**
 * Query Capture Script
 *
 * Opens a separate Firefox window (NOT your everyday browser profile), loads the
 * Facebook cookies from secrets/fb_cookies, browses Marketplace like a normal
 * user, and records the GraphQL doc_ids it sees.
 *
 * Prerequisites:
 *   npm install -D playwright
 *   npx playwright install firefox
 *
 * Usage:
 *   npm run capture-queries
 *
 * Env (defaults point at ./secrets):
 *   FB_COOKIES_FILE, FB_USER_AGENT_FILE
 *
 * Output: captured-queries.json plus ready-to-paste FB_*_DOC_ID lines.
 * Do not run this repeatedly; a few times per doc_id rotation is plenty.
 */

import { firefox } from "playwright";
import path from "node:path";
import fs from "node:fs";
import { loadCookiesFromEnv } from "../src/facebook/auth.js";

const root = path.join(import.meta.dirname ?? ".", "..");
process.env.FB_COOKIES_FILE ??= path.join(root, "secrets", "fb_cookies");
const uaFile =
  process.env.FB_USER_AGENT_FILE ?? path.join(root, "secrets", "fb_user_agent.txt");

interface CapturedQuery {
  docId: string;
  operationName: string;
  variables: string;
  timestamp: number;
}

async function main() {
  console.log("🔍 Launching browser to capture GraphQL queries...\n");

  const captured: CapturedQuery[] = [];

  const cookies = loadCookiesFromEnv();
  if (!cookies?.length) throw new Error("No cookies found in FB_COOKIES_FILE");

  const browser = await firefox.launch({ headless: false });
  const context = await browser.newContext({
    userAgent: fs.existsSync(uaFile)
      ? fs.readFileSync(uaFile, "utf8").trim()
      : undefined,
  });
  await context.addCookies(
    cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: ".facebook.com",
      path: "/",
      secure: true,
      httpOnly: c.httpOnly,
      sameSite: "None" as const,
    }))
  );
  const page = await context.newPage();

  // Intercept GraphQL requests
  page.on("request", (req) => {
    const url = req.url();
    if (url.includes("/api/graphql")) {
      const postData = req.postData() ?? "";
      const params = new URLSearchParams(postData);
      const docId = params.get("doc_id") ?? "";
      const variables = params.get("variables") ?? "{}";

      if (docId) {
        // Try to guess operation name from variables
        let opName = "unknown";
        try {
          const vars = JSON.parse(variables);
          if (vars.params?.bqf?.callsite === "COMMERCE_MKTPLACE_WWW") {
            opName = "marketplace_search";
          } else if (vars.params?.caller === "MARKETPLACE") {
            opName = "city_street_search";
          } else if (variables.toLowerCase().includes("zelda")) {
            opName = "marketplace_search";
          } else if (vars.targetId) {
            opName = "listing_detail";
          }
        } catch {
          // ignore parse errors
        }

        captured.push({
          docId,
          operationName: opName,
          variables: variables.slice(0, 400),
          timestamp: Date.now(),
        });

        console.log(`📡 Captured: doc_id=${docId} op=${opName}`);
      }
    }
  });

  console.log("Navigating to Facebook Marketplace...");
  await page.goto("https://www.facebook.com/marketplace/", {
    waitUntil: "networkidle",
    timeout: 30000,
  });

  if (page.url().includes("/login") || page.url().includes("checkpoint")) {
    console.log(
      `\nFacebook is asking for login/verification (${page.url()}). ` +
        "Stop here: resolve it manually in a normal browser, don't retry in a loop."
    );
    await browser.close();
    return;
  }

  console.log("\nPage loaded. Opening a sample search...");
  await page.waitForTimeout(3000);
  await page.goto("https://www.facebook.com/marketplace/search/?query=zelda", {
    waitUntil: "networkidle",
    timeout: 30000,
  });
  await page.waitForTimeout(5000);

  console.log("\n⏳ Waiting 30 seconds for more queries...");
  console.log("   Browse around Marketplace to capture more doc_ids.");
  console.log("   Click on listings, change categories, etc.\n");
  await page.waitForTimeout(30000);

  await browser.close();

  // Deduplicate and display results
  const unique = new Map<string, CapturedQuery>();
  for (const q of captured) {
    const key = `${q.docId}-${q.operationName}`;
    if (!unique.has(key)) {
      unique.set(key, q);
    }
  }

  console.log("\n\n=== Captured GraphQL Queries ===\n");
  for (const q of unique.values()) {
    console.log(`doc_id: ${q.docId}`);
    console.log(`  operation: ${q.operationName}`);
    console.log(`  variables: ${q.variables}`);
    console.log();
  }

  // Save to a JSON file for reference
  const outputPath = path.join(root, "captured-queries.json");
  fs.writeFileSync(
    outputPath,
    JSON.stringify([...unique.values()], null, 2)
  );
  console.log(`\nSaved to ${outputPath}`);
  const envName: Record<string, string> = {
    marketplace_search: "FB_SEARCH_DOC_ID",
    city_street_search: "FB_LOCATION_DOC_ID",
  };
  console.log("\nSet these env vars if they differ from the defaults:");
  for (const q of unique.values()) {
    if (envName[q.operationName]) {
      console.log(`  ${envName[q.operationName]}=${q.docId}`);
    }
  }
}

main().catch(console.error);
