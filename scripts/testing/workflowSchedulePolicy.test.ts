import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { parse } from 'yaml';

test('nightly dev releases are manual-only', () => {
  const workflow = parse(readFileSync('.github/workflows/nightly-dev.yml', 'utf8')) as {
    on?: {
      schedule?: Array<{ cron?: string }>;
      workflow_dispatch?: unknown;
    };
  };

  assert.equal(workflow.on?.schedule, undefined, 'nightly-dev.yml must not publish on a timer');
  assert.ok(workflow.on?.workflow_dispatch, 'nightly-dev.yml should remain manually dispatchable');
});

test('extended DB matrix runs the bounded fast E2E lane for each external database', () => {
  const workflow = parse(readFileSync('.github/workflows/extended-db-tests.yml', 'utf8')) as {
    jobs?: Record<string, { steps?: Array<{ run?: string }> }>;
  };

  const runCommands = Object.values(workflow.jobs ?? {})
    .flatMap((job) => job.steps ?? [])
    .map((step) => String(step.run ?? '').trim())
    .filter(Boolean);

  assert.equal(
    runCommands.filter((command) => command === 'yarn test:e2e:core:fast').length,
    2,
    'Postgres and MySQL must each run the bounded fast E2E lane',
  );
  assert.equal(
    runCommands.filter((command) => command === 'yarn test:e2e').length,
    0,
    'the full fast+slow+testkit suite cannot fit safely in one external-DB job',
  );
});
