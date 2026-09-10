import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

test('stress tests workflow keeps manual config encoded as reusable-workflow data', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'stress-tests.yml'), 'utf8');

  assert.match(raw, /\bstress:\r?\n[\s\S]*?uses:\s*\.\/\.github\/workflows\/tests\.yml/);
  assert.match(
    raw,
    /stress_config:\s*\$\{\{\s*format\([\s\S]*toJSON\(github\.event\.inputs\.repeat\)[\s\S]*toJSON\(github\.event\.inputs\.seed\)/,
  );
  assert.doesNotMatch(
    raw,
    /stress-scheduled|stress-dispatch|github\.event_name/,
    'manual-only stress workflow should not retain event-gated dead jobs',
  );
});
