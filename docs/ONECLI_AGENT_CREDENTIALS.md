# OneCLI agent credentials for legacy host scripts

This checkout is retained for historical host utilities, but it is not an approved credential store. Every script that uses the OneCLI proxy requires `ONECLI_AGENT_TOKEN` at runtime and fails closed when the variable is absent. No tracked file, generated document, command-line argument, or temporary file may contain the bearer credential.

Scheduled jobs have moved to the current NanoClaw v2 checkout, where `docs/onecli-agent-credentials.md` defines the dedicated-agent rotation, least-privilege secret assignment, verification, and rollback procedure. Do not copy a replacement token back into this repository or its launchd artifacts.

## Verify

```bash
npm exec vitest run scripts/onecli-agent-token-policy.test.ts scripts/lib/onecli-agent-token.test.ts
```

The guard scans tracked executable, source, config, documentation, and documentation-generator paths. It reports only paths and violation classes.

For a one-off legacy utility, an approved in-memory supervisor may provide `ONECLI_AGENT_TOKEN` in the child environment. Never put the value after a command-line flag, in a proxy URL argument, in shell history, or in an `.env` file.

## Rollback

Revert application behavior if necessary, but never restore the compromised fallback. Leave a utility disabled until it can receive a runtime identity through the current v2 credential runner. The old credential remains revoked during rollback.
