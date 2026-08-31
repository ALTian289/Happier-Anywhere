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
    // The module's collaborators read the mutable mocks below at call time, so the
    // module graph can stay shared across cases. Rebuilding the full UI graph for
    // every test retains enough transformed modules to exhaust the CI heap.
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

describe('getSessionStatus', () => {
    it('exports the shared runtime status freshness budget and helper', async () => {
        const statusModule = await import('./sessionUtils');

        expect(statusModule.SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS).toBe(120_000);
        expect(statusModule.isFreshTimestamp(880_001, 1_000_000, statusModule.SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS)).toBe(true);
        expect(statusModule.isFreshTimestamp(880_000, 1_000_000, statusModule.SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS)).toBe(false);
        expect(statusModule.isFreshTimestamp(null, 1_000_000, statusModule.SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS)).toBe(false);
    });

    it('returns disconnected when presence is not online', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const session = createBaseSession({ presence: 123 });
        const status = getSessionStatus(session, 1_000, 0);
        expect(status.state).toBe('disconnected');
        expect(status.isConnected).toBe(false);
        expect(status.shouldShowStatus).toBe(true);
    });

    it('surfaces a retained live terminal host whose session control endpoint is unservable', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const session = createBaseSession({
            active: false,
            presence: 123,
            metadata: {
                path: '/repo',
                host: 'local',
                terminal: {
                    mode: 'tmux',
                    tmux: { target: 'happy:win-1' },
                    controlServiceabilityV1: {
                        v: 1,
                        state: 'recoverable_unservable',
                        observedAt: 456,
                        reason: 'session_rpc_unavailable',
                    },
                },
            },
        });
        const status = getSessionStatus(session, 1_000, 0);
        expect(status.state).toBe('recoverable_unservable');
        expect(status.isConnected).toBe(false);
        expect(status.statusText).toBe('status.disconnected');
        expect(status.shouldShowStatus).toBe(true);
    });

    it('formats last-seen without throwing when activeAt is missing or invalid', async () => {
        const { formatLastSeen } = await import('./sessionUtils');

        // Sessions can reach the disconnected status line without a usable
        // activeAt; the formatter must degrade instead of crashing the row.
        expect(() => formatLastSeen(undefined as unknown as number)).not.toThrow();
        expect(() => formatLastSeen(Number.NaN)).not.toThrow();
        expect(() => formatLastSeen(0)).not.toThrow();
        expect(typeof formatLastSeen(undefined as unknown as number)).toBe('string');
        expect(formatLastSeen(undefined as unknown as number).length).toBeGreaterThan(0);
    });

    it('returns permission_required when the agent has pending requests', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const now = 1_000_000;
        const session = createBaseSession({
            thinking: true,
            thinkingAt: now - 1_000,
            agentState: {
                controlledByUser: null,
                requests: {
                    req1: { tool: 'tool', arguments: {}, createdAt: null },
                },
                completedRequests: null,
            },
        });
        const status = getSessionStatus(session, now, 0);
        expect(status.state).toBe('permission_required');
        expect(status.isConnected).toBe(true);
        expect(status.shouldShowStatus).toBe(true);
    });

    it('returns permission_required when pending transcript requests only exist in the registered storage state', async () => {
        const { registerStorageStateReader } = await import('@/sync/domains/state/storageStateReaderBridge');
        const { getSessionStatus } = await import('./sessionUtils');
        const now = 1_000_000;
        registerStorageStateReader(readMockStorageState);
        mockStorageState.sessionMessages = {
            s1: {
                messages: [
                    {
                        kind: 'tool-call',
                        id: 'm-tool-1',
                        localId: null,
                        createdAt: 10,
                        children: [],
                        tool: {
                            id: 'req1',
                            name: 'writeTextFile',
                            state: 'running',
                            input: { path: '/tmp/test.txt' },
                            createdAt: 10,
                            permission: {
                                id: 'req1',
                                status: 'pending',
                                kind: 'permission',
                            },
                        },
                    },
                ],
                messagesVersion: 1,
            },
        };
        const session = createBaseSession({
            thinking: true,
            thinkingAt: now - 1_000,
            agentState: {
                controlledByUser: null,
                requests: {},
                completedRequests: null,
            },
        });

        const status = getSessionStatus(session, now, 0);

        expect(status.state).toBe('permission_required');
        expect(status.isConnected).toBe(true);
    });

    it('does not surface permission_required when a session is inactive (even if stale pending flags exist)', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const status = getSessionStatus({
            id: 's-renderable',
            seq: 1,
            createdAt: 0,
            updatedAt: 0,
            active: false,
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
            runtimeActivityState: 'idle',
            runtimeActivityRevision: 0,
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: null,
            accessLevel: undefined,
            canApprovePermissions: undefined,
            hasPendingPermissionRequests: true,
            hasPendingUserActionRequests: false,
        } as any, 1_000, 0);

        expect(status.state).toBe('waiting');
    });

    it('returns action_required when the agent has pending user-action requests', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const now = 1_000_000;
        const session = createBaseSession({
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: now - 1_000,
            agentState: {
                controlledByUser: null,
                requests: {
                    req1: { tool: 'AskUserQuestion', kind: 'user_action', arguments: { q: 'x' }, createdAt: 1 },
                },
                completedRequests: null,
            },
        });
        const status = getSessionStatus(session, now, 0);
        expect(status.state).toBe('action_required');
        expect(status.isConnected).toBe(true);
        expect(status.shouldShowStatus).toBe(true);
    });

    it('does not surface action_required when a session is inactive (even if stale pending flags exist)', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const status = getSessionStatus({
            id: 's-renderable',
            seq: 1,
            createdAt: 0,
            updatedAt: 0,
            active: false,
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
            runtimeActivityState: 'idle',
            runtimeActivityRevision: 0,
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: null,
            accessLevel: undefined,
            canApprovePermissions: undefined,
            hasPendingPermissionRequests: false,
            hasPendingUserActionRequests: true,
        } as any, 1_000, 0);

        expect(status.state).toBe('waiting');
    });

    it('returns resuming for inactive sessions with an optimistic prompt even when presence is stale online', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const status = getSessionStatus(createBaseSession({
            active: false,
            presence: 'online',
            optimisticThinkingAt: 1_000,
        }), 1_100, 0);

        expect(status.state).toBe('resuming');
        expect(status.statusText).toBe('session.resuming');
        expect(status.isPulsing).toBe(true);
    });

    it('does not return permission_required when agentState.requests is stale relative to completedRequests', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const session = createBaseSession({
            agentState: {
                controlledByUser: null,
                requests: {
                    req1: { tool: 'Bash', arguments: { command: 'ls' }, createdAt: 100 },
                },
                completedRequests: {
                    req1: {
                        tool: 'Bash',
                        arguments: { command: 'ls' },
                        createdAt: 100,
                        completedAt: 200,
                        status: 'canceled',
                        reason: null,
                        mode: null,
                        allowedTools: null,
                        decision: null,
                    },
                },
            },
        });
        const status = getSessionStatus(session, 1_000, 0);
        expect(status.state).toBe('waiting');
    });

    it('does not return action_required when a user-action request is stale relative to completedRequests', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const session = createBaseSession({
            agentState: {
                controlledByUser: null,
                requests: {
                    req1: {
                        tool: 'ExitPlanMode',
                        kind: 'user_action',
                        arguments: { plan: 'Use the approved plan.' },
                        createdAt: 100,
                    },
                },
                completedRequests: {
                    req1: {
                        tool: 'ExitPlanMode',
                        arguments: { plan: 'Use the approved plan.' },
                        createdAt: 100,
                        completedAt: 200,
                        status: 'approved',
                        reason: null,
                        mode: null,
                        allowedTools: null,
                        decision: 'approved',
                    },
                },
            },
        });

        const status = getSessionStatus(session, 1_000, 0);
        expect(status.state).toBe('waiting');
    });

    it('does not return action_required when a generated local-bridge request is covered by a recent canonical bridge cancellation', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const question = {
            questions: [{
                question: 'remote-dev is complete + live-validated (9/9 QA). How do you want to proceed?',
                header: 'Next step',
                options: [{ label: 'Review remote-dev first', description: 'Pause here.' }],
            }],
        };
        const session = createBaseSession({
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 11_000,
            agentState: {
                controlledByUser: null,
                requests: {
                    'perm_generated': {
                        tool: 'AskUserQuestion',
                        kind: 'user_action',
                        arguments: question,
                        createdAt: 10_500,
                        source: CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
                    },
                },
                completedRequests: {
                    'toolu_canonical': {
                        tool: 'AskUserQuestion',
                        kind: 'user_action',
                        arguments: question,
                        createdAt: 1_000,
                        completedAt: 10_000,
                        status: 'canceled',
                        reason: CLAUDE_LOCAL_PERMISSION_BRIDGE_STOPPED_REASON,
                        source: CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
                    },
                },
            } as any,
        });

        const status = getSessionStatus(session, 11_000, 0);

        expect(status.state).toBe('thinking');
    });

    it('does not return action_required when transcript marks the same request as canceled', async () => {
        const { registerStorageStateReader } = await import('@/sync/domains/state/storageStateReaderBridge');
        const { getSessionStatus, listPendingUserActionRequests } = await import('./sessionUtils');
        registerStorageStateReader(readMockStorageState);
        const session = createBaseSession({
            id: 's-transcript-canceled',
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

        mockStorageState.sessionMessages = {
            's-transcript-canceled': {
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

        expect(listPendingUserActionRequests(session)).toEqual([]);

        const status = getSessionStatus(session, 1_000, 0);
        expect(status.state).toBe('waiting');
    });

    it('returns thinking when session.thinking is true', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const now = 1_000_000;
        const session = createBaseSession({ thinking: true, thinkingAt: now - 1_000 });
        const status = getSessionStatus(session, now, 0);
        expect(status.state).toBe('thinking');
        expect(status.isConnected).toBe(true);
        expect(status.statusText).toBe('accomplishing…');
        expect(status.shouldShowStatus).toBe(true);
        expect(status.isPulsing).toBe(true);
    });

    it('returns thinking when the latest primary turn is in progress', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const now = 1_000_000;
        const session = createBaseSession({
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: now - 1_000,
            thinking: false,
        });
        const status = getSessionStatus(session, now, 0);
        expect(status.state).toBe('thinking');
        expect(status.isConnected).toBe(true);
        expect(status.shouldShowStatus).toBe(true);
        expect(status.isPulsing).toBe(true);
    });

    it('does not keep stale thinking state after a completed primary turn projection', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const session = {
            ...createBaseSession({
                latestTurnStatus: 'completed',
                thinking: true,
                meaningfulActivityAt: 500,
            }),
            latestTurnStatusObservedAt: 1_000,
        };
        const status = getSessionStatus(session, 1_000, 0);
        expect(status.state).toBe('waiting');
        expect(status.shouldShowStatus).toBe(false);
    });

    it('does not use legacy thinking after an older completed turn projection', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const session = {
            ...createBaseSession({
                active: true,
                presence: 'online',
                thinking: true,
                thinkingAt: 1_500,
                latestTurnStatus: 'completed',
            }),
            latestTurnStatusObservedAt: 1_000,
        };
        const status = getSessionStatus(session, 1_600, 0);
        expect(status.state).toBe('waiting');
        expect(status.shouldShowStatus).toBe(false);
    });

    it('does not show working when completed terminal projection has newer meaningful activity', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const session = {
            ...createBaseSession({
                active: true,
                presence: 'online',
                meaningfulActivityAt: 1_500,
                thinking: false,
                latestTurnStatus: 'completed',
            }),
            latestTurnStatusObservedAt: 1_000,
        };
        const status = getSessionStatus(session, 1_600, 0);
        expect(status.state).toBe('waiting');
        expect(status.shouldShowStatus).toBe(false);
    });

    it('does not falsely show resuming for a finished idle session whose heartbeat crept past its last event', async () => {
        // Regression: previously "resuming" was derived by comparing the creeping presence
        // heartbeat (activeAt) against frozen event timestamps, so an idle-online session that
        // had already finished flipped into a false "resuming". With the explicit lifecycle
        // marker, no resume was initiated -> resumingAt is absent -> never resuming.
        const { getSessionStatus } = await import('./sessionUtils');
        const now = 1_000_000;
        const activeAt = now - 10_000;
        const session = createBaseSession({
            active: true,
            activeAt,
            presence: 'online',
            latestTurnStatus: 'failed',
            latestTurnStatusObservedAt: activeAt - 50_000,
            meaningfulActivityAt: activeAt - 50_000,
            latestReadyEventAt: activeAt - 45_000,
        });

        const status = getSessionStatus(session, now, 0);

        expect(status.state).toBe('waiting');
    });

    it('shows resuming for the whole resume window from an explicit resume marker', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const now = 1_000_000;
        const session = createBaseSession({
            active: true,
            activeAt: now - 10_000,
            presence: 'online',
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: now - 60_000,
            resumingAt: now - 5_000,
        });

        const status = getSessionStatus(session, now, 0);

        expect(status.state).toBe('resuming');
        expect(status.statusText).toBe('session.resuming');
        expect(status.shouldShowStatus).toBe(true);
        expect(status.isPulsing).toBe(true);
    });

    it('lets a fresh explicit resuming marker take precedence over ordinary offline presence', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const now = 1_000_000;
        const session = createBaseSession({
            active: false,
            presence: now - 2_000,
            resumingAt: now - 1_000,
        });

        const status = getSessionStatus(session, now, 0);

        expect(status.state).toBe('resuming');
        expect(status.statusText).toBe('session.resuming');
        expect(status.isConnected).toBe(true);
        expect(status.isPulsing).toBe(true);
    });

    it('keeps ordinary offline precedence once an explicit resuming marker is stale', async () => {
        const { getSessionStatus, SESSION_RESUMING_PRESENTATION_TIMEOUT_MS } = await import('./sessionUtils');
        const now = 1_000_000;
        const session = createBaseSession({
            active: false,
            presence: now - 2_000,
            resumingAt: now - SESSION_RESUMING_PRESENTATION_TIMEOUT_MS - 1,
        });

        const status = getSessionStatus(session, now, 0);

        expect(status.state).toBe('disconnected');
        expect(status.isConnected).toBe(false);
    });

    it('stops showing resuming once the explicit marker has decayed past its bounded lifetime', async () => {
        const { getSessionStatus, SESSION_RESUMING_PRESENTATION_TIMEOUT_MS } = await import('./sessionUtils');
        const now = 1_000_000;
        const session = createBaseSession({
            active: true,
            activeAt: now - 10_000,
            presence: 'online',
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: now - 60_000,
            resumingAt: now - SESSION_RESUMING_PRESENTATION_TIMEOUT_MS - 1,
        });

        const status = getSessionStatus(session, now, 0);

        expect(status.state).toBe('waiting');
    });

    it('does not treat inactive post-terminal activity as active work', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const session = {
            ...createBaseSession({
                active: false,
                presence: 'online',
                meaningfulActivityAt: 1_500,
                thinking: false,
                latestTurnStatus: 'completed',
            }),
            latestTurnStatusObservedAt: 1_000,
        };
        const status = getSessionStatus(session, 1_600, 0);
        expect(status.state).toBe('waiting');
    });

    it('does not keep stale thinking state after a completed primary turn projection without observation time', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const session = createBaseSession({
            latestTurnStatus: 'completed',
            thinking: true,
        });
        const status = getSessionStatus(session, 1_000, 0);
        expect(status.state).toBe('waiting');
        expect(status.shouldShowStatus).toBe(false);
    });

    it('does not show working for stale thinking even when active and online', async () => {
        const { getSessionStatus, SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS } = await import('./sessionUtils');
        const now = 1_000_000;
        const session = createBaseSession({
            active: true,
            presence: 'online',
            thinking: true,
            thinkingAt: now - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS,
        });

        const status = getSessionStatus(session, now, 0);

        expect(status.state).toBe('waiting');
        expect(status.shouldShowStatus).toBe(false);
    });

    it('does not use legacy thinking after an older failed turn projection', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const now = 1_000_000;
        const session = createBaseSession({
            latestTurnStatus: 'failed',
            latestTurnStatusObservedAt: now - 2_000,
            thinking: true,
            thinkingAt: now - 1_000,
        });

        const status = getSessionStatus(session, now, 0);

        expect(status.state).toBe('waiting');
        expect(status.shouldShowStatus).toBe(false);
    });

    it('does not show working for stale in-progress projection without fresh thinking', async () => {
        const { getSessionStatus, SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS } = await import('./sessionUtils');
        const now = 1_000_000;
        const session = createBaseSession({
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: now - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS,
            thinking: false,
            thinkingAt: 0,
        });

        const status = getSessionStatus(session, now, 0);

        expect(status.state).toBe('waiting');
        expect(status.shouldShowStatus).toBe(false);
    });

    it('uses fresh thinking when in-progress projection is stale', async () => {
        const { getSessionStatus, SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS } = await import('./sessionUtils');
        const now = 1_000_000;
        const session = createBaseSession({
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: now - SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS,
            thinking: true,
            thinkingAt: now - 1_000,
        });

        const status = getSessionStatus(session, now, 0);

        expect(status.state).toBe('thinking');
        expect(status.shouldShowStatus).toBe(true);
    });

    it('does not show actionable permission state for stale active online pending flags', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const status = getSessionStatus({
            id: 's-renderable',
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
            runtimeActivityState: 'idle',
            runtimeActivityRevision: 0,
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: null,
            accessLevel: undefined,
            canApprovePermissions: undefined,
            hasPendingPermissionRequests: true,
            hasPendingUserActionRequests: false,
        }, 1_000_000, 0);

        expect(status.state).toBe('waiting');
    });

    it('returns static translated working text when animated working status text is disabled', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const now = 1_000_000;
        const session = createBaseSession({ thinking: true, thinkingAt: now - 1_000 });
        const status = getSessionStatus(session, now, {
            vibingIndex: 0,
            workingTextMode: 'static',
        });

        expect(status.state).toBe('thinking');
        expect(status.statusText).toBe('status.working');
    });

    it('uses the neutral status color token for background-active runtime status', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const now = 1_000_000;
        const status = getSessionStatus(createBaseSession({
            activeAt: now - 10_000,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: now - 5_000,
            runtimeActivityState: 'active',
            runtimeActivityRevision: 1,
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: now - 1_000,
        }), now, {
            workingTextMode: 'static',
            statusColors: {
                connected: 'connected-token',
                connecting: 'working-token',
                actionRequired: 'action-token',
                disconnected: 'disconnected-token',
                error: 'error-token',
                default: 'default-token',
            },
        });

        expect(status.state).toBe('background_active');
        expect(status.statusText).toBe('status.backgroundActive');
        expect(status.statusColor).toBe('default-token');
        expect(status.statusDotColor).toBe('default-token');
        expect(status.isPulsing).toBe(false);
    });

    it('keeps projected unknown activity quiet', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const now = 1_000_000;
        const status = getSessionStatus(createBaseSession({
            active: true,
            presence: 'online',
            thinking: false,
            runtimeActivityState: 'unknown',
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: null,
            runtimeActivityRevision: 9,
        }), now, { workingTextMode: 'static' });

        expect(status).toMatchObject({
            state: 'waiting',
            statusText: 'status.online',
            shouldShowStatus: false,
        });
    });

    it('keeps an incomplete activity projection quiet', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const now = 1_000_000;
        const status = getSessionStatus(createBaseSession({
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: now - 5_000,
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: now - 180_000,
        }), now, 0);

        expect(status).toMatchObject({
            state: 'waiting',
            shouldShowStatus: false,
        });
    });

    it('keeps actionable user attention ahead of explicit unknown activity', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const now = 1_000_000;
        const status = getSessionStatus(createBaseSession({
            active: true,
            presence: 'online',
            runtimeActivityState: 'unknown',
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: null,
            runtimeActivityRevision: 9,
            agentState: {
                controlledByUser: false,
                requests: {
                    req1: {
                        tool: 'AskUserQuestion',
                        kind: 'user_action',
                        arguments: {},
                        createdAt: now - 1_000,
                    },
                },
                completedRequests: null,
            },
        }), now, { workingTextMode: 'static' });

        expect(status.state).toBe('action_required');
    });

    it('keeps offline precedence over projected background activity', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const status = getSessionStatus(createBaseSession({
            active: false,
            presence: 900_000,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: 850_000,
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: 800_000,
            runtimeActivityRevision: 10,
        }), 1_000_000, { workingTextMode: 'static' });

        expect(status).toMatchObject({
            state: 'disconnected',
            isConnected: false,
        });
    });

    it('suppresses background activity status for archived sessions', async () => {
        const { getSessionStatus } = await import('./sessionUtils');

        expect(getSessionStatus(createBaseSession({
            archivedAt: 900_000,
            resumingAt: 999_000,
            pendingUserActionRequestCount: 1,
            pendingRequestObservedAt: 999_000,
            latestTurnStatus: 'completed',
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 1,
        }), 1_000_000, { workingTextMode: 'static' })).toMatchObject({
            state: 'waiting',
            shouldShowStatus: false,
        });
    });

    it('uses the account setting to disable animated working text in the status hook', async () => {
        mockStorageState.settings = {
            sessionListWorkingStatusAnimatedTextEnabled: false,
        };
        const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000);
        const { useSessionStatus } = await import('./sessionUtils');
        const session = createBaseSession({ thinking: true, thinkingAt: 999 });

        const hook = await renderHook(() => useSessionStatus(session));

        expect(hook.getCurrent().state).toBe('thinking');
        expect(hook.getCurrent().statusText).toBe('status.working');
        nowSpy.mockRestore();
    });

    it('uses the current theme status colors in the status hook', async () => {
        const { useSessionStatus } = await import('./sessionUtils');
        const hook = await renderHook(() => useSessionStatus(createBaseSession({
            thinking: true,
            thinkingAt: Date.now(),
        })));

        expect(hook.getCurrent()).toMatchObject({
            state: 'thinking',
            statusColor: '#2222AA',
            statusDotColor: '#2222AA',
            isPulsing: true,
        });
    });

    it('does not show working from optimisticThinkingAt without fresh runtime evidence', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const now = 1_000_000;
        const session = createBaseSession({ optimisticThinkingAt: now - 1_000 });
        const status = getSessionStatus(session, now, 0);
        expect(status.state).toBe('waiting');
    });

    it('keeps offline precedence over recent optimistic send activity', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const now = 1_000_000;
        const session = createBaseSession({
            active: false,
            presence: now - 10_000,
            optimisticThinkingAt: now - 1_000,
        });
        const status = getSessionStatus(session, now, 0);
        expect(status.state).toBe('disconnected');
        expect(status.isConnected).toBe(false);
        expect(status.shouldShowStatus).toBe(true);
        expect(status.isPulsing).toBeUndefined();
    });

    it('does not treat stale optimisticThinkingAt as thinking', async () => {
        const { getSessionStatus, OPTIMISTIC_SESSION_THINKING_TIMEOUT_MS } = await import('./sessionUtils');
        const now = 1_000_000;
        const session = createBaseSession({ optimisticThinkingAt: now - OPTIMISTIC_SESSION_THINKING_TIMEOUT_MS - 1 });
        const status = getSessionStatus(session, now, 0);
        expect(status.state).toBe('waiting');
    });

    it('does not treat optimisticThinkingAt exactly at timeout as thinking', async () => {
        const { getSessionStatus, OPTIMISTIC_SESSION_THINKING_TIMEOUT_MS } = await import('./sessionUtils');
        const now = 1_000_000;
        const session = createBaseSession({ optimisticThinkingAt: now - OPTIMISTIC_SESSION_THINKING_TIMEOUT_MS });
        const status = getSessionStatus(session, now, 0);
        expect(status.state).toBe('waiting');
    });

    it('does not show working from thinkingGraceUntil without fresh runtime evidence', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const now = 1_000_000;
        const session = createBaseSession({ thinkingGraceUntil: now + 1_000 });
        const status = getSessionStatus(session, now, 0);
        expect(status.state).toBe('waiting');
    });

    it('does not treat thinkingGraceUntil in the past as thinking', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const now = 1_000_000;
        const session = createBaseSession({ thinkingGraceUntil: now - 1 });
        const status = getSessionStatus(session, now, 0);
        expect(status.state).toBe('waiting');
    });

    it('prioritizes permission_required over thinking state', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const now = 1_000_000;
        const session = createBaseSession({
            thinking: true,
            thinkingAt: now - 1_000,
            agentState: {
                controlledByUser: false,
                requests: {
                    req1: { tool: 'tool', arguments: {}, createdAt: null },
                },
                completedRequests: null,
            },
        });
        const status = getSessionStatus(session, now, 0);
        expect(status.state).toBe('permission_required');
    });

    it('prioritizes action_required over thinking state', async () => {
        const { getSessionStatus } = await import('./sessionUtils');
        const now = 1_000_000;
        const session = createBaseSession({
            thinking: true,
            thinkingAt: now - 1_000,
            agentState: {
                controlledByUser: false,
                requests: {
                    req1: { tool: 'AskUserQuestion', kind: 'user_action', arguments: {}, createdAt: 1 },
                },
                completedRequests: null,
            },
        });
        const status = getSessionStatus(session, now, 0);
        expect(status.state).toBe('action_required');
    });
});
