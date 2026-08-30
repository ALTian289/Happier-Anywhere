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

describe('useSessionStatus', () => {
    it('refreshes when fresh thinking expires without a storage update', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        try {
            const { useSessionStatus, SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS } = await import('./sessionUtils');
            const thinkingAt = Date.now() - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS + 5;
            const hook = await renderHook(() => useSessionStatus(createBaseSession({
                thinking: true,
                thinkingAt,
            })));

            expect(hook.getCurrent().state).toBe('thinking');

            await flushHookEffects({ cycles: 1, turns: 0, advanceTimersMs: 5 });

            expect(hook.getCurrent().state).toBe('waiting');
        } finally {
            vi.useRealTimers();
        }
    });

    it('refreshes when a fresh in-progress projection expires without a storage update', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        try {
            const { useSessionStatus, SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS } = await import('./sessionUtils');
            const latestTurnStatusObservedAt = Date.now() - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS + 5;
            const hook = await renderHook(() => useSessionStatus(createBaseSession({
                thinking: false,
                latestTurnStatus: 'in_progress',
                latestTurnStatusObservedAt,
            })));

            expect(hook.getCurrent().state).toBe('thinking');

            await flushHookEffects({ cycles: 1, turns: 0, advanceTimersMs: 5 });

            expect(hook.getCurrent().state).toBe('waiting');
        } finally {
            vi.useRealTimers();
        }
    });

    it('refreshes when fresh active heartbeat extends a stale in-progress projection without a storage update', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        try {
            const { useSessionStatus, SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS } = await import('./sessionUtils');
            const activeAt = Date.now() - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS + 5;
            const hook = await renderHook(() => useSessionStatus(createBaseSession({
                activeAt,
                thinking: true,
                latestTurnStatus: 'in_progress',
                latestTurnStatusObservedAt: Date.now() - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
            })));

            expect(hook.getCurrent().state).toBe('thinking');

            await flushHookEffects({ cycles: 1, turns: 0, advanceTimersMs: 5 });

            expect(hook.getCurrent().state).toBe('waiting');
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not show working when only meaningful activity follows a stale in-progress projection', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        try {
            const { useSessionStatus, SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS } = await import('./sessionUtils');
            const hook = await renderHook(() => useSessionStatus(createBaseSession({
                activeAt: Date.now() - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
                thinking: false,
                latestTurnStatus: 'in_progress',
                latestTurnStatusObservedAt: Date.now() - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
                meaningfulActivityAt: Date.now() - 5,
            })));

            expect(hook.getCurrent().state).toBe('waiting');
        } finally {
            vi.useRealTimers();
        }
    });

    it('refreshes when fresh thinking extends a stale in-progress projection', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        try {
            const { useSessionStatus, SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS } = await import('./sessionUtils');
            const thinkingAt = Date.now() - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS + 5;
            const hook = await renderHook(() => useSessionStatus(createBaseSession({
                thinking: true,
                thinkingAt,
                latestTurnStatus: 'in_progress',
                latestTurnStatusObservedAt: Date.now() - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - 1_000,
            })));

            expect(hook.getCurrent().state).toBe('thinking');

            await flushHookEffects({ cycles: 1, turns: 0, advanceTimersMs: 5 });

            expect(hook.getCurrent().state).toBe('waiting');
        } finally {
            vi.useRealTimers();
        }
    });

    it('refreshes when a fresh pending request expires without a storage update', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        try {
            const { useSessionStatus, SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS } = await import('./sessionUtils');
            const createdAt = Date.now() - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS + 5;
            const hook = await renderHook(() => useSessionStatus(createBaseSession({
                agentState: {
                    controlledByUser: null,
                    requests: {
                        req1: { tool: 'Bash', arguments: {}, createdAt },
                    },
                    completedRequests: null,
                },
            })));

            expect(hook.getCurrent().state).toBe('permission_required');

            await flushHookEffects({ cycles: 1, turns: 0, advanceTimersMs: 5 });

            expect(hook.getCurrent().state).toBe('waiting');
        } finally {
            vi.useRealTimers();
        }
    });

    it('uses the raw session state when a renderable session still has stale pending flags', async () => {
        const { useSessionStatus } = await import('./sessionUtils');

        mockStorageState.sessions = {
            's-renderable-stale': createBaseSession({
                id: 's-renderable-stale',
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
            }),
        };
        mockStorageState.sessionMessages = {
            's-renderable-stale': {
                messages: [
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
                    },
                ],
                messagesVersion: 1,
            },
        };

        const hook = await renderHook(() => useSessionStatus({
            id: 's-renderable-stale',
            seq: 1,
            createdAt: 0,
            updatedAt: 0,
            active: true,
            activeAt: 0,
            archivedAt: null,
            pendingVersion: 0,
            pendingCount: 0,
            metadataVersion: 0,
            agentStateVersion: 0,
            metadata: null,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
            accessLevel: undefined,
            canApprovePermissions: undefined,
            hasPendingPermissionRequests: false,
            hasPendingUserActionRequests: true,
        } as any));

        expect(hook.getCurrent().state).toBe('waiting');
    });

    it('can skip transcript-version subscriptions for session-list rows', async () => {
        const { useSessionStatus } = await import('./sessionUtils');

        const hook = await renderHook(() => useSessionStatus(createBaseSession({
            id: 's-list-row',
            active: true,
            thinking: true,
            thinkingAt: Date.now(),
            presence: 'online',
        }), { subscribeToTranscript: false }));

        expect(hook.getCurrent().state).toBe('thinking');
        expect(useSessionMessagesVersionSpy).toHaveBeenCalledWith('s-list-row', false);
    });

    it('can skip full-session subscriptions for session-list rows', async () => {
        const { useSessionStatus } = await import('./sessionUtils');

        mockStorageState.sessions = {
            's-list-row': createBaseSession({
                id: 's-list-row',
                active: true,
                thinking: true,
                thinkingAt: 1_000,
                updatedAt: 1_000,
                presence: 'online',
            }),
        };

        const hook = await renderHook(() => useSessionStatus(createBaseSession({
            id: 's-list-row',
            active: true,
            thinking: false,
            thinkingAt: 0,
            updatedAt: 0,
            presence: 'online',
        }), {
            subscribeToSession: false,
            subscribeToTranscript: false,
        }));

        expect(hook.getCurrent().state).toBe('waiting');
        expect(useSessionSpy).toHaveBeenCalledWith('');
        expect(useSessionMessagesVersionSpy).toHaveBeenCalledWith('s-list-row', false);
    });
});
