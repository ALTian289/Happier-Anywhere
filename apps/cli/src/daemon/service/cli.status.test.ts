import { existsSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildLaunchdPlistXml, renderSystemdServiceUnit, renderWindowsScheduledTaskWrapperPs1 } from '@happier-dev/cli-common/service';
import { withConfiguredDaemonTestHome, writeDaemonSettingsFixture } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { captureStderr, captureStdout, captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';
import type { DaemonLocallyPersistedState } from '@/persistence';
import { planDaemonServiceInstall, planDaemonServiceLifecycle } from './plan';
const stopDaemonMock = vi.fn(async () => undefined);
const restartDaemonAndWaitMock = vi.fn(async () => true);

function doMockChildProcessSpawnSync(
  spawnSyncImpl: (command: string, args?: readonly string[]) => unknown,
): void {
  vi.doMock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return {
      ...actual,
      spawnSync: vi.fn(spawnSyncImpl),
    };
  });
}

const SCOPED_ENV_KEYS = [
  'HAPPIER_DAEMON_SERVICE_PLATFORM',
  'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
  'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
  'HAPPIER_DAEMON_SERVICE_INSTANCE_ID',
  'HAPPIER_DAEMON_SERVICE_NODE_PATH',
  'HAPPIER_DAEMON_SERVICE_ENTRY_PATH',
  'HAPPIER_DAEMON_SERVICE_MODE',
  'HAPPIER_DAEMON_SERVICE_SYSTEM_USER',
  'HAPPIER_DAEMON_SERVICE_CHANNEL',
  'HAPPIER_DAEMON_SERVICE_TARGET_MODE',
  'HAPPIER_PUBLIC_RELEASE_CHANNEL',
  'HAPPIER_SERVER_URL',
  'HAPPIER_PUBLIC_SERVER_URL',
  'HAPPIER_LOCAL_SERVER_URL',
  'HAPPIER_WEBAPP_URL',
  'HAPPIER_HOME_DIR',
  'HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_TIMEOUT_MS',
  'HAPPIER_DAEMON_SERVICE_OWNERSHIP_ACTIVE_GRACE_TIMEOUT_MS',
  'HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_POLL_MS',
  'HAPPIER_DAEMON_SERVICE_OWNERSHIP_STABLE_MS',
  'HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS',
  'HAPPIER_DAEMON_START_WAIT_POLL_MS',
  'HAPPIER_CLI_INVOKER_NAME',
  'PATH',
] as const;

async function loadCliModule(): Promise<typeof import('./cli.js')> {
  return import('./cli.js');
}

function writeValidInstalledDaemonServiceFile(
  installedPath: string,
  options: Readonly<{
    activeServerId?: string;
    releaseChannel?: 'stable' | 'preview' | 'dev';
    targetMode?: 'default-following' | 'pinned';
  }> = {},
): void {
  writeFileSync(
    installedPath,
    renderSystemdServiceUnit({
      description: 'Happier Daemon',
      execStart: ['/Users/tester/.happier/cli/current/happier', 'daemon', 'start-sync'],
      env: {
        HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
        HAPPIER_DAEMON_SERVICE_TARGET_MODE: options.targetMode ?? 'default-following',
        HAPPIER_ACTIVE_SERVER_ID: options.activeServerId ?? 'cloud',
        HAPPIER_PUBLIC_RELEASE_CHANNEL: options.releaseChannel ?? 'stable',
      },
      wantedBy: 'default.target',
    }),
    'utf-8',
  );
}

function writeValidInstalledWindowsDaemonServiceFile(
    installedPath: string,
    options: Readonly<{
        activeServerId?: string;
        releaseChannel?: 'stable' | 'preview' | 'dev';
        targetMode?: 'default-following' | 'pinned';
    }> = {},
): void {
    const happierHomeDir = dirname(dirname(installedPath));
    writeFileSync(
        installedPath,
        renderWindowsScheduledTaskWrapperPs1({
            workingDirectory: 'C:\\Users\\tester',
            programArgs: ['C:\\hq\\happier.exe', 'daemon', 'start-sync'],
            env: {
                HAPPIER_HOME_DIR: happierHomeDir,
                HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
                HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
                HAPPIER_DAEMON_SERVICE_TARGET_MODE: options.targetMode ?? 'default-following',
                HAPPIER_ACTIVE_SERVER_ID: options.activeServerId ?? 'cloud',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: options.releaseChannel ?? 'stable',
            },
      stdoutPath: 'C:\\hq\\daemon.out.log',
      stderrPath: 'C:\\hq\\daemon.err.log',
    }),
    'utf-8',
  );
}

function scheduleDelayedOwnerWriteOnce(
  delayedOwnerWrites: Array<Promise<void>>,
  writeOwner: () => void,
): void {
  if (delayedOwnerWrites.length > 0) {
    return;
  }
  delayedOwnerWrites.push(new Promise<void>((resolve, reject) => {
    setTimeout(() => {
      try {
        writeOwner();
        resolve();
      } catch (error) {
        reject(error);
      }
    }, 120);
  }));
}

describe('runDaemonServiceCliCommand', () => {
  let envScope = createEnvKeyScope(SCOPED_ENV_KEYS);

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(SCOPED_ENV_KEYS);
    stopDaemonMock.mockReset();
    restartDaemonAndWaitMock.mockReset();
    vi.restoreAllMocks();
    vi.doUnmock('node:child_process');
    vi.doUnmock('./commandExistsInPath');
    vi.doUnmock('@/daemon/controlClient');
    vi.doUnmock('@/daemon/restartDaemonAndWait');
    vi.doUnmock('@/daemon/waitForDaemonRunningWithinBudget');
    vi.unmock('node:child_process');
    vi.unmock('./commandExistsInPath');
    vi.unmock('@/daemon/controlClient');
    vi.unmock('@/daemon/restartDaemonAndWait');
    vi.unmock('@/daemon/waitForDaemonRunningWithinBudget');
    vi.unmock('node:os');
    vi.doUnmock('./resolveDaemonServiceDiscoveryTargets');
    vi.doUnmock('./resolveLinuxSystemUserPaths');
    vi.doUnmock('./discoverInstalledDaemonServiceEntries');
    vi.unmock('./resolveDaemonServiceDiscoveryTargets');
    vi.unmock('./resolveLinuxSystemUserPaths');
    vi.unmock('./discoverInstalledDaemonServiceEntries');
    vi.resetModules();
  });

  it('prefers the configured API server URL when resolving pinned service targets from env', async () => {
    const { resolveDaemonServiceCliRuntimeFromEnv } = await loadCliModule();
    const runtime = resolveDaemonServiceCliRuntimeFromEnv({
      processEnv: {
        ...process.env,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'pinned',
        HAPPIER_PUBLIC_SERVER_URL: 'https://public.example.test',
        HAPPIER_SERVER_URL: 'http://127.0.0.1:4010',
        HAPPIER_WEBAPP_URL: 'https://app.example.test',
      },
    });

    expect(runtime.serverUrl).toBe('http://127.0.0.1:4010');
    expect(runtime.publicServerUrl).toBe('https://public.example.test');
    expect(runtime.webappUrl).toBe('https://app.example.test');
  });

  it('supports help JSON output', async () => {
    const { runDaemonServiceCliCommand } = await loadCliModule();
    envScope.patch({
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'darwin',
      HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '/tmp',
      HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: '/tmp/happier',
    });

    const output = captureStdoutJsonOutput<{
      ok: boolean;
      commands: string[];
      flags: string[];
    }>();
    try {
      await runDaemonServiceCliCommand({ argv: ['--help', '--json'] });

      const payload = output.json();
      expect(payload.ok).toBe(true);
      expect(payload.commands).toContain('list');
      expect(payload.commands).toContain('install');
      expect(payload.flags).toContain('--json');
    } finally {
      output.restore();
    }
  });

  it('treats --mode system as a flag (not as a subcommand) and reports systemd system paths (linux)', async () => {
    const { runDaemonServiceCliCommand } = await loadCliModule();
    envScope.patch({
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
      HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '/tmp',
      HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: '/tmp/happier',
    });

    const output = captureStdoutJsonOutput<{
      ok: boolean;
      platform: string;
      paths: { unitPath?: string; unitName?: string };
    }>();
    try {
      await runDaemonServiceCliCommand({ argv: ['paths', '--json', '--mode', 'system', '--system-user', 'happier'] });

      const payload = output.json();
      expect(payload.ok).toBe(true);
      expect(payload.platform).toBe('linux');
      expect(payload.paths.unitPath).toContain('/etc/systemd/system/');
      expect(payload.paths.unitName).toContain('happier-daemon.');
    } finally {
      output.restore();
    }
  });

  it('defaults service install dry-runs to the singleton default background service', async () => {
    const { runDaemonServiceCliCommand } = await loadCliModule();
    envScope.patch({
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
      HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '/tmp',
      HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: '/tmp/happier',
      HAPPIER_DAEMON_SERVICE_CHANNEL: 'preview',
      HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'company',
      HAPPIER_DAEMON_SERVICE_NODE_PATH: '/usr/local/bin/happier',
      HAPPIER_DAEMON_SERVICE_ENTRY_PATH: '',
      PATH: '/usr/bin',
    });

    const output = captureStdoutJsonOutput<{
      ok: boolean;
      plan: { files: Array<{ path: string; content: string }> };
    }>();
    try {
      await runDaemonServiceCliCommand({ argv: ['install', '--dry-run', '--json'] });

      const payload = output.json();
      expect(payload.ok).toBe(true);
      expect(payload.plan.files[0]?.path).toBe('/tmp/.config/systemd/user/happier-daemon.default.service');
      expect(payload.plan.files[0]?.content).toContain('Environment=HAPPIER_DAEMON_SERVICE_TARGET_MODE=default-following');
      expect(payload.plan.files[0]?.content).toContain('Environment=HAPPIER_PUBLIC_RELEASE_CHANNEL=preview');
      expect(payload.plan.files[0]?.content).not.toContain('Environment=HAPPIER_ACTIVE_SERVER_ID=');
      expect(payload.plan.files[0]?.content).not.toContain('Environment=HAPPIER_SERVER_URL=');
    } finally {
      output.restore();
    }
  });

  it('reports competing background services in install dry-run JSON output', async () => {
    await withTempDir('happier-service-install-dry-run-conflict-', async (homeDir) => {
      const happierHomeDir = `${homeDir}/.happier`;
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_CHANNEL: 'preview',
        HAPPIER_DAEMON_SERVICE_NODE_PATH: '/usr/local/bin/happier',
        HAPPIER_DAEMON_SERVICE_ENTRY_PATH: '',
        PATH: '/usr/bin',
      });
      vi.resetModules();

      const { runDaemonServiceCliCommand, resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths } = await loadCliModule();
      const stableRuntime = resolveDaemonServiceCliRuntimeFromEnv({
        channel: 'stable',
        targetMode: 'default-following',
        processEnv: process.env,
      });
      const stablePaths = resolveDaemonServicePaths(stableRuntime);
      mkdirSync(dirname(stablePaths.installedPath), { recursive: true });
      writeFileSync(
        stablePaths.installedPath,
        renderSystemdServiceUnit({
          description: 'Happier Daemon',
          execStart: ['/usr/local/bin/happier', 'daemon', 'start-sync'],
          env: {
            HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
            HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
            HAPPIER_HOME_DIR: happierHomeDir,
            HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
          },
          wantedBy: 'default.target',
        }),
        'utf-8',
      );

      const output = captureStdoutJsonOutput<{
        ok: boolean;
        installConflict?: {
          blocking: boolean;
          message: string;
          competingServices: Array<{ label: string }>;
        };
      }>();
      try {
        await runDaemonServiceCliCommand({ argv: ['install', '--dry-run', '--json'] });

        const payload = output.json();
        expect(payload.ok).toBe(true);
        expect(payload.installConflict).toEqual(expect.objectContaining({
          blocking: true,
          message: expect.stringContaining('Competing background services detected'),
        }));
        expect(payload.installConflict?.competingServices).toEqual([
          expect.objectContaining({ label: 'happier-daemon.default' }),
        ]);
      } finally {
        output.restore();
      }
    });
  });

  it('rejects invalid --mode values', async () => {
    const { runDaemonServiceCliCommand } = await loadCliModule();
    await expect(runDaemonServiceCliCommand({ argv: ['paths', '--mode', 'systm'] })).rejects.toThrow(
      'Invalid --mode value "systm" (expected user|system)',
    );
  });

  it('fails closed when --mode system is requested on unsupported platforms', async () => {
    const { runDaemonServiceCliCommand } = await loadCliModule();

    envScope.patch({
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'darwin',
      HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '/tmp',
      HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: '/tmp/happier',
    });
    await expect(runDaemonServiceCliCommand({ argv: ['paths', '--json', '--mode', 'system'] })).rejects.toThrow(
      'System mode background services are only supported on Linux',
    );

    envScope.patch({
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'win32',
      HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '/tmp',
      HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: '/tmp/happier',
    });
    await expect(runDaemonServiceCliCommand({ argv: ['paths', '--json', '--mode', 'system'] })).rejects.toThrow(
      'System mode background services are only supported on Linux',
    );
  });

  it('uses the system service user home for system install working directories and log paths', async () => {
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      return {
        ...actual,
        spawnSync: vi.fn(() => ({
          pid: 1,
          output: ['', 'happier:x:1001:1001::/home/happier:/bin/bash\n', ''],
          stdout: 'happier:x:1001:1001::/home/happier:/bin/bash\n',
          stderr: '',
          status: 0,
          signal: null,
        })),
      };
    });
    vi.doMock('node:os', async () => {
      const actual = await vi.importActual<typeof import('node:os')>('node:os');
      return {
        ...actual,
        homedir: vi.fn(() => '/root'),
      };
    });

    const { runDaemonServiceCliCommand } = await loadCliModule();
    envScope.patch({
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
      HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'pinned',
      HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'company',
      HAPPIER_DAEMON_SERVICE_NODE_PATH: '/usr/local/bin/happier',
      HAPPIER_DAEMON_SERVICE_ENTRY_PATH: '',
      PATH: '/usr/bin',
    });

    const processWithGetuid = process as typeof process & { getuid: () => number };
    vi.spyOn(processWithGetuid, 'getuid').mockReturnValue(0);
    const installOutput = captureStdoutJsonOutput<{
      ok: boolean;
      plan: { files: Array<{ path: string; content: string }> };
    }>();
    try {
      await runDaemonServiceCliCommand({
        argv: ['install', '--dry-run', '--json', '--mode', 'system', '--system-user', 'happier'],
      });

      const installPayload = installOutput.json();
      expect(installPayload.ok).toBe(true);
      expect(installPayload.plan.files[0]?.path).toBe('/etc/systemd/system/happier-daemon.company.service');
      expect(installPayload.plan.files[0]?.content).toContain('User=happier');
      expect(installPayload.plan.files[0]?.content).toContain('WorkingDirectory=/home/happier');
      expect(installPayload.plan.files[0]?.content).toContain('Environment=HAPPIER_HOME_DIR=/home/happier/.happier');
      expect(installPayload.plan.files[0]?.content).toContain('Environment=PATH=');
      expect(installPayload.plan.files[0]?.content).toContain('/home/happier/.local/bin');
      expect(installPayload.plan.files[0]?.content).toContain('/home/happier/bin');
      expect(installPayload.plan.files[0]?.content).not.toContain('/root/.local/bin');
      expect(installPayload.plan.files[0]?.content).not.toContain('/root/.happier');
    } finally {
      installOutput.restore();
    }

    const pathsOutput = captureStdoutJsonOutput<{
      ok: boolean;
      paths: { stdoutPath?: string; stderrPath?: string };
    }>();
    try {
      await runDaemonServiceCliCommand({ argv: ['paths', '--json', '--mode', 'system', '--system-user', 'happier'] });

      const pathsPayload = pathsOutput.json();
      expect(pathsPayload.ok).toBe(true);
      expect(pathsPayload.paths.stdoutPath).toBe('/home/happier/.happier/logs/daemon-service.company.out.log');
      expect(pathsPayload.paths.stderrPath).toBe('/home/happier/.happier/logs/daemon-service.company.err.log');
    } finally {
      pathsOutput.restore();
    }
  });

  it('scopes systemd unit names by release channel so dev services can coexist with stable', async () => {
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      return {
        ...actual,
        spawnSync: vi.fn(() => ({
          pid: 1,
          output: ['', 'happier:x:1001:1001::/home/happier:/bin/bash\n', ''],
          stdout: 'happier:x:1001:1001::/home/happier:/bin/bash\n',
          stderr: '',
          status: 0,
          signal: null,
        })),
      };
    });
    vi.doMock('node:os', async () => {
      const actual = await vi.importActual<typeof import('node:os')>('node:os');
      return {
        ...actual,
        homedir: vi.fn(() => '/root'),
      };
    });

    const { runDaemonServiceCliCommand } = await loadCliModule();
    envScope.patch({
      HAPPIER_DAEMON_SERVICE_CHANNEL: 'dev',
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
      HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'pinned',
      HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'company',
      HAPPIER_DAEMON_SERVICE_NODE_PATH: '/usr/local/bin/happier',
      HAPPIER_DAEMON_SERVICE_ENTRY_PATH: '',
      PATH: '/usr/bin',
    });

    const processWithGetuid = process as typeof process & { getuid: () => number };
    vi.spyOn(processWithGetuid, 'getuid').mockReturnValue(0);

    const installOutput = captureStdoutJsonOutput<{
      ok: boolean;
      plan: { files: Array<{ path: string; content: string }> };
    }>();
    try {
      await runDaemonServiceCliCommand({
        argv: ['install', '--dry-run', '--json', '--mode', 'system', '--system-user', 'happier'],
      });

      const installPayload = installOutput.json();
      expect(installPayload.ok).toBe(true);
      expect(installPayload.plan.files[0]?.path).toBe('/etc/systemd/system/happier-daemon.dev.company.service');
      expect(installPayload.plan.files[0]?.content).toContain('Environment=HAPPIER_PUBLIC_RELEASE_CHANNEL=dev');
    } finally {
      installOutput.restore();
    }
  });

  it('reports daemon service status as not installed when the service file is absent', async () => {
    const { runDaemonServiceCliCommand } = await loadCliModule();
    envScope.patch({
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
      HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '/tmp',
      HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: '/tmp/happier',
    });

    const output = captureStdoutJsonOutput<{
      ok: boolean;
      installed: boolean;
      daemon?: { running: boolean };
    }>();
    try {
      await runDaemonServiceCliCommand({ argv: ['status', '--json'] });

      const payload = output.json();
      expect(payload.ok).toBe(true);
      expect(payload.installed).toBe(false);
      expect(payload.daemon?.running).toBe(false);
    } finally {
      output.restore();
    }
  });

  it('reports the current relay owner and invocation mismatch in service status JSON', async () => {
    await withTempDir('happier-service-status-owner-', async (homeDir) => {
      const happierHomeDir = `${homeDir}/.happier`;
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
      });
      vi.resetModules();

      const [{ runDaemonServiceCliCommand, resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths }, { writeDaemonState }] = await Promise.all([
        loadCliModule(),
        import('@/persistence'),
      ]);

      const runtime = resolveDaemonServiceCliRuntimeFromEnv({ processEnv: process.env });
      const paths = resolveDaemonServicePaths(runtime);
      mkdirSync(dirname(paths.installedPath), { recursive: true });
      writeFileSync(
        paths.installedPath,
        renderSystemdServiceUnit({
          description: 'Happier Daemon',
          execStart: ['/Users/tester/.happier/cli/current/happier', 'daemon', 'start-sync'],
          env: {
            HAPPIER_ACTIVE_SERVER_ID: 'cloud',
            HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
            HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
          },
          wantedBy: 'default.target',
        }),
        'utf-8',
      );

      await writeDaemonState({
        pid: process.pid,
        httpPort: 3005,
        startedAt: Date.now(),
        startedWithCliVersion: '0.0.0-other',
        startedWithPublicReleaseChannel: 'preview',
        runtimeId: 'runtime-1',
        startupSource: 'background-service',
        serviceLabel: paths.label,
      });

      const output = captureStdoutJsonOutput<{
        ok: boolean;
        owner?: {
          serviceManaged?: boolean;
          startupSource?: string | null;
          serviceLabel?: string | null;
          startedWithCliVersion?: string | null;
          startedWithPublicReleaseChannel?: string | null;
          currentInvocationMatches?: boolean;
        } | null;
      }>();
      try {
        await runDaemonServiceCliCommand({ argv: ['status', '--json'] });

        const payload = output.json();
        expect(payload.ok).toBe(true);
        expect(payload.owner).toEqual(expect.objectContaining({
          serviceManaged: true,
          startupSource: 'background-service',
          serviceLabel: paths.label,
          startedWithCliVersion: '0.0.0-other',
          startedWithPublicReleaseChannel: 'preview',
          currentInvocationMatches: false,
        }));
      } finally {
        output.restore();
      }
    });
  });

  it('includes a services inventory field in service status JSON', async () => {
    await withTempDir('happier-service-status-inventory-', async (homeDir) => {
      const happierHomeDir = `${homeDir}/.happier`;
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
        HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
        HAPPIER_ACTIVE_SERVER_ID: 'cloud',
        HAPPIER_SERVER_URL: 'https://cloud.example.test',
        HAPPIER_PUBLIC_SERVER_URL: 'https://cloud.example.test',
        HAPPIER_WEBAPP_URL: 'https://cloud.example.test',
      });
      vi.resetModules();

      const [{ runDaemonServiceCliCommand, resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths }, { writeDaemonState }] = await Promise.all([
        loadCliModule(),
        import('@/persistence'),
      ]);

      await writeDaemonSettingsFixture(happierHomeDir, {
        servers: {
          cloud: {
            id: 'cloud',
            name: 'Cloud',
            serverUrl: 'https://cloud.example.test',
            webappUrl: 'https://cloud.example.test',
            createdAt: 0,
            updatedAt: 0,
            lastUsedAt: 0,
          },
        },
      });

      const runtime = resolveDaemonServiceCliRuntimeFromEnv({ processEnv: process.env });
      const paths = resolveDaemonServicePaths(runtime);
      mkdirSync(dirname(paths.installedPath), { recursive: true });
      writeFileSync(
        paths.installedPath,
        renderSystemdServiceUnit({
          description: 'Happier Daemon',
          execStart: ['/Users/tester/.happier/cli/current/happier', 'daemon', 'start-sync'],
          env: {
            HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
            HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
            HAPPIER_ACTIVE_SERVER_ID: 'cloud',
            HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
          },
          wantedBy: 'default.target',
        }),
        'utf-8',
      );

      await writeDaemonState({
        pid: process.pid,
        httpPort: 3007,
        startedAt: Date.now(),
        startedWithCliVersion: '0.0.0-other',
        startedWithPublicReleaseChannel: 'preview',
        runtimeId: 'runtime-inventory',
        startupSource: 'background-service',
        serviceLabel: paths.label,
      });

      const output = captureStdoutJsonOutput<{
        ok: boolean;
        services?: Array<{
          label?: string;
          ring?: string;
          targetMode?: string;
          installed?: boolean;
        }>;
        owner?: {
          serviceManaged?: boolean;
          startupSource?: string | null;
          serviceLabel?: string | null;
        } | null;
      }>();
      try {
        await runDaemonServiceCliCommand({ argv: ['status', '--json'] });

        const payload = output.json();
        expect(payload.ok).toBe(true);
        expect(Array.isArray(payload.services)).toBe(true);
        expect(payload.owner).toEqual(expect.objectContaining({
          serviceManaged: true,
          startupSource: 'background-service',
          serviceLabel: paths.label,
        }));
      } finally {
        output.restore();
      }
    });
  });

  it('keeps the relay owner source unknown in service status JSON for legacy daemon state', async () => {
    await withTempDir('happier-service-status-owner-legacy-', async (homeDir) => {
      const happierHomeDir = `${homeDir}/.happier`;
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
      });
      vi.resetModules();

      const [{ runDaemonServiceCliCommand, resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths }, { writeDaemonState }] = await Promise.all([
        loadCliModule(),
        import('@/persistence'),
      ]);

      const runtime = resolveDaemonServiceCliRuntimeFromEnv({ processEnv: process.env });
      const paths = resolveDaemonServicePaths(runtime);
      mkdirSync(dirname(paths.installedPath), { recursive: true });
      writeFileSync(paths.installedPath, '[Unit]\nDescription=Happier\n');

      await writeDaemonState({
        pid: process.pid,
        httpPort: 3006,
        startedAt: Date.now(),
        startedWithCliVersion: '0.0.0-other',
        startedWithPublicReleaseChannel: 'preview',
        runtimeId: 'runtime-legacy',
      });

      const output = captureStdoutJsonOutput<{
        ok: boolean;
        owner?: {
          serviceManaged?: boolean | null;
          startupSource?: string | null;
          currentInvocationMatches?: boolean | null;
        } | null;
      }>();
      try {
        await runDaemonServiceCliCommand({ argv: ['status', '--json'] });

        const payload = output.json();
        expect(payload.ok).toBe(true);
        expect(payload.owner).toEqual(expect.objectContaining({
          serviceManaged: false,
          startupSource: null,
          currentInvocationMatches: false,
        }));
      } finally {
        output.restore();
      }
    });
  });

  it('fails closed when enabling automatic startup while a manually started daemon is already running', async () => {
    await withTempDir('happier-service-install-owner-conflict-', async (homeDir) => {
      const happierHomeDir = `${homeDir}/.happier`;
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
      });
      vi.resetModules();

      const [{ runDaemonServiceCliCommand }, { writeDaemonState }] = await Promise.all([
        loadCliModule(),
        import('@/persistence'),
      ]);

      await writeDaemonState({
        pid: process.pid,
        httpPort: 3005,
        startedAt: Date.now(),
        startedWithCliVersion: '0.0.0',
        startedWithPublicReleaseChannel: 'stable',
        runtimeId: 'runtime-1',
        startupSource: 'manual',
      });

      const output = captureStdoutJsonOutput<{
        ok: boolean;
        error: string;
        message: string;
      }>();
      try {
        await runDaemonServiceCliCommand({ argv: ['install', '--dry-run', '--json'] });

        const payload = output.json();
        expect(payload.ok).toBe(false);
        expect(payload.error).toBe('owner_conflict');
        expect(payload.message).toContain('manually started daemon');
      } finally {
        output.restore();
      }
    });
  });

  it('allows planning an automatic-startup takeover for a manual daemon with --takeover', async () => {
    await withTempDir('happier-service-install-owner-takeover-', async (homeDir) => {
      const happierHomeDir = `${homeDir}/.happier`;
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
      });
      vi.resetModules();

      const [{ runDaemonServiceCliCommand }, { writeDaemonState }] = await Promise.all([
        loadCliModule(),
        import('@/persistence'),
      ]);

      await writeDaemonState({
        pid: process.pid,
        httpPort: 3006,
        startedAt: Date.now(),
        startedWithCliVersion: '0.0.0',
        startedWithPublicReleaseChannel: 'stable',
        runtimeId: 'runtime-2',
        startupSource: 'manual',
      });

      const output = captureStdoutJsonOutput<{
        ok: boolean;
        plan?: { files: Array<{ path: string }> };
        takeover?: string;
      }>();
      try {
        await runDaemonServiceCliCommand({ argv: ['install', '--dry-run', '--json', '--takeover'] });

        const payload = output.json();
        expect(payload.ok).toBe(true);
        expect(payload.plan?.files.length).toBeGreaterThan(0);
        expect(payload.takeover).toContain('Taking over the current manual daemon');
      } finally {
        output.restore();
      }
    });
  });

  it('fails closed and classifies a legacy manual owner correctly during service install', async () => {
    await withTempDir('happier-service-install-owner-legacy-conflict-', async (homeDir) => {
      const happierHomeDir = `${homeDir}/.happier`;
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
      });
      vi.resetModules();

      const [{ runDaemonServiceCliCommand }, { writeDaemonState }] = await Promise.all([
        loadCliModule(),
        import('@/persistence'),
      ]);

      await writeDaemonState({
        pid: process.pid,
        httpPort: 3007,
        startedAt: Date.now(),
        startedWithCliVersion: '0.0.0',
        startedWithPublicReleaseChannel: 'stable',
        runtimeId: 'runtime-legacy',
      });

      const output = captureStdoutJsonOutput<{
        ok: boolean;
        error: string;
        message: string;
      }>();
      try {
        await runDaemonServiceCliCommand({ argv: ['install', '--dry-run', '--json'] });

        const payload = output.json();
        expect(payload.ok).toBe(false);
        expect(payload.error).toBe('owner_conflict');
        expect(payload.message).toContain('manually started daemon');
        expect(payload.message).toContain('--takeover');
      } finally {
        output.restore();
      }
    });
  });

});
