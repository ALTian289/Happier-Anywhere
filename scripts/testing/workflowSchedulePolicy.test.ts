import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { parse } from 'yaml';

test('resource-intensive workflows are manual-only', () => {
  for (const workflowName of [
    'nightly-dev.yml',
    'stress-tests.yml',
    'extended-db-tests.yml',
    'self-host-e2e.yml',
  ]) {
    const workflow = parse(readFileSync(`.github/workflows/${workflowName}`, 'utf8')) as {
      on?: {
        schedule?: Array<{ cron?: string }>;
        workflow_dispatch?: unknown;
      };
    };

    const triggers = workflow.on ?? {};
    assert.equal(triggers.schedule, undefined, `${workflowName} must not run on a timer`);
    assert.ok(
      Object.prototype.hasOwnProperty.call(triggers, 'workflow_dispatch'),
      `${workflowName} should remain manually dispatchable`,
    );
  }
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
