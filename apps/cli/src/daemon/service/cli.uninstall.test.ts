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

  it('allows planning a background-service install takeover for a legacy manual relay owner with --takeover', async () => {
    await withTempDir('happier-service-install-owner-legacy-takeover-', async (homeDir) => {
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
        httpPort: 3008,
        startedAt: Date.now(),
        startedWithCliVersion: '0.0.0',
        startedWithPublicReleaseChannel: 'stable',
        runtimeId: 'runtime-legacy-takeover',
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

  it('fails closed when starting a daemon service that is not installed', async () => {
    const { runDaemonServiceCliCommand, resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths } = await loadCliModule();
    envScope.patch({
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
      HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '/tmp',
      HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: '/tmp/happier',
    });

    const output = captureStdoutJsonOutput<{
      ok: boolean;
      error: string;
      message: string;
    }>();
    try {
      await runDaemonServiceCliCommand({ argv: ['start', '--json'] });

      const payload = output.json();
      expect(payload.ok).toBe(false);
      expect(payload.error).toBe('not_installed');
      expect(payload.message).toContain('Background service is not installed');
    } finally {
      output.restore();
    }
  });

  it('fails closed when starting a daemon service whose installed file is invalid', async () => {
    await withTempDir('happier-service-start-invalid-installed-file-', async (homeDir) => {
      const happierHomeDir = `${homeDir}/.happier`;
      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
      });
      vi.resetModules();

      const { runDaemonServiceCliCommand, resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths } = await loadCliModule();
      const runtime = resolveDaemonServiceCliRuntimeFromEnv({ processEnv: process.env });
      const paths = resolveDaemonServicePaths(runtime);
      mkdirSync(dirname(paths.installedPath), { recursive: true });
      writeFileSync(paths.installedPath, '# installed background service', 'utf-8');

      const output = captureStderr();
      try {
        await runDaemonServiceCliCommand({ argv: ['start'] });
        expect(output.text()).toContain('Background service is not installed');
      } finally {
        output.restore();
      }
    });
  });

  it('reports that stopping the background service will not stop a manual daemon', async () => {
    await withTempDir('happier-service-stop-owner-note-', async (homeDir) => {
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

      const runtime = resolveDaemonServiceCliRuntimeFromEnv({ targetMode: 'default-following' });
      const paths = resolveDaemonServicePaths(runtime);
      mkdirSync(dirname(paths.installedPath), { recursive: true });
      writeValidInstalledDaemonServiceFile(paths.installedPath);

      writeDaemonState({
        pid: process.pid,
        httpPort: 43118,
        startedAt: Date.now(),
        startedWithCliVersion: '0.0.0-manual',
        startupSource: 'manual',
      });

      const output = captureStdoutJsonOutput<{
        ok: boolean;
        warning?: string;
      }>();
      try {
        await runDaemonServiceCliCommand({ argv: ['stop', '--dry-run', '--json'] });
        const payload = output.json();
        expect(payload.ok).toBe(true);
        expect(payload.warning).toContain('will not stop the current daemon');
        expect(payload.warning).toContain('happier daemon stop');
      } finally {
        output.restore();
      }
    });
  });

  it('uninstalls every discovered service when --all --yes is provided', async () => {
    const {
      runDaemonServiceCliCommand,
      resolveDaemonServiceCliRuntimeFromEnv,
      resolveDaemonServicePaths,
    } = await loadCliModule();
    await withConfiguredDaemonTestHome(
      {
        prefix: 'happier-daemon-service-uninstall-all-',
        env: {
          HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
          HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
          HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '',
          HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: '',
        },
      },
      async ({ homeDir }) => {
        process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR = homeDir;
        process.env.HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR = join(homeDir, '.happier');
        process.env.HAPPIER_DAEMON_SERVICE_CHANNEL = 'stable';
        await writeDaemonSettingsFixture(homeDir);

        const stableRuntime = resolveDaemonServiceCliRuntimeFromEnv({
          channel: 'stable',
          targetMode: 'pinned',
          instanceId: 'company',
        });
        const previewRuntime = resolveDaemonServiceCliRuntimeFromEnv({
          channel: 'preview',
          targetMode: 'pinned',
          instanceId: 'company',
        });
        const stableUnitPath = resolveDaemonServicePaths(stableRuntime).installedPath;
        const previewUnitPath = resolveDaemonServicePaths(previewRuntime).installedPath;
        await mkdir(dirname(stableUnitPath), { recursive: true });
        writeValidInstalledDaemonServiceFile(stableUnitPath, {
          activeServerId: 'company',
          releaseChannel: 'stable',
          targetMode: 'pinned',
        });
        writeValidInstalledDaemonServiceFile(previewUnitPath, {
          activeServerId: 'company',
          releaseChannel: 'preview',
          targetMode: 'pinned',
        });

        const output = captureStdoutJsonOutput<{
          ok: boolean;
          removed?: number;
        }>();
        try {
          await runDaemonServiceCliCommand({ argv: ['uninstall', '--all', '--yes', '--json'] });

          expect(output.json()).toEqual(expect.objectContaining({ ok: true, removed: 2 }));
          expect(existsSync(stableUnitPath)).toBe(false);
          expect(existsSync(previewUnitPath)).toBe(false);
        } finally {
          output.restore();
        }
      },
    );
  });

  it('respects an explicit linux service list mode filter', async () => {
    envScope.patch({
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
      HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '/tmp/happier-list-home',
      HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: '/tmp/happier-list-home/.happier',
    });
    vi.resetModules();

    const discoverInstalledDaemonServiceEntriesMock = vi.fn(async ({ mode }: { mode: 'user' | 'system' }) => {
      if (mode === 'system') {
        return [{
          serverId: 'company',
          name: 'Company',
          installed: true as const,
          path: '/etc/systemd/system/happier-daemon.company.service',
          platform: 'linux' as const,
          mode: 'system' as const,
          happierHomeDir: '/tmp/happier-list-home/.happier',
          releaseChannel: 'stable' as const,
          label: 'happier-daemon.company',
          targetMode: 'pinned' as const,
        }];
      }

      return [{
        serverId: 'cloud',
        name: 'Default background service',
        installed: true as const,
        path: '/tmp/happier-list-home/.config/systemd/user/happier-daemon.default.service',
        platform: 'linux' as const,
        mode: 'user' as const,
        happierHomeDir: '/tmp/happier-list-home/.happier',
        releaseChannel: 'preview' as const,
        label: 'happier-daemon.default',
        targetMode: 'default-following' as const,
      }];
    });

    vi.doMock('./discoverInstalledDaemonServiceEntries', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./discoverInstalledDaemonServiceEntries')>();
      return {
        ...actual,
        discoverInstalledDaemonServiceEntries: discoverInstalledDaemonServiceEntriesMock,
      };
    });

    const { runDaemonServiceCliCommand } = await loadCliModule();
    const output = captureStdoutJsonOutput<{
      entries: Array<{
        serverId: string;
        mode?: 'user' | 'system';
        path: string;
      }>;
    }>();

    try {
      await runDaemonServiceCliCommand({ argv: ['list', '--json', '--mode', 'system', '--system-user', 'happier'] });

      expect(discoverInstalledDaemonServiceEntriesMock).toHaveBeenCalledTimes(2);
      for (const call of discoverInstalledDaemonServiceEntriesMock.mock.calls) {
        expect(call[0]).toEqual(expect.objectContaining({ mode: 'system' }));
      }
      expect(output.json().entries).toEqual([
        expect.objectContaining({
          serverId: 'company',
          mode: 'system',
          path: '/etc/systemd/system/happier-daemon.company.service',
        }),
      ]);
    } finally {
      output.restore();
    }
  });

  it('builds uninstall --all plans across user and system services on linux when system mode is selected', async () => {
    envScope.patch({
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
      HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '/tmp/happier-uninstall-home',
      HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: '/tmp/happier-uninstall-home/.happier',
    });
    vi.spyOn(process as NodeJS.Process & { getuid: () => number }, 'getuid').mockReturnValue(0);
    vi.resetModules();

    const discoverInstalledDaemonServiceEntriesMock = vi.fn(async ({ mode }: { mode: 'user' | 'system' }) => {
      if (mode === 'system') {
        return [{
          serverId: 'company',
          name: 'Company',
          installed: true as const,
          path: '/etc/systemd/system/happier-daemon.company.legacy.service',
          platform: 'linux' as const,
          mode: 'system' as const,
          happierHomeDir: '/tmp/happier-uninstall-home/.happier',
          releaseChannel: 'stable' as const,
          label: 'happier-daemon.company',
          targetMode: 'pinned' as const,
        }];
      }

      return [{
        serverId: 'cloud',
        name: 'Default background service',
        installed: true as const,
        path: '/tmp/happier-uninstall-home/.config/systemd/user/happier-daemon.default.legacy.service',
        platform: 'linux' as const,
        mode: 'user' as const,
        happierHomeDir: '/tmp/happier-uninstall-home/.happier',
        releaseChannel: 'preview' as const,
        label: 'happier-daemon.default',
        targetMode: 'default-following' as const,
      }];
    });

    vi.doMock('./discoverInstalledDaemonServiceEntries', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./discoverInstalledDaemonServiceEntries')>();
      return {
        ...actual,
        discoverInstalledDaemonServiceEntries: discoverInstalledDaemonServiceEntriesMock,
      };
    });

    const { runDaemonServiceCliCommand } = await loadCliModule();
    const output = captureStdoutJsonOutput<{
      ok: boolean;
      removed: number;
      plans: Array<{
        filesToRemove: string[];
      }>;
    }>();

    try {
      await runDaemonServiceCliCommand({ argv: ['uninstall', '--all', '--dry-run', '--json', '--mode', 'system', '--system-user', 'happier'] });

      expect(discoverInstalledDaemonServiceEntriesMock).toHaveBeenCalledTimes(2);
      expect(output.json()).toEqual(expect.objectContaining({ ok: true, removed: 2 }));
      expect(output.json().plans).toEqual(expect.arrayContaining([
        expect.objectContaining({
          filesToRemove: expect.arrayContaining(['/tmp/happier-uninstall-home/.config/systemd/user/happier-daemon.default.legacy.service']),
        }),
        expect.objectContaining({
          filesToRemove: expect.arrayContaining(['/etc/systemd/system/happier-daemon.company.legacy.service']),
        }),
      ]));
    } finally {
      output.restore();
    }
  });

  it('passes the discovered installed path into uninstall --all execution', async () => {
    envScope.patch({
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
      HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '/tmp/happier-uninstall-runtime-home',
      HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: '/tmp/happier-uninstall-runtime-home/.happier',
    });
    vi.resetModules();

    const legacyUserUnitPath = '/tmp/happier-uninstall-runtime-home/.config/systemd/user/happier-daemon.default.legacy.service';
    const discoverInstalledDaemonServiceEntriesMock = vi.fn(async () => [{
      serverId: 'cloud',
      name: 'Default background service',
      installed: true as const,
      path: legacyUserUnitPath,
      platform: 'linux' as const,
      mode: 'user' as const,
      happierHomeDir: '/tmp/happier-uninstall-runtime-home/.happier',
      releaseChannel: 'stable' as const,
      label: 'happier-daemon.default',
      targetMode: 'default-following' as const,
    }]);

    vi.doMock('./discoverInstalledDaemonServiceEntries', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./discoverInstalledDaemonServiceEntries')>();
      return {
        ...actual,
        discoverInstalledDaemonServiceEntries: discoverInstalledDaemonServiceEntriesMock,
      };
    });
    doMockChildProcessSpawnSync(() => ({ status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') }));
    vi.doMock('./commandExistsInPath', () => ({
      commandExistsInPath: vi.fn(() => true),
    }));

    const { runDaemonServiceCliCommand } = await loadCliModule();
    mkdirSync(dirname(legacyUserUnitPath), { recursive: true });
    writeFileSync(legacyUserUnitPath, '[Unit]\nDescription=Legacy Happier\n', 'utf-8');

    const output = captureStdoutJsonOutput<{ ok: boolean; removed: number }>();
    try {
      await runDaemonServiceCliCommand({ argv: ['uninstall', '--all', '--yes', '--json'] });

      expect(output.json()).toEqual(expect.objectContaining({ ok: true, removed: 1 }));
      expect(existsSync(legacyUserUnitPath)).toBe(false);
    } finally {
      output.restore();
    }
  });

  it('builds user-mode uninstall plans from the invoking user home during system-mode cleanup', async () => {
    envScope.patch({
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
      HOME: '/root',
      SUDO_USER: 'sudo-user',
    });
    vi.spyOn(process as NodeJS.Process & { getuid: () => number }, 'getuid').mockReturnValue(0);
    vi.resetModules();
    vi.doMock('./resolveLinuxSystemUserPaths', async () => {
      const actual = await vi.importActual<typeof import('./resolveLinuxSystemUserPaths')>('./resolveLinuxSystemUserPaths');
      return {
        ...actual,
        resolveLinuxSystemUserPaths: vi.fn(({ systemUser }: { systemUser: string }) => ({
          userHomeDir: systemUser === 'happier' ? '/srv/happier' : '/home/sudo-user',
          happierHomeDir: systemUser === 'happier' ? '/srv/happier/.happier' : '/home/sudo-user/.happier',
        })),
      };
    });
    vi.doMock('./resolveDaemonServiceDiscoveryTargets', async () => {
      const actual = await vi.importActual<typeof import('./resolveDaemonServiceDiscoveryTargets')>('./resolveDaemonServiceDiscoveryTargets');
      return {
        ...actual,
        resolveDaemonServiceDiscoveryTargets: vi.fn(() => ([
          {
            mode: 'user',
            userHomeDir: '/home/sudo-user',
            happierHomeDir: '/home/sudo-user/.happier',
          },
          {
            mode: 'system',
            userHomeDir: '/srv/happier',
            happierHomeDir: '/srv/happier/.happier',
          },
        ])),
      };
    });

    const discoverInstalledDaemonServiceEntriesMock = vi.fn(async ({ mode }: { mode: 'user' | 'system' }) => {
      if (mode === 'system') {
        return [{
          serverId: 'company',
          name: 'Company',
          installed: true as const,
          path: '/etc/systemd/system/happier-daemon.company.service',
          platform: 'linux' as const,
          mode: 'system' as const,
          happierHomeDir: '/srv/happier/.happier',
          releaseChannel: 'stable' as const,
          label: 'happier-daemon.company',
          targetMode: 'pinned' as const,
        }];
      }

      return [{
        serverId: 'cloud',
        name: 'Default background service',
        installed: true as const,
        path: '/home/sudo-user/.config/systemd/user/happier-daemon.default.service',
        platform: 'linux' as const,
        mode: 'user' as const,
        happierHomeDir: '/home/sudo-user/.happier',
        releaseChannel: 'preview' as const,
        label: 'happier-daemon.default',
        targetMode: 'default-following' as const,
      }];
    });

    vi.doMock('./discoverInstalledDaemonServiceEntries', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./discoverInstalledDaemonServiceEntries')>();
      return {
        ...actual,
        discoverInstalledDaemonServiceEntries: discoverInstalledDaemonServiceEntriesMock,
      };
    });

    const { runDaemonServiceCliCommand } = await loadCliModule();
    const output = captureStdoutJsonOutput<{
      ok: boolean;
      removed: number;
      plans: Array<{
        filesToRemove: string[];
      }>;
    }>();

    try {
      await runDaemonServiceCliCommand({ argv: ['uninstall', '--all', '--dry-run', '--json', '--mode', 'system', '--system-user', 'happier'] });

      expect(output.json()).toEqual(expect.objectContaining({ ok: true, removed: 2 }));
      expect(output.json().plans).toEqual(expect.arrayContaining([
        expect.objectContaining({
          filesToRemove: expect.arrayContaining(['/home/sudo-user/.config/systemd/user/happier-daemon.default.service']),
        }),
        expect.objectContaining({
          filesToRemove: expect.arrayContaining(['/etc/systemd/system/happier-daemon.company.service']),
        }),
      ]));
    } finally {
      output.restore();
    }
  });
});
