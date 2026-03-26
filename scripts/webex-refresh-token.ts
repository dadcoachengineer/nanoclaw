/**
 * Webex OAuth token refresh script.
 * Reads store/webex-oauth.json, refreshes the access token, updates both
 * the local file and the OneCLI secret.
 *
 * Run via cron or scheduled task every 7 days to stay ahead of the 14-day expiry.
 * Usage: npx tsx scripts/webex-refresh-token.ts
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OAUTH_PATH = path.join(__dirname, '..', 'store', 'webex-oauth.json');
const ONECLI = process.env.ONECLI_PATH || `${process.env.HOME}/.local/bin/onecli`;

async function main() {
  const config = JSON.parse(fs.readFileSync(OAUTH_PATH, 'utf-8'));

  console.log('Refreshing Webex access token...');

  const resp = await fetch('https://webexapis.com/v1/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: config.client_id,
      client_secret: config.client_secret,
      refresh_token: config.refresh_token,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    console.error(`Token refresh failed (${resp.status}): ${body}`);
    process.exit(1);
  }

  const tokens = await resp.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    refresh_token_expires_in: number;
  };

  // Calculate new expiry
  const expiry = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

  // Update local file
  config.access_token = tokens.access_token;
  config.refresh_token = tokens.refresh_token;
  config.token_expiry = expiry;
  fs.writeFileSync(OAUTH_PATH, JSON.stringify(config, null, 2) + '\n');
  console.log(`Local config updated. New expiry: ${expiry}`);

  // Update OneCLI secret
  try {
    execSync(
      `${ONECLI} secrets update --id ${config.onecli_secret_id} --value "${tokens.access_token}"`,
      { stdio: 'pipe' },
    );
    console.log('OneCLI secret updated.');
  } catch (err) {
    console.error('Failed to update OneCLI secret:', err instanceof Error ? err.message : err);
    console.error('Token was saved locally — update OneCLI manually.');
  }

  // Verify the new token works
  const verify = await fetch('https://webexapis.com/v1/people/me', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (verify.ok) {
    const me = await verify.json() as { displayName: string };
    console.log(`Verified: token valid for ${me.displayName}`);
  } else {
    console.error(`Warning: verification failed (${verify.status})`);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
