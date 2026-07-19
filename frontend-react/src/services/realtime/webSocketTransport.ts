import SockJS from "sockjs-client";
import { RealtimeEventHandler, RealtimeTransport } from "./types";

interface RealtimeEnvelope {
    event: string;
    args: unknown[];
}

interface SockJsClient {
    onopen: (() => void) | null;
    onclose: (() => void) | null;
    onmessage: ((event : MessageEvent) => void) | null;
    close(): void;
    send(payload : string): void;
}

abstract class MessageTransport implements RealtimeTransport {
    protected handlers = new Map<string, Set<RealtimeEventHandler>>();
    protected isConnected = false;

    abstract connect(): void;
    abstract disconnect(): void;
    protected abstract send(payload : string): void;

    emit(event : string, ...args : unknown[]) {
        this.send(JSON.stringify({ event,
            args } satisfies RealtimeEnvelope));
    }

    on(event : string, handler : RealtimeEventHandler) {
        const handlers = this.handlers.get(event) || new Set<RealtimeEventHandler>();
        handlers.add(handler);
        this.handlers.set(event, handlers);
        return () => handlers.delete(handler);
    }

    connected() {
        return this.isConnected;
    }

    protected receive(payload : string) {
        const envelope = JSON.parse(payload) as RealtimeEnvelope;
        this.handlers.get(envelope.event)?.forEach(handler => handler(...envelope.args));
    }
}

export class NativeWebSocketTransport extends MessageTransport {
    private socket?: WebSocket;

    constructor(private url : string) {
        super();
    }

    connect() {
        this.socket = new WebSocket(this.url);
        this.socket.addEventListener("open", () => {
            this.isConnected = true;
        });
        this.socket.addEventListener("close", () => {
            this.isConnected = false;
        });
        this.socket.addEventListener("message", event => this.receive(String(event.data)));
    }

    disconnect() {
        this.socket?.close();
    }

    protected send(payload : string) {
        this.socket?.send(payload);
    }
}

export class SockJsTransport extends MessageTransport {
    private socket?: SockJsClient;

    constructor(private url : string) {
        super();
    }

    connect() {
        this.socket = new SockJS(this.url) as SockJsClient;
        this.socket.onopen = () => {
            this.isConnected = true;
        };
        this.socket.onclose = () => {
            this.isConnected = false;
        };
        this.socket.onmessage = (event : MessageEvent) => this.receive(String(event.data));
    }

    disconnect() {
        this.socket?.close();
    }

    protected send(payload : string) {
        this.socket?.send(payload);
    }
}
