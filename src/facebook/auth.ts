import crypto from "node:crypto";
import { execSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import type { FacebookCookie } from "./types.js";

const CHROME_SALT = "saltysalt";
const CHROME_ITERATIONS = 1003;
const CHROME_KEY_LENGTH = 16;
const CHROME_IV = Buffer.alloc(16, " ");

function getChromePassword(): string {
  try {
    return execSync(
      'security find-generic-password -w -s "Chrome Safe Storage" -a "Chrome"',
      { stdio: ["pipe", "pipe", "pipe"] }
    )
      .toString()
      .trim();
  } catch {
    throw new Error(
      "Failed to get Chrome password from Keychain. " +
        "Make sure Chrome is installed and you approve the Keychain prompt."
    );
  }
}

function deriveChromeKey(password: string): Buffer {
  return crypto.pbkdf2Sync(
    password,
    CHROME_SALT,
    CHROME_ITERATIONS,
    CHROME_KEY_LENGTH,
    "sha1"
  );
}

function decryptCookieValue(encrypted: Buffer, key: Buffer): string {
  if (encrypted.length === 0) return "";

  // Check for v10 prefix (macOS Chrome encryption)
  const prefix = encrypted.slice(0, 3).toString("ascii");
  if (prefix !== "v10") {
    // Not encrypted or unknown format
    return encrypted.toString("utf8");
  }

  const data = encrypted.slice(3);
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, CHROME_IV);
  decipher.setAutoPadding(false);

  let decoded = Buffer.concat([decipher.update(data), decipher.final()]);

  // Remove PKCS7 padding
  const padding = decoded[decoded.length - 1];
  if (padding && padding > 0 && padding <= 16) {
    decoded = decoded.slice(0, decoded.length - padding);
  }

  // Chrome prepends a 32-byte header to cookie values before encrypting.
  // Skip it to get the actual value.
  if (decoded.length > 32) {
    decoded = decoded.slice(32);
  }

  return decoded.toString("utf8");
}

function getCookieDbPath(profile = "Default"): string {
  return path.join(
    os.homedir(),
    "Library/Application Support/Google/Chrome",
    profile,
    "Cookies"
  );
}

export async function extractChromeCookies(
  domain: string,
  profile = "Default"
): Promise<FacebookCookie[]> {
  if (process.platform !== "darwin") {
    throw new Error(
      "Chrome cookie extraction is macOS-only. Set FB_COOKIES or FB_COOKIES_FILE instead."
    );
  }
  // Optional dependency: only needed for the macOS Chrome path
  const { default: Database } = await import("better-sqlite3");
  const cookiePath = getCookieDbPath(profile);

  // Chrome locks the DB while running — copy it first
  const tmpPath = path.join(os.tmpdir(), `chrome_cookies_${Date.now()}`);
  try {
    execSync(`cp "${cookiePath}" "${tmpPath}"`, {
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    throw new Error(
      `Failed to copy Chrome cookie DB from ${cookiePath}. ` +
        "Make sure Chrome is installed and the profile exists."
    );
  }

  const password = getChromePassword();
  const key = deriveChromeKey(password);

  let db: InstanceType<typeof Database>;
  try {
    db = new Database(tmpPath, { readonly: true });
  } catch {
    throw new Error(`Failed to open cookie database at ${tmpPath}`);
  }

  try {
    const rows = db
      .prepare(
        `SELECT host_key, name, value, encrypted_value, path, expires_utc,
                is_secure, is_httponly
         FROM cookies
         WHERE host_key LIKE ?`
      )
      .all(`%${domain}`) as Array<{
      host_key: string;
      name: string;
      value: string;
      encrypted_value: Buffer;
      path: string;
      expires_utc: number;
      is_secure: number;
      is_httponly: number;
    }>;

    return rows.map((row) => {
      let value = row.value;
      if (
        !value &&
        row.encrypted_value &&
        row.encrypted_value.length > 0
      ) {
        value = decryptCookieValue(row.encrypted_value, key);
      }
      return {
        host: row.host_key,
        name: row.name,
        value,
        path: row.path,
        expires: row.expires_utc,
        secure: !!row.is_secure,
        httpOnly: !!row.is_httponly,
      };
    });
  } finally {
    db.close();
    try {
      execSync(`rm -f "${tmpPath}"`, { stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      // cleanup failure is non-fatal
    }
  }
}

export function cookiesToHeader(cookies: FacebookCookie[]): string {
  return cookies
    .map((c) => {
      // Strip non-Latin1 chars — fetch rejects them in Cookie headers
      const safe = c.value.replace(/[^\x00-\xFF]/g, "");
      return `${c.name}=${safe}`;
    })
    .join("; ");
}

export function getCookieValue(
  cookies: FacebookCookie[],
  name: string
): string | undefined {
  return cookies.find((c) => c.name === name)?.value;
}

/**
 * Load Facebook cookies from the environment, so the server can run without
 * a local Chrome profile (Windows, Linux, containers).
 *
 * FB_COOKIES_FILE: path to a file (Docker secret) containing the cookies
 * FB_COOKIES: the same content inline
 * Accepted formats: a raw "Cookie:" header string ("a=b; c=d"), a JSON object
 * {name: value}, or a JSON array as exported by cookie extensions
 * ([{name, value, domain?, ...}]).
 */
export function loadCookiesFromEnv(): FacebookCookie[] | null {
  const file = process.env.FB_COOKIES_FILE;
  let raw = process.env.FB_COOKIES;
  if (file) raw = fs.readFileSync(file, "utf8");
  if (!raw || !raw.trim()) return null;
  raw = raw.trim().replace(/^cookie:\s*/i, "");

  const make = (name: string, value: string): FacebookCookie => ({
    host: ".facebook.com",
    name,
    value,
    path: "/",
    expires: 0,
    secure: true,
    httpOnly: true,
  });

  if (raw.startsWith("[") || raw.startsWith("{")) {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((c) => c?.name && typeof c.value === "string")
        .filter((c) => !c.domain || String(c.domain).includes("facebook.com"))
        .map((c) => make(String(c.name), c.value));
    }
    return Object.entries(parsed).map(([k, v]) => make(k, String(v)));
  }
  return raw
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf("=");
      return make(p.slice(0, i), p.slice(i + 1));
    });
}
