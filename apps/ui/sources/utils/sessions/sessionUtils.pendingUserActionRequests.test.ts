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

describe('listPendingUserActionRequests', () => {
    it('does not return requests that are terminal in the transcript even if agentState.requests still contains them', async () => {
        const { listPendingUserActionRequests } = await import('./sessionUtils');
        const session = createBaseSession({
            id: 's-terminal-transcript',
            agentState: {
                controlledByUser: null,
                requests: {
                    req1: {
                        tool: 'AskUserQuestion',
                        kind: 'user_action',
                        arguments: { q: 'continue?' },
                        createdAt: 100,
                    },
                },
                completedRequests: null,
            },
        });

        expect(listPendingUserActionRequests(session, [
            {
                kind: 'tool-call',
                id: 'm-tool-1',
                localId: null,
                createdAt: 100,
                children: [],
                tool: {
                    id: 'req1',
                    name: 'AskUserQuestion',
                    state: 'error',
                    input: { q: 'continue?' },
                    createdAt: 100,
                    completedAt: 101,
                    permission: {
                        id: 'req1',
                        status: 'canceled',
                        kind: 'user_action',
                    },
                },
            } as any,
        ])).toEqual([]);
    });

    it('keeps requests pending when the transcript only shows a synthetic Request interrupted placeholder', async () => {
        const { listPendingUserActionRequests } = await import('./sessionUtils');
        const session = createBaseSession({
            id: 's-interrupted-transcript',
            agentState: {
                controlledByUser: null,
                requests: {
                    req1: {
                        tool: 'AskUserQuestion',
                        kind: 'user_action',
                        arguments: { q: 'continue?' },
                        createdAt: 100,
                    },
                },
                completedRequests: null,
            },
        });

        expect(listPendingUserActionRequests(session, [
            {
                kind: 'tool-call',
                id: 'm-tool-1',
                localId: null,
                createdAt: 100,
                children: [],
                tool: {
                    id: 'req1',
                    name: 'AskUserQuestion',
                    state: 'error',
                    input: { q: 'continue?' },
                    createdAt: 100,
                    completedAt: 101,
                    result: { error: 'Request interrupted' },
                    permission: {
                        id: 'req1',
                        status: 'canceled',
                        kind: 'user_action',
                        reason: 'Request interrupted',
                    },
                },
            } as any,
        ])).toEqual([
            expect.objectContaining({
                id: 'req1',
                tool: 'AskUserQuestion',
                kind: 'user_action',
                arguments: { q: 'continue?' },
                createdAt: 100,
            }),
        ]);
    });

    it('keeps requests pending when a local Request interrupted placeholder carries an abort decision', async () => {
        const { listPendingUserActionRequests } = await import('./sessionUtils');
        const session = createBaseSession({
            id: 's-aborted-transcript',
            agentState: {
                controlledByUser: null,
                requests: {
                    req1: {
                        tool: 'AskUserQuestion',
                        kind: 'user_action',
                        arguments: { q: 'continue?' },
                        createdAt: 100,
                    },
                },
                completedRequests: null,
            },
        });

        expect(listPendingUserActionRequests(session, [
            {
                kind: 'tool-call',
                id: 'm-tool-1',
                localId: null,
                createdAt: 100,
                children: [],
                tool: {
                    id: 'req1',
                    name: 'AskUserQuestion',
                    state: 'error',
                    input: { q: 'continue?' },
                    createdAt: 100,
                    completedAt: 101,
                    result: { error: 'Request interrupted' },
                    permission: {
                        id: 'req1',
                        status: 'canceled',
                        kind: 'user_action',
                        reason: 'Request interrupted',
                        decision: 'abort',
                    },
                },
            } as any,
        ])).toEqual([
            expect.objectContaining({
                id: 'req1',
                tool: 'AskUserQuestion',
                kind: 'user_action',
                arguments: { q: 'continue?' },
                createdAt: 100,
            }),
        ]);
    });
});
