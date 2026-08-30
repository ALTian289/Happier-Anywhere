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

  it('uses extended Windows ownership wait defaults for background-service restarts', async () => {
    await withTempDir('happier-service-restart-win32-wait-budget-', async (homeDir) => {
      const happierHomeDir = `${homeDir}/.happier`;
      const observedWaitTimeouts: number[] = [];
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'win32',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_POLL_MS: '10',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_STABLE_MS: '20',
      });
      vi.resetModules();
      doMockChildProcessSpawnSync(() => ({ status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') }));
      vi.doMock('./commandExistsInPath', () => ({
        commandExistsInPath: vi.fn(() => true),
      }));
      vi.doMock('@/daemon/waitForDaemonRunningWithinBudget', async (importOriginal) => {
        const actual = await importOriginal<typeof import('@/daemon/waitForDaemonRunningWithinBudget')>();
        return {
          ...actual,
          waitForDaemonRunningWithinBudget: vi.fn(async (params: { timeoutMs: number }) => {
            observedWaitTimeouts.push(params.timeoutMs);
            return false;
          }),
        };
      });

      const [{ runDaemonServiceCliCommand, resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths }, { writeCredentialsLegacy }] = await Promise.all([
        loadCliModule(),
        import('@/persistence'),
      ]);

      const runtime = resolveDaemonServiceCliRuntimeFromEnv({ targetMode: 'default-following' });
      const paths = resolveDaemonServicePaths(runtime);
      mkdirSync(dirname(paths.installedPath), { recursive: true });
      writeValidInstalledWindowsDaemonServiceFile(paths.installedPath);
      await writeCredentialsLegacy({ secret: new Uint8Array(32).fill(1), token: 'token-win32-wait-budget' });

      await expect(runDaemonServiceCliCommand({ argv: ['restart', '--json'], commandPath: 'hdev service' })).rejects.toThrow(/hdev service status/i);
      expect(observedWaitTimeouts).toEqual([120_000, 60_000]);
    });
  });

  it('fails service restart when the background-service owner keeps the old release channel', async () => {
    await withTempDir('happier-service-restart-stale-owner-', async (homeDir) => {
      const happierHomeDir = `${homeDir}/.happier`;
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS: '50',
        HAPPIER_DAEMON_START_WAIT_POLL_MS: '10',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_TIMEOUT_MS: '120',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_ACTIVE_GRACE_TIMEOUT_MS: '120',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_POLL_MS: '10',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_STABLE_MS: '20',
      });
      vi.resetModules();
      vi.doMock('node:child_process', async (importOriginal) => {
        const actual = await importOriginal<typeof import('node:child_process')>();
        return {
          ...actual,
          spawnSync: vi.fn((command: string, args: readonly string[] = []) => {
            if (command === 'systemctl' && args.includes('is-active')) {
              return { status: 0, stdout: Buffer.from('active'), stderr: Buffer.from('') };
            }
            return { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
          }),
        };
      });
      vi.doMock('./commandExistsInPath', () => ({
        commandExistsInPath: vi.fn(() => true),
      }));

      const [{ runDaemonServiceCliCommand, resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths }, { writeDaemonState }, { configuration }] = await Promise.all([
        loadCliModule(),
        import('@/persistence'),
        import('@/configuration'),
      ]);

      const runtime = resolveDaemonServiceCliRuntimeFromEnv({ targetMode: 'default-following' });
      const paths = resolveDaemonServicePaths(runtime);
      mkdirSync(dirname(paths.installedPath), { recursive: true });
      writeValidInstalledDaemonServiceFile(paths.installedPath);

      writeDaemonState({
        pid: process.pid,
        httpPort: 43127,
        startedAt: Date.now(),
        startedWithCliVersion: configuration.currentCliVersion,
        startedWithPublicReleaseChannel: 'preview',
        startupSource: 'background-service',
        serviceLabel: paths.label,
      });

      await expect(runDaemonServiceCliCommand({ argv: ['restart', '--json'] })).rejects.toThrow(/did not become the active daemon/i);
    });
  });

  it('stops the current Windows service owner before reinstalling the same service label', async () => {
    await withTempDir('happier-service-install-win32-same-owner-', async (homeDir) => {
      const happierHomeDir = `${homeDir}/.happier`;
      const lifecycleEvents: string[] = [];
      let writeDaemonStateImpl: ((state: DaemonLocallyPersistedState) => void) | null = null;
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'win32',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_TIMEOUT_MS: '120',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_POLL_MS: '10',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_STABLE_MS: '20',
      });
      vi.resetModules();
      vi.doMock('node:child_process', async (importOriginal) => {
        const actual = await importOriginal<typeof import('node:child_process')>();
        return {
          ...actual,
          spawnSync: vi.fn((command: string, args: readonly string[] = []) => {
            if (command !== 'schtasks') {
              return { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
            }
            const action = String(args[0] ?? '');
            lifecycleEvents.push(action);
            if (action === '/Run' && writeDaemonStateImpl) {
              writeDaemonStateImpl({
                pid: process.pid,
                httpPort: 43141,
                startedAt: Date.now(),
                startedWithCliVersion: configuration.currentCliVersion,
                startedWithPublicReleaseChannel: currentPublicReleaseChannel,
                startupSource: 'background-service',
                serviceLabel: paths.label,
                runtimeId: 'runtime-win32-install',
              });
            }
            if (action === '/Query') {
              return {
                status: 0,
                stdout: Buffer.from('Status: Running\nScheduled Task State: Enabled\n'),
                stderr: Buffer.from(''),
              };
            }
            return { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
          }),
        };
      });
      vi.doMock('./commandExistsInPath', () => ({
        commandExistsInPath: vi.fn(() => true),
      }));

      const controlClient = await import('@/daemon/controlClient');
      const [{ clearDaemonStateForTests: clearDaemonState, writeDaemonState }, { configuration }] = await Promise.all([
        import('@/persistence'),
        import('@/configuration'),
      ]);
      vi.spyOn(controlClient, 'stopDaemon').mockImplementation(async () => {
        lifecycleEvents.push('stopDaemon');
        await clearDaemonState();
      });

      const [{ runDaemonServiceCliCommand, resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths }] = await Promise.all([
        loadCliModule(),
      ]);
      writeDaemonStateImpl = writeDaemonState;

      const runtime = resolveDaemonServiceCliRuntimeFromEnv({ targetMode: 'default-following' });
      const paths = resolveDaemonServicePaths(runtime);
      const currentPublicReleaseChannel = runtime.channel === 'publicdev' ? 'dev' : runtime.channel;
      mkdirSync(dirname(paths.installedPath), { recursive: true });
      writeValidInstalledWindowsDaemonServiceFile(paths.installedPath);
      writeDaemonState({
        pid: process.pid,
        httpPort: 43140,
        startedAt: Date.now(),
        startedWithCliVersion: configuration.currentCliVersion,
        startedWithPublicReleaseChannel: currentPublicReleaseChannel,
        startupSource: 'background-service',
        serviceLabel: paths.label,
        runtimeId: 'runtime-win32-existing',
      });

      const output = captureStdoutJsonOutput<{ ok: boolean; platform: string }>();
      try {
        await runDaemonServiceCliCommand({ argv: ['install', '--yes', '--json'] });
        const payload = output.json();
        expect(payload.ok).toBe(true);
        expect(payload.platform).toBe('win32');
      } finally {
        output.restore();
      }

      const stopIndex = lifecycleEvents.indexOf('stopDaemon');
      const createIndex = lifecycleEvents.indexOf('/Create');
      const runIndex = lifecycleEvents.indexOf('/Run');
      expect(stopIndex).toBeGreaterThanOrEqual(0);
      expect(createIndex).toBeGreaterThan(stopIndex);
      expect(runIndex).toBeGreaterThan(createIndex);
    });
  });

  it('stops the current Windows service owner before restarting the same service label', async () => {
    await withTempDir('happier-service-restart-win32-same-owner-', async (homeDir) => {
      const happierHomeDir = `${homeDir}/.happier`;
      const lifecycleEvents: string[] = [];
      let writeDaemonStateImpl: ((state: DaemonLocallyPersistedState) => void) | null = null;
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'win32',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_PUBLIC_RELEASE_CHANNEL: 'preview',
        HAPPIER_DAEMON_SERVICE_CHANNEL: 'preview',
        HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_TIMEOUT_MS: '120',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_POLL_MS: '10',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_STABLE_MS: '20',
      });
      vi.resetModules();
      vi.doMock('node:child_process', async (importOriginal) => {
        const actual = await importOriginal<typeof import('node:child_process')>();
        return {
          ...actual,
          spawnSync: vi.fn((command: string, args: readonly string[] = []) => {
            if (command === 'powershell.exe' && String(args.at(-1) ?? '').includes('Stop-ScheduledTask')) {
              lifecycleEvents.push('Stop-ScheduledTask');
            }
            if (command !== 'schtasks') {
              return { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
            }
            const action = String(args[0] ?? '');
            lifecycleEvents.push(action);
            if (action === '/Run' && writeDaemonStateImpl) {
              writeDaemonStateImpl({
                pid: process.pid,
                httpPort: 43143,
                startedAt: Date.now(),
                startedWithCliVersion: configuration.currentCliVersion,
                startedWithPublicReleaseChannel: currentPublicReleaseChannel,
                startupSource: 'background-service',
                serviceLabel: paths.label,
                runtimeId: 'runtime-win32-restarted',
              });
            }
            if (action === '/Query') {
              return {
                status: 0,
                stdout: Buffer.from('Status: Running\nScheduled Task State: Enabled\n'),
                stderr: Buffer.from(''),
              };
            }
            return { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
          }),
        };
      });
      vi.doMock('./commandExistsInPath', () => ({
        commandExistsInPath: vi.fn(() => true),
      }));

      const controlClient = await import('@/daemon/controlClient');
      const [{ clearDaemonStateForTests: clearDaemonState, writeDaemonState }, { configuration }] = await Promise.all([
        import('@/persistence'),
        import('@/configuration'),
      ]);
      vi.spyOn(controlClient, 'stopDaemon').mockImplementation(async () => {
        lifecycleEvents.push('stopDaemon');
        await clearDaemonState();
      });

      const [{ runDaemonServiceCliCommand, resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths }] = await Promise.all([
        loadCliModule(),
      ]);
      writeDaemonStateImpl = writeDaemonState;

      const runtime = resolveDaemonServiceCliRuntimeFromEnv({ targetMode: 'default-following' });
      const paths = resolveDaemonServicePaths(runtime);
      const currentPublicReleaseChannel = runtime.channel === 'publicdev' ? 'dev' : runtime.channel;
      mkdirSync(dirname(paths.installedPath), { recursive: true });
      writeValidInstalledWindowsDaemonServiceFile(paths.installedPath, { releaseChannel: 'preview' });
      writeDaemonState({
        pid: process.pid,
        httpPort: 43142,
        startedAt: Date.now(),
        startedWithCliVersion: configuration.currentCliVersion,
        startedWithPublicReleaseChannel: 'stable',
        startupSource: 'background-service',
        serviceLabel: paths.label,
        runtimeId: 'runtime-win32-stale-owner',
      });

      const output = captureStdoutJsonOutput<{ ok: boolean; platform: string }>();
      try {
        await runDaemonServiceCliCommand({ argv: ['restart', '--json'] });
        const payload = output.json();
        expect(payload.ok).toBe(true);
        expect(payload.platform).toBe('win32');
      } finally {
        output.restore();
      }

      expect(lifecycleEvents.slice(0, 3)).toEqual(['stopDaemon', 'Stop-ScheduledTask', '/Run']);
    });
  });

  it('allows taking over a manual daemon when starting a background service with --takeover', async () => {
    await withTempDir('happier-service-start-owner-takeover-', async (homeDir) => {
      stopDaemonMock.mockReset();
      let ownerWritten = false;
      let expectedServiceLabel = '';
      let writeDaemonStateImpl: ((state: DaemonLocallyPersistedState) => void) | null = null;
      const happierHomeDir = `${homeDir}/.happier`;
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
      });
      vi.resetModules();
      doMockChildProcessSpawnSync((command: string, args: readonly string[] = []) => {
        if (command === 'systemctl' && args.includes('is-active')) {
          return ownerWritten
            ? { status: 0, stdout: Buffer.from('active'), stderr: Buffer.from('') }
            : { status: 1, stdout: Buffer.from(''), stderr: Buffer.from('inactive') };
        }
        writeDaemonStateImpl?.({
          pid: process.pid,
          httpPort: 43122,
          startedAt: Date.now(),
          startedWithCliVersion: configuration.currentCliVersion,
          startupSource: 'background-service',
          serviceLabel: expectedServiceLabel,
        });
        ownerWritten = true;
        return { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
      });
      vi.doMock('./commandExistsInPath', () => ({
        commandExistsInPath: vi.fn(() => true),
      }));
      const controlClient = await import('@/daemon/controlClient');
      vi.spyOn(controlClient, 'stopDaemon').mockImplementation(stopDaemonMock);

      const [{ runDaemonServiceCliCommand, resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths }, { writeDaemonState }, { configuration }] = await Promise.all([
        loadCliModule(),
        import('@/persistence'),
        import('@/configuration'),
      ]);

      const runtime = resolveDaemonServiceCliRuntimeFromEnv({ targetMode: 'default-following' });
      const paths = resolveDaemonServicePaths(runtime);
      expectedServiceLabel = paths.label;
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
      writeDaemonStateImpl = writeDaemonState;

      writeDaemonState({
        pid: process.pid,
        httpPort: 43119,
        startedAt: Date.now(),
        startedWithCliVersion: '0.0.0-manual',
        startupSource: 'manual',
      });

      const output = captureStdoutJsonOutput<{
        ok: boolean;
        warning?: string;
      }>();
      try {
        await runDaemonServiceCliCommand({ argv: ['start', '--json', '--takeover'] });
        const payload = output.json();
        expect(payload.ok).toBe(true);
        expect(payload.warning).toContain('Taking over the current manual daemon');
        expect(stopDaemonMock).toHaveBeenCalledTimes(1);
      } finally {
        output.restore();
      }
    });
  });

  it('allows taking over a legacy manual daemon without startup metadata when starting a background service with --takeover', async () => {
    await withTempDir('happier-service-start-owner-legacy-takeover-', async (homeDir) => {
      stopDaemonMock.mockReset();
      let ownerWritten = false;
      let expectedServiceLabel = '';
      let writeDaemonStateImpl: ((state: DaemonLocallyPersistedState) => void) | null = null;
      const happierHomeDir = `${homeDir}/.happier`;
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
      });
      vi.resetModules();
      doMockChildProcessSpawnSync((command: string, args: readonly string[] = []) => {
        if (command === 'systemctl' && args.includes('is-active')) {
          return ownerWritten
            ? { status: 0, stdout: Buffer.from('active'), stderr: Buffer.from('') }
            : { status: 1, stdout: Buffer.from(''), stderr: Buffer.from('inactive') };
        }
        writeDaemonStateImpl?.({
          pid: process.pid,
          httpPort: 43123,
          startedAt: Date.now(),
          startedWithCliVersion: configuration.currentCliVersion,
          startupSource: 'background-service',
          serviceLabel: expectedServiceLabel,
        });
        ownerWritten = true;
        return { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
      });
      vi.doMock('./commandExistsInPath', () => ({
        commandExistsInPath: vi.fn(() => true),
      }));
      const controlClient = await import('@/daemon/controlClient');
      vi.spyOn(controlClient, 'stopDaemon').mockImplementation(stopDaemonMock);

      const [{ runDaemonServiceCliCommand, resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths }, { writeDaemonState }, { configuration }] = await Promise.all([
        loadCliModule(),
        import('@/persistence'),
        import('@/configuration'),
      ]);

      const runtime = resolveDaemonServiceCliRuntimeFromEnv({ targetMode: 'default-following' });
      const paths = resolveDaemonServicePaths(runtime);
      expectedServiceLabel = paths.label;
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
      writeDaemonStateImpl = writeDaemonState;

      await writeDaemonState({
        pid: process.pid,
        httpPort: 43124,
        startedAt: Date.now(),
        startedWithCliVersion: '0.0.0-manual',
        startedWithPublicReleaseChannel: 'stable',
        runtimeId: 'runtime-legacy-manual',
      });

      const output = captureStdoutJsonOutput<{
        ok: boolean;
        warning?: string;
      }>();
      try {
        await runDaemonServiceCliCommand({ argv: ['start', '--json', '--takeover'] });
        const payload = output.json();
        expect(payload.ok).toBe(true);
        expect(payload.warning).toContain('Taking over the current manual daemon');
        expect(stopDaemonMock).toHaveBeenCalledTimes(1);
      } finally {
        output.restore();
      }
    });
  });

  it('restores the manual daemon when service start takeover does not switch relay ownership', async () => {
    await withTempDir('happier-service-start-owner-takeover-postcondition-', async (homeDir) => {
      const happierHomeDir = `${homeDir}/.happier`;
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS: '200',
        HAPPIER_DAEMON_START_WAIT_POLL_MS: '10',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_TIMEOUT_MS: '300',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_POLL_MS: '10',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_STABLE_MS: '40',
      });
      vi.resetModules();
      doMockChildProcessSpawnSync(() => ({ status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') }));
      vi.doMock('./commandExistsInPath', () => ({
        commandExistsInPath: vi.fn(() => true),
      }));
      vi.doMock('@/daemon/restartDaemonAndWait', () => ({
        restartDaemonAndWait: restartDaemonAndWaitMock,
      }));

      const controlClient = await import('@/daemon/controlClient');
      vi.spyOn(controlClient, 'stopDaemon').mockImplementation(stopDaemonMock);

      const [{ runDaemonServiceCliCommand, resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths }, { writeDaemonState }] = await Promise.all([
        loadCliModule(),
        import('@/persistence'),
      ]);

      const runtime = resolveDaemonServiceCliRuntimeFromEnv({ targetMode: 'default-following' });
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

      writeDaemonState({
        pid: process.pid,
        httpPort: 43120,
        startedAt: Date.now(),
        startedWithCliVersion: '0.0.0-manual',
        startupSource: 'manual',
      });

      await expect(runDaemonServiceCliCommand({ argv: ['start', '--takeover'] })).rejects.toThrow(/did not become the active daemon/i);
      expect(stopDaemonMock).toHaveBeenCalledTimes(1);
      expect(restartDaemonAndWaitMock).toHaveBeenCalledTimes(1);
    });
  });

  it('allows restarting the currently owning background service label', async () => {
    await withTempDir('happier-service-restart-same-owner-', async (homeDir) => {
      const happierHomeDir = `${homeDir}/.happier`;
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'darwin',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
      });
      vi.resetModules();

      const [{ runDaemonServiceCliCommand, resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths }, { writeDaemonState }, { configuration }, { resolveDaemonServiceInstallRuntimeTarget }] = await Promise.all([
        loadCliModule(),
        import('@/persistence'),
        import('@/configuration'),
        import('./resolveDaemonServiceInstallRuntimeTarget'),
      ]);

      const runtime = resolveDaemonServiceCliRuntimeFromEnv({ targetMode: 'default-following' });
      const paths = resolveDaemonServicePaths(runtime);
      const installRuntimeTarget = await resolveDaemonServiceInstallRuntimeTarget({
        currentExecPath: process.execPath,
        explicitNodePath: process.env.HAPPIER_DAEMON_SERVICE_NODE_PATH ?? '',
        explicitEntryPath: process.env.HAPPIER_DAEMON_SERVICE_ENTRY_PATH ?? '',
        targetMode: runtime.targetMode,
        processEnv: process.env,
      });
      mkdirSync(dirname(paths.installedPath), { recursive: true });
      const expectedInstallPlan = planDaemonServiceInstall({
        platform: runtime.platform,
        channel: runtime.channel,
        targetMode: runtime.targetMode,
        instanceId: runtime.instanceId,
        uid: runtime.uid ?? undefined,
        userHomeDir: runtime.userHomeDir,
        happierHomeDir: runtime.happierHomeDir,
        serverUrl: runtime.serverUrl,
        webappUrl: runtime.webappUrl,
        publicServerUrl: runtime.publicServerUrl,
        nodePath: installRuntimeTarget.nodePath,
        entryPath: installRuntimeTarget.entryPath,
      });
      writeFileSync(paths.installedPath, expectedInstallPlan.files[0]?.content ?? '', 'utf-8');

      writeDaemonState({
        pid: process.pid,
        httpPort: 43117,
        startedAt: Date.now(),
        startedWithCliVersion: configuration.currentCliVersion,
        startedWithPublicReleaseChannel: 'stable',
        startupSource: 'background-service',
        serviceLabel: paths.label,
      });

      const output = captureStdoutJsonOutput<{
        ok: boolean;
        plan?: { commands: Array<{ cmd: string; args: string[] }> };
      }>();
      try {
        await runDaemonServiceCliCommand({ argv: ['restart', '--dry-run', '--json'] });
        const payload = output.json();
        expect(payload.ok).toBe(true);
        expect(payload.plan?.commands).toEqual([
          {
            cmd: 'launchctl',
            args: ['kickstart', '-k', `gui/${process.getuid?.() ?? 0}/${paths.label}`],
          },
        ]);
      } finally {
        output.restore();
      }
    });
  });

  it('treats an active wait-for-auth background service as a successful restart when the current relay has no credentials', async () => {
    await withTempDir('happier-service-restart-wait-for-auth-', async (homeDir) => {
      const happierHomeDir = `${homeDir}/.happier`;
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS: '50',
        HAPPIER_DAEMON_START_WAIT_POLL_MS: '10',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_TIMEOUT_MS: '120',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_POLL_MS: '10',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_STABLE_MS: '20',
      });
      vi.resetModules();
      vi.doMock('node:child_process', async (importOriginal) => {
        const actual = await importOriginal<typeof import('node:child_process')>();
        return {
          ...actual,
          spawnSync: vi.fn((command: string, args: readonly string[] = []) => {
            if (command === 'systemctl' && args.includes('is-active')) {
              return { status: 0, stdout: Buffer.from('active'), stderr: Buffer.from('') };
            }
            return { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
          }),
        };
      });
      vi.doMock('./commandExistsInPath', () => ({
        commandExistsInPath: vi.fn(() => true),
      }));

      const [{ runDaemonServiceCliCommand, resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths }, { clearDaemonStateForTests: clearDaemonState }] = await Promise.all([
        loadCliModule(),
        import('@/persistence'),
      ]);
      const runtime = resolveDaemonServiceCliRuntimeFromEnv({ targetMode: 'default-following' });
      const paths = resolveDaemonServicePaths(runtime);
      mkdirSync(dirname(paths.installedPath), { recursive: true });
      writeValidInstalledDaemonServiceFile(paths.installedPath);
      clearDaemonState();

      const output = captureStdoutJsonOutput<{ ok: boolean; platform: string }>();
      try {
        await runDaemonServiceCliCommand({ argv: ['restart', '--json'] });
        const payload = output.json();
        expect(payload.ok).toBe(true);
        expect(payload.platform).toBe('linux');
      } finally {
        output.restore();
      }
    });
  });
  it('plans starting the currently owning background service label with kickstart instead of rebootstrap', () => {
    const uid = process.getuid?.() ?? 501;
    const plan = planDaemonServiceLifecycle({
      platform: 'darwin',
      action: 'start',
      channel: 'stable',
      targetMode: 'default-following',
      instanceId: 'cloud',
      userHomeDir: '/Users/tester',
      uid,
      darwinStartMode: 'kickstart',
    });

    expect(plan.commands).toEqual([
      {
        cmd: 'launchctl',
        args: ['kickstart', '-k', `gui/${uid}/com.happier.cli.daemon.default`],
      },
    ]);
  });

  it('refreshes the darwin launch agent definition before starting an installed stopped service', async () => {
    await withTempDir('happier-service-start-darwin-refreshes-plist-', async (homeDir) => {
      const happierHomeDir = `${homeDir}/.happier`;
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'darwin',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_CHANNEL: '',
        HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
        HAPPIER_PUBLIC_RELEASE_CHANNEL: '',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_TIMEOUT_MS: '500',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_POLL_MS: '10',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_STABLE_MS: '20',
      });
      vi.resetModules();
      const originalArgv = process.argv;
      process.argv = [originalArgv[0] ?? 'node', 'happier'];

      let ownerWritten = false;
      let expectedServiceLabel = '';
      let writeDaemonStateImpl: ((state: DaemonLocallyPersistedState) => void) | null = null;
      let installedPath = '';
      let installedPathInitialMtimeMs = 0;
      doMockChildProcessSpawnSync((command: string, args: readonly string[] = []) => {
        if (command !== 'launchctl') {
          return { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
        }

        const action = String(args[0] ?? '');
        if (action === 'print') {
          return ownerWritten
            ? { status: 0, stdout: Buffer.from('state = running'), stderr: Buffer.from('') }
            : { status: 1, stdout: Buffer.from(''), stderr: Buffer.from('service not running') };
        }

        if (action === 'bootstrap') {
          const currentMtimeMs = existsSync(installedPath) ? statSync(installedPath).mtimeMs : 0;
          if (currentMtimeMs <= installedPathInitialMtimeMs) {
            return { status: 1, stdout: Buffer.from(''), stderr: Buffer.from('Bootstrap failed: 5: Input/output error') };
          }
          ownerWritten = true;
          writeDaemonStateImpl?.({
            pid: process.pid,
            httpPort: 43124,
            startedAt: Date.now(),
            startedWithCliVersion: configuration.currentCliVersion,
            startedWithPublicReleaseChannel: 'stable',
            startupSource: 'background-service',
            serviceLabel: expectedServiceLabel,
            runtimeId: 'runtime-service-start-darwin',
          });
          return { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
        }

        if (action === 'kickstart') {
          return { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
        }

        return { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
      });
      vi.doMock('./commandExistsInPath', () => ({
        commandExistsInPath: vi.fn(() => true),
      }));

      const [{ runDaemonServiceCliCommand, resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths }, { writeDaemonState }, { configuration }] = await Promise.all([
        loadCliModule(),
        import('@/persistence'),
        import('@/configuration'),
      ]);

      const runtime = resolveDaemonServiceCliRuntimeFromEnv({ targetMode: 'default-following' });
      const paths = resolveDaemonServicePaths(runtime);
      expectedServiceLabel = paths.label;
      installedPath = paths.installedPath;
      mkdirSync(dirname(paths.installedPath), { recursive: true });
      writeFileSync(
        paths.installedPath,
        buildLaunchdPlistXml({
          label: paths.label,
          programArgs: ['/Users/tester/.happier/cli/current/happier', 'daemon', 'start-sync'],
          env: {
            PATH: '/usr/bin:/bin',
            HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
            HAPPIER_DAEMON_SERVICE_LABEL: paths.label,
            HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
            HAPPIER_ACTIVE_SERVER_ID: 'cloud',
            HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
          },
          stdoutPath: `${happierHomeDir}/logs/daemon-service.out.log`,
          stderrPath: `${happierHomeDir}/logs/daemon-service.err.log`,
          workingDirectory: '/tmp',
        }),
        'utf-8',
      );
      installedPathInitialMtimeMs = statSync(paths.installedPath).mtimeMs;
      writeDaemonStateImpl = writeDaemonState;

      const output = captureStdoutJsonOutput<{
        ok: boolean;
        platform: string;
      }>();
      try {
        await runDaemonServiceCliCommand({ argv: ['start', '--json'] });
        const payload = output.json();
        expect(payload.ok).toBe(true);
        expect(payload.platform).toBe('darwin');
      } finally {
        output.restore();
      }
    });
  });

  it('treats installing the currently owning darwin background service as a no-op when the installed definition already matches', async () => {
    await withTempDir('happier-service-install-same-owner-', async (homeDir) => {
      const happierHomeDir = `${homeDir}/.happier`;
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'darwin',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_TIMEOUT_MS: '500',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_POLL_MS: '10',
        HAPPIER_DAEMON_SERVICE_OWNERSHIP_STABLE_MS: '20',
      });
      vi.resetModules();

      const launchctlCalls: string[] = [];
      doMockChildProcessSpawnSync((command: string, args: readonly string[] = []) => {
        if (command === 'launchctl') {
          launchctlCalls.push(args.join(' '));
          if (String(args[0] ?? '') === 'print') {
            return { status: 0, stdout: Buffer.from('state = running'), stderr: Buffer.from('') };
          }
        }
        return { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
      });
      vi.doMock('./commandExistsInPath', () => ({
        commandExistsInPath: vi.fn(() => true),
      }));
      const expectedDaemonState = {
        pid: process.pid,
        httpPort: 43129,
        startedAt: Date.now(),
        startedWithCliVersion: '',
        startedWithPublicReleaseChannel: 'stable' as const,
        startupSource: 'background-service' as const,
        serviceLabel: '',
      };
      vi.doMock('@/daemon/controlClient', async (importOriginal) => {
        const actual = await importOriginal<typeof import('@/daemon/controlClient')>();
        return {
          ...actual,
          inspectDaemonRunningStateAndCleanupStaleState: vi.fn(async () => ({
            status: 'running' as const,
            state: expectedDaemonState,
          })),
        };
      });

      const [{ runDaemonServiceCliCommand, resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths }, { writeDaemonState }, { configuration }, { resolveDaemonServiceInstallRuntimeTarget }] = await Promise.all([
        loadCliModule(),
        import('@/persistence'),
        import('@/configuration'),
        import('./resolveDaemonServiceInstallRuntimeTarget'),
      ]);

      const runtime = resolveDaemonServiceCliRuntimeFromEnv({ targetMode: 'default-following' });
      const paths = resolveDaemonServicePaths(runtime);
      const installRuntimeTarget = await resolveDaemonServiceInstallRuntimeTarget({
        currentExecPath: process.execPath,
        explicitNodePath: process.env.HAPPIER_DAEMON_SERVICE_NODE_PATH ?? '',
        explicitEntryPath: process.env.HAPPIER_DAEMON_SERVICE_ENTRY_PATH ?? '',
      });
      mkdirSync(dirname(paths.installedPath), { recursive: true });
      const expectedInstallPlan = planDaemonServiceInstall({
        platform: runtime.platform,
        channel: runtime.channel,
        targetMode: runtime.targetMode,
        instanceId: runtime.instanceId,
        uid: runtime.uid ?? undefined,
        userHomeDir: runtime.userHomeDir,
        happierHomeDir: runtime.happierHomeDir,
        serverUrl: runtime.serverUrl,
        webappUrl: runtime.webappUrl,
        publicServerUrl: runtime.publicServerUrl,
        nodePath: installRuntimeTarget.nodePath,
        entryPath: installRuntimeTarget.entryPath,
      });
      writeFileSync(paths.installedPath, expectedInstallPlan.files[0]?.content ?? '', 'utf-8');

      writeDaemonState({
        ...expectedDaemonState,
        startedAt: Date.now(),
        startedWithCliVersion: configuration.currentCliVersion,
        serviceLabel: paths.label,
      });
      expectedDaemonState.startedWithCliVersion = configuration.currentCliVersion;
      expectedDaemonState.serviceLabel = paths.label;

      const output = captureStdoutJsonOutput<{
        ok: boolean;
        platform: string;
      }>();
      try {
        await runDaemonServiceCliCommand({ argv: ['install', '--yes', '--json'] });
        expect(output.json()).toEqual(expect.objectContaining({ ok: true, platform: 'darwin' }));
      } finally {
        output.restore();
      }

      expect(launchctlCalls.some((call) => call.startsWith('bootstrap '))).toBe(false);
    });
  });

});
