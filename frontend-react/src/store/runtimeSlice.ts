import { createSlice, PayloadAction } from "@reduxjs/toolkit";
import { DockerSnapshot, EndpointConnectionStatus, EndpointSummary, StackSummary } from "@/types/domain";

interface RuntimeState {
    stacks: Record<string, StackSummary>;
    endpoints: Record<string, EndpointSummary>;
    stackSyncErrors: Record<string, string>;
    stackSyncedAt: Record<string, string>;
    snapshot?: DockerSnapshot;
    loadingSnapshot: boolean;
    snapshotError: string;
}

interface StackListPayload {
    endpoint: string;
    stacks: Record<string, StackSummary>;
    generatedAt: string;
}

interface StackStatusPayload {
    endpoint: string;
    statuses: Record<string, number>;
}

interface EndpointStatusPayload {
    endpoint: string;
    status: EndpointConnectionStatus;
    changedAt?: string;
    lastSeenAt?: string | null;
    msg?: string;
}

interface EndpointListPayload {
    agents: Record<string, {
        endpoint?: string;
        name?: string;
        url?: string;
    }>;
    statuses?: Record<string, {
        status?: EndpointConnectionStatus;
        changedAt?: string;
        lastSeenAt?: string | null;
        msg?: string;
    }>;
    generatedAt?: string;
}

const initialState : RuntimeState = {
    stacks: {},
    endpoints: {},
    stackSyncErrors: {},
    stackSyncedAt: {},
    loadingSnapshot: false,
    snapshotError: "",
};

const runtimeSlice = createSlice({
    name: "runtime",
    initialState,
    reducers: {
        stackListReceived(state, action : PayloadAction<StackListPayload>) {
            for (const [ key, stack ] of Object.entries(state.stacks)) {
                if (stack.endpoint === action.payload.endpoint) {
                    delete state.stacks[key];
                }
            }
            for (const [ key, stack ] of Object.entries(action.payload.stacks)) {
                state.stacks[`${stack.name}_${stack.endpoint || key}`] = {
                    ...stack,
                    syncedAt: action.payload.generatedAt,
                };
            }
            const endpoint = state.endpoints[action.payload.endpoint];
            if (endpoint) {
                endpoint.lastSeenAt = action.payload.generatedAt;
            }
            state.stackSyncedAt[action.payload.endpoint] = action.payload.generatedAt;
            delete state.stackSyncErrors[action.payload.endpoint];
        },
        stackStatusesReceived(state, action : PayloadAction<StackStatusPayload>) {
            for (const stack of Object.values(state.stacks)) {
                if (stack.endpoint === action.payload.endpoint && action.payload.statuses[stack.name] !== undefined) {
                    stack.status = action.payload.statuses[stack.name];
                    stack.syncedAt = new Date().toISOString();
                }
            }
        },
        endpointListReceived(state, action : PayloadAction<EndpointListPayload>) {
            const generatedAt = action.payload.generatedAt || new Date().toISOString();
            const nextEndpoints : Record<string, EndpointSummary> = {};
            for (const [ key, agent ] of Object.entries(action.payload.agents)) {
                const endpoint = typeof agent.endpoint === "string" ? agent.endpoint : key;
                const status = action.payload.statuses?.[endpoint];
                nextEndpoints[endpoint] = {
                    endpoint,
                    name: agent.name || (endpoint ? endpoint : "本机"),
                    url: agent.url || "",
                    status: status?.status || (endpoint ? "connecting" : "online"),
                    changedAt: status?.changedAt || generatedAt,
                    lastSeenAt: status?.lastSeenAt ?? (endpoint ? null : generatedAt),
                    message: status?.msg || "",
                };
            }
            state.endpoints = nextEndpoints;
        },
        endpointStatusReceived(state, action : PayloadAction<EndpointStatusPayload>) {
            const existing = state.endpoints[action.payload.endpoint];
            const now = action.payload.changedAt || new Date().toISOString();
            state.endpoints[action.payload.endpoint] = {
                endpoint: action.payload.endpoint,
                name: existing?.name || (action.payload.endpoint ? action.payload.endpoint : "本机"),
                url: existing?.url || "",
                status: action.payload.status,
                changedAt: now,
                lastSeenAt: action.payload.lastSeenAt !== undefined
                    ? action.payload.lastSeenAt
                    : action.payload.status === "online" ? now : existing?.lastSeenAt || null,
                message: action.payload.msg || "",
            };
        },
        endpointsDisconnected(state, action : PayloadAction<{ changedAt?: string; message?: string } | undefined>) {
            const changedAt = action.payload?.changedAt || new Date().toISOString();
            for (const endpoint of Object.values(state.endpoints)) {
                endpoint.status = "offline";
                endpoint.changedAt = changedAt;
                endpoint.message = action.payload?.message || "Control-plane connection closed";
            }
        },
        stackSyncFailed(state, action : PayloadAction<{ endpoint: string; message: string }>) {
            state.stackSyncErrors[action.payload.endpoint] = action.payload.message;
        },
        snapshotLoading(state) {
            state.loadingSnapshot = true;
            state.snapshotError = "";
        },
        snapshotReceived(state, action : PayloadAction<DockerSnapshot>) {
            state.snapshot = action.payload;
            state.loadingSnapshot = false;
        },
        snapshotFailed(state, action : PayloadAction<string>) {
            state.loadingSnapshot = false;
            state.snapshotError = action.payload;
        },
        runtimeCleared() {
            return initialState;
        },
    },
});

export const {
    runtimeCleared,
    endpointListReceived,
    endpointStatusReceived,
    endpointsDisconnected,
    snapshotFailed,
    snapshotLoading,
    snapshotReceived,
    stackListReceived,
    stackSyncFailed,
    stackStatusesReceived,
} = runtimeSlice.actions;
export default runtimeSlice.reducer;
