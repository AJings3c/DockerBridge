import jwtDecode from "jwt-decode";
import { store } from "@/store/store";
import {
    authenticated,
    connectionChanged,
    infoReceived,
    loggedOut,
    sessionReady,
    setupRequired,
} from "@/store/sessionSlice";
import { endpointListReceived, endpointsDisconnected, endpointStatusReceived, runtimeCleared, stackListReceived, stackStatusesReceived, stackSyncFailed } from "@/store/runtimeSlice";
import { ApiResponse, EndpointConnectionStatus, StackSummary, UserPermission, UserRole } from "@/types/domain";
import { emitWithAck, realtime } from "./realtime/client";

interface JwtPayload {
    username?: string;
}

function storage() {
    return store.getState().session.remember ? localStorage : sessionStorage;
}

function usernameFromToken(token : string) {
    try {
        return jwtDecode<JwtPayload>(token).username || "管理员";
    } catch (error) {
        return "管理员";
    }
}

export function initializeSession() {
    realtime.on("connect", () => {
        store.dispatch(connectionChanged({ connected: true }));
        const token = storage().getItem("token");
        if (token && token !== "autoLogin") {
            void loginByToken(token);
        } else if (token === "autoLogin") {
            window.setTimeout(() => {
                if (!store.getState().session.loggedIn) {
                    storage().removeItem("token");
                    store.dispatch(sessionReady());
                }
            }, 5000);
        } else if (!token) {
            store.dispatch(sessionReady());
        }
    });
    realtime.on("disconnect", () => {
        store.dispatch(connectionChanged({ connected: false,
            error: "与运行服务的连接已中断，正在重连。" }));
        store.dispatch(endpointsDisconnected({ message: "与主运行服务的连接已中断" }));
    });
    realtime.on("connect_error", (error : unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        store.dispatch(connectionChanged({ connected: false,
            error: `无法连接运行服务：${message}`,
            initialized: true }));
    });
    realtime.on("setup", () => store.dispatch(setupRequired()));
    realtime.on("autoLogin", () => {
        localStorage.setItem("token", "autoLogin");
        store.dispatch(authenticated({ username: "管理员",
            role: "admin",
            permissions: [ "read", "operate", "destructive", "terminal", "settings", "users", "agents", "admin" ] }));
    });
    realtime.on("info", (info : unknown) => store.dispatch(infoReceived(info as Record<string, unknown>)));
    realtime.on("stackStatusList", (response : unknown) => {
        const data = response as { ok: boolean; stackStatusList: Record<string, number>; endpoint?: string };
        if (data.ok) {
            store.dispatch(stackStatusesReceived({ endpoint: typeof data.endpoint === "string" ? data.endpoint : "",
                statuses: data.stackStatusList }));
        }
    });
    realtime.on("agentStatus", (response : unknown) => {
        const data = response as { endpoint?: unknown; status?: unknown; changedAt?: unknown; lastSeenAt?: unknown; msg?: unknown };
        if (typeof data.endpoint !== "string" || ![ "connecting", "online", "offline" ].includes(String(data.status))) {
            return;
        }
        store.dispatch(endpointStatusReceived({
            endpoint: data.endpoint,
            status: data.status as EndpointConnectionStatus,
            changedAt: typeof data.changedAt === "string" ? data.changedAt : undefined,
            lastSeenAt: typeof data.lastSeenAt === "string" || data.lastSeenAt === null ? data.lastSeenAt : undefined,
            msg: typeof data.msg === "string" ? data.msg : undefined,
        }));
    });
    realtime.on("agentList", (response : unknown) => {
        const data = response as { ok?: unknown; agentList?: unknown; statusList?: unknown; generatedAt?: unknown };
        if (data.ok !== true || !data.agentList || typeof data.agentList !== "object") {
            return;
        }
        store.dispatch(endpointListReceived({
            agents: data.agentList as Record<string, { endpoint?: string; name?: string; url?: string }>,
            statuses: data.statusList && typeof data.statusList === "object" ? data.statusList as Record<string, { status?: EndpointConnectionStatus; changedAt?: string; lastSeenAt?: string | null; msg?: string }> : undefined,
            generatedAt: typeof data.generatedAt === "string" ? data.generatedAt : undefined,
        }));
    });
    realtime.on("agent", (event : unknown, payload : unknown) => {
        if (event === "stackListError") {
            const response = payload as { msg?: unknown; endpoint?: unknown };
            store.dispatch(stackSyncFailed({
                endpoint: typeof response.endpoint === "string" ? response.endpoint : "",
                message: typeof response.msg === "string" ? response.msg : "Compose 项目状态同步失败",
            }));
            return;
        }
        if (event !== "stackList") {
            return;
        }
        const response = payload as { ok: boolean; stackList: Record<string, StackSummary>; endpoint?: string };
        if (response.ok) {
            const stacks = Object.fromEntries(Object.entries(response.stackList).map(([ key, stack ]) => [ key, {
                ...stack,
                endpoint: response.endpoint || stack.endpoint || "",
            }]));
            const endpoint = typeof response.endpoint === "string" ? response.endpoint : Object.values(stacks)[0]?.endpoint || "";
            store.dispatch(stackListReceived({ endpoint,
                stacks,
                generatedAt: typeof response === "object" && response && "generatedAt" in response && typeof (response as { generatedAt?: unknown }).generatedAt === "string" ? (response as { generatedAt: string }).generatedAt : new Date().toISOString() }));
        }
    });
    realtime.on("refresh", () => window.location.reload());
    realtime.connect();
}

export async function login(username : string, password : string, token = "") {
    const response = await emitWithAck<ApiResponse & { token?: string; tokenRequired?: boolean; role?: UserRole; permissions?: UserPermission[] }>("login", {
        username,
        password,
        token,
    });
    if (response.ok && response.token) {
        storage().setItem("token", response.token);
        store.dispatch(authenticated({ username: usernameFromToken(response.token),
            role: response.role,
            permissions: response.permissions }));
    }
    return response;
}

export async function loginByToken(token : string) {
    const response = await emitWithAck<ApiResponse & { role?: UserRole; permissions?: UserPermission[] }>("loginByToken", token);
    if (response.ok) {
        store.dispatch(authenticated({ username: usernameFromToken(token),
            role: response.role,
            permissions: response.permissions }));
    } else {
        logout();
    }
    return response;
}

export async function setup(username : string, password : string) {
    return emitWithAck<ApiResponse>("setup", username, password);
}

export function logout() {
    realtime.emit("logout", () => undefined);
    localStorage.removeItem("token");
    sessionStorage.removeItem("token");
    store.dispatch(loggedOut());
    store.dispatch(runtimeCleared());
}
