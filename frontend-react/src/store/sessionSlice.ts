import { createSlice, PayloadAction } from "@reduxjs/toolkit";
import { UserPermission, UserRole } from "@/types/domain";

interface SessionState {
    connected: boolean;
    connecting: boolean;
    initialized: boolean;
    loggedIn: boolean;
    setupRequired: boolean;
    username: string;
    role: UserRole;
    permissions: UserPermission[];
    remember: boolean;
    connectionError: string;
    info: Record<string, unknown>;
}

const initialState : SessionState = {
    connected: false,
    connecting: true,
    initialized: false,
    loggedIn: false,
    setupRequired: false,
    username: "",
    role: "viewer",
    permissions: [],
    remember: localStorage.getItem("remember") !== "0",
    connectionError: "",
    info: {},
};

const sessionSlice = createSlice({
    name: "session",
    initialState,
    reducers: {
        connectionChanged(state, action : PayloadAction<{ connected: boolean; error?: string; initialized?: boolean }>) {
            state.connected = action.payload.connected;
            state.connecting = false;
            if (action.payload.initialized !== undefined) {
                state.initialized = action.payload.initialized;
            }
            state.connectionError = action.payload.error || "";
        },
        authenticated(state, action : PayloadAction<{ username?: string; role?: UserRole; permissions?: UserPermission[] }>) {
            state.loggedIn = true;
            state.initialized = true;
            state.setupRequired = false;
            state.username = action.payload.username || "管理员";
            state.role = action.payload.role || state.role;
            state.permissions = action.payload.permissions || state.permissions;
        },
        loggedOut(state) {
            state.loggedIn = false;
            state.initialized = true;
            state.username = "";
            state.role = "viewer";
            state.permissions = [];
        },
        setupRequired(state) {
            state.setupRequired = true;
            state.connecting = false;
            state.initialized = true;
        },
        sessionReady(state) {
            state.initialized = true;
        },
        rememberChanged(state, action : PayloadAction<boolean>) {
            state.remember = action.payload;
            localStorage.setItem("remember", action.payload ? "1" : "0");
        },
        infoReceived(state, action : PayloadAction<Record<string, unknown>>) {
            state.info = action.payload;
            if ([ "viewer", "operator", "admin" ].includes(String(action.payload.role))) {
                state.role = action.payload.role as UserRole;
            }
            if (Array.isArray(action.payload.permissions)) {
                state.permissions = action.payload.permissions.filter((permission): permission is UserPermission => [ "read", "operate", "destructive", "terminal", "settings", "users", "agents", "admin" ].includes(String(permission)));
            }
        },
    },
});

export const {
    authenticated,
    connectionChanged,
    infoReceived,
    loggedOut,
    rememberChanged,
    sessionReady,
    setupRequired,
} = sessionSlice.actions;
export default sessionSlice.reducer;
