export type RealtimeEventHandler = (...args : unknown[]) => void;

export interface RealtimeTransport {
    connect(): void;
    disconnect(): void;
    emit(event : string, ...args : unknown[]): void;
    on(event : string, handler : RealtimeEventHandler): () => void;
    connected(): boolean;
}
