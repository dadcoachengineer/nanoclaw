/**
 * OneCLI proxy utilities.
 * Routes requests through the OneCLI HTTPS proxy (port 10255)
 * which intercepts HTTPS and injects credentials based on host patterns.
 *
 * Requires NODE_EXTRA_CA_CERTS pointing to OneCLI's combined CA cert.
 */
import { HttpsProxyAgent } from "https-proxy-agent";

const AGENT_TOKEN =
  process.env.ONECLI_AGENT_TOKEN ||
  "aoc_181429a83379e2122e9e0b6cde6eefd6b897809b92c08cc4bc788816e26e399a";
const PROXY_HOST = process.env.ONECLI_PROXY_HOST || "localhost:10255";
const PROXY_URL = `http://x:${AGENT_TOKEN}@${PROXY_HOST}`;

const proxyAgent = new HttpsProxyAgent(PROXY_URL);

export async function proxiedFetch(
  url: string,
  init?: RequestInit
): Promise<Response> {
  const nodeFetch = (await import("node-fetch")).default;
  const resp = await nodeFetch(url, {
    ...init,
    agent: proxyAgent,
  } as Parameters<typeof nodeFetch>[1]);

  return resp as unknown as Response;
}
