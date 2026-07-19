import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, readSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const TEXT_EXTENSIONS = new Set([
  '.cjs',
  '.html',
  '.js',
  '.json',
  '.lock',
  '.md',
  '.mjs',
  '.plist',
  '.py',
  '.sh',
  '.toml',
  '.ts',
  '.tsx',
  '.xml',
  '.yaml',
  '.yml',
]);

function regularFileStartsWithShebang(file: string): boolean {
  const descriptor = openSync(file, 'r');
  try {
    const prefix = Buffer.alloc(2);
    return (
      readSync(descriptor, prefix, 0, prefix.length, 0) === 2 &&
      prefix.toString('utf8') === '#!'
    );
  } finally {
    closeSync(descriptor);
  }
}

function isActiveTrackedPath(file: string, mode: string): boolean {
  if (mode !== '100644' && mode !== '100755') return false;
  return (
    mode === '100755' ||
    TEXT_EXTENSIONS.has(path.extname(file)) ||
    regularFileStartsWithShebang(file)
  );
}

function activeTrackedPaths(): string[] {
  return execFileSync('git', ['ls-files', '--stage', '-z'], {
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const match = /^(?<mode>\d+) [0-9a-f]+ \d+\t(?<file>.+)$/s.exec(entry);
      if (!match?.groups)
        throw new Error('unexpected git ls-files --stage record');
      return { file: match.groups.file, mode: match.groups.mode };
    })
    .filter(({ file, mode }) => isActiveTrackedPath(file, mode))
    .map(({ file }) => file);
}

const literalPrefix = ['aoc', ''].join('_');
const AGENT_TOKEN_LITERAL = new RegExp(
  `\\b${literalPrefix}[A-Za-z0-9_-]{32,}\\b`,
);
const NONEMPTY_JAVASCRIPT_FALLBACK =
  /(?:process\.)?env(?:\.|\[['"])?ONECLI_AGENT_TOKEN(?:['"]\])?\s*(?:\|\||\?\?)\s*(?:'[^']+'|"[^"]+"|`[^`]+`)/;
const NONEMPTY_SHELL_FALLBACK = /\$\{ONECLI_AGENT_TOKEN:-[^}\s][^}]*\}/;
const PLIST_LITERAL =
  /<key>ONECLI_AGENT_TOKEN<\/key>\s*<string>\s*[^<$\s][^<]*<\/string>/;
const SHELL_ARGV_CREDENTIAL =
  /(?:PROXY|proxy)[^\n=]*=[^\n]*ONECLI_AGENT_TOKEN[\s\S]{0,800}\bcurl\b[^\n]*(?:-x\b|--proxy(?:-user)?\b)/;

function credentialViolations(file: string, source: string): string[] {
  const normalized = source.replace(/[\s'"`+]/g, '');
  return [
    AGENT_TOKEN_LITERAL.test(normalized)
      ? 'OneCLI agent-token-shaped literal'
      : '',
    NONEMPTY_JAVASCRIPT_FALLBACK.test(source)
      ? 'non-empty JavaScript runtime fallback'
      : '',
    NONEMPTY_SHELL_FALLBACK.test(source)
      ? 'non-empty shell runtime fallback'
      : '',
    PLIST_LITERAL.test(source) ? 'literal launchd environment credential' : '',
    file.endsWith('.sh') && SHELL_ARGV_CREDENTIAL.test(source)
      ? 'shell proxy credential in argv'
      : '',
  ].filter(Boolean);
}

describe('OneCLI agent-token policy', () => {
  it('keeps active tracked text and executable paths credential-literal free', () => {
    const violations = activeTrackedPaths().flatMap((file) =>
      credentialViolations(file, readFileSync(file, 'utf8')).map(
        (reason) => `${file}: ${reason}`,
      ),
    );
    expect(violations).toEqual([]);
  });

  it('covers docs generators, hooks, and deployment guidance', () => {
    const paths = activeTrackedPaths();
    expect(paths).toContain('scripts/create-notion-docs.ts');
    expect(paths).toContain('scripts/certbot/auth-hook.sh');
    expect(paths).toContain('docs/ONECLI_AGENT_CREDENTIALS.md');
  });

  it('fails closed before backing up or restoring credential-bearing plists', () => {
    const backup = readFileSync('scripts/backup/backup.sh', 'utf8');
    const restore = readFileSync('scripts/backup/restore.sh', 'utf8');
    const verify = readFileSync('scripts/backup/verify.sh', 'utf8');

    expect(
      backup.indexOf('EnvironmentVariables.ONECLI_AGENT_TOKEN'),
    ).toBeLessThan(backup.indexOf('backup_file "$plist"'));
    expect(
      restore.indexOf('EnvironmentVariables.ONECLI_AGENT_TOKEN'),
    ).toBeLessThan(restore.indexOf('cp -p "$plist"'));
    expect(verify).toContain('EnvironmentVariables.ONECLI_AGENT_TOKEN');
  });

  it('recognizes literal, fragmented, fallback, plist, and argv mutations', () => {
    const synthetic = ['aoc', 'x'.repeat(64)].join('_');
    const variable = ['ONECLI', 'AGENT', 'TOKEN'].join('_');
    const mutations: Array<[string, string]> = [
      [
        'mutation.ts',
        `const token = process.env.${variable} || '${synthetic}'`,
      ],
      ['mutation.sh', `token="\${${variable}:-synthetic-fallback}"`],
      ['job.plist', `<key>${variable}</key><string>${synthetic}</string>`],
      ['generator.ts', `const documentation = '${synthetic}'`],
      ['fragmented.ts', `const token = 'aoc_' + '${'x'.repeat(64)}'`],
      [
        'proxy.sh',
        'PROXY="http://x:${ONECLI_AGENT_TOKEN}@localhost:10255"\ncurl -x "$PROXY" https://example.invalid',
      ],
    ];
    for (const [file, mutation] of mutations)
      expect(credentialViolations(file, mutation), file).not.toEqual([]);
  });
});
