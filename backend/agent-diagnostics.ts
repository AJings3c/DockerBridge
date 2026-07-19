import os from "node:os";
import { spawn as spawnProcess } from "node:child_process";
import type { DockgeServer } from "./dockge-server";

const AGENT_PROTOCOL_VERSION = 2;

interface CommandResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

export class AgentDiagnostics {
    constructor(private server : DockgeServer) {
    }

    async collect() {
        const errors : string[] = [];
        let dockerInfo : Record<string, unknown> = {};
        let dockerVersion : Record<string, unknown> = {};
        let composeVersion = "";
        let composeProjects = 0;

        try {
            const result = await this.run("docker", [ "version", "--format", "{{json .}}" ]);
            dockerVersion = this.jsonObject(result.stdout);
        } catch (error) {
            errors.push(this.message(error));
        }
        if (Object.keys(dockerVersion).length > 0) {
            try {
                const result = await this.run("docker", [ "info", "--format", "{{json .}}" ]);
                dockerInfo = this.jsonObject(result.stdout);
            } catch (error) {
                errors.push(this.message(error));
            }
            try {
                composeVersion = (await this.run("docker", [ "compose", "version", "--short" ])).stdout.trim();
            } catch (error) {
                errors.push(this.message(error));
            }
            try {
                const output = (await this.run("docker", [ "compose", "ls", "--all", "--format", "json" ])).stdout.trim();
                const projects = output ? JSON.parse(output) : [];
                composeProjects = Array.isArray(projects) ? projects.length : 0;
            } catch (error) {
                errors.push(this.message(error));
            }
        }

        const serverInfo = this.object(dockerVersion.Server);
        return {
            generatedAt: new Date().toISOString(),
            protocolVersion: AGENT_PROTOCOL_VERSION,
            version: String(this.server.packageJSON.version || "unknown"),
            runtime: {
                platform: process.platform,
                arch: process.arch,
                nodeVersion: process.version,
                hostname: os.hostname(),
                uptimeSeconds: Math.floor(process.uptime()),
                isContainer: process.env.DOCKGE_IS_CONTAINER === "1",
            },
            paths: {
                dataDir: this.server.config.dataDir,
                stacksDir: this.server.stacksDir,
            },
            console: {
                enabled: Boolean(this.server.config.enableConsole),
                target: this.server.config.consoleTarget || "runtime",
                idleTimeoutSeconds: this.server.config.consoleIdleTimeoutSeconds || 900,
                maxSessions: this.server.config.consoleMaxSessions || 3,
            },
            docker: {
                available: Object.keys(dockerVersion).length > 0,
                clientVersion: String(this.object(dockerVersion.Client).Version || ""),
                serverVersion: String(serverInfo.Version || dockerInfo.ServerVersion || ""),
                apiVersion: String(serverInfo.ApiVersion || ""),
                operatingSystem: String(dockerInfo.OperatingSystem || ""),
                osType: String(dockerInfo.OSType || ""),
                architecture: String(dockerInfo.Architecture || ""),
                storageDriver: String(dockerInfo.Driver || ""),
                swarmState: String(this.object(dockerInfo.Swarm).LocalNodeState || ""),
                containers: this.number(dockerInfo.Containers),
                runningContainers: this.number(dockerInfo.ContainersRunning),
                images: this.number(dockerInfo.Images),
                cpuCount: this.number(dockerInfo.NCPU),
                memoryBytes: this.number(dockerInfo.MemTotal),
                composeVersion,
                composeProjects,
            },
            capabilities: [
                "agent-rbac-v1",
                "compose-runtime-v1",
                "compose-editor-v1",
                "docker-resources-v1",
                "terminal-policy-v1",
                "operation-errors-v1",
            ],
            errors,
        };
    }

    private run(file : string, args : string[], timeoutMs = 10000) : Promise<CommandResult> {
        return new Promise((resolve, reject) => {
            const child = spawnProcess(file, args, { windowsHide: true });
            const stdout : Buffer[] = [];
            const stderr : Buffer[] = [];
            let settled = false;
            const finish = (action : () => void) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timeout);
                action();
            };
            child.stdout.on("data", (chunk : Buffer) => stdout.push(chunk));
            child.stderr.on("data", (chunk : Buffer) => stderr.push(chunk));
            child.on("error", error => finish(() => reject(error)));
            child.on("close", code => finish(() => {
                const result = {
                    stdout: Buffer.concat(stdout).toString("utf-8"),
                    stderr: Buffer.concat(stderr).toString("utf-8"),
                    exitCode: code ?? 1,
                };
                if (result.exitCode === 0) {
                    resolve(result);
                } else {
                    reject(new Error(result.stderr.trim() || `${file} ${args.join(" ")} exited with code ${result.exitCode}`));
                }
            }));
            const timeout = setTimeout(() => {
                child.kill();
                finish(() => reject(new Error(`${file} ${args.join(" ")} timed out after ${timeoutMs}ms`)));
            }, timeoutMs);
            timeout.unref?.();
        });
    }

    private jsonObject(value : string) {
        try {
            return this.object(JSON.parse(value));
        } catch (error) {
            throw new Error(`Docker returned invalid JSON: ${this.message(error)}`);
        }
    }

    private object(value : unknown) : Record<string, unknown> {
        return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    }

    private number(value : unknown) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    private message(error : unknown) {
        return error instanceof Error ? error.message : String(error);
    }
}

export { AGENT_PROTOCOL_VERSION };
