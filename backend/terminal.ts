import { DockgeServer } from "./dockge-server";
import * as os from "node:os";
import * as pty from "@homebridge/node-pty-prebuilt-multiarch";
import { LimitQueue } from "./utils/limit-queue";
import { DockgeSocket } from "./util-server";
import {
    PROGRESS_TERMINAL_ROWS,
    TERMINAL_COLS,
    TERMINAL_ROWS
} from "../common/util-common";
import { sync as commandExistsSync } from "command-exists";
import { log } from "./log";
import fs from "node:fs";
import path from "node:path";
import { ChildProcessWithoutNullStreams, spawn as spawnProcess } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export interface ConsoleProfile {
    target: "host" | "runtime";
    shell: string;
    platform: string;
    label: string;
    transport?: "pty" | "pipe";
}

export interface TerminalExecResult {
    exitCode: number;
    output: string;
}

export interface TerminalCloseEvent {
    exitCode: number;
    reason: string;
}

interface ConsoleCommand extends ConsoleProfile {
    file: string;
    args: string[];
    cwd: string;
}

interface TerminalProcess {
    write(data : string): void;
    resize(cols : number, rows : number): void;
    onData(listener : (data : string) => void): void;
    onExit(listener : (event : { exitCode: number; signal?: number }) => void): void;
    kill(): void;
}

class PipeTerminalProcess implements TerminalProcess {
    private readonly child : ChildProcessWithoutNullStreams;
    private readonly dataListeners = new Set<(data : string) => void>();
    private readonly exitListeners = new Set<(event : { exitCode: number; signal?: number }) => void>();
    private readonly pendingData : string[] = [];
    private exitEvent? : { exitCode: number; signal?: number };

    constructor(file : string, args : string[], cwd : string) {
        this.child = spawnProcess(file, args, {
            cwd,
            env: {
                ...process.env,
                TERM: process.env.TERM || "xterm-256color",
            },
            stdio: "pipe",
            windowsHide: true,
        });
        const emitData = (data : Buffer) => {
            const text = data.toString();
            if (this.dataListeners.size === 0) {
                this.pendingData.push(text);
                return;
            }
            for (const listener of this.dataListeners) {
                listener(text);
            }
        };
        this.child.stdout.on("data", emitData);
        this.child.stderr.on("data", emitData);
        this.child.on("error", error => emitData(Buffer.from(`\r\n${error.message}\r\n`)));
        this.child.on("close", (code, signal) => {
            this.exitEvent = {
                exitCode: code ?? 1,
                signal: typeof signal === "number" ? signal : undefined,
            };
            for (const listener of this.exitListeners) {
                listener(this.exitEvent);
            }
        });
    }

    write(data : string) {
        if (!this.child.stdin.destroyed) {
            this.child.stdin.write(data.replace(/\r(?!\n)/g, "\n"));
        }
    }

    resize() {
        // Pipe mode has no pseudo-terminal dimensions.
    }

    onData(listener : (data : string) => void) {
        this.dataListeners.add(listener);
        for (const data of this.pendingData.splice(0)) {
            listener(data);
        }
    }

    onExit(listener : (event : { exitCode: number; signal?: number }) => void) {
        this.exitListeners.add(listener);
        if (this.exitEvent) {
            queueMicrotask(() => listener(this.exitEvent as { exitCode: number; signal?: number }));
        }
    }

    kill() {
        this.child.kill(os.platform() === "win32" ? undefined : "SIGINT");
    }
}

function readOSLabel(root = "") {
    const releaseFile = path.join(root, "etc", "os-release");
    try {
        const values = Object.fromEntries(fs.readFileSync(releaseFile, "utf-8").split("\n").map(line => line.split("=", 2)).filter(parts => parts.length === 2).map(([ key, value ]) => [ key, value.replace(/^['"]|['"]$/g, "") ]));
        return values.PRETTY_NAME || values.NAME || os.platform();
    } catch (error) {
        return os.platform();
    }
}

function firstAvailableShell(candidates : string[], root = "") {
    for (const candidate of candidates) {
        if (!candidate) {
            continue;
        }
        if (path.isAbsolute(candidate)) {
            if (fs.existsSync(path.join(root, candidate.replace(/^[/\\]+/, "")))) {
                return candidate;
            }
        } else if (!root && commandExistsSync(candidate)) {
            return candidate;
        }
    }
    return "";
}

function shellArgs(shell : string) {
    const name = path.basename(shell).toLowerCase();
    if (name.startsWith("powershell") || name === "pwsh.exe" || name === "pwsh") {
        return [ "-NoLogo", "-NoProfile" ];
    }
    return [ "-l" ];
}

function hasHostPIDNamespace(hostPid : number) {
    if (!fs.existsSync("/.dockerenv")) {
        return true;
    }
    const runtimeRoot = fs.statSync("/");
    const hostRoot = fs.statSync(`/proc/${hostPid}/root`);
    return runtimeRoot.dev !== hostRoot.dev || runtimeRoot.ino !== hostRoot.ino;
}

function nativePTYAvailable() {
    if (os.platform() !== "win32") {
        return true;
    }
    try {
        const packageRoot = path.dirname(require.resolve("@homebridge/node-pty-prebuilt-multiarch/package.json"));
        return [ "Release", "Debug" ].some(configuration => fs.existsSync(path.join(packageRoot, "build", configuration, "conpty.node")));
    } catch (error) {
        return false;
    }
}

export function resolveConsoleCommand(server : DockgeServer) : ConsoleCommand {
    const target = server.config.consoleTarget?.toLowerCase() === "host" ? "host" : "runtime";
    const configuredShell = server.config.consoleShell?.trim() || "";

    if (target === "host") {
        if (os.platform() !== "linux") {
            throw new Error("Host console requires a Linux Docker host. Use DOCKERBRIDGE_CONSOLE_TARGET=runtime on this platform.");
        }
        if (!commandExistsSync("nsenter")) {
            throw new Error("Host console requires nsenter. Install util-linux in the DockerBridge image.");
        }
        const hostPid = server.config.consoleHostPid || 1;
        const hostRoot = `/proc/${hostPid}/root`;
        if (!fs.existsSync(hostRoot)) {
            throw new Error(`Host process ${hostPid} is not visible. Deploy with pid: host and privileged: true.`);
        }
        if (!hasHostPIDNamespace(hostPid)) {
            throw new Error("DockerBridge can only see its own container root. Deploy with pid: host and privileged: true to enable the host console.");
        }
        const shell = firstAvailableShell([ configuredShell, "/bin/bash", "/usr/bin/bash", "/bin/zsh", "/bin/ash", "/bin/sh", "/usr/bin/sh" ], hostRoot);
        if (!shell) {
            throw new Error("No supported shell was found on the host. Set DOCKERBRIDGE_CONSOLE_SHELL to an absolute host shell path.");
        }
        return {
            target,
            shell,
            platform: "linux",
            label: readOSLabel(hostRoot),
            file: "nsenter",
            args: [ `--target=${hostPid}`, "--mount", "--uts", "--ipc", "--net", "--pid", `--root=${hostRoot}`, "--wd=/", "--", shell, ...shellArgs(shell) ],
            cwd: "/",
        };
    }

    if (os.platform() === "win32") {
        const shell = firstAvailableShell([ configuredShell, "pwsh.exe", "powershell.exe" ]);
        if (!shell) {
            throw new Error("No supported PowerShell executable was found. Install PowerShell or set DOCKERBRIDGE_CONSOLE_SHELL.");
        }
        return {
            target,
            shell,
            platform: "win32",
            label: "Windows runtime",
            file: shell,
            args: shellArgs(shell),
            cwd: fs.existsSync(server.stacksDir) ? server.stacksDir : process.cwd(),
        };
    }

    const shell = firstAvailableShell([ configuredShell, process.env.SHELL || "", "bash", "zsh", "fish", "ash", "sh" ]);
    if (!shell) {
        throw new Error("No supported shell was found. Install bash/sh or set DOCKERBRIDGE_CONSOLE_SHELL.");
    }
    return {
        target,
        shell,
        platform: os.platform(),
        label: readOSLabel(),
        file: shell,
        args: shellArgs(shell),
        cwd: fs.existsSync(server.stacksDir) ? server.stacksDir : process.cwd(),
    };
}

/**
 * Terminal for running commands, no user interaction
 */
export class Terminal {
    protected static terminalMap : Map<string, Terminal> = new Map();

    protected _ptyProcess? : TerminalProcess;
    protected _transport : "pty" | "pipe" = "pty";
    protected server : DockgeServer;
    protected buffer : LimitQueue<string> = new LimitQueue(100);
    protected _name : string;

    protected file : string;
    protected args : string | string[];
    protected cwd : string;
    protected callback? : (exitCode : number) => void;
    protected closeListeners = new Set<(event : TerminalCloseEvent) => void>();
    protected closeReason = "process_exit";
    protected closed = false;
    protected closing = false;

    protected _rows : number = TERMINAL_ROWS;
    protected _cols : number = TERMINAL_COLS;

    public enableKeepAlive : boolean = false;
    protected keepAliveInterval? : NodeJS.Timeout;
    protected kickDisconnectedClientsInterval? : NodeJS.Timeout;

    protected socketList : Record<string, DockgeSocket> = {};

    constructor(server : DockgeServer, name : string, file : string, args : string | string[], cwd : string) {
        this.server = server;
        this._name = name;
        //this._name = "terminal-" + Date.now() + "-" + getCryptoRandomInt(0, 1000000);
        this.file = file;
        this.args = args;
        this.cwd = cwd;

        Terminal.terminalMap.set(this.name, this);
    }

    get rows() {
        return this._rows;
    }

    set rows(rows : number) {
        this._rows = rows;
        try {
            this.ptyProcess?.resize(this.cols, this.rows);
        } catch (e) {
            if (e instanceof Error) {
                log.debug("Terminal", "Failed to resize terminal: " + e.message);
            }
        }
    }

    get cols() {
        return this._cols;
    }

    set cols(cols : number) {
        this._cols = cols;
        log.debug("Terminal", `Terminal cols: ${this._cols}`); // Added to check if cols is being set when changing terminal size.
        try {
            this.ptyProcess?.resize(this.cols, this.rows);
        } catch (e) {
            if (e instanceof Error) {
                log.debug("Terminal", "Failed to resize terminal: " + e.message);
            }
        }
    }

    public start() {
        if (this._ptyProcess) {
            return;
        }

        this.kickDisconnectedClientsInterval = setInterval(() => {
            for (const socketID in this.socketList) {
                const socket = this.socketList[socketID];
                if (!socket.connected) {
                    log.debug("Terminal", "Kicking disconnected client " + socket.id + " from terminal " + this.name);
                    this.leave(socket);
                }
            }
        }, 60 * 1000);

        if (this.enableKeepAlive) {
            log.debug("Terminal", "Keep alive enabled for terminal " + this.name);

            // Close if there is no clients
            this.keepAliveInterval = setInterval(() => {
                const numClients = Object.keys(this.socketList).length;

                if (numClients === 0) {
                    log.debug("Terminal", "Terminal " + this.name + " has no client, closing...");
                    this.close();
                } else {
                    log.debug("Terminal", "Terminal " + this.name + " has " + numClients + " client(s)");
                }
            }, 60 * 1000);
        } else {
            log.debug("Terminal", "Keep alive disabled for terminal " + this.name);
        }

        try {
            try {
                if (!nativePTYAvailable()) {
                    throw new Error("Native ConPTY module is not installed for this Node runtime.");
                }
                this._ptyProcess = pty.spawn(this.file, this.args, {
                    name: this.name,
                    cwd: this.cwd,
                    cols: TERMINAL_COLS,
                    rows: this.rows,
                });
                this._transport = "pty";
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                log.warn("Terminal", `PTY unavailable for ${this.name}, using pipe mode: ${message}`);
                const args = Array.isArray(this.args) ? this.args : [ this.args ];
                this._ptyProcess = new PipeTerminalProcess(this.file, args, this.cwd);
                this._transport = "pipe";
            }

            // On Data
            this._ptyProcess.onData((data) => {
                this.onProcessData();
                this.buffer.pushItem(data);

                for (const socketID in this.socketList) {
                    const socket = this.socketList[socketID];
                    socket.emitAgent("terminalWrite", this.name, data);
                }
            });

            // On Exit
            this._ptyProcess.onExit(this.exit);
        } catch (error) {
            if (error instanceof Error) {
                clearInterval(this.keepAliveInterval);
                clearInterval(this.kickDisconnectedClientsInterval);
                Terminal.terminalMap.delete(this.name);
                this.onStartFailure();

                log.error("Terminal", "Failed to start terminal: " + error.message);
                throw error;
            }
            throw error;
        }
    }

    /**
     * Exit event handler
     * @param res
     */
    protected exit = (res : {exitCode: number, signal?: number | undefined}) => {
        if (this.closed) {
            return;
        }
        this.closed = true;
        for (const socketID in this.socketList) {
            const socket = this.socketList[socketID];
            socket.emitAgent("terminalExit", this.name, res.exitCode, {
                reason: this.closeReason,
            });
        }

        // Remove all clients
        this.socketList = {};

        Terminal.terminalMap.delete(this.name);
        log.debug("Terminal", "Terminal " + this.name + " exited with code " + res.exitCode);

        clearInterval(this.keepAliveInterval);
        clearInterval(this.kickDisconnectedClientsInterval);

        if (this.callback) {
            this.callback(res.exitCode);
        }
        for (const listener of this.closeListeners) {
            listener({
                exitCode: res.exitCode,
                reason: this.closeReason,
            });
        }
        this.closeListeners.clear();
    };

    protected onProcessData() {
    }

    protected onStartFailure() {
    }

    public onExit(callback : (exitCode : number) => void) {
        this.callback = callback;
    }

    public onClose(callback : (event : TerminalCloseEvent) => void) {
        this.closeListeners.add(callback);
    }

    public join(socket : DockgeSocket) {
        this.socketList[socket.id] = socket;
    }

    public leave(socket : DockgeSocket) {
        delete this.socketList[socket.id];
    }

    public get ptyProcess() {
        return this._ptyProcess;
    }

    public get transport() {
        return this._transport;
    }

    public get name() {
        return this._name;
    }

    /**
     * Get the terminal output string
     */
    getBuffer() : string {
        if (this.buffer.length === 0) {
            return "";
        }
        return this.buffer.join("");
    }

    close(reason = "closed") {
        if (this.closed || this.closing) {
            return;
        }
        this.closing = true;
        this.closeReason = reason;
        clearInterval(this.keepAliveInterval);
        clearInterval(this.kickDisconnectedClientsInterval);
        this.ptyProcess?.kill();
    }

    /**
     * Get a running and non-exited terminal
     * @param name
     */
    public static getTerminal(name : string) : Terminal | undefined {
        return Terminal.terminalMap.get(name);
    }

    public static removeTerminal(name : string) {
        Terminal.terminalMap.delete(name);
    }

    public static getOrCreateTerminal(server : DockgeServer, name : string, file : string, args : string | string[], cwd : string) : Terminal {
        // Since exited terminal will be removed from the map, it is safe to get the terminal from the map
        let terminal = Terminal.getTerminal(name);
        if (!terminal) {
            terminal = new Terminal(server, name, file, args, cwd);
        }
        return terminal;
    }

    public static exec(server : DockgeServer, socket : DockgeSocket | undefined, terminalName : string, file : string, args : string | string[], cwd : string) : Promise<number> {
        return this.execWithOutput(server, socket, terminalName, file, args, cwd).then(result => result.exitCode);
    }

    public static execWithOutput(server : DockgeServer, socket : DockgeSocket | undefined, terminalName : string, file : string, args : string | string[], cwd : string) : Promise<TerminalExecResult> {
        return new Promise((resolve, reject) => {
            // check if terminal exists
            if (Terminal.terminalMap.has(terminalName)) {
                reject(new Error("Another operation is already running, please try again later."));
                return;
            }

            let terminal = new Terminal(server, terminalName, file, args, cwd);
            terminal.rows = PROGRESS_TERMINAL_ROWS;

            if (socket) {
                terminal.join(socket);
            }

            terminal.onExit((exitCode : number) => {
                resolve({
                    exitCode,
                    output: terminal.getBuffer(),
                });
            });
            try {
                terminal.start();
            } catch (error) {
                reject(error);
            }
        });
    }

    public static getTerminalCount() {
        return Terminal.terminalMap.size;
    }

    public static getTerminalList() {
        return Array.from(Terminal.terminalMap.values());
    }

    public static closeAll(reason = "server_shutdown") {
        for (const terminal of this.getTerminalList()) {
            terminal.close(reason);
        }
    }
}

/**
 * Interactive terminal
 * Mainly used for container exec
 */
export class InteractiveTerminal extends Terminal {
    public write(input : string) {
        this.ptyProcess?.write(input);
    }

    resetCWD() {
        const cwd = process.cwd();
        this.ptyProcess?.write(`cd "${cwd}"\r`);
    }
}

/**
 * User interactive terminal that use bash or powershell with limited commands such as docker, ls, cd, dir
 */
export class MainTerminal extends InteractiveTerminal {
    public readonly profile : ConsoleProfile;
    public readonly ownerSocketId : string;
    public readonly ownerUserId : number;
    public readonly openedAt = Date.now();
    public lastActivityAt = Date.now();
    public readonly idleTimeoutSeconds : number;
    protected idleTimer? : NodeJS.Timeout;

    constructor(server : DockgeServer, name : string, owner : DockgeSocket) {
        // Throw an error if console is not enabled
        if (!server.config.enableConsole) {
            throw new Error("Console is not enabled.");
        }
        const command = resolveConsoleCommand(server);
        super(server, name, command.file, command.args, command.cwd);
        this.ownerSocketId = owner.id;
        this.ownerUserId = owner.userID;
        this.idleTimeoutSeconds = server.config.consoleIdleTimeoutSeconds || 900;
        this.profile = {
            target: command.target,
            shell: command.shell,
            platform: command.platform,
            label: command.label,
        };
        this.resetIdleTimer();
    }

    public write(input : string) {
        this.touch();
        super.write(input);
    }

    public belongsTo(socket : DockgeSocket) {
        return socket.id === this.ownerSocketId && socket.userID === this.ownerUserId;
    }

    public touch() {
        this.lastActivityAt = Date.now();
        this.resetIdleTimer();
    }

    protected onProcessData() {
        this.touch();
    }

    protected onStartFailure() {
        clearTimeout(this.idleTimer);
    }

    close(reason = "closed") {
        clearTimeout(this.idleTimer);
        super.close(reason);
    }

    private resetIdleTimer() {
        clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => {
            this.ptyProcess?.write(`\r\n[DockerBridge] Session closed after ${this.idleTimeoutSeconds} seconds of inactivity.\r\n`);
            this.close("idle_timeout");
        }, this.idleTimeoutSeconds * 1000);
        this.idleTimer.unref?.();
    }
}
