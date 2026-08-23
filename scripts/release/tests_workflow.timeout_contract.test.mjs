import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..', '..');

function extractJobBlock(raw, jobName) {
  const normalized = raw.replace(/\r\n/g, '\n');
  const match = normalized.match(new RegExp(`(?:^|\\n)  ${jobName}:\\n([\\s\\S]*?)(?=\\n  [A-Za-z0-9-]+:|\\n$)`));
  assert.ok(match, `expected to find job block for ${jobName}`);
  return match[1];
}

test('tests workflow keeps slow CI jobs above the observed timeout floor', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8');
  const uiE2eJob = extractJobBlock(raw, 'ui-e2e');
  const uiJob = extractJobBlock(raw, 'ui');
  const cliJob = extractJobBlock(raw, 'cli');
  const stackJob = extractJobBlock(raw, 'stack');
  const installerSmokeWindowsJob = extractJobBlock(raw, 'installers-smoke-windows');

  assert.match(
    uiE2eJob,
    /name:\s*UI E2E \(Playwright\)[\s\S]*?timeout-minutes:\s*120\b/,
    'UI E2E job should reserve enough time to finish the slow multi-session Playwright scenarios on GitHub-hosted runners',
  );
  assert.match(uiE2eJob, /shard:\s*\[1, 2, 3, 4, 5, 6\]/, 'UI E2E should split the slow suite across six shards');
  assert.match(uiE2eJob, /--shard=\$\{\{ matrix\.shard \}\}\/6/, 'UI E2E should pass the six-way shard count to Playwright');
  assert.match(
    uiE2eJob,
    /Upload UI E2E artifacts \(Playwright\)[\s\S]*?if:\s*always\(\)/,
    'UI E2E should retain diagnostics after failures and job cancellation',
  );
  assert.match(
    uiE2eJob,
    /\.project\/logs\/e2e\/\*-ui-e2e-\*\/\*\*\/\*\.log/,
    'UI E2E failure artifacts should include daemon, server, and CLI runtime logs',
  );

  assert.match(
    uiJob,
    /name:\s*UI Tests \(unit \+ integration\)[\s\S]*?timeout-minutes:\s*75\b/,
    'UI Tests job should reserve enough time to finish on GitHub-hosted runners',
  );
  assert.match(uiJob, /shard:\s*\[1, 2, 3, 4\]/, 'UI unit tests should fan out across four runner jobs');
  assert.match(
    uiJob,
    /HAPPIER_UI_VITEST_SHARDS:\s*"96"[\s\S]*?HAPPIER_UI_VITEST_OUTER_SHARD:\s*"\$\{\{ matrix\.shard \}\}\/4"/,
    'each UI runner should execute only its quarter of the unit suite in child processes small enough to stay below the heap limit',
  );

  assert.match(
    cliJob,
    /name:\s*CLI Tests \(unit \+ integration\)[\s\S]*?timeout-minutes:\s*90\b/,
    'CLI Tests job should reserve enough time for bounded unit shards and integration tests',
  );
  assert.match(cliJob, /shard:\s*\[1, 2, 3, 4\]/, 'CLI unit tests should fan out across four runner jobs');
  assert.match(
    cliJob,
    /NODE_OPTIONS:\s*--max-old-space-size=8192\b/,
    'CLI unit shards should retain enough heap for the heaviest isolated app-server and daemon test files',
  );
  assert.match(
    cliJob,
    /HAPPIER_CLI_VITEST_OUTER_SHARD:\s*"\$\{\{ matrix\.shard \}\}\/4"/,
    'each CLI runner should execute only its deterministic quarter of the unit suite',
  );
  assert.match(
    cliJob,
    /- name:\s*Run integration tests[\s\S]*?- name:\s*Run unit tests and import-cycle guard/,
    'CLI integration tests should run before the unit shards can contaminate the fixed integration-test home',
  );

  assert.match(
    stackJob,
    /name:\s*Stack Tests \(unit \+ integration\)[\s\S]*?timeout-minutes:\s*45\b/,
    'Stack Tests job should reserve enough time to finish on GitHub-hosted runners',
  );

  assert.match(
    installerSmokeWindowsJob,
    /name:\s*Installer Smoke \(Windows\)[\s\S]*?timeout-minutes:\s*45\b/,
    'Windows installer smoke should reserve enough time to finish published-channel validation on GitHub-hosted runners',
  );
});
