import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import {
    CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
    CLAUDE_LOCAL_PERMISSION_BRIDGE_STOPPED_REASON,
} from '@happier-dev/agents';
import { installSessionUtilsCommonModuleMocks } from './sessionUtilsTestHelpers';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { StorageState } from '@/sync/store/types';

type MockStorageState = {
    sessionMessages: Record<string, { messages: unknown[]; messagesVersion?: number }>;
    sessions?: Record<string, unknown>;
    machines?: Record<string, unknown>;
    settings?: Record<string, unknown>;
    getProjectForSession?: (sessionId: string) => { key?: { machineId?: string; path?: string } } | null;
};

const mockStorageState: MockStorageState = {
    sessionMessages: {},
    sessions: {},
    machines: {},
    getProjectForSession: () => null,
};
const readMockStorageState = () => mockStorageState as unknown as StorageState;
const useSessionSpy = vi.hoisted(() => vi.fn((id: string) => (mockStorageState.sessions?.[id] as Session | null | undefined) ?? null));
const useSessionMessagesVersionSpy = vi.hoisted(() => vi.fn((id: string) => mockStorageState.sessionMessages[id]?.messagesVersion ?? 0));

installSessionUtilsCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string) => key,
        });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            storage: {
                getState: () => mockStorageState,
                setState: (updater: ((state: typeof mockStorageState) => typeof mockStorageState) | typeof mockStorageState) => {
                    const next = typeof updater === 'function' ? updater(mockStorageState) : updater;
                    mockStorageState.sessionMessages = next.sessionMessages;
                },
            },
            useSession: useSessionSpy,
            useSessionMessagesVersion: useSessionMessagesVersionSpy,
            useSetting: ((key: string) => mockStorageState.settings?.[key]) as ReturnType<typeof createStorageModuleStub>['useSetting'],
        });
    },
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                status: {
                    connected: '#11AA11',
                    connecting: '#2222AA',
                    actionRequired: '#AA7722',
                    disconnected: '#666666',
                    error: '#CC3333',
                    default: '#555555',
                },
            },
        },
    });
});

afterEach(() => {
    standardCleanup();
});

beforeEach(async () => {
    vi.resetModules();
    mockStorageState.sessionMessages = {};
    mockStorageState.sessions = {};
    mockStorageState.machines = {};
    mockStorageState.settings = {};
    mockStorageState.getProjectForSession = () => null;
    useSessionSpy.mockClear();
    useSessionMessagesVersionSpy.mockClear();
    const { registerStorageStateReader } = await import('@/sync/domains/state/storageStateReaderBridge');
    registerStorageStateReader(readMockStorageState);
});

function createBaseSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 's1',
        seq: 1,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        runtimeActivityState: 'idle',
        runtimeActivityRevision: 0,
        runtimeActivityActiveCount: 0,
        runtimeActivityObservedAt: null,
        ...overrides,
    };
}

describe('getSessionName', () => {
    it('prefers metadata summary text over other fallbacks', async () => {
        const { getSessionName } = await import('./sessionUtils');
        const session = createBaseSession({
            metadata: {
                path: '/tmp/worktree',
                host: 'mac',
                name: 'Stored Name',
                summary: {
                    text: 'Summary Title',
                    updatedAt: 1,
                },
            },
        });
        expect(getSessionName(session)).toBe('Summary Title');
    });

    it('prefers the Codex native name for a linked direct Codex session', async () => {
        const { getSessionName } = await import('./sessionUtils');
        const session = createBaseSession({
            metadata: {
                path: '/tmp/worktree',
                host: 'mac',
                flavor: 'codex',
                name: 'Codex Desktop Title',
                summary: {
                    text: 'Title Derived From The First Prompt',
                    updatedAt: 1,
                },
                directSessionV1: {
                    v: 1,
                    providerId: 'codex',
                    machineId: 'machine-1',
                    remoteSessionId: 'thread-1',
                    source: { kind: 'codexHome', home: 'user' },
                },
            } as Session['metadata'],
        });

        expect(getSessionName(session)).toBe('Codex Desktop Title');
    });

    it('prefers the Codex native name for the compact session-list representation', async () => {
        const { getSessionName } = await import('./sessionUtils');
        const { buildSessionListRenderableMetadata } = await import('@/sync/domains/session/listing/sessionListRenderable');
        const metadata = {
            path: '/tmp/worktree',
            host: 'mac',
            flavor: 'codex',
            name: 'Codex Desktop Title',
            summary: {
                text: 'Title Derived From The First Prompt',
                updatedAt: 1,
            },
            directSessionV1: {
                v: 1,
                providerId: 'codex',
                machineId: 'machine-1',
                remoteSessionId: 'thread-1',
                source: { kind: 'codexHome', home: 'user' },
            },
        } as Session['metadata'];
        const session = {
            id: 'session-list-row-1',
            metadata: buildSessionListRenderableMetadata(metadata),
        } as any;

        expect(getSessionName(session)).toBe('Codex Desktop Title');
    });

    it('ignores a raw Codex remote-session id used as a fallback name', async () => {
        const { getSessionName } = await import('./sessionUtils');
        const session = createBaseSession({
            metadata: {
                path: '/tmp/worktree',
                host: 'mac',
                flavor: 'codex',
                name: 'thread-1',
                summary: {
                    text: 'Readable Happier Summary',
                    updatedAt: 1,
                },
                directSessionV1: {
                    v: 1,
                    providerId: 'codex',
                    machineId: 'machine-1',
                    remoteSessionId: 'thread-1',
                    source: { kind: 'codexHome', home: 'user' },
                },
            } as Session['metadata'],
        });

        expect(getSessionName(session)).toBe('Readable Happier Summary');

        const { buildSessionListRenderableMetadata } = await import('@/sync/domains/session/listing/sessionListRenderable');
        const listSession = {
            id: session.id,
            metadata: buildSessionListRenderableMetadata(session.metadata),
        } as any;
        expect(getSessionName(listSession)).toBe('Readable Happier Summary');
    });

    it('keeps the Happier summary authoritative for other direct-session providers', async () => {
        const { getSessionName } = await import('./sessionUtils');
        const session = createBaseSession({
            metadata: {
                path: '/tmp/worktree',
                host: 'mac',
                flavor: 'claude',
                name: 'Claude Candidate Title',
                summary: {
                    text: 'Happier Summary Title',
                    updatedAt: 1,
                },
                directSessionV1: {
                    v: 1,
                    providerId: 'claude',
                    machineId: 'machine-1',
                    remoteSessionId: 'claude-1',
                    source: { kind: 'claudeConfig', configDir: '/tmp', projectId: 'project-1' },
                },
            } as Session['metadata'],
        });

        expect(getSessionName(session)).toBe('Happier Summary Title');
    });

    it('falls back to metadata name before path segments', async () => {
        const { getSessionName } = await import('./sessionUtils');
        const session = createBaseSession({
            metadata: {
                path: '/tmp/worktree',
                host: 'mac',
                name: 'Linked Direct Session',
            },
        });
        expect(getSessionName(session)).toBe('Linked Direct Session');
    });

    it('uses the stable display target path when path-derived names are stale after explicit replacement', async () => {
        const { getSessionName } = await import('./sessionUtils');
        const session = createBaseSession({
            id: 'session-1',
            active: false,
            metadata: {
                machineId: 'machine-old',
                path: '/Users/test/workspace/stale-name',
                homeDir: '/Users/test',
                host: 'stale.local',
            } as Session['metadata'],
        });

        mockStorageState.sessions = {
            'session-1': {
                active: false,
                updatedAt: 10,
                metadata: session.metadata,
            },
        };
        mockStorageState.machines = {
                'machine-old': {
                    id: 'machine-old',
                    active: false,
                    activeAt: 1,
                    replacedByMachineId: 'machine-target',
                    replacedAt: 11,
                    replacementReason: 'manual_repair',
                    replacementSource: 'manual',
                    metadata: { host: 'stale.local' },
                },
                'machine-target': {
                    id: 'machine-target',
                    active: true,
                    activeAt: 20,
                    metadata: { host: 'target.local' },
            },
        };
        mockStorageState.getProjectForSession = (sessionId: string) =>
            sessionId === 'session-1'
                ? {
                    key: {
                        machineId: 'machine-target',
                        path: '/Users/test/workspace/live-name',
                    },
                }
                : null;

        expect(getSessionName(session)).toBe('live-name');
    });
});
