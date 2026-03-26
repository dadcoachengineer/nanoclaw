/**
 * Lightweight local OAuth callback server.
 * Starts on port 9876, captures the authorization code, then exits.
 *
 * Usage: npx tsx scripts/oauth-callback.ts
 */
import http from 'http';
import { URL } from 'url';

const PORT = 9876;

const server = http.createServer((req, res) => {
  const url = new URL(req.url!, `http://localhost:${PORT}`);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end(`<h1>Authorization failed</h1><p>${error}</p>`);
    console.error(`Error: ${error}`);
    process.exit(1);
  }

  if (code) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<h1>Authorization successful</h1><p>You can close this tab.</p>`);
    console.log(JSON.stringify({ code, state }));
    setTimeout(() => process.exit(0), 500);
  } else {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end(`<h1>No code received</h1>`);
  }
});

server.listen(PORT, () => {
  console.error(`OAuth callback listening on http://localhost:${PORT}/callback`);
});
