import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { buildCodexAgentRuntimeDescriptor } from '@happier-dev/agents';
import { describe, expect, it } from 'vitest';

import { withTempDir } from '@/testkit/fs/tempDir';

import {
    createCodexAppServerProcessEnv,
    writeFakeCodexAppServerScript,
} from '../testkit/fakeCodexAppServer';

async function importControlClientModule(): Promise<{
    withCodexAppServerControlClient?: unknown;
}> {
    return await import('./withCodexAppServerControlClient').catch(() => ({}));
}

describe('withCodexAppServerControlClient', () => {
    it('returns unsupported without spawning Codex when the session is not app-server backed', async () => {
        const module = await importControlClientModule();
        expect(module.withCodexAppServerControlClient).toBeTypeOf('function');

        const result = await (module.withCodexAppServerControlClient as (params: {
            cwd: string;
            metadata: Record<string, unknown>;
            processEnv: NodeJS.ProcessEnv;
            run: () => Promise<string>;
        }) => Promise<unknown>)({
            cwd: process.cwd(),
            metadata: {
                agentRuntimeDescriptorV1: buildCodexAgentRuntimeDescriptor({
                    backendMode: 'mcp',
                    vendorSessionId: 'thread-1',
                }),
            },
            processEnv: {
                ...process.env,
                HAPPIER_CODEX_APP_SERVER_BIN: join(process.cwd(), 'missing-codex-app-server'),
            },
            run: async () => 'unexpected',
        });

        expect(result).toEqual({
            ok: false,
            errorCode: 'unsupported_codex_app_server_control',
            error: 'unsupported_codex_app_server_control',
        });
    });

    it('applies the short-lived control timeout while running the app-server callback', async () => {
        await withTempDir('happier-codex-app-server-control-timeout-', async (root) => {
            const fakeAppServer = await writeFakeCodexAppServerScript({
                dir: root,
                bodyLines: [
                    'for await (const line of rl) {',
                    '  if (!line.trim()) continue;',
                    '  const msg = JSON.parse(line);',
                    '  if (msg.method === "initialize") {',
                    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake", version: "0.0.0" } } }) + "\\n");',
                    '    continue;',
                    '  }',
                    '  if (msg.method === "initialized") continue;',
                    '  if (msg.method === "thread/list") {',
                    '    setTimeout(() => {',
                    '      process.stdout.write(JSON.stringify({ id: msg.id, result: { data: [{ id: "thread-1" }], nextCursor: null } }) + "\\n");',
                    '    }, 550);',
                    '    continue;',
                    '  }',
                    '  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
                    '}',
                ],
            });
            const module = await importControlClientModule();
            expect(module.withCodexAppServerControlClient).toBeTypeOf('function');

            const result = await (module.withCodexAppServerControlClient as (params: {
                cwd: string;
                timeoutMs: number;
                metadata: Record<string, unknown>;
                processEnv: NodeJS.ProcessEnv;
                run: (client: { request: (method: string, params?: unknown) => Promise<unknown> }) => Promise<unknown>;
            }) => Promise<unknown>)({
                cwd: root,
                timeoutMs: 1_500,
                metadata: {
                    agentRuntimeDescriptorV1: buildCodexAgentRuntimeDescriptor({
                        backendMode: 'appServer',
                        vendorSessionId: 'thread-1',
                    }),
                },
                processEnv: createCodexAppServerProcessEnv(fakeAppServer, {
                    HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '250',
                }),
                run: async (client) => await client.request('thread/list', { archived: false }),
            });

            expect(result).toEqual({
                ok: true,
                value: { data: [{ id: 'thread-1' }], nextCursor: null },
            });
        });
    });

    it('disposes the app-server client when the callback throws', async () => {
        await withTempDir('happier-codex-app-server-control-dispose-', async (root) => {
            const requestLogPath = join(root, 'requests.jsonl');
            const fakeAppServer = await writeFakeCodexAppServerScript({
                dir: root,
                importLines: ['import { appendFileSync } from "node:fs";'],
                setupLines: [
                    `const requestLogPath = ${JSON.stringify(requestLogPath)};`,
                    'process.on("exit", () => appendFileSync(requestLogPath, JSON.stringify({ event: "exit" }) + "\\n"));',
                    'process.on("SIGTERM", () => { appendFileSync(requestLogPath, JSON.stringify({ event: "sigterm" }) + "\\n"); process.exit(0); });',
                ],
                bodyLines: [
                    'for await (const line of rl) {',
                    '  if (!line.trim()) continue;',
                    '  const msg = JSON.parse(line);',
                    '  appendFileSync(requestLogPath, JSON.stringify({ method: msg.method }) + "\\n");',
                    '  if (msg.method === "initialize") {',
                    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake", version: "0.0.0" } } }) + "\\n");',
                    '    continue;',
                    '  }',
                    '  if (msg.method === "initialized") continue;',
                    '  if (msg.method === "thread/list") {',
                    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { data: [] } }) + "\\n");',
                    '    continue;',
                    '  }',
                    '}',
                ],
            });
            const module = await importControlClientModule();
            expect(module.withCodexAppServerControlClient).toBeTypeOf('function');

            await expect((module.withCodexAppServerControlClient as (params: {
                cwd: string;
                metadata: Record<string, unknown>;
                processEnv: NodeJS.ProcessEnv;
                run: (client: { request: (method: string, params?: unknown) => Promise<unknown> }) => Promise<unknown>;
            }) => Promise<unknown>)({
                cwd: root,
                metadata: {
                    agentRuntimeDescriptorV1: buildCodexAgentRuntimeDescriptor({
                        backendMode: 'appServer',
                        vendorSessionId: 'thread-1',
                    }),
                },
                processEnv: createCodexAppServerProcessEnv(fakeAppServer),
                run: async (client) => {
                    await client.request('thread/list');
                    throw new Error('callback failed');
                },
            })).rejects.toThrow('callback failed');

            await appendFile(requestLogPath, '');
            const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
            expect(requestLog).toEqual(expect.arrayContaining([
                { method: 'initialize' },
                { method: 'initialized' },
                { method: 'thread/list' },
                { event: 'exit' },
            ]));
        });
    });
});
