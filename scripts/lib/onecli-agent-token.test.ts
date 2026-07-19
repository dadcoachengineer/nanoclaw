import { describe, expect, it } from 'vitest';
import { requireOneCliAgentToken } from './onecli-agent-token.js';

describe('requireOneCliAgentToken', () => {
  it('returns a runtime-supplied token', () => {
    expect(
      requireOneCliAgentToken({ ONECLI_AGENT_TOKEN: 'runtime-only-token' }),
    ).toBe('runtime-only-token');
  });

  it.each([{}, { ONECLI_AGENT_TOKEN: '' }, { ONECLI_AGENT_TOKEN: '   ' }])(
    'fails closed when the token is absent',
    (env) => {
      expect(() => requireOneCliAgentToken(env)).toThrow(
        'ONECLI_AGENT_TOKEN is required at runtime',
      );
    },
  );
});
