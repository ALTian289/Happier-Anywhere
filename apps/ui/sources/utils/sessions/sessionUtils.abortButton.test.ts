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

describe('shouldShowAbortButtonForSessionState', () => {
    it('returns false for waiting (idle online) sessions', async () => {
        const { shouldShowAbortButtonForSessionState } = await import('./sessionUtils');
        expect(shouldShowAbortButtonForSessionState('waiting')).toBe(false);
    });

    it('returns true for thinking sessions', async () => {
        const { shouldShowAbortButtonForSessionState } = await import('./sessionUtils');
        expect(shouldShowAbortButtonForSessionState('thinking')).toBe(true);
    });

    it('returns true for permission_required sessions', async () => {
        const { shouldShowAbortButtonForSessionState } = await import('./sessionUtils');
        expect(shouldShowAbortButtonForSessionState('permission_required')).toBe(true);
    });

    it('returns true for action_required sessions', async () => {
        const { shouldShowAbortButtonForSessionState } = await import('./sessionUtils');
        expect(shouldShowAbortButtonForSessionState('action_required')).toBe(true);
    });

    it('returns false for disconnected sessions', async () => {
        const { shouldShowAbortButtonForSessionState } = await import('./sessionUtils');
        expect(shouldShowAbortButtonForSessionState('disconnected')).toBe(false);
    });

    it('returns false for resuming sessions before the provider process is attached', async () => {
        const { shouldShowAbortButtonForSessionState } = await import('./sessionUtils');
        expect(shouldShowAbortButtonForSessionState('resuming')).toBe(false);
    });

    it('returns false for background-only activity', async () => {
        const { shouldShowAbortButtonForSessionState } = await import('./sessionUtils');
        expect(shouldShowAbortButtonForSessionState('background_active')).toBe(false);
    });
});
