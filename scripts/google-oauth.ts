/**
 * Google OAuth2 authorization flow for Gmail + Calendar.
 *
 * First run: opens browser for login, captures auth code, saves tokens.
 * Subsequent runs: refreshes the access token.
 *
 * Usage:
 *   npx tsx scripts/google-oauth.ts          # authorize (first time)
 *   npx tsx scripts/google-oauth.ts refresh   # refresh token
 */
import fs from "fs";
import http from "http";
import path from "path";
import { URL } from "url";

const STORE_DIR = path.join(process.cwd(), "store");
const CREDS_PATH = "/Users/nanoclaw/Downloads/client_secret_950273220288-fnoirrtjchikcbvic3jel8qsi6si98es.apps.googleusercontent.com.json";
const TOKEN_PATH = path.join(STORE_DIR, "google-oauth.json");
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
];
const REDIRECT_PORT = 9877;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;

interface GoogleCreds {
  installed: {
    client_id: string;
    client_secret: string;
    auth_uri: string;
    token_uri: string;
  };
}

function loadCreds(): GoogleCreds {
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf-8"));
}

async function authorize() {
  const creds = loadCreds();
  const { client_id, client_secret } = creds.installed;

  // Build auth URL
  const authUrl = new URL("https://accounts.google.com/o/oauth2/auth");
  authUrl.searchParams.set("client_id", client_id);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", SCOPES.join(" "));
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent"); // Force refresh token

  console.log("Opening browser for Google authorization...\n");

  // Start local callback server
  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || "/", `http://localhost:${REDIRECT_PORT}`);
      const authCode = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`<h1>Authorization failed</h1><p>${error}</p>`);
        reject(new Error(error));
        server.close();
        return;
      }

      if (authCode) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h1>Authorization successful!</h1><p>You can close this tab.</p>");
        resolve(authCode);
        server.close();
        return;
      }

      res.writeHead(400, { "Content-Type": "text/html" });
      res.end("<h1>No code received</h1>");
    });

    server.listen(REDIRECT_PORT, () => {
      console.log(`Callback server listening on port ${REDIRECT_PORT}`);
      // Open browser
      import("child_process").then(({ execSync }) => {
        execSync(`open "${authUrl.toString()}"`);
      });
    });

    server.on("error", reject);
    setTimeout(() => { server.close(); reject(new Error("Timeout waiting for authorization")); }, 120000);
  });

  console.log("\nExchanging code for tokens...");

  // Exchange code for tokens
  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id,
      client_secret,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });

  const tokens = await tokenResp.json() as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (tokens.error) {
    console.error(`Token error: ${tokens.error} — ${tokens.error_description}`);
    process.exit(1);
  }

  // Save tokens
  const tokenData = {
    client_id,
    client_secret,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_expiry: new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString(),
    scopes: SCOPES,
  };

  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokenData, null, 2));
  console.log(`\nTokens saved to ${TOKEN_PATH}`);
  console.log(`Access token expires: ${tokenData.token_expiry}`);
  console.log(`Refresh token: ${tokens.refresh_token ? "present" : "MISSING"}`);
}

async function refresh() {
  if (!fs.existsSync(TOKEN_PATH)) {
    console.error("No token file found. Run without 'refresh' argument first.");
    process.exit(1);
  }

  const tokenData = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));

  console.log("Refreshing Google access token...");

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: tokenData.client_id,
      client_secret: tokenData.client_secret,
      refresh_token: tokenData.refresh_token,
      grant_type: "refresh_token",
    }),
  });

  const tokens = await resp.json() as {
    access_token?: string;
    expires_in?: number;
    error?: string;
  };

  if (tokens.error) {
    console.error(`Refresh error: ${tokens.error}`);
    process.exit(1);
  }

  tokenData.access_token = tokens.access_token;
  tokenData.token_expiry = new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString();

  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokenData, null, 2));
  console.log(`Token refreshed. Expires: ${tokenData.token_expiry}`);
}

// Main
const args = process.argv.slice(2);
if (args[0] === "refresh") {
  refresh().catch((err) => { console.error(err); process.exit(1); });
} else {
  authorize().catch((err) => { console.error(err); process.exit(1); });
}
