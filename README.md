# Facebook Marketplace MCP Server

An MCP server that provides access to Facebook Marketplace via direct GraphQL API calls. No browser automation at runtime — speaks Facebook's internal protocol directly.

## How It Works

Facebook's web client makes all Marketplace requests as `POST /api/graphql/` with a `doc_id` (query hash) and `variables`. This server replays those requests using your existing Facebook session cookies from Chrome.

**Think of it like [pypush](https://github.com/JJTech0130/pypush) for iMessage — direct protocol, no browser.**

## Prerequisites

- **macOS** (cookie extraction uses Keychain)
- **Google Chrome** with an active Facebook login
- **Node.js** 20+

## Installation

```bash
git clone <this-repo>
cd facebook-marketplace-mcp
npm install
npm run build
```

## Setup with Claude Code

```bash
claude mcp add facebook-marketplace -- node /path/to/facebook-marketplace-mcp/dist/index.js
```

Or add to your Claude Code config manually:

```json
{
  "mcpServers": {
    "facebook-marketplace": {
      "command": "node",
      "args": ["/path/to/facebook-marketplace-mcp/dist/index.js"],
      "env": {
        "CHROME_PROFILE": "Default"
      }
    }
  }
}
```

## Tools

### `search_listings`
Search Marketplace by query, location, and filters.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Search term |
| `latitude` | number | yes | Latitude of search center |
| `longitude` | number | yes | Longitude of search center |
| `radius_km` | number | no | Search radius (default: 50) |
| `min_price` | number | no | Min price in dollars |
| `max_price` | number | no | Max price in dollars |
| `category` | string | no | Category ID |
| `limit` | number | no | Max results (default: 20) |

### `get_listing`
Get full details for a specific listing.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `listing_id` | string | yes | Marketplace listing ID |

### `monitor_search`
Save a search as a monitor to track new listings over time.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | yes | Monitor name |
| `query` | string | yes | Search term |
| `latitude` | number | yes | Search center lat |
| `longitude` | number | yes | Search center lng |
| `radius_km` | number | no | Radius (default: 50) |
| `min_price` | number | no | Min price |
| `max_price` | number | no | Max price |

### `check_monitors`
Check monitors for new listings since last check.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `monitor_name` | string | no | Check specific monitor, or omit for all |

### `list_monitors`
List all saved monitors.

### `delete_monitor`
Delete a saved monitor.

## Configuration

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `CHROME_PROFILE` | `Default` | Chrome profile directory name |

## Updating GraphQL Queries

Facebook rotates their `doc_id` values on deploys. If searches stop working:

```bash
npm install -D playwright
npx playwright install chromium
npm run capture-queries
```

This opens a browser, navigates Marketplace, and captures current query IDs. Update `src/facebook/queries.ts` with the new values.

## Rate Limiting

The server self-rate-limits to 3 requests/minute with random jitter to avoid detection. This means searches take a few seconds.

## Limitations

- **macOS only** for automatic cookie extraction
- **Requires Chrome** with active Facebook session
- **Facebook ToS** — automating Facebook violates their Terms of Service
- **Fragile** — `doc_id` values change on Facebook deploys
- **Rate limited** — aggressive use may trigger CAPTCHAs or account flags
- **No write operations** — search/read only, no messaging or listing creation

---

## Self-hosted fork (`selfhost` branch)

Changes from upstream: runs anywhere (Windows/Linux/Docker), no Chrome profile needed, and can serve MCP over authenticated HTTP.

### Cookies
Log into Facebook in a browser, export the cookies for facebook.com (devtools, or a cookie-export extension), and provide **either**:
- `FB_COOKIES_FILE=/path/to/file` (preferred; use a Docker secret), or
- `FB_COOKIES="c_user=...; xs=..."` (a raw Cookie header, a `{name: value}` JSON object, or a JSON array export).

Set `FB_USER_AGENT` and `FB_CH_PLATFORM` (`Windows`, `Linux`, `macOS`) to match the browser the cookies came from. When the session expires you'll get an error asking you to re-export. Consider a throwaway account: this violates Facebook's ToS.

Other env: `FB_SEARCH_DOC_ID` / `FB_LOCATION_DOC_ID` (override rotated doc_ids), `FB_STORAGE_DIR` (monitors), `FB_MAX_RPM` (default 3).

### HTTP transport (`MCP_TRANSPORT=http`)
Security model:
- **Bearer token required** (`MCP_AUTH_TOKEN` or `MCP_AUTH_TOKEN_FILE`, 32+ chars; the server refuses to start otherwise). Compared in constant time. Generate one with `openssl rand -hex 32`.
- Binds to `127.0.0.1` by default. In Docker, publish only on a specific LAN/Tailscale IP via `BIND_IP`.
- `Host` header must be in `ALLOWED_HOSTS` and any request carrying an `Origin` header is rejected (DNS-rebinding / browser CSRF defense).
- Per-IP lockout after 10 failed auth attempts a minute, 64 KB body limit, stateless (no sessions), generic error messages.
- **No TLS built in.** Use Tailscale, or a reverse proxy with TLS, if the traffic leaves a trusted network: the bearer token is sent in cleartext otherwise.
- The container runs as non-root, read-only, all capabilities dropped. Cookies and token are mounted as secrets, never in the image or environment.
- Listing titles and descriptions are untrusted text from strangers. They reach the model as tool output, so treat them as possible prompt injection. All tools here are read-only against Facebook (monitors only write a local JSON file), which limits the damage.

```bash
mkdir secrets
openssl rand -hex 32 > secrets/mcp_token
# paste exported cookies into secrets/fb_cookies
BIND_IP=192.168.1.x ALLOWED_HOSTS=nas.local:3939 docker compose up -d --build
claude mcp add --transport http fb-marketplace http://nas.local:3939/mcp \
  --header "Authorization: Bearer $(cat secrets/mcp_token)"
```
