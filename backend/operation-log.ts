import { R } from "redbean-node";
import { log } from "./log";
import { DockgeSocket } from "./util-server";

interface OperationLogEntry {
    actionType: string;
    objectType: string;
    objectId: string;
    before?: unknown;
    after?: unknown;
    result: "success" | "failed" | "skipped";
    error?: unknown;
    socket?: DockgeSocket;
    startedAt?: number;
}

const SENSITIVE_KEY_PATTERN = /(?:^|[._-])(password|passwd|secret|token|credential|authorization|cookie|api[_-]?key|private[_-]?key)(?:$|[._-])/i;
const ENV_KEY_PATTERN = /^(?:[A-Za-z_][A-Za-z0-9_]*)(?:=|$)/;

function isSensitiveKey(key : string) {
    const normalized = key.replace(/[A-Z]/g, character => `-${character.toLowerCase()}`);
    return [ "env", "environment", "compose-env", "global-env" ].includes(normalized)
        || SENSITIVE_KEY_PATTERN.test(normalized);
}

function redactText(value : string) {
    return value
        .replace(/(https?:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, "$1<redacted>:<redacted>@")
        .replace(/((?:authorization|proxy-authorization|cookie|set-cookie)\s*:\s*)[^\r\n]+/gi, "$1<redacted>")
        .replace(/([?&](?:password|passwd|secret|token|credential|authorization|cookie|api[_-]?key|private[_-]?key)=)[^&#\s]*/gi, "$1<redacted>")
        .replace(/((?:["']?)(?:password|passwd|secret|token|credential|authorization|cookie|api[_-]?key|private[_-]?key)(?:["']?\s*[=:]\s*))("[^"]*"|'[^']*'|[^\s,;\]}]+)/gi, "$1<redacted>");
}

export function sanitizeOperationLogValue(value : unknown, key = "", seen = new WeakSet<object>()) : unknown {
    if (typeof value === "string") {
        if (key.toLowerCase() === "env" || key.toLowerCase() === "environment" || key.toLowerCase() === "composeenv" || key.toLowerCase() === "globalenv") {
            return ENV_KEY_PATTERN.test(value) ? `${value.split("=", 1)[0]}=<redacted>` : "<redacted>";
        }
        return redactText(value);
    }

    if (value === null || typeof value !== "object") {
        return value;
    }

    if (seen.has(value)) {
        return "<circular>";
    }
    seen.add(value);

    if (Array.isArray(value)) {
        if (key.toLowerCase() === "env" || key.toLowerCase() === "environment" || key.toLowerCase() === "composeenv" || key.toLowerCase() === "globalenv") {
            const result = value.map(item => typeof item === "string" && ENV_KEY_PATTERN.test(item)
                ? `${item.split("=", 1)[0]}=<redacted>`
                : "<redacted>");
            seen.delete(value);
            return result;
        }
        const result = value.map(item => sanitizeOperationLogValue(item, key, seen));
        seen.delete(value);
        return result;
    }

    const result : Record<string, unknown> = {};
    for (const [ childKey, childValue ] of Object.entries(value)) {
        result[childKey] = isSensitiveKey(childKey)
            ? "<redacted>"
            : sanitizeOperationLogValue(childValue, childKey, seen);
    }
    seen.delete(value);
    return result;
}

function errorMessage(error : unknown) {
    if (error instanceof Error) {
        return error.message;
    }
    return error == null ? null : String(error);
}

export async function writeOperationLog(entry : OperationLogEntry) {
    let actor : string | null = null;
    if (entry.socket?.userID) {
        const user = await R.knex("user").select("username").where("id", entry.socket.userID).first();
        actor = user?.username ? String(user.username) : null;
    }

    await R.knex("dockerbridge_operation_log").insert({
        time: new Date().toISOString(),
        action_type: entry.actionType,
        object_type: entry.objectType,
        object_id: entry.objectId,
        before_json: entry.before == null ? null : JSON.stringify(sanitizeOperationLogValue(entry.before)),
        after_json: entry.after == null ? null : JSON.stringify(sanitizeOperationLogValue(entry.after)),
        result: entry.result,
        error: entry.error == null ? null : redactText(errorMessage(entry.error) || ""),
        actor,
        endpoint: entry.socket?.endpoint || "local",
        duration_ms: entry.startedAt == null ? null : Math.max(0, Date.now() - entry.startedAt),
    });
}

export async function safelyWriteOperationLog(entry : OperationLogEntry) {
    try {
        await writeOperationLog(entry);
    } catch (error) {
        log.warn("operation-log", `Failed to persist ${entry.actionType}: ${errorMessage(error) || "unknown error"}`);
    }
}
