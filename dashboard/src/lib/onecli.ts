/**
 * OneCLI proxy utilities.
 * Routes requests through the OneCLI HTTPS proxy (port 10255)
 * which intercepts HTTPS and injects credentials based on host patterns.
 *
 * Requires NODE_EXTRA_CA_CERTS pointing to OneCLI's combined CA cert.
 */
import { HttpsProxyAgent } from "https-proxy-agent";

const PROXY_HOST = process.env.ONECLI_PROXY_HOST || "localhost:10255";

let _proxyAgent: HttpsProxyAgent<string> | null = null;

function getProxyAgent(): HttpsProxyAgent<string> {
  if (_proxyAgent) return _proxyAgent;
  const token = process.env.ONECLI_AGENT_TOKEN;
  if (!token) {
    throw new Error("ONECLI_AGENT_TOKEN environment variable is required");
  }
  _proxyAgent = new HttpsProxyAgent(`http://x:${token}@${PROXY_HOST}`);
  return _proxyAgent;
}

export async function proxiedFetch(
  url: string,
  init?: RequestInit
): Promise<Response> {
  const nodeFetch = (await import("node-fetch")).default;
  const resp = await nodeFetch(url, {
    ...init,
    agent: getProxyAgent(),
  } as Parameters<typeof nodeFetch>[1]);

  return resp as unknown as Response;
}
