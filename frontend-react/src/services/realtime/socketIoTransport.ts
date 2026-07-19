import { io, Socket } from "socket.io-client";
import { RealtimeEventHandler, RealtimeTransport } from "./types";

export class SocketIoTransport implements RealtimeTransport {
    private socket : Socket;

    constructor(url = window.location.origin) {
        this.socket = io(url, { autoConnect: false });
    }

    connect() {
        this.socket.connect();
    }

    disconnect() {
        this.socket.disconnect();
    }

    emit(event : string, ...args : unknown[]) {
        this.socket.emit(event, ...args);
    }

    on(event : string, handler : RealtimeEventHandler) {
        this.socket.on(event, handler);
        return () => this.socket.off(event, handler);
    }

    connected() {
        return this.socket.connected;
    }
}
