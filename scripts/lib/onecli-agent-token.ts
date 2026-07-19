export function requireOneCliAgentToken(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const token = env.ONECLI_AGENT_TOKEN?.trim();
  if (!token) {
    throw new Error(
      'ONECLI_AGENT_TOKEN is required at runtime; see docs/ONECLI_AGENT_CREDENTIALS.md',
    );
  }
  return token;
}
