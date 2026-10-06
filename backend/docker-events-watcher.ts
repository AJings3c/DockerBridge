import { spawn as spawnProcess, ChildProcessWithoutNullStreams } from "child_process";
import { log } from "./log";
import type { Server as SocketIOServer } from "socket.io";

export interface DockerEventRecord {
    t : number;
    type : string;
    action : string;
    actorName : string;
    image : string;
}

const EVENT_BUFFER_LIMIT = 50;
const KEEP_TYPES = new Set([ "container", "image" ]);

/**
 * Watches `docker events --format json` and keeps a small rolling buffer of
 * container/image events, broadcasting each record to connected clients.
 */
export class DockerEventsWatcher {
    private child ?: ChildProcessWithoutNullStreams;
    private restarting = false;
    private stopped = false;
    buffer : DockerEventRecord[] = [];

    start(io : SocketIOServer) {
        this.stopped = false;
        try {
            this.child = spawnProcess("docker", [ "events", "--format", "json" ], {
                windowsHide: true,
            });
        } catch (e) {
            log.error("dockerEvents", e);
            this.scheduleRestart(io);
            return;
        }

        let pending = "";
        this.child.stdout.on("data", (chunk : Buffer) => {
            pending += chunk.toString("utf-8");
            let newline = pending.indexOf("\n");
            while (newline !== -1) {
                const line = pending.slice(0, newline).trim();
                pending = pending.slice(newline + 1);
                if (line) {
                    this.handleLine(line, io);
                }
                newline = pending.indexOf("\n");
            }
        });
        this.child.stderr.on("data", () => {});
        this.child.on("error", error => {
            log.error("dockerEvents", error);
        });
        this.child.on("close", () => {
            this.child = undefined;
            if (!this.stopped) {
                this.scheduleRestart(io);
            }
        });
    }

    private handleLine(line : string, io : SocketIOServer) {
        try {
            const raw = JSON.parse(line) as Record<string, unknown>;
            const type = String(raw.Type || "");
            const action = String(raw.Action || "");
            if (!KEEP_TYPES.has(type)) {
                return;
            }
            if (type === "image" && ![ "pull", "tag", "untag", "delete", "save", "load" ].includes(action)) {
                return;
            }
            const actor = (raw.Actor || {}) as { Attributes?: Record<string, unknown> };
            const record : DockerEventRecord = {
                t: typeof raw.time === "number" ? raw.time * 1000 : Date.now(),
                type,
                action,
                actorName: String(actor.Attributes?.name || actor.Attributes?.image || String((raw.Actor as { ID?: unknown } | undefined)?.ID) || "").slice(0, 120),
                image: String(actor.Attributes?.image || ""),
            };
            this.buffer.push(record);
            if (this.buffer.length > EVENT_BUFFER_LIMIT) {
                this.buffer.splice(0, this.buffer.length - EVENT_BUFFER_LIMIT);
            }
            io.emit("dockerBridgeEvent", record);
        } catch (e) {
            // Ignore malformed lines; docker events output is line-delimited JSON.
        }
    }

    private scheduleRestart(io : SocketIOServer) {
        if (this.restarting || this.stopped) {
            return;
        }
        this.restarting = true;
        setTimeout(() => {
            this.restarting = false;
            if (!this.stopped) {
                log.info("dockerEvents", "Restarting docker events watcher");
                this.start(io);
            }
        }, 5000);
    }

    stop() {
        this.stopped = true;
        this.child?.kill();
        this.child = undefined;
    }
}
