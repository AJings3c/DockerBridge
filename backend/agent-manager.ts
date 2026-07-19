import { DockgeSocket } from "./util-server";
import { io, Socket as SocketClient } from "socket.io-client";
import { log } from "./log";
import { Agent } from "./models/agent";
import { isDev, LooseObject, sleep } from "../common/util-common";
import semver from "semver";
import { R } from "redbean-node";
import dayjs, { Dayjs } from "dayjs";
import crypto from "node:crypto";
import { DockgeServer } from "./dockge-server";
import { AgentCredentialCipher } from "./agent-credentials";
import { ValidationError } from "./util-server";

export interface AgentRuntimeInfo {
    version: string;
    protocolVersion: number;
    capabilities: string[];
    runtime?: Record<string, unknown>;
    console?: Record<string, unknown>;
}

export interface AgentTestResult {
    endpoint: string;
    url: string;
    latencyMs: number;
    info?: AgentRuntimeInfo;
    diagnostics?: Record<string, unknown>;
}

/**
 * Dockge Instance Manager
 * One AgentManager per Socket connection
 */
export class AgentManager {

    protected socket : DockgeSocket;
    protected agentSocketList : Record<string, SocketClient> = {};
    protected agentLoggedInList : Record<string, boolean> = {};
    protected agentStatusList : Record<string, {
        status: "connecting" | "online" | "offline";
        changedAt: string;
        lastSeenAt: string | null;
        msg?: string;
    }> = {};

    protected agentInfoList : Record<string, AgentRuntimeInfo> = {};

    protected _firstConnectTime : Dayjs = dayjs();

    private readonly credentialCipher : AgentCredentialCipher;

    constructor(socket: DockgeSocket, private server : DockgeServer) {
        this.socket = socket;
        this.credentialCipher = new AgentCredentialCipher(server.jwtSecret);
    }

    get firstConnectTime() : Dayjs {
        return this._firstConnectTime;
    }

    test(url : string, username : string, password : string, allowExisting = false) : Promise<AgentTestResult> {
        const target = this.validateConnectionInput(url, username, password);
        if (!allowExisting && this.agentSocketList[target.endpoint]) {
            throw new ValidationError("The DockerBridge endpoint is already connected");
        }
        const startedAt = Date.now();
        return new Promise((resolve, reject) => {
            let settled = false;
            let info : AgentRuntimeInfo | undefined;
            const client = io(target.url, {
                reconnection: false,
                timeout: 10000,
                extraHeaders: { endpoint: target.endpoint },
            });
            const finish = (error? : unknown, diagnostics? : Record<string, unknown>) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timeout);
                client.removeAllListeners();
                client.disconnect();
                if (error) {
                    reject(error instanceof Error ? error : new Error(String(error)));
                } else {
                    resolve({ endpoint: target.endpoint,
                        url: target.url,
                        latencyMs: Date.now() - startedAt,
                        info,
                        diagnostics });
                }
            };
            client.on("info", (value : unknown) => {
                const parsed = this.runtimeInfo(value);
                if (parsed) {
                    info = parsed;
                }
            });
            client.on("connect", () => {
                client.emit("login", { username: target.username,
                    password: target.password }, (res : LooseObject) => {
                    if (!res?.ok) {
                        finish(new Error(typeof res?.msg === "string" ? res.msg : "Agent login failed"));
                        return;
                    }
                    const diagnosticsTimeout = setTimeout(() => finish(), 8000);
                    diagnosticsTimeout.unref?.();
                    client.emit("agent", target.endpoint, "getAgentDiagnostics", (response : LooseObject) => {
                        clearTimeout(diagnosticsTimeout);
                        finish(undefined, response?.ok && response.diagnostics && typeof response.diagnostics === "object" ? response.diagnostics as Record<string, unknown> : undefined);
                    });
                });
            });
            client.on("connect_error", error => finish(new Error(error.message === "xhr poll error" ? "Unable to connect to the DockerBridge Agent" : error.message)));
            const timeout = setTimeout(() => finish(new Error("Agent connection test timed out after 15 seconds")), 15000);
            timeout.unref?.();
        });
    }

    /**
     *
     * @param url
     * @param username
     * @param password
     * @param name
     */
    async add(url: string, username: string, password: string, name: string): Promise<Agent> {
        const target = this.validateConnectionInput(url, username, password);
        const displayName = this.validateName(name);
        const existing = await Agent.getAgentList();
        if (existing[target.endpoint]) {
            throw new ValidationError(`Agent endpoint ${target.endpoint} already exists`);
        }
        let bean = R.dispense("agent") as Agent;
        bean.url = target.url;
        bean.username = target.username;
        bean.password = "";
        bean.credential = this.credentialCipher.encrypt(target.password);
        bean.credential_version = 1;
        bean.name = displayName;
        bean.active = true;
        bean.created_at = new Date().toISOString();
        bean.updated_at = bean.created_at;
        await R.store(bean);
        return bean;
    }

    /**
     *
     * @param url
     */
    async remove(url : string) {
        let bean = await R.findOne("agent", " url = ? ", [
            url,
        ]);

        if (bean) {
            await R.trash(bean);
            let endpoint = bean.endpoint;
            this.disconnect(endpoint);
            this.sendAgentList();
            delete this.agentSocketList[endpoint];
            delete this.agentLoggedInList[endpoint];
            delete this.agentStatusList[endpoint];
            delete this.agentInfoList[endpoint];
        } else {
            throw new Error("Agent not found");
        }
    }

    /**
     *
     * @param url
     * @param updatedName
     */
    async update(url: string, updatedName: string) {
        const agent = await R.findOne("agent", " url = ? ", [
            url,
        ]);
        if (agent) {
            agent.name = this.validateName(updatedName);
            agent.updated_at = new Date().toISOString();
            await R.store(agent);
        } else {
            throw new Error("Agent not found");
        }
    }

    connect(url : string, username : string, password : string) {
        const target = this.validateConnectionInput(url, username, password);
        const endpoint = target.endpoint;

        this.emitStatus(endpoint, "connecting");

        if (this.agentSocketList[endpoint]) {
            log.debug("agent-manager", "Already connected to the socket server: " + endpoint);
            return;
        }

        log.info("agent-manager", "Connecting to the socket server: " + endpoint);
        let client = io(target.url, {
            extraHeaders: {
                endpoint,
            }
        });

        client.on("connect", () => {
            log.info("agent-manager", "Connected to the socket server: " + endpoint);

            client.emit("login", {
                username: target.username,
                password: target.password,
            }, (res : LooseObject) => {
                if (res.ok) {
                    log.info("agent-manager", "Logged in to the socket server: " + endpoint);
                    this.agentLoggedInList[endpoint] = true;
                    this.emitStatus(endpoint, "online");
                } else {
                    log.error("agent-manager", "Failed to login to the socket server: " + endpoint);
                    this.agentLoggedInList[endpoint] = false;
                    this.emitStatus(endpoint, "offline", typeof res.msg === "string" ? res.msg : "Agent login failed");
                }
            });
        });

        client.on("connect_error", (err) => {
            log.error("agent-manager", "Error from the socket server: " + endpoint);
            this.agentLoggedInList[endpoint] = false;
            this.emitStatus(endpoint, "offline", err.message);
        });

        client.on("disconnect", () => {
            log.info("agent-manager", "Disconnected from the socket server: " + endpoint);
            this.agentLoggedInList[endpoint] = false;
            this.emitStatus(endpoint, "offline", "Agent connection closed");
        });

        client.on("agent", (...args : unknown[]) => {
            this.markSeen(endpoint);
            this.socket.emit("agent", ...args);
        });

        client.on("info", (res) => {
            log.debug("agent-manager", res);

            const info = this.runtimeInfo(res);
            if (info) {
                this.agentInfoList[endpoint] = info;
                this.markSeen(endpoint);
                void this.sendAgentList();
            }

            // Disconnect if the version is lower than 1.4.0
            if (!isDev && typeof res?.version === "string" && semver.valid(res.version) && semver.satisfies(res.version, "< 1.4.0")) {
                this.emitStatus(endpoint, "offline", `${endpoint}: Unsupported version: ` + res.version);
                client.disconnect();
            }
        });

        this.agentSocketList[endpoint] = client;
    }

    disconnect(endpoint : string) {
        let client = this.agentSocketList[endpoint];
        client?.disconnect();
    }

    async connectAll() {
        this._firstConnectTime = dayjs();

        if (this.socket.endpoint) {
            log.info("agent-manager", "This connection is connected as an agent, skip connectAll()");
            return;
        }

        let list : Record<string, Agent> = await Agent.getActiveAgentList();

        if (Object.keys(list).length !== 0) {
            log.info("agent-manager", "Connecting to all instance socket server(s)...");
        }

        for (let endpoint in list) {
            let agent = list[endpoint];
            try {
                this.connect(agent.url, agent.username, await this.passwordFor(agent));
            } catch (error) {
                this.emitStatus(endpoint, "offline", error instanceof Error ? error.message : String(error));
            }
        }
    }

    disconnectAll() {
        for (let endpoint in this.agentSocketList) {
            this.disconnect(endpoint);
        }
    }

    async emitToEndpoint(endpoint: string, eventName: string, ...args : unknown[]) {
        log.debug("agent-manager", "Emitting event to endpoint: " + endpoint);
        let client = this.agentSocketList[endpoint];

        if (!client) {
            log.error("agent-manager", "Socket client not found for endpoint: " + endpoint);
            throw new Error("Socket client not found for endpoint: " + endpoint);
        }

        if (!client.connected || !this.agentLoggedInList[endpoint]) {
            // Maybe the request is too quick, the socket is not connected yet, check firstConnectTime
            // If it is within 10 seconds, we should apply retry logic here
            let diff = dayjs().diff(this.firstConnectTime, "second");
            log.debug("agent-manager", endpoint + ": diff: " + diff);
            let ok = false;
            while (diff < 10) {
                if (client.connected && this.agentLoggedInList[endpoint]) {
                    log.debug("agent-manager", `${endpoint}: Connected & Logged in`);
                    ok = true;
                    break;
                }
                log.debug("agent-manager", endpoint + ": not ready yet, retrying in 1 second...");
                await sleep(1000);
                diff = dayjs().diff(this.firstConnectTime, "second");
            }

            if (!ok) {
                log.error("agent-manager", `${endpoint}: Socket client not connected`);
                throw new Error("Socket client not connected for endpoint: " + endpoint);
            }
        }

        client.emit("agent", endpoint, eventName, ...args);
    }

    emitToAllEndpoints(eventName: string, ...args : unknown[]) {
        log.debug("agent-manager", "Emitting event to all endpoints");
        for (let endpoint in this.agentSocketList) {
            this.emitToEndpoint(endpoint, eventName, ...args).catch((e) => {
                log.warn("agent-manager", e.message);
            });
        }
    }

    async sendAgentList() {
        let list = await Agent.getAgentList();
        let result : Record<string, LooseObject> = {};

        // Myself
        result[""] = {
            url: "",
            username: "",
            endpoint: "",
            name: "",
            updatedName: "",
        };

        const statusList : Record<string, typeof this.agentStatusList[string]> = {
            "": {
                status: "online",
                changedAt: new Date().toISOString(),
                lastSeenAt: new Date().toISOString(),
            },
        };

        for (let endpoint in list) {
            let agent = list[endpoint];
            result[endpoint] = { ...agent.toJSON(),
                runtimeInfo: this.agentInfoList[endpoint],
                compatibility: this.compatibility(this.agentInfoList[endpoint]) };
            statusList[endpoint] = !agent.active ? {
                status: "offline",
                changedAt: agent.updated_at || new Date().toISOString(),
                lastSeenAt: this.agentStatusList[endpoint]?.lastSeenAt || null,
                msg: "Agent is disabled",
            } : this.agentStatusList[endpoint] || {
                status: "connecting",
                changedAt: new Date().toISOString(),
                lastSeenAt: null,
            };
        }

        this.socket.emit("agentList", {
            ok: true,
            agentList: result,
            statusList,
            generatedAt: new Date().toISOString(),
        });
    }

    async getManagementSnapshot() {
        const list = await Agent.getAgentList();
        return {
            generatedAt: new Date().toISOString(),
            credentialEncryption: {
                algorithm: "AES-256-GCM",
                externalKeyConfigured: this.credentialCipher.externalKeyConfigured,
            },
            agents: Object.entries(list).sort(([ , left ], [ , right ]) => String(left.name || left.endpoint).localeCompare(String(right.name || right.endpoint))).map(([ endpoint, agent ]) => {
                const status = !agent.active ? {
                    status: "offline" as const,
                    changedAt: agent.updated_at || new Date().toISOString(),
                    lastSeenAt: this.agentStatusList[endpoint]?.lastSeenAt || null,
                    msg: "Agent is disabled",
                } : this.agentStatusList[endpoint] || {
                    status: "connecting" as const,
                    changedAt: new Date().toISOString(),
                    lastSeenAt: null,
                };
                return {
                    ...agent.toJSON(),
                    status,
                    runtimeInfo: this.agentInfoList[endpoint],
                    compatibility: this.compatibility(this.agentInfoList[endpoint]),
                    fingerprint: this.agentFingerprint(agent),
                };
            }),
        };
    }

    async updateManaged(endpoint : string, name : string, active : boolean) {
        const agent = await this.findAgent(endpoint);
        const nextName = this.validateName(name || endpoint);
        if (typeof active !== "boolean") {
            throw new ValidationError("Agent active state must be a boolean");
        }
        agent.name = nextName;
        agent.active = active;
        agent.updated_at = new Date().toISOString();
        await R.store(agent);
        if (active) {
            const password = await this.passwordFor(agent);
            this.reconnect(agent.endpoint, agent.url, agent.username, password);
        } else {
            this.forgetConnection(agent.endpoint, "Agent disabled");
        }
        await this.sendAgentList();
        return agent;
    }

    async rotateCredentials(endpoint : string, username : string, password : string) {
        const agent = await this.findAgent(endpoint);
        const target = this.validateConnectionInput(agent.url, username, password);
        const test = await this.test(target.url, target.username, target.password, true);
        agent.username = target.username;
        agent.password = "";
        agent.credential = this.credentialCipher.encrypt(target.password);
        agent.credential_version = Number(agent.credential_version || 1) + 1;
        agent.updated_at = new Date().toISOString();
        await R.store(agent);
        if (agent.active) {
            this.reconnect(agent.endpoint, agent.url, agent.username, target.password);
        }
        await this.sendAgentList();
        return { agent,
            test };
    }

    async previewRemoval(endpoint : string) {
        const agent = await this.findAgent(endpoint);
        const warnings : string[] = [ "Removing an Agent only unregisters it from this controller; remote Docker workloads keep running" ];
        let diagnostics : Record<string, unknown> | undefined;
        let diagnosticError = "";
        if (agent.active && this.agentStatusList[endpoint]?.status === "online") {
            try {
                diagnostics = await this.requestDiagnostics(endpoint);
                const docker = diagnostics.docker && typeof diagnostics.docker === "object" ? diagnostics.docker as Record<string, unknown> : {};
                const containers = Number(docker.containers || 0);
                const projects = Number(docker.composeProjects || 0);
                if (containers > 0 || projects > 0) {
                    warnings.push(`Remote node reports ${containers} container(s) and ${projects} Compose project(s)`);
                }
            } catch (error) {
                diagnosticError = error instanceof Error ? error.message : String(error);
                warnings.push(`Live diagnostics unavailable: ${diagnosticError}`);
            }
        }
        return {
            endpoint,
            name: agent.name || endpoint,
            url: agent.url,
            username: agent.username,
            active: Boolean(agent.active),
            status: this.agentStatusList[endpoint]?.status || (agent.active ? "connecting" : "offline"),
            lastSeenAt: this.agentStatusList[endpoint]?.lastSeenAt || null,
            fingerprint: this.agentFingerprint(agent),
            diagnostics,
            diagnosticError,
            warnings,
        };
    }

    async removeManaged(endpoint : string, expectedFingerprint : string, confirmation : string) {
        const preview = await this.previewRemoval(endpoint);
        if (confirmation !== endpoint) {
            throw new ValidationError("Type the exact Agent endpoint to confirm removal");
        }
        if (preview.fingerprint !== expectedFingerprint) {
            throw new ValidationError("Agent configuration changed after preview; generate a new removal preview");
        }
        const agent = await this.findAgent(endpoint);
        await R.trash(agent);
        this.forgetConnection(endpoint, "Agent removed");
        await this.sendAgentList();
        return preview;
    }

    async requestDiagnostics(endpoint : string) : Promise<Record<string, unknown>> {
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (error? : unknown, diagnostics? : Record<string, unknown>) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timeout);
                if (error) {
                    reject(error instanceof Error ? error : new Error(String(error)));
                } else if (diagnostics) {
                    resolve(diagnostics);
                } else {
                    reject(new Error("Agent diagnostics response is invalid"));
                }
            };
            void this.emitToEndpoint(endpoint, "getAgentDiagnostics", (response : LooseObject) => {
                if (response?.ok && response.diagnostics && typeof response.diagnostics === "object") {
                    finish(undefined, response.diagnostics as Record<string, unknown>);
                } else {
                    finish(new Error(typeof response?.msg === "string" ? response.msg : "Agent diagnostics failed"));
                }
            }).catch(finish);
            const timeout = setTimeout(() => finish(new Error("Agent diagnostics timed out after 15 seconds")), 15000);
            timeout.unref?.();
        });
    }

    private async findAgent(endpoint : string) : Promise<Agent> {
        if (typeof endpoint !== "string" || !endpoint) {
            throw new ValidationError("Agent endpoint is required");
        }
        const list = await Agent.getAgentList();
        const agent = list[endpoint];
        if (!agent) {
            throw new ValidationError(`Agent ${endpoint} was not found`);
        }
        return agent;
    }

    private reconnect(endpoint : string, url : string, username : string, password : string) {
        this.forgetConnection(endpoint, "Agent reconnecting");
        this.connect(url, username, password);
    }

    private forgetConnection(endpoint : string, message : string) {
        const client = this.agentSocketList[endpoint];
        client?.removeAllListeners();
        client?.disconnect();
        delete this.agentSocketList[endpoint];
        delete this.agentLoggedInList[endpoint];
        this.emitStatus(endpoint, "offline", message);
    }

    private async passwordFor(agent : Agent) {
        if (agent.credential) {
            return this.credentialCipher.decrypt(agent.credential);
        }
        if (agent.password) {
            const password = String(agent.password);
            agent.credential = this.credentialCipher.encrypt(password);
            agent.password = "";
            agent.updated_at = new Date().toISOString();
            await R.store(agent);
            return password;
        }
        throw new ValidationError(`Agent ${agent.endpoint} has no stored credential`);
    }

    private validateConnectionInput(url : unknown, username : unknown, password : unknown) {
        if (typeof url !== "string" || url.length > 2048) {
            throw new ValidationError("Agent URL is invalid");
        }
        let parsed : URL;
        try {
            parsed = new URL(url.trim());
        } catch (error) {
            throw new ValidationError("Agent URL is invalid");
        }
        if (![ "http:", "https:" ].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.hash) {
            throw new ValidationError("Agent URL must be HTTP/HTTPS without embedded credentials or fragments");
        }
        if (typeof username !== "string" || !username.trim() || username.length > 255) {
            throw new ValidationError("Agent username is required and must not exceed 255 characters");
        }
        if (typeof password !== "string" || !password || password.length > 4096) {
            throw new ValidationError("Agent password is required and must not exceed 4096 characters");
        }
        const normalizedPath = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
        parsed.pathname = normalizedPath;
        return { url: parsed.toString().replace(/\/$/, ""),
            endpoint: parsed.host,
            username: username.trim(),
            password };
    }

    private validateName(value : unknown) {
        if (typeof value !== "string" || !value.trim() || value.trim().length > 128) {
            throw new ValidationError("Agent display name is required and must not exceed 128 characters");
        }
        return value.trim();
    }

    private runtimeInfo(value : unknown) : AgentRuntimeInfo | undefined {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            return undefined;
        }
        const info = value as Record<string, unknown>;
        if (typeof info.version !== "string") {
            return undefined;
        }
        return {
            version: info.version,
            protocolVersion: Number.isInteger(info.protocolVersion) ? Number(info.protocolVersion) : 0,
            capabilities: Array.isArray(info.capabilities) ? info.capabilities.filter((item): item is string => typeof item === "string") : [],
            runtime: info.runtime && typeof info.runtime === "object" && !Array.isArray(info.runtime) ? info.runtime as Record<string, unknown> : undefined,
            console: info.console && typeof info.console === "object" && !Array.isArray(info.console) ? info.console as Record<string, unknown> : undefined,
        };
    }

    private compatibility(info : AgentRuntimeInfo | undefined) : "compatible" | "legacy" | "incompatible" | "unknown" {
        if (!info) {
            return "unknown";
        }
        if (info.protocolVersion < 2) {
            return "legacy";
        }
        const controllerVersion = String(this.server.packageJSON.version || "");
        if (semver.valid(info.version) && semver.valid(controllerVersion) && semver.major(info.version) !== semver.major(controllerVersion)) {
            return "incompatible";
        }
        return "compatible";
    }

    private agentFingerprint(agent : Agent) {
        return crypto.createHash("sha256").update(JSON.stringify({ id: Number(agent.id),
            endpoint: agent.endpoint,
            url: agent.url,
            username: agent.username,
            name: agent.name,
            active: Boolean(agent.active),
            credentialVersion: Number(agent.credential_version || 1),
            updatedAt: agent.updated_at || null })).digest("hex");
    }

    private emitStatus(endpoint : string, status : "connecting" | "online" | "offline", msg? : string) {
        if (!endpoint) {
            return;
        }
        const previous = this.agentStatusList[endpoint];
        const now = new Date().toISOString();
        const value = {
            status,
            changedAt: now,
            lastSeenAt: status === "online" ? now : previous?.lastSeenAt || null,
            ...(msg ? { msg } : {}),
        };
        this.agentStatusList[endpoint] = value;
        this.socket.emit("agentStatus", {
            endpoint,
            ...value,
        });
    }

    private markSeen(endpoint : string) {
        const status = this.agentStatusList[endpoint];
        if (!status || status.status !== "online") {
            return;
        }
        status.lastSeenAt = new Date().toISOString();
    }
}
