import { SocketIoTransport } from "./socketIoTransport";
import { RealtimeTransport } from "./types";

export const realtime : RealtimeTransport = new SocketIoTransport();

const ACK_TIMEOUT_MS = 120000;

export function emitWithAck<T>(event : string, ...args : unknown[]) : Promise<T> {
    return emitWithAckTimeout<T>(ACK_TIMEOUT_MS, event, ...args);
}

export function emitWithAckTimeout<T>(timeoutMs : number, event : string, ...args : unknown[]) : Promise<T> {
    return new Promise(resolve => {
        let settled = false;
        const complete = (response : T) => {
            if (settled) {
                return;
            }
            settled = true;
            window.clearTimeout(timeout);
            resolve(response);
        };
        const failure = (msg : string) => ({ ok: false,
            msg }) as T;
        const timeout = window.setTimeout(() => complete(failure("运行服务响应超时，请检查目标节点和 Compose 日志后重试。")), timeoutMs);

        if (!realtime.connected()) {
            complete(failure("运行服务未连接，请等待连接恢复后重试。"));
            return;
        }
        realtime.emit(event, ...args, (response : T) => complete(response));
    });
}

export function emitAgentWithAck<T>(endpoint : string, event : string, ...args : unknown[]) : Promise<T> {
    return emitWithAck<T>("agent", endpoint, event, ...args);
}
