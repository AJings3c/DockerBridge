import { EndpointSummary, StackSummary } from "@/types/domain";

export const STACK_STALE_AFTER_MS = 90_000;

export function endpointFor(endpoints : Record<string, EndpointSummary>, endpoint : string) : EndpointSummary {
    return endpoints[endpoint] || {
        endpoint,
        name: endpoint || "本机",
        url: "",
        status: endpoint ? "connecting" : "online",
        changedAt: "",
        lastSeenAt: null,
        message: "",
    };
}

export function isEndpointOperational(endpoints : Record<string, EndpointSummary>, endpoint : string) {
    return endpointFor(endpoints, endpoint).status === "online";
}

export function isStackStale(stack : StackSummary, now = Date.now()) {
    if (!stack.syncedAt) {
        return true;
    }
    const syncedAt = new Date(stack.syncedAt).getTime();
    return Number.isNaN(syncedAt) || now - syncedAt > STACK_STALE_AFTER_MS;
}

export function formatLastSeen(value : string | null) {
    if (!value) {
        return "尚未连通";
    }
    const time = new Date(value).getTime();
    if (Number.isNaN(time)) {
        return value;
    }
    const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
    if (seconds < 10) {
        return "刚刚";
    }
    if (seconds < 60) {
        return `${seconds} 秒前`;
    }
    if (seconds < 3600) {
        return `${Math.floor(seconds / 60)} 分钟前`;
    }
    if (seconds < 86400) {
        return `${Math.floor(seconds / 3600)} 小时前`;
    }
    return new Date(value).toLocaleString();
}
