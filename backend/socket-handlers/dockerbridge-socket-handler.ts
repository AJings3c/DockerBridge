import os from "os";
import fs from "fs";
import path from "path";
import net from "net";
import { spawn as spawnProcess } from "child_process";
import yaml from "yaml";
import * as childProcessAsync from "promisify-child-process";
import { R } from "redbean-node";
import { SocketHandler } from "../socket-handler";
import { DockgeServer } from "../dockge-server";
import { callbackError, callbackResult, checkPermission, DockgeSocket, ValidationError } from "../util-server";
import { acceptedComposeFileNames } from "../../common/util-common";
import { Stack } from "../stack";
import { Knex } from "knex";
import { safelyWriteOperationLog, sanitizeOperationLogValue } from "../operation-log";

type DockerJSON = Record<string, unknown>;

interface DockerPortBinding {
    HostIp?: string;
    HostPort?: string;
}

interface DockerMount {
    Type?: string;
    Name?: string;
    Source?: string;
    Destination?: string;
    RW?: boolean;
    Mode?: string;
}

interface DockerInspectState {
    Status?: string;
    Running?: boolean;
    Paused?: boolean;
    Restarting?: boolean;
    ExitCode?: number;
    StartedAt?: string;
    FinishedAt?: string;
    Health?: {
        Status?: string;
    };
}

interface DockerContainerInspect {
    Id?: string;
    Name?: string;
    Config?: {
        Image?: string;
        Env?: string[];
        Cmd?: string[];
        Entrypoint?: string | string[];
        WorkingDir?: string;
        User?: string;
        Hostname?: string;
        Labels?: Record<string, string>;
        ExposedPorts?: Record<string, unknown>;
    };
    HostConfig?: {
        Binds?: string[];
        PortBindings?: Record<string, DockerPortBinding[] | null>;
        RestartPolicy?: {
            Name?: string;
            MaximumRetryCount?: number;
        };
        NetworkMode?: string;
        Privileged?: boolean;
        ExtraHosts?: string[];
        CapAdd?: string[];
        CapDrop?: string[];
        ShmSize?: number;
    };
    Image?: string;
    Created?: string;
    State?: DockerInspectState;
    NetworkSettings?: {
        Ports?: Record<string, DockerPortBinding[] | null>;
        Networks?: Record<string, {
            Aliases?: string[];
            IPAddress?: string;
            Gateway?: string;
            MacAddress?: string;
            IPAMConfig?: Record<string, unknown> | null;
        }>;
    };
    Mounts?: DockerMount[];
}

interface DockerImageInspect {
    Id?: string;
    RepoTags?: string[];
    Config?: {
        ExposedPorts?: Record<string, unknown>;
    };
    Created?: string;
    Size?: number;
}

interface DockerStats {
    Name?: string;
    CPUPerc?: string;
    MemPerc?: string;
    MemUsage?: string;
    NetIO?: string;
    BlockIO?: string;
}

interface DockerBridgeContainer {
    id: string;
    shortId: string;
    name: string;
    stack: string;
    service: string;
    status: "running" | "stopped" | "abnormal" | "restarting";
    dockerState: string;
    statusText: string;
    image: string;
    imageId: string;
    imageTag: string;
    ports: Array<{
        containerPort: string;
        protocol: string;
        hostIp: string;
        hostPort: string;
        published: boolean;
    }>;
    mounts: Array<{
        type: string;
        name: string;
        source: string;
        destination: string;
        cache: boolean;
    }>;
    networks: Array<{
        name: string;
        aliases: string[];
        ipAddress: string;
        gateway: string;
        macAddress: string;
    }>;
    cacheDirs: string[];
    command: string[];
    entrypoint: string[];
    workingDir: string;
    runAs: string;
    restartPolicy: string;
    networkMode: string;
    createdAt: string;
    startedAt: string;
    cpuPercent: string;
    memoryUsage: string;
    memoryPercent: string;
    networkIO: string;
    blockIO: string;
    volumeCount: number;
    cacheState: "configured" | "not_configured";
    health: string;
    exitCode: number | null;
    canEditPorts: boolean;
    managedBy: "compose" | "container";
}

interface DockerBridgeImage {
    id: string;
    repository: string;
    tag: string;
    repoTags: string[];
    size: string;
    sizeBytes: number;
    dangling: boolean;
    createdAt: string;
    recentPulledAt: string;
    exposedPorts: string[];
    usedBy: string[];
}

interface DockerBridgeSnapshot {
    ok: true;
    dockerAvailable: boolean;
    generatedAt: string;
    summary: {
        cpuPercent: number;
        memoryTotal: number;
        memoryUsed: number;
        memoryPercent: number;
        containerTotal: number;
        running: number;
        stopped: number;
        abnormal: number;
        restarting: number;
        imageTotal: number;
        disk: DockerJSON[];
    };
    containers: DockerBridgeContainer[];
    images: DockerBridgeImage[];
    errors: string[];
}

interface DockerBridgePortUpdate {
    containerId: string;
    containerPort: string;
    protocol: string;
    hostPort: string;
    currentHostPort: string;
    hostIp: string;
}

interface DockerBridgeRollback {
    kind: "compose" | "container";
    backupFile: string;
    composeFile?: string;
    stack?: string;
    service?: string;
    containerName?: string;
}

interface DockerBridgeDockerConfigForm {
    registryMirrors: string[];
    httpProxy: string;
    httpsProxy: string;
    noProxy: string;
    dns: string[];
    insecureRegistries: string[];
    logDriver: string;
    logMaxSize: string;
    logMaxFile: string;
}

interface DockerBridgeDockerConfigAccess {
    editable: boolean;
    reason?: string;
}

interface DockerBridgeOperationLogQuery {
    page: number;
    pageSize: number;
    search: string;
    action: string;
    objectType: string;
    result: string;
    from: string;
    to: string;
}

interface DockerBridgeOperationLogRow {
    id: number;
    time: string;
    action_type: string;
    object_type: string;
    object_id: string;
    before_json: string | null;
    after_json: string | null;
    result: string;
    error: string | null;
    actor: string | null;
    endpoint: string | null;
    duration_ms: number | null;
    count?: string | number;
}

export class DockerBridgeSocketHandler extends SocketHandler {
    private rebuildingContainers = new Set<string>();
    private pullingImages = new Set<string>();
    private cleaningCaches = new Set<string>();

    create(socket : DockgeSocket, server : DockgeServer) {
        socket.on("getDockerBridgeSnapshot", async (callback) => {
            try {
                checkPermission(socket, "read");
                const snapshot = await this.getSnapshot(server);
                callbackResult(snapshot, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        socket.on("dockerBridgeContainerAction", async (containerId : unknown, action : unknown, callback) => {
            const startedAt = Date.now();
            try {
                if (typeof containerId !== "string" || typeof action !== "string") {
                    throw new ValidationError("Invalid container action request");
                }

                if (![ "start", "stop", "restart", "recreate" ].includes(action)) {
                    throw new ValidationError("Unsupported container action");
                }
                checkPermission(socket, action === "recreate" ? "destructive" : "operate");

                const before = await this.inspectContainer(containerId);
                if (action === "recreate") {
                    this.rebuildingContainers.add((before.Name || containerId).replace(/^\//, ""));
                    try {
                        const output = await this.recreateContainer(server, before, socket, startedAt);
                        await this.writeOperationLog(action, "container", containerId, before, {
                            action,
                            output,
                        }, "success", undefined, socket, startedAt);
                    } finally {
                        this.rebuildingContainers.delete((before.Name || containerId).replace(/^\//, ""));
                    }
                } else {
                    const output = await this.runDocker([ action, containerId ]);
                    await this.writeOperationLog(action, "container", containerId, before, {
                        action,
                        output,
                    }, "success", undefined, socket, startedAt);
                }

                callbackResult({
                    ok: true,
                    msg: `Container ${action} completed`,
                }, callback);
            } catch (e) {
                if (typeof containerId === "string" && typeof action === "string") {
                    await this.writeOperationLog(action, "container", containerId, null, { action }, "failed", e, socket, startedAt);
                }
                callbackError(e, callback);
            }
        });

        socket.on("getDockerBridgeContainerLogs", async (containerId : unknown, options : unknown, callback) => {
            const resolvedCallback = typeof options === "function" ? options : callback;
            try {
                checkPermission(socket, "read");

                if (typeof containerId !== "string") {
                    throw new ValidationError("Container ID must be a string");
                }

                const tail = this.validateLogTail(options);
                const logs = await this.runDockerLogs(containerId, tail);
                callbackResult({
                    ok: true,
                    logs,
                    tail,
                }, resolvedCallback);
            } catch (e) {
                callbackError(e, resolvedCallback);
            }
        });

        socket.on("previewDockerBridgeContainerCache", async (payloadOrId : unknown, callback) => {
            try {
                checkPermission(socket, "destructive");
                const containerId = this.validateCacheContainerId(payloadOrId);
                const inspect = await this.inspectContainer(containerId);
                const entries = await this.previewDeclaredCacheDirsFromMounts(inspect, this.getCacheDirsForContainer(server, inspect));
                callbackResult({
                    ok: true,
                    containerId,
                    entries,
                    eligibleCount: entries.filter(entry => entry.eligible).length,
                    totalBytes: entries.filter(entry => entry.eligible).reduce((total, entry) => total + entry.estimatedBytes, 0),
                    generatedAt: new Date().toISOString(),
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        socket.on("cleanDockerBridgeContainerCache", async (payload : unknown, callback) => {
            const startedAt = Date.now();
            let containerId = "";
            try {
                checkPermission(socket, "destructive");
                if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
                    throw new ValidationError("Invalid cache cleanup request");
                }
                const data = payload as Record<string, unknown>;
                containerId = this.validateCacheContainerId(data);
                if (!Array.isArray(data.expectedTargets) || data.expectedTargets.length > 1000) {
                    throw new ValidationError("Cache cleanup preview is missing or too large");
                }
                const expectedTargets = data.expectedTargets.map(item => {
                    if (!item || typeof item !== "object" || Array.isArray(item)) {
                        throw new ValidationError("Cache cleanup preview contains an invalid target");
                    }
                    const target = item as Record<string, unknown>;
                    if (typeof target.cacheDir !== "string" || typeof target.source !== "string") {
                        throw new ValidationError("Cache cleanup preview contains an invalid target");
                    }
                    return `${target.cacheDir}\n${target.source}`;
                }).sort();
                if (this.cleaningCaches.has(containerId)) {
                    throw new ValidationError(`Cache cleanup is already running for container ${containerId}`);
                }

                const inspect = await this.inspectContainer(containerId);
                const entries = await this.previewDeclaredCacheDirsFromMounts(inspect, this.getCacheDirsForContainer(server, inspect));
                const eligible = entries.filter(entry => entry.eligible && entry.source);
                const currentTargets = eligible.map(entry => `${entry.cacheDir}\n${entry.source}`).sort();
                if (currentTargets.length !== expectedTargets.length || currentTargets.some((target, index) => target !== expectedTargets[index])) {
                    throw new ValidationError("Cache cleanup preview is stale; run preview again before deleting files");
                }

                this.cleaningCaches.add(containerId);
                const cleaned : Array<{ cacheDir: string; source: string; estimatedBytes: number; fileCount: number }> = [];
                try {
                    for (const entry of eligible) {
                        await this.cleanCacheDirectoryContents(entry.source as string);
                        cleaned.push({
                            cacheDir: entry.cacheDir,
                            source: entry.source as string,
                            estimatedBytes: entry.estimatedBytes,
                            fileCount: entry.fileCount,
                        });
                    }
                } finally {
                    this.cleaningCaches.delete(containerId);
                }

                const totalBytes = cleaned.reduce((total, entry) => total + entry.estimatedBytes, 0);
                const fileCount = cleaned.reduce((total, entry) => total + entry.fileCount, 0);
                await this.writeOperationLog("clean_cache", "container", containerId, {
                    targets: eligible,
                }, {
                    cleaned,
                    totalBytes,
                    fileCount,
                    durationMs: Date.now() - startedAt,
                }, "success", undefined, socket, startedAt);
                callbackResult({
                    ok: true,
                    cleaned,
                    totalBytes,
                    fileCount,
                    msg: `Cleaned ${cleaned.length} declared cache director${cleaned.length === 1 ? "y" : "ies"}`,
                }, callback);
            } catch (e) {
                if (containerId) {
                    await this.writeOperationLog("clean_cache", "container", containerId, null, {
                        durationMs: Date.now() - startedAt,
                    }, "failed", e, socket, startedAt);
                }
                callbackError(e, callback);
            }
        });

        socket.on("updateDockerBridgeHostPort", async (payload : unknown, callback) => {
            const startedAt = Date.now();
            try {
                checkPermission(socket, "destructive");

                const result = await this.updateHostPort(server, payload, socket, startedAt);
                callbackResult({
                    ok: true,
                    msg: "Port updated and container recreated",
                    rollback: result.rollback,
                }, callback);
            } catch (e) {
                if (typeof callback === "function" && e instanceof Error && "rollback" in e) {
                    callback({
                        ok: false,
                        msg: e.message,
                        rollback: (e as Error & { rollback?: DockerBridgeRollback }).rollback,
                    });
                } else {
                    callbackError(e, callback);
                }
            }
        });

        socket.on("preflightDockerBridgeHostPort", async (payload : unknown, callback) => {
            try {
                checkPermission(socket, "destructive");
                const result = await this.preflightHostPort(server, payload);
                callbackResult({
                    ok: true,
                    msg: `Host port ${result.hostPort} is available`,
                    ...result,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        socket.on("rollbackDockerBridgeHostPort", async (payload : unknown, callback) => {
            const startedAt = Date.now();
            let rollback : DockerBridgeRollback | undefined;
            try {
                checkPermission(socket, "destructive");

                rollback = this.validateRollbackPayload(payload);
                this.assertRollbackBackupPath(server, rollback);
                if (rollback.kind === "compose") {
                    if (!rollback.composeFile || !rollback.stack || !rollback.service) {
                        throw new ValidationError("Compose rollback payload is incomplete");
                    }

                    const stack = await Stack.getStack(server, rollback.stack);
                    if (path.resolve(rollback.composeFile) !== path.resolve(stack.composeFilePath)) {
                        throw new ValidationError("Compose rollback target does not match the registered stack file");
                    }
                    fs.copyFileSync(rollback.backupFile, stack.composeFilePath);
                    await this.runDocker(stack.getComposeOptions("up", "-d", "--force-recreate", rollback.service), stack.path);
                    await this.verifyComposeServiceRunning(server, rollback.stack, rollback.service);

                    await this.writeOperationLog("rollback_port", "compose_service", `${rollback.stack}/${rollback.service}`, null, rollback, "success", undefined, socket, startedAt);
                } else {
                    const inspectRows = JSON.parse(fs.readFileSync(rollback.backupFile, "utf-8")) as DockerContainerInspect[];
                    const inspect = inspectRows[0];
                    if (!inspect) {
                        throw new ValidationError("Container rollback backup is invalid");
                    }

                    const output = await this.recreateStandaloneContainer(inspect, undefined, socket, startedAt);
                    await this.writeOperationLog("rollback_port", "container", rollback.containerName || inspect.Name || "", null, {
                        rollback,
                        output,
                    }, "success", undefined, socket, startedAt);
                }
                callbackResult({
                    ok: true,
                    msg: "Port configuration rolled back",
                }, callback);
            } catch (e) {
                await this.writeOperationLog("rollback_port", rollback?.kind === "compose" ? "compose_service" : "container", rollback?.stack && rollback.service ? `${rollback.stack}/${rollback.service}` : rollback?.containerName || "", null, rollback || payload, "failed", e, socket, startedAt);
                callbackError(e, callback);
            }
        });

        socket.on("pullDockerBridgeImage", async (imageRef : unknown, callback) => {
            const startedAt = Date.now();
            let normalizedRef = "";
            let ownsPull = false;
            try {
                checkPermission(socket, "operate");

                normalizedRef = this.validateImageReference(imageRef, "Image name");
                if (this.pullingImages.has(normalizedRef)) {
                    throw new ValidationError(`Image ${normalizedRef} is already being pulled`);
                }

                this.pullingImages.add(normalizedRef);
                ownsPull = true;
                socket.emit("dockerBridgeImagePullProgress", {
                    imageRef: normalizedRef,
                    phase: "starting",
                    message: `Starting pull for ${normalizedRef}`,
                    receivedAt: new Date().toISOString(),
                });
                const output = await this.runDockerStreaming([ "pull", normalizedRef ], (stream, message) => {
                    socket.emit("dockerBridgeImagePullProgress", {
                        imageRef: normalizedRef,
                        phase: "running",
                        stream,
                        message,
                        receivedAt: new Date().toISOString(),
                    });
                });
                socket.emit("dockerBridgeImagePullProgress", {
                    imageRef: normalizedRef,
                    phase: "completed",
                    message: `Pull completed for ${normalizedRef}`,
                    receivedAt: new Date().toISOString(),
                });
                await this.writeOperationLog("pull_image", "image", normalizedRef, null, {
                    imageRef: normalizedRef,
                    output,
                    durationMs: Date.now() - startedAt,
                }, "success", undefined, socket, startedAt);

                callbackResult({
                    ok: true,
                    msg: "Image pulled",
                    output,
                }, callback);
            } catch (e) {
                socket.emit("dockerBridgeImagePullProgress", {
                    imageRef: normalizedRef || (typeof imageRef === "string" ? imageRef : ""),
                    phase: "failed",
                    message: this.errorMessage("Image pull failed", e),
                    receivedAt: new Date().toISOString(),
                });
                await this.writeOperationLog("pull_image", "image", normalizedRef || (typeof imageRef === "string" ? imageRef : ""), null, {
                    imageRef,
                    durationMs: Date.now() - startedAt,
                }, "failed", e, socket, startedAt);
                callbackError(e, callback);
            } finally {
                if (ownsPull) {
                    this.pullingImages.delete(normalizedRef);
                }
            }
        });

        socket.on("tagDockerBridgeImage", async (sourceOrPayload : unknown, targetOrCallback : unknown, maybeCallback : unknown) => {
            const startedAt = Date.now();
            const callback = typeof targetOrCallback === "function" ? targetOrCallback : maybeCallback;
            let source = "";
            let target = "";
            try {
                checkPermission(socket, "operate");
                const payload = typeof sourceOrPayload === "object" && sourceOrPayload && !Array.isArray(sourceOrPayload)
                    ? sourceOrPayload as Record<string, unknown>
                    : { source: sourceOrPayload,
                        target: targetOrCallback };
                source = this.validateImageReference(payload.source, "Source image");
                target = this.validateImageReference(payload.target, "Target tag");
                const output = await this.runDocker([ "image", "tag", source, target ]);
                await this.writeOperationLog("tag_image", "image", target, { source }, { target,
                    output }, "success", undefined, socket, startedAt);
                callbackResult({ ok: true,
                    msg: "Image tagged",
                    output }, callback);
            } catch (e) {
                await this.writeOperationLog("tag_image", "image", target || source, { source }, { target }, "failed", e, socket, startedAt);
                callbackError(e, callback);
            }
        });

        socket.on("previewDockerBridgeImagePrune", async (optionsOrCallback : unknown, maybeCallback : unknown) => {
            const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
            try {
                checkPermission(socket, "destructive");
                const allUnused = this.validateImagePruneMode(typeof optionsOrCallback === "function" ? {} : optionsOrCallback);
                const candidates = await this.getImagePruneCandidates(server, allUnused);
                callbackResult({
                    ok: true,
                    allUnused,
                    candidates,
                    totalBytes: candidates.reduce((total, image) => total + image.sizeBytes, 0),
                    generatedAt: new Date().toISOString(),
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        socket.on("pruneDockerBridgeImages", async (payload : unknown, callback) => {
            const startedAt = Date.now();
            let allUnused = false;
            let expectedImageIds : string[] = [];
            try {
                checkPermission(socket, "destructive");
                if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
                    throw new ValidationError("Invalid image prune request");
                }
                const data = payload as Record<string, unknown>;
                allUnused = this.validateImagePruneMode(data);
                if (!Array.isArray(data.expectedImageIds) || data.expectedImageIds.length > 10000) {
                    throw new ValidationError("Image prune preview is missing or too large");
                }
                expectedImageIds = data.expectedImageIds.map(id => this.validateImageReference(id, "Image ID"));
                const candidates = await this.getImagePruneCandidates(server, allUnused);
                const currentIds = candidates.map(image => image.id).sort();
                const expectedIds = Array.from(new Set(expectedImageIds)).sort();
                if (currentIds.length !== expectedIds.length || currentIds.some((id, index) => id !== expectedIds[index])) {
                    throw new ValidationError("Image prune preview is stale; run preview again before deleting images");
                }

                const outputs : string[] = [];
                for (let index = 0; index < currentIds.length; index += 100) {
                    outputs.push(await this.runDocker([ "image", "rm", ...currentIds.slice(index, index + 100) ]));
                }
                const totalBytes = candidates.reduce((total, image) => total + image.sizeBytes, 0);
                await this.writeOperationLog("prune_images", "image_collection", allUnused ? "all-unused" : "dangling", {
                    imageIds: currentIds,
                }, {
                    deleted: currentIds.length,
                    totalBytes,
                    durationMs: Date.now() - startedAt,
                    output: outputs.join("\n"),
                }, "success", undefined, socket, startedAt);
                callbackResult({
                    ok: true,
                    deleted: currentIds.length,
                    totalBytes,
                    output: outputs.join("\n"),
                    msg: `Deleted ${currentIds.length} unused image(s)`,
                }, callback);
            } catch (e) {
                await this.writeOperationLog("prune_images", "image_collection", allUnused ? "all-unused" : "dangling", {
                    imageIds: expectedImageIds,
                }, { durationMs: Date.now() - startedAt }, "failed", e, socket, startedAt);
                callbackError(e, callback);
            }
        });

        socket.on("deleteDockerBridgeImage", async (imageId : unknown, callback) => {
            const startedAt = Date.now();
            try {
                checkPermission(socket, "destructive");

                if (typeof imageId !== "string" || !imageId.trim()) {
                    throw new ValidationError("Image ID is required");
                }

                const containers = await this.getContainersForPortCheck();
                const inspectRows = JSON.parse(await this.runDocker([ "image", "inspect", imageId ])) as DockerImageInspect[];
                const fullImageId = inspectRows[0]?.Id || "";

                const usedBy = containers.filter(container => {
                    return "imageId" in container && container.imageId === fullImageId;
                }).map(container => "name" in container ? String(container.name) : "unknown");

                if (usedBy.length > 0) {
                    throw new ValidationError(`Image is used by container(s): ${usedBy.join(", ")}`);
                }

                const output = await this.runDocker([ "image", "rm", imageId ]);
                await this.writeOperationLog("delete_image", "image", imageId, { imageId }, { output }, "success", undefined, socket, startedAt);

                callbackResult({
                    ok: true,
                    msg: "Image deleted",
                    output,
                }, callback);
            } catch (e) {
                await this.writeOperationLog("delete_image", "image", typeof imageId === "string" ? imageId : "", { imageId }, null, "failed", e, socket, startedAt);
                callbackError(e, callback);
            }
        });

        socket.on("getDockerBridgeDockerConfig", async (callback) => {
            try {
                checkPermission(socket, "settings");

                const access = this.getDockerDaemonConfigAccess();
                const config = access.editable ? this.readDockerDaemonConfig() : {};
                callbackResult({
                    ok: true,
                    configPath: this.getDockerDaemonConfigPath(),
                    restartCommand: this.getDockerRestartCommand(),
                    editable: access.editable,
                    reason: access.reason,
                    config,
                    form: this.configToForm(config),
                    backups: this.getDockerConfigBackups(server),
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        socket.on("saveDockerBridgeDockerConfig", async (form : unknown, callback) => {
            const startedAt = Date.now();
            try {
                checkPermission(socket, "settings");

                this.assertDockerDaemonConfigEditable();
                const validatedForm = this.validateDockerConfigForm(form);
                const configPath = this.getDockerDaemonConfigPath();
                const beforeConfig = this.readDockerDaemonConfig();
                const nextConfig = this.mergeDockerConfig(beforeConfig, validatedForm);
                const backupFile = this.backupDockerConfig(server, configPath);

                fs.mkdirSync(path.dirname(configPath), {
                    recursive: true,
                });
                fs.writeFileSync(configPath, JSON.stringify(nextConfig, null, 4) + "\n");

                await this.writeOperationLog("save_docker_config", "docker_daemon", configPath, beforeConfig, {
                    config: nextConfig,
                    backupFile,
                }, "success", undefined, socket, startedAt);

                callbackResult({
                    ok: true,
                    msg: "Docker config saved. Docker service restart is required.",
                    backupFile,
                    config: nextConfig,
                    form: this.configToForm(nextConfig),
                    backups: this.getDockerConfigBackups(server),
                }, callback);
            } catch (e) {
                await this.writeOperationLog("save_docker_config", "docker_daemon", this.getDockerDaemonConfigPath(), null, form, "failed", e, socket, startedAt);
                callbackError(e, callback);
            }
        });

        socket.on("previewDockerBridgeDockerConfig", async (form : unknown, callback) => {
            try {
                checkPermission(socket, "settings");
                this.assertDockerDaemonConfigEditable();
                const validatedForm = this.validateDockerConfigForm(form);
                const beforeConfig = this.readDockerDaemonConfig();
                const nextConfig = this.mergeDockerConfig(beforeConfig, validatedForm);
                const changedKeys = Array.from(new Set([ ...Object.keys(beforeConfig), ...Object.keys(nextConfig) ]))
                    .filter(key => JSON.stringify(beforeConfig[key]) !== JSON.stringify(nextConfig[key]));
                callbackResult({
                    ok: true,
                    beforeConfig,
                    nextConfig,
                    changedKeys,
                    changed: changedKeys.length > 0,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        socket.on("rollbackDockerBridgeDockerConfig", async (backupFile : unknown, callback) => {
            const startedAt = Date.now();
            try {
                checkPermission(socket, "settings");
                this.assertDockerDaemonConfigEditable();

                if (typeof backupFile !== "string" || !backupFile) {
                    throw new ValidationError("Backup file is required");
                }
                this.assertDockerConfigBackupPath(server, backupFile);

                const configPath = this.getDockerDaemonConfigPath();
                const beforeConfig = this.readDockerDaemonConfig();
                const restoredConfig = JSON.parse(fs.readFileSync(backupFile, "utf-8"));
                if (!restoredConfig || typeof restoredConfig !== "object" || Array.isArray(restoredConfig)) {
                    throw new ValidationError("Docker config backup must contain a JSON object");
                }
                fs.copyFileSync(backupFile, configPath);

                await this.writeOperationLog("rollback_docker_config", "docker_daemon", configPath, beforeConfig, {
                    config: restoredConfig,
                    backupFile,
                }, "success", undefined, socket, startedAt);

                callbackResult({
                    ok: true,
                    msg: "Docker config rolled back. Docker service restart is required.",
                    config: restoredConfig,
                    form: this.configToForm(restoredConfig),
                    backups: this.getDockerConfigBackups(server),
                }, callback);
            } catch (e) {
                await this.writeOperationLog("rollback_docker_config", "docker_daemon", this.getDockerDaemonConfigPath(), null, { backupFile }, "failed", e, socket, startedAt);
                callbackError(e, callback);
            }
        });

        socket.on("restartDockerBridgeDockerDaemon", async (callback) => {
            const startedAt = Date.now();
            try {
                checkPermission(socket, "settings");
                this.assertDockerDaemonConfigEditable();

                const command = this.getDockerRestartCommand();
                const beforeContainers = await this.getContainerStateSnapshot();
                const output = await childProcessAsync.spawn("sh", [ "-c", command ], {
                    encoding: "utf-8",
                });

                await this.runDocker([ "info" ]);
                const afterContainers = await this.getContainerStateSnapshot();
                await this.writeOperationLog("restart_docker", "docker_daemon", "local", null, {
                    command,
                    stdout: output.stdout?.toString() || "",
                    stderr: output.stderr?.toString() || "",
                    beforeContainers,
                    afterContainers,
                    platformReachable: true,
                }, "success", undefined, socket, startedAt);

                callbackResult({
                    ok: true,
                    msg: "Docker service restarted",
                }, callback);
            } catch (e) {
                await this.writeOperationLog("restart_docker", "docker_daemon", "local", null, {
                    command: this.getDockerRestartCommand(),
                }, "failed", e, socket, startedAt);
                callbackError(e, callback);
            }
        });

        socket.on("getDockerBridgeOperationLogs", async (queryOrCallback : unknown, maybeCallback : unknown) => {
            const callback = typeof queryOrCallback === "function" ? queryOrCallback : maybeCallback;
            try {
                checkPermission(socket, "read");
                const query = this.validateOperationLogQuery(typeof queryOrCallback === "function" ? {} : queryOrCallback);
                const filteredQuery = this.buildOperationLogQuery(query);

                const countRow = await filteredQuery.clone().count("id as count").first();
                const total = Number(countRow?.count || 0);
                const pageCount = Math.max(1, Math.ceil(total / query.pageSize));
                const page = Math.min(query.page, pageCount);
                const resultRows = await filteredQuery.clone()
                    .select("result")
                    .count("id as count")
                    .groupBy("result");
                const resultSummary = Object.fromEntries((resultRows as DockerBridgeOperationLogRow[]).map(row => [ String(row.result), Number(row.count) ]));
                const logs = await filteredQuery.clone()
                    .select("*")
                    .orderBy("id", "desc")
                    .offset((page - 1) * query.pageSize)
                    .limit(query.pageSize);
                const actionRows = await R.knex("dockerbridge_operation_log").distinct("action_type").orderBy("action_type");
                const objectTypeRows = await R.knex("dockerbridge_operation_log").distinct("object_type").orderBy("object_type");

                callbackResult({
                    ok: true,
                    items: (logs as DockerBridgeOperationLogRow[]).map(logRow => this.serializeOperationLog(logRow)),
                    pagination: {
                        page,
                        pageSize: query.pageSize,
                        pageCount,
                        total,
                    },
                    summary: {
                        total,
                        success: resultSummary.success || 0,
                        failed: resultSummary.failed || 0,
                        skipped: resultSummary.skipped || 0,
                    },
                    options: {
                        actions: (actionRows as DockerBridgeOperationLogRow[]).map(row => String(row.action_type)),
                        objectTypes: (objectTypeRows as DockerBridgeOperationLogRow[]).map(row => String(row.object_type)),
                    },
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        socket.on("exportDockerBridgeOperationLogs", async (queryOrCallback : unknown, maybeCallback : unknown) => {
            const callback = typeof queryOrCallback === "function" ? queryOrCallback : maybeCallback;
            try {
                checkPermission(socket, "read");
                const query = this.validateOperationLogQuery(typeof queryOrCallback === "function" ? {} : queryOrCallback);
                const filteredQuery = this.buildOperationLogQuery(query);
                const countRow = await filteredQuery.clone().count("id as count").first();
                const total = Number(countRow?.count || 0);
                const logs = await filteredQuery.clone()
                    .select("*")
                    .orderBy("id", "desc")
                    .limit(10000);
                const items = (logs as DockerBridgeOperationLogRow[]).map(logRow => this.serializeOperationLog(logRow));

                callbackResult({
                    ok: true,
                    items,
                    total,
                    exported: items.length,
                    truncated: total > items.length,
                    generatedAt: new Date().toISOString(),
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });
    }

    private buildOperationLogQuery(query : DockerBridgeOperationLogQuery) {
        const filteredQuery = R.knex("dockerbridge_operation_log");

        if (query.search) {
            filteredQuery.where((builder : Knex.QueryBuilder) => builder
                .whereLike("action_type", `%${query.search}%`)
                .orWhereLike("object_type", `%${query.search}%`)
                .orWhereLike("object_id", `%${query.search}%`)
                .orWhereLike("actor", `%${query.search}%`)
                .orWhereLike("endpoint", `%${query.search}%`)
                .orWhereLike("error", `%${query.search}%`));
        }
        if (query.action) {
            filteredQuery.andWhere("action_type", query.action);
        }
        if (query.objectType) {
            filteredQuery.andWhere("object_type", query.objectType);
        }
        if (query.result) {
            filteredQuery.andWhere("result", query.result);
        }
        if (query.from) {
            filteredQuery.andWhere("time", ">=", query.from);
        }
        if (query.to) {
            filteredQuery.andWhere("time", "<=", query.to);
        }

        return filteredQuery;
    }

    private serializeOperationLog(logRow : DockerBridgeOperationLogRow) {
        return {
            id: Number(logRow.id),
            time: String(logRow.time),
            actionType: String(logRow.action_type),
            objectType: String(logRow.object_type),
            objectId: String(logRow.object_id),
            beforeJson: this.sanitizeStoredOperationLogJSON(logRow.before_json),
            afterJson: this.sanitizeStoredOperationLogJSON(logRow.after_json),
            result: String(logRow.result),
            error: logRow.error == null ? null : String(sanitizeOperationLogValue(String(logRow.error))),
            actor: logRow.actor == null ? null : String(logRow.actor),
            endpoint: logRow.endpoint == null ? null : String(logRow.endpoint),
            durationMs: logRow.duration_ms == null ? null : Number(logRow.duration_ms),
        };
    }

    private sanitizeStoredOperationLogJSON(value : string | null) {
        if (value == null) {
            return null;
        }
        try {
            return JSON.stringify(sanitizeOperationLogValue(JSON.parse(value)));
        } catch (error) {
            return JSON.stringify(sanitizeOperationLogValue(value));
        }
    }

    private async getSnapshot(server : DockgeServer) : Promise<DockerBridgeSnapshot> {
        const errors : string[] = [];
        let dockerAvailable = true;
        let containers : DockerBridgeContainer[] = [];
        let images : DockerBridgeImage[] = [];
        let disk : DockerJSON[] = [];

        try {
            containers = await this.getContainers(server);
        } catch (e) {
            dockerAvailable = false;
            errors.push(this.errorMessage("Failed to read Docker containers", e));
        }

        try {
            images = await this.getImages(containers);
        } catch (e) {
            dockerAvailable = false;
            errors.push(this.errorMessage("Failed to read Docker images", e));
        }

        try {
            disk = this.parseJSONLines(await this.runDocker([ "system", "df", "--format", "json" ]));
        } catch (e) {
            errors.push(this.errorMessage("Failed to read Docker disk usage", e));
        }

        const running = containers.filter(item => item.status === "running").length;
        const stopped = containers.filter(item => item.status === "stopped").length;
        const abnormal = containers.filter(item => item.status === "abnormal").length;
        const restarting = containers.filter(item => item.status === "restarting").length;
        const memoryTotal = os.totalmem();
        const memoryUsed = memoryTotal - os.freemem();

        return {
            ok: true,
            dockerAvailable,
            generatedAt: new Date().toISOString(),
            summary: {
                cpuPercent: this.getHostCPUPercent(),
                memoryTotal,
                memoryUsed,
                memoryPercent: Math.round((memoryUsed / memoryTotal) * 1000) / 10,
                containerTotal: containers.length,
                running,
                stopped,
                abnormal,
                restarting,
                imageTotal: images.length,
                disk,
            },
            containers,
            images,
            errors,
        };
    }

    private async getContainers(server : DockgeServer) : Promise<DockerBridgeContainer[]> {
        const psRows = this.parseJSONLines(await this.runDocker([ "ps", "-a", "--format", "json" ]));
        const ids = psRows
            .map(row => this.stringValue(row.ID))
            .filter((id): id is string => id.length > 0);

        if (ids.length === 0) {
            return [];
        }

        const inspectRows = JSON.parse(await this.runDocker([ "inspect", ...ids ])) as DockerContainerInspect[];
        const stats = Object.fromEntries(await server.getDockerStats()) as Record<string, DockerStats>;

        return inspectRows.map((item): DockerBridgeContainer => {
            const id = item.Id || "";
            const labels = item.Config?.Labels || {};
            const name = (item.Name || "").replace(/^\//, "");
            const state = item.State || {};
            const status = this.rebuildingContainers.has(name) ? "restarting" : this.classifyContainer(state);
            const ports = this.parsePorts(item.NetworkSettings?.Ports || {});
            const stat = stats[name] || stats[id.slice(0, 12)] || {};
            const image = item.Config?.Image || "";
            const config = item.Config;
            const entrypoint = config?.Entrypoint;
            const imageParts = image.split(":");
            const cacheDirs = this.getCacheDirsForContainer(server, item);
            const mounts = (item.Mounts || []).map(mount => ({
                type: mount.Type || "",
                name: mount.Name || "",
                source: mount.Source || "",
                destination: mount.Destination || "",
                cache: cacheDirs.includes(mount.Destination || ""),
            }));
            const networks = Object.entries(item.NetworkSettings?.Networks || {}).map(([ networkName, network ]) => ({
                name: networkName,
                aliases: network.Aliases || [],
                ipAddress: network.IPAddress || "",
                gateway: network.Gateway || "",
                macAddress: network.MacAddress || "",
            }));
            const restartPolicy = item.HostConfig?.RestartPolicy;

            return {
                id,
                shortId: id.slice(0, 12),
                name,
                stack: labels["com.docker.compose.project"] || "-",
                service: labels["com.docker.compose.service"] || "-",
                status,
                dockerState: state.Status || "unknown",
                statusText: this.containerStatusText(state),
                image,
                imageId: item.Image || "",
                imageTag: imageParts.length > 1 ? imageParts[imageParts.length - 1] : "latest",
                ports,
                mounts,
                networks,
                cacheDirs,
                command: config?.Cmd || [],
                entrypoint: Array.isArray(entrypoint) ? entrypoint : entrypoint ? [ entrypoint ] : [],
                workingDir: config?.WorkingDir || "/",
                runAs: config?.User || "root",
                restartPolicy: restartPolicy?.Name ? `${restartPolicy.Name}${restartPolicy.MaximumRetryCount ? `:${restartPolicy.MaximumRetryCount}` : ""}` : "no",
                networkMode: item.HostConfig?.NetworkMode || "default",
                createdAt: item.Created || "",
                startedAt: state.StartedAt || "",
                cpuPercent: stat.CPUPerc || "0%",
                memoryUsage: stat.MemUsage || "-",
                memoryPercent: stat.MemPerc || "0%",
                networkIO: stat.NetIO || "-",
                blockIO: stat.BlockIO || "-",
                volumeCount: (item.Mounts || []).length,
                cacheState: cacheDirs.length > 0 ? "configured" : "not_configured",
                health: state.Health?.Status || "-",
                exitCode: typeof state.ExitCode === "number" ? state.ExitCode : null,
                canEditPorts: ports.some(port => port.published),
                managedBy: labels["com.docker.compose.project"] && labels["com.docker.compose.service"] ? "compose" : "container",
            };
        }).sort((a, b) => {
            if (a.status !== b.status) {
                const order = {
                    abnormal: 0,
                    restarting: 1,
                    running: 2,
                    stopped: 3,
                };
                return order[a.status] - order[b.status];
            }
            return a.name.localeCompare(b.name);
        });
    }

    private async getImages(containers : DockerBridgeContainer[]) : Promise<DockerBridgeImage[]> {
        const imageRows = this.parseJSONLines(await this.runDocker([ "image", "ls", "--format", "json" ]));
        const imageIds = Array.from(new Set(imageRows
            .map(row => this.stringValue(row.ID))
            .filter((id): id is string => id.length > 0)));

        if (imageIds.length === 0) {
            return [];
        }

        const inspectRows = JSON.parse(await this.runDocker([ "image", "inspect", ...imageIds ])) as DockerImageInspect[];
        const inspectById = new Map(inspectRows.map(item => [ this.shortImageId(item.Id || ""), item ]));
        const pullTimes = await this.getRecentImagePullTimes();

        return imageRows.map((row) => {
            const shortId = this.stringValue(row.ID);
            const inspect = inspectById.get(this.shortImageId(shortId));
            const repository = this.stringValue(row.Repository);
            const tag = this.stringValue(row.Tag);
            const repoTag = repository && tag && tag !== "<none>" ? `${repository}:${tag}` : "";
            const repoTags = inspect?.RepoTags || (repoTag ? [ repoTag ] : []);
            const usedBy = containers
                .filter(container => {
                    return container.imageId === inspect?.Id
                        || container.image === repoTag
                        || repoTags.includes(container.image);
                })
                .map(container => container.name);

            return {
                id: shortId,
                repository,
                tag,
                repoTags,
                size: this.stringValue(row.Size),
                sizeBytes: Number(inspect?.Size || 0),
                dangling: repoTags.length === 0 || repository === "<none>" || tag === "<none>",
                createdAt: this.stringValue(row.CreatedAt) || inspect?.Created || "",
                recentPulledAt: pullTimes.get(repoTag) || "",
                exposedPorts: Object.keys(inspect?.Config?.ExposedPorts || {}),
                usedBy,
            };
        }).sort((a, b) => {
            if (b.usedBy.length !== a.usedBy.length) {
                return b.usedBy.length - a.usedBy.length;
            }
            return `${a.repository}:${a.tag}`.localeCompare(`${b.repository}:${b.tag}`);
        });
    }

    private async getImagePruneCandidates(server : DockgeServer, allUnused : boolean) {
        const images = await this.getImages(await this.getContainers(server));
        const candidates = new Map<string, DockerBridgeImage>();
        for (const image of images) {
            if (image.usedBy.length > 0 || (!allUnused && !image.dangling)) {
                continue;
            }
            const existing = candidates.get(image.id);
            if (existing) {
                existing.repoTags = Array.from(new Set([ ...existing.repoTags, ...image.repoTags ]));
                continue;
            }
            candidates.set(image.id, { ...image,
                repoTags: [ ...image.repoTags ] });
        }
        return Array.from(candidates.values()).map(image => ({
            id: image.id,
            repoTags: image.repoTags,
            size: image.size,
            sizeBytes: image.sizeBytes,
            dangling: image.dangling,
        }));
    }

    private async recreateContainer(server : DockgeServer, inspect : DockerContainerInspect, socket : DockgeSocket, startedAt? : number) {
        const labels = inspect.Config?.Labels || {};
        const stackName = labels["com.docker.compose.project"];
        const serviceName = labels["com.docker.compose.service"];

        if (stackName && serviceName) {
            return this.recreateComposeContainer(server, inspect, socket, startedAt);
        }

        return this.recreateStandaloneContainer(inspect, undefined, socket, startedAt);
    }

    private async getRecentImagePullTimes() : Promise<Map<string, string>> {
        const rows = await R.knex("dockerbridge_operation_log")
            .select("time", "object_id")
            .where("action_type", "pull_image")
            .andWhere("result", "success")
            .orderBy("id", "desc")
            .limit(500);

        const result = new Map<string, string>();
        for (const row of rows) {
            if (!result.has(row.object_id)) {
                result.set(row.object_id, row.time);
            }
        }

        return result;
    }

    private async recreateComposeContainer(server : DockgeServer, inspect : DockerContainerInspect, socket : DockgeSocket, startedAt? : number) {
        const labels = inspect.Config?.Labels || {};
        const stackName = labels["com.docker.compose.project"];
        const serviceName = labels["com.docker.compose.service"];

        if (!stackName || !serviceName) {
            throw new ValidationError("Recreate is currently available for Compose-managed containers only");
        }

        const { stack, service } = await this.getComposeStackService(server, stackName, serviceName);

        await this.cleanDeclaredCacheDirsForObject(inspect, this.extractServiceCacheDirs(service), "compose_service", `${stackName}/${serviceName}`, socket, startedAt);

        const output = await this.runDocker(stack.getComposeOptions("up", "-d", "--force-recreate", serviceName), stack.path);
        await this.verifyComposeServiceRunning(server, stackName, serviceName);
        return output;
    }

    private async recreateStandaloneContainer(inspect : DockerContainerInspect, portBindings? : Record<string, DockerPortBinding[] | null>, socket? : DockgeSocket, startedAt? : number) {
        const name = (inspect.Name || "").replace(/^\//, "");
        const image = inspect.Config?.Image;

        if (!name || !image) {
            throw new ValidationError("Container inspect data is missing name or image");
        }

        this.assertStandaloneRecreateSupported(inspect);

        const wasRunning = Boolean(inspect.State?.Running);
        const existing = await this.containerExists(name);
        if (existing) {
            const currentInspect = await this.inspectContainer(name);
            await this.cleanDeclaredCacheDirsForObject(currentInspect, this.extractContainerCacheDirs(currentInspect), "container", name, socket, startedAt);

            if (currentInspect.State?.Running) {
                await this.runDocker([ "stop", name ]);
            }
            await this.runDocker([ "rm", name ]);
        }

        let createOutput = "";
        let startOutput = "";
        let newContainerId = "";
        try {
            const createArgs = this.buildStandaloneCreateArgs(inspect, portBindings || this.getEffectivePortBindings(inspect));
            createOutput = await this.runDocker(createArgs);
            newContainerId = createOutput.trim();

            if (wasRunning) {
                startOutput = await this.runDocker([ "start", name ]);
                const recreatedInspect = await this.inspectContainer(newContainerId || name);
                const status = this.classifyContainer(recreatedInspect.State || {});
                if (status === "abnormal") {
                    throw new ValidationError(`Container ${name} recreated but is abnormal: ${this.containerStatusText(recreatedInspect.State || {})}`);
                }
            }
        } catch (e) {
            await this.restoreStandaloneContainerAfterFailure(inspect, e, socket, startedAt);
            throw e;
        }

        return [ createOutput, startOutput ].filter(Boolean).join("\n");
    }

    private buildStandaloneCreateArgs(inspect : DockerContainerInspect, portBindings : Record<string, DockerPortBinding[] | null>) {
        const name = (inspect.Name || "").replace(/^\//, "");
        const config = inspect.Config || {};
        const hostConfig = inspect.HostConfig || {};
        const args = [ "create", "--name", name ];

        if (config.Hostname) {
            args.push("--hostname", config.Hostname);
        }

        if (config.User) {
            args.push("--user", config.User);
        }

        if (config.WorkingDir) {
            args.push("--workdir", config.WorkingDir);
        }

        const restartPolicy = hostConfig.RestartPolicy;
        if (restartPolicy?.Name && restartPolicy.Name !== "no") {
            const retryCount = restartPolicy.Name === "on-failure" && restartPolicy.MaximumRetryCount
                ? `:${restartPolicy.MaximumRetryCount}`
                : "";
            args.push("--restart", `${restartPolicy.Name}${retryCount}`);
        }

        if (hostConfig.Privileged) {
            args.push("--privileged");
        }

        if (hostConfig.ShmSize && hostConfig.ShmSize !== 64 * 1024 * 1024) {
            args.push("--shm-size", String(hostConfig.ShmSize));
        }

        for (const extraHost of hostConfig.ExtraHosts || []) {
            args.push("--add-host", extraHost);
        }

        for (const cap of hostConfig.CapAdd || []) {
            args.push("--cap-add", cap);
        }

        for (const cap of hostConfig.CapDrop || []) {
            args.push("--cap-drop", cap);
        }

        const networkMode = hostConfig.NetworkMode || "";
        if (networkMode && ![ "default", "bridge" ].includes(networkMode) && !networkMode.startsWith("container:")) {
            args.push("--network", networkMode);
        }

        for (const env of config.Env || []) {
            args.push("--env", env);
        }

        for (const [ key, value ] of Object.entries(config.Labels || {})) {
            args.push("--label", `${key}=${value}`);
        }

        for (const mount of inspect.Mounts || []) {
            const destination = mount.Destination;
            if (!destination) {
                continue;
            }

            if (mount.Type === "bind" && mount.Source) {
                args.push("--volume", `${mount.Source}:${destination}:${mount.Mode || (mount.RW === false ? "ro" : "rw")}`);
            } else if (mount.Type === "volume" && mount.Name) {
                args.push("--volume", `${mount.Name}:${destination}:${mount.Mode || (mount.RW === false ? "ro" : "rw")}`);
            } else if (mount.Type === "tmpfs") {
                args.push("--tmpfs", destination);
            }
        }

        for (const exposedPort of Object.keys(config.ExposedPorts || {})) {
            if (!portBindings[exposedPort]) {
                args.push("--expose", exposedPort);
            }
        }

        for (const [ containerPort, bindings ] of Object.entries(portBindings)) {
            for (const binding of bindings || []) {
                if (!binding.HostPort) {
                    continue;
                }

                const hostPrefix = binding.HostIp ? `${binding.HostIp}:` : "";
                args.push("--publish", `${hostPrefix}${binding.HostPort}:${containerPort}`);
            }
        }

        const entrypoint = config.Entrypoint;
        if (typeof entrypoint === "string" && entrypoint) {
            args.push("--entrypoint", entrypoint);
        } else if (Array.isArray(entrypoint) && entrypoint.length > 0) {
            args.push("--entrypoint", entrypoint[0]);
        }

        if (!config.Image) {
            throw new ValidationError("Container image is missing");
        }
        args.push(config.Image);

        for (const command of config.Cmd || []) {
            args.push(command);
        }

        return args;
    }

    private assertStandaloneRecreateSupported(inspect : DockerContainerInspect) {
        const config = (inspect.Config || {}) as Record<string, unknown>;
        const hostConfig = (inspect.HostConfig || {}) as Record<string, unknown>;
        const unsupported : string[] = [];
        const nonEmptyArray = (value : unknown) => Array.isArray(value) && value.length > 0;
        const nonEmptyObject = (value : unknown) => Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0);
        const nonZeroNumber = (value : unknown) => typeof value === "number" && value !== 0;
        const configuredMemorySwappiness = (value : unknown) => typeof value === "number" && value !== -1;
        const configuredPidsLimit = (value : unknown) => typeof value === "number" && value !== 0 && value !== -1;

        if (nonEmptyObject(config.Healthcheck)) {
            unsupported.push("healthcheck");
        }
        if (config.Tty === true || config.OpenStdin === true || config.StdinOnce === true) {
            unsupported.push("interactive stdin/TTY");
        }
        if (Array.isArray(config.Entrypoint) && config.Entrypoint.length > 1) {
            unsupported.push("multi-part entrypoint");
        }
        if (config.StopSignal || config.StopTimeout != null || config.Domainname || config.MacAddress) {
            unsupported.push("container stop/network identity settings");
        }

        if (hostConfig.AutoRemove === true || hostConfig.ReadonlyRootfs === true) {
            unsupported.push("auto-remove/read-only rootfs");
        }
        if (nonZeroNumber(hostConfig.Memory) || nonZeroNumber(hostConfig.MemoryReservation) || nonZeroNumber(hostConfig.MemorySwap) || configuredMemorySwappiness(hostConfig.MemorySwappiness) || nonZeroNumber(hostConfig.NanoCpus) || nonZeroNumber(hostConfig.CpuShares) || nonZeroNumber(hostConfig.CpuPeriod) || nonZeroNumber(hostConfig.CpuQuota) || hostConfig.CpusetCpus || hostConfig.CpusetMems || configuredPidsLimit(hostConfig.PidsLimit)) {
            unsupported.push("resource limits");
        }
        if (nonEmptyArray(hostConfig.Devices) || nonEmptyArray(hostConfig.DeviceRequests) || nonEmptyArray(hostConfig.SecurityOpt) || nonEmptyArray(hostConfig.Ulimits) || nonEmptyArray(hostConfig.GroupAdd) || nonEmptyArray(hostConfig.Dns) || nonEmptyArray(hostConfig.DnsSearch) || nonEmptyArray(hostConfig.DnsOptions)) {
            unsupported.push("devices/security/resource options");
        }
        if (hostConfig.Init === true || hostConfig.OomKillDisable === true || nonZeroNumber(hostConfig.OomScoreAdj) || nonEmptyObject(hostConfig.Tmpfs) || nonEmptyObject(hostConfig.Sysctls) || nonEmptyObject(hostConfig.StorageOpt)) {
            unsupported.push("runtime isolation/storage options");
        }
        if (hostConfig.LogConfig && typeof hostConfig.LogConfig === "object") {
            const logConfig = hostConfig.LogConfig as Record<string, unknown>;
            if ((logConfig.Type && logConfig.Type !== "json-file") || nonEmptyObject(logConfig.Config)) {
                unsupported.push("logging options");
            }
        }
        if (hostConfig.VolumeDriver || hostConfig.Runtime && hostConfig.Runtime !== "runc" || hostConfig.CgroupParent || hostConfig.Isolation || hostConfig.PublishAllPorts === true || nonEmptyArray(hostConfig.Links) || nonEmptyArray(hostConfig.VolumesFrom)) {
            unsupported.push("runtime/volume driver options");
        }
        if ([ "PidMode", "IpcMode", "UTSMode", "UsernsMode", "CgroupnsMode" ].some(key => {
            const value = hostConfig[key];
            return Boolean(value) && ![ "private", "default" ].includes(String(value));
        })) {
            unsupported.push("non-default namespaces");
        }
        if (typeof hostConfig.NetworkMode === "string" && hostConfig.NetworkMode.startsWith("container:")) {
            unsupported.push("container network namespace");
        }

        const binds = Array.isArray(hostConfig.Binds) ? hostConfig.Binds.filter((value): value is string => typeof value === "string") : [];
        if (binds.some(bind => /:(?:ro|rw),(?!$)/i.test(bind))) {
            unsupported.push("advanced bind mount propagation");
        }
        if ((inspect.Mounts || []).some(mount => mount.Type === "tmpfs" || Boolean(mount.Mode && ![ "ro", "rw" ].includes(mount.Mode)))) {
            unsupported.push("advanced mounts");
        }

        const networks = Object.values(inspect.NetworkSettings?.Networks || {});
        if (networks.length > 1 || networks.some(network => network.Aliases?.length || nonEmptyObject(network.IPAMConfig))) {
            unsupported.push("multiple/static network attachments");
        }

        if (unsupported.length > 0) {
            throw new ValidationError(`Standalone container recreate is blocked because these settings cannot be reproduced safely: ${Array.from(new Set(unsupported)).join(", ")}. Use Compose or recreate the container manually.`);
        }
    }

    private async containerExists(nameOrId : string) {
        try {
            await this.runDocker([ "inspect", nameOrId ]);
            return true;
        } catch (e) {
            return false;
        }
    }

    private async restoreStandaloneContainerAfterFailure(inspect : DockerContainerInspect, originalError : unknown, socket? : DockgeSocket, startedAt? : number) {
        const name = (inspect.Name || "").replace(/^\//, "");
        const wasRunning = Boolean(inspect.State?.Running);

        if (!name) {
            return;
        }

        try {
            if (await this.containerExists(name)) {
                const currentInspect = await this.inspectContainer(name);
                if (currentInspect.State?.Running) {
                    await this.runDocker([ "stop", name ]);
                }
                await this.runDocker([ "rm", name ]);
            }

            const createOutput = await this.runDocker(this.buildStandaloneCreateArgs(inspect, this.getEffectivePortBindings(inspect)));
            let startOutput = "";
            if (wasRunning) {
                startOutput = await this.runDocker([ "start", name ]);
            }

            await this.writeOperationLog("restore_container", "container", name, {
                error: this.errorMessage("", originalError).replace(/^: /, ""),
            }, {
                output: [ createOutput, startOutput ].filter(Boolean).join("\n"),
            }, "success", undefined, socket, startedAt);
        } catch (restoreError) {
            await this.writeOperationLog("restore_container", "container", name, {
                error: this.errorMessage("", originalError).replace(/^: /, ""),
            }, null, "failed", restoreError, socket, startedAt);
        }
    }

    private async verifyComposeServiceRunning(server : DockgeServer, stackName : string, serviceName : string) {
        const stack = await Stack.getStack(server, stackName);
        const containerId = (await this.runDocker(stack.getComposeOptions("ps", "-q", serviceName), stack.path)).trim().split("\n")[0];
        if (!containerId) {
            throw new ValidationError(`Compose service ${stackName}/${serviceName} did not create a container`);
        }

        const inspect = await this.inspectContainer(containerId);
        const status = this.classifyContainer(inspect.State || {});
        if (status === "abnormal") {
            throw new ValidationError(`Compose service ${stackName}/${serviceName} is abnormal: ${this.containerStatusText(inspect.State || {})}`);
        }
    }

    private parsePorts(rawPorts : Record<string, DockerPortBinding[] | null>) : DockerBridgeContainer["ports"] {
        return Object.entries(rawPorts).flatMap(([ key, bindings ]) => {
            const [ containerPort, protocol = "tcp" ] = key.split("/");
            if (!bindings || bindings.length === 0) {
                return [{
                    containerPort,
                    protocol,
                    hostIp: "",
                    hostPort: "",
                    published: false,
                }];
            }

            return bindings.map(binding => ({
                containerPort,
                protocol,
                hostIp: binding?.HostIp || "",
                hostPort: binding?.HostPort || "",
                published: Boolean(binding?.HostPort),
            }));
        }).sort((a, b) => Number(a.containerPort) - Number(b.containerPort));
    }

    private getCacheDirsForContainer(server : DockgeServer, container : DockerContainerInspect) : string[] {
        const labels = container.Config?.Labels || {};
        const stackName = labels["com.docker.compose.project"];
        const serviceName = labels["com.docker.compose.service"];

        if (!stackName || !serviceName) {
            return this.extractContainerCacheDirs(container);
        }

        try {
            const stackPath = path.join(server.stacksDir, stackName);
            const composeFile = this.findComposeFile(stackPath);
            const config = yaml.parse(fs.readFileSync(composeFile, "utf-8")) || {};
            const service = config.services?.[serviceName];
            return this.extractServiceCacheDirs(service);
        } catch (e) {
            return [];
        }
    }

    private classifyContainer(state : DockerInspectState) : DockerBridgeContainer["status"] {
        if (state.Restarting) {
            return "restarting";
        }

        if (state.Health?.Status === "unhealthy") {
            return "abnormal";
        }

        if (state.Running) {
            return "running";
        }

        if (typeof state.ExitCode === "number" && state.ExitCode !== 0) {
            return "abnormal";
        }

        return "stopped";
    }

    private containerStatusText(state : DockerInspectState) : string {
        if (state.Restarting) {
            return "Restarting";
        }

        if (state.Health?.Status === "unhealthy") {
            return "Unhealthy";
        }

        if (state.Running) {
            return state.Health?.Status ? `Running (${state.Health.Status})` : "Running";
        }

        if (typeof state.ExitCode === "number") {
            return `Exited (${state.ExitCode})`;
        }

        return state.Status || "Unknown";
    }

    private parseJSONLines(stdout : string) : DockerJSON[] {
        const trimmed = stdout.trim();
        if (!trimmed) {
            return [];
        }

        return trimmed.split("\n").map((line) => JSON.parse(line) as DockerJSON);
    }

    private async updateHostPort(server : DockgeServer, payload : unknown, socket : DockgeSocket, startedAt : number) {
        const data = this.validatePortUpdatePayload(payload);
        const newHostPort = Number(data.hostPort);
        const inspect = await this.inspectContainer(data.containerId);
        const labels = inspect.Config?.Labels || {};
        const stackName = labels["com.docker.compose.project"];
        const serviceName = labels["com.docker.compose.service"];

        if (!stackName || !serviceName) {
            return this.updateStandaloneHostPort(server, data, inspect, socket, startedAt);
        }

        await this.assertHostPortAvailable(newHostPort, data.containerId);

        const { stack, composeFile, originalCompose, config, service } = await this.getComposeStackService(server, stackName, serviceName);

        const before = {
            containerId: data.containerId,
            stack: stackName,
            service: serviceName,
            composeFile,
            port: data,
        };

        const oldHostPort = this.updateComposePort(service, data.containerPort, data.protocol, data.hostPort, data.currentHostPort, data.hostIp);
        this.assertNoDuplicatePublishedPorts(service);
        config.services[serviceName] = service;

        const backupFile = this.createBackupFile(server, composeFile, "ports");
        fs.writeFileSync(backupFile, originalCompose);
        fs.writeFileSync(composeFile, yaml.stringify(config));

        const rollback = {
            kind: "compose" as const,
            backupFile,
            composeFile,
            stack: stackName,
            service: serviceName,
        };

        try {
            await this.cleanDeclaredCacheDirsForObject(inspect, this.extractServiceCacheDirs(service), "compose_service", `${stackName}/${serviceName}`, socket, startedAt);

            const output = await this.runDocker(stack.getComposeOptions("up", "-d", "--force-recreate", serviceName), stack.path);
            await this.verifyComposeServiceRunning(server, stackName, serviceName);

            await this.writeOperationLog("update_port", "compose_service", `${stackName}/${serviceName}`, before, {
                ...before,
                oldHostPort,
                newHostPort: data.hostPort,
                rollback,
                output,
            }, "success", undefined, socket, startedAt);

            return {
                rollback,
            };
        } catch (e) {
            await this.writeOperationLog("update_port", "compose_service", `${stackName}/${serviceName}`, before, {
                ...before,
                oldHostPort,
                newHostPort: data.hostPort,
                rollback,
            }, "failed", e, socket, startedAt);
            if (e instanceof Error) {
                (e as Error & { rollback?: DockerBridgeRollback }).rollback = rollback;
            }
            throw e;
        }
    }

    private async preflightHostPort(server : DockgeServer, payload : unknown) {
        const data = this.validatePortUpdatePayload(payload);
        const newHostPort = Number(data.hostPort);
        const inspect = await this.inspectContainer(data.containerId);
        await this.assertHostPortAvailable(newHostPort, data.containerId);
        const cacheEntries = await this.previewDeclaredCacheDirsFromMounts(inspect, this.getCacheDirsForContainer(server, inspect));
        const cacheCleanup = {
            entries: cacheEntries,
            eligibleCount: cacheEntries.filter(entry => entry.eligible).length,
            totalBytes: cacheEntries.filter(entry => entry.eligible).reduce((total, entry) => total + entry.estimatedBytes, 0),
        };

        const labels = inspect.Config?.Labels || {};
        const stackName = labels["com.docker.compose.project"];
        const serviceName = labels["com.docker.compose.service"];
        if (stackName && serviceName) {
            const { service } = await this.getComposeStackService(server, stackName, serviceName);
            const candidate = structuredClone(service);
            const oldHostPort = this.updateComposePort(candidate, data.containerPort, data.protocol, data.hostPort, data.currentHostPort, data.hostIp);
            this.assertNoDuplicatePublishedPorts(candidate);
            return {
                containerId: data.containerId,
                containerName: (inspect.Name || "").replace(/^\//, ""),
                managedBy: "compose" as const,
                target: `${stackName}/${serviceName}`,
                hostPort: data.hostPort,
                currentHostPort: oldHostPort,
                requiresRecreate: true,
                cacheCleanup,
            };
        }

        this.assertStandaloneRecreateSupported(inspect);

        const portBindings = this.clonePortBindings(this.getEffectivePortBindings(inspect));
        const bindingKey = `${data.containerPort}/${data.protocol}`;
        const existingBindings = portBindings[bindingKey];
        if (!existingBindings || existingBindings.length === 0) {
            throw new ValidationError(`Port ${bindingKey} was not found in container port bindings`);
        }
        const bindingIndex = this.findContainerPortBindingIndex(existingBindings, data.currentHostPort, data.hostIp);
        const oldHostPort = existingBindings[bindingIndex].HostPort || "";
        existingBindings[bindingIndex] = {
            ...existingBindings[bindingIndex],
            HostPort: data.hostPort,
        };
        this.assertNoDuplicateContainerPortBindings(portBindings);
        return {
            containerId: data.containerId,
            containerName: (inspect.Name || "").replace(/^\//, ""),
            managedBy: "container" as const,
            target: (inspect.Name || data.containerId).replace(/^\//, ""),
            hostPort: data.hostPort,
            currentHostPort: oldHostPort,
            requiresRecreate: true,
            cacheCleanup,
        };
    }

    private async getComposeStackService(server : DockgeServer, stackName : string, serviceName : string) {
        const stack = await Stack.getStack(server, stackName);
        const composeFile = stack.composeFilePath;

        if (!fs.existsSync(composeFile)) {
            throw new ValidationError(`Compose file was not found for stack ${stackName}`);
        }

        const originalCompose = fs.readFileSync(composeFile, "utf-8");
        const config = yaml.parse(originalCompose) || {};
        const service = config.services?.[serviceName];

        if (!service || typeof service !== "object") {
            throw new ValidationError(`Service ${serviceName} was not found in compose file`);
        }

        return {
            stack,
            composeFile,
            originalCompose,
            config,
            service: service as Record<string, unknown>,
        };
    }

    private async updateStandaloneHostPort(server : DockgeServer, data : DockerBridgePortUpdate, inspect : DockerContainerInspect, socket : DockgeSocket, startedAt : number) {
        const newHostPort = Number(data.hostPort);
        await this.assertHostPortAvailable(newHostPort, data.containerId);

        const before = {
            containerId: data.containerId,
            containerName: (inspect.Name || "").replace(/^\//, ""),
            port: data,
        };
        const portBindings = this.clonePortBindings(this.getEffectivePortBindings(inspect));
        const bindingKey = `${data.containerPort}/${data.protocol}`;
        const existingBindings = portBindings[bindingKey];

        if (!existingBindings || existingBindings.length === 0) {
            throw new ValidationError(`Port ${bindingKey} was not found in container port bindings`);
        }

        const bindingIndex = this.findContainerPortBindingIndex(existingBindings, data.currentHostPort, data.hostIp);
        const oldHostPort = existingBindings[bindingIndex].HostPort || "";
        existingBindings[bindingIndex] = {
            ...existingBindings[bindingIndex],
            HostPort: data.hostPort,
        };
        portBindings[bindingKey] = existingBindings;

        this.assertNoDuplicateContainerPortBindings(portBindings);

        const backupFile = this.createBackupFile(server, `${before.containerName || data.containerId}.inspect.json`, "container-ports");
        fs.writeFileSync(backupFile, JSON.stringify([ inspect ], null, 4) + "\n");

        const rollback = {
            kind: "container" as const,
            backupFile,
            containerName: before.containerName,
        };

        try {
            const output = await this.recreateStandaloneContainer(inspect, portBindings, socket, startedAt);
            await this.writeOperationLog("update_port", "container", before.containerName || data.containerId, before, {
                ...before,
                oldHostPort,
                newHostPort: data.hostPort,
                rollback,
                output,
            }, "success", undefined, socket, startedAt);

            return {
                rollback,
            };
        } catch (e) {
            await this.writeOperationLog("update_port", "container", before.containerName || data.containerId, before, {
                ...before,
                oldHostPort,
                newHostPort: data.hostPort,
                rollback,
            }, "failed", e, socket, startedAt);
            if (e instanceof Error) {
                (e as Error & { rollback?: DockerBridgeRollback }).rollback = rollback;
            }
            throw e;
        }
    }

    private updateComposePort(service : Record<string, unknown>, containerPort : string, protocol : string, newHostPort : string, currentHostPort : string, hostIp : string) : string {
        const ports = service.ports;

        if (!Array.isArray(ports)) {
            throw new ValidationError("The service does not define editable ports");
        }

        for (let i = 0; i < ports.length; i++) {
            const port = ports[i];

            if (typeof port === "string") {
                const parsed = this.parseComposePortString(port);
                if (parsed && parsed.containerPort === containerPort && parsed.protocol === protocol && this.composePortBindingMatches(parsed.hostPort, parsed.hostIp, currentHostPort, hostIp)) {
                    ports[i] = this.stringifyComposePort(parsed, newHostPort);
                    service.ports = ports;
                    return parsed.hostPort;
                }
            } else if (port && typeof port === "object") {
                const portObj = port as Record<string, unknown>;
                const target = String(portObj.target || "");
                const portProtocol = String(portObj.protocol || "tcp");
                const published = String(portObj.published || "");
                const publishedHostIp = String(portObj.host_ip || portObj.hostIp || "");
                if (target === containerPort && portProtocol === protocol && this.composePortBindingMatches(published, publishedHostIp, currentHostPort, hostIp)) {
                    const oldHostPort = String(portObj.published || "");
                    portObj.published = newHostPort;
                    service.ports = ports;
                    return oldHostPort;
                }
            }
        }

        throw new ValidationError(`Port ${containerPort}/${protocol} was not found in compose service`);
    }

    private parseComposePortString(value : string) {
        const protocolSplit = value.split("/");
        const protocol = protocolSplit[1] || "tcp";
        const portValue = protocolSplit[0];
        const parts = portValue.split(":");

        if (parts.length < 2 || parts.length > 3) {
            return null;
        }

        return {
            hostIp: parts.length === 3 ? parts[0] : "",
            hostPort: parts.length === 3 ? parts[1] : parts[0],
            containerPort: parts.length === 3 ? parts[2] : parts[1],
            protocol,
        };
    }

    private stringifyComposePort(parsed : { hostIp: string; hostPort: string; containerPort: string; protocol: string }, newHostPort : string) {
        const protocolSuffix = parsed.protocol === "tcp" ? "" : `/${parsed.protocol}`;
        if (parsed.hostIp) {
            return `${parsed.hostIp}:${newHostPort}:${parsed.containerPort}${protocolSuffix}`;
        }
        return `${newHostPort}:${parsed.containerPort}${protocolSuffix}`;
    }

    private composePortBindingMatches(candidateHostPort : string, candidateHostIp : string, currentHostPort : string, hostIp : string) {
        if (!currentHostPort) {
            return true;
        }

        if (candidateHostPort !== currentHostPort) {
            return false;
        }

        if (!hostIp || candidateHostIp === hostIp) {
            return true;
        }

        return !candidateHostIp && [ "0.0.0.0", "::" ].includes(hostIp);
    }

    private findContainerPortBindingIndex(bindings : DockerPortBinding[], currentHostPort : string, hostIp : string) {
        if (!currentHostPort) {
            return 0;
        }

        const index = bindings.findIndex(binding => {
            return binding.HostPort === currentHostPort && (hostIp ? binding.HostIp === hostIp : true);
        });

        if (index < 0) {
            throw new ValidationError(`Port binding ${currentHostPort} was not found in container port bindings`);
        }

        return index;
    }

    private async assertHostPortAvailable(port : number, currentContainerId : string) {
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new ValidationError("Port must be an integer from 1 to 65535");
        }

        const containers = await this.getContainersForPortCheck();
        const conflictingContainer = containers.find(container => {
            return container.id !== currentContainerId && container.ports.some(item => item.hostPort === String(port));
        });

        if (conflictingContainer) {
            throw new ValidationError(`Port ${port} is already used by container ${conflictingContainer.name}`);
        }

        const currentContainer = containers.find(container => container.id === currentContainerId);
        const currentOwnsPort = currentContainer?.ports.some(item => item.hostPort === String(port));
        if (currentOwnsPort) {
            return;
        }

        await new Promise<void>((resolve, reject) => {
            const server = net.createServer()
                .once("error", () => reject(new ValidationError(`Port ${port} is already used by another host process`)))
                .once("listening", () => {
                    server.close(() => resolve());
                })
                .listen(port, "0.0.0.0");
        });
    }

    private async getContainersForPortCheck() {
        const psRows = this.parseJSONLines(await this.runDocker([ "ps", "-a", "--format", "json" ]));
        const ids = psRows
            .map(row => this.stringValue(row.ID))
            .filter((id): id is string => id.length > 0);

        if (ids.length === 0) {
            return [];
        }

        const inspectRows = JSON.parse(await this.runDocker([ "inspect", ...ids ])) as DockerContainerInspect[];
        return inspectRows.map(item => ({
            id: item.Id || "",
            imageId: item.Image || "",
            name: (item.Name || "").replace(/^\//, ""),
            ports: this.parsePorts(item.NetworkSettings?.Ports || {}),
        }));
    }

    private async getContainerStateSnapshot() {
        const psRows = this.parseJSONLines(await this.runDocker([ "ps", "-a", "--format", "json" ]));
        const ids = psRows
            .map(row => this.stringValue(row.ID))
            .filter((id): id is string => id.length > 0);

        if (ids.length === 0) {
            return [];
        }

        const inspectRows = JSON.parse(await this.runDocker([ "inspect", ...ids ])) as DockerContainerInspect[];
        return inspectRows.map(item => ({
            id: item.Id?.slice(0, 12) || "",
            name: (item.Name || "").replace(/^\//, ""),
            status: item.State?.Status || "unknown",
            running: Boolean(item.State?.Running),
            health: item.State?.Health?.Status || "",
            exitCode: typeof item.State?.ExitCode === "number" ? item.State.ExitCode : null,
        }));
    }

    private async cleanDeclaredCacheDirsForObject(inspect : DockerContainerInspect, cacheDirs : string[], objectType : string, objectId : string, socket? : DockgeSocket, startedAt? : number) {
        const result = await this.cleanDeclaredCacheDirsFromMounts(inspect, cacheDirs);
        if (result.cleanedDirs.length > 0) {
            await this.writeOperationLog("clean_cache", objectType, objectId, null, {
                cacheDirs: result.cleanedDirs,
            }, "success", undefined, socket, startedAt);
        }

        if (result.skippedDirs.length > 0) {
            await this.writeOperationLog("clean_cache_skipped", objectType, objectId, null, {
                cacheDirs: result.skippedDirs,
            }, "skipped", undefined, socket, startedAt);
        }
    }

    private async cleanDeclaredCacheDirsFromMounts(inspect : DockerContainerInspect, cacheDirs : string[]) : Promise<{ cleanedDirs: string[]; skippedDirs: Array<{ cacheDir: string; reason: string; source?: string }> }> {
        const cleanedDirs : string[] = [];
        const skippedDirs : Array<{ cacheDir: string; reason: string; source?: string }> = [];

        const entries = await this.previewDeclaredCacheDirsFromMounts(inspect, cacheDirs);
        for (const entry of entries) {
            if (!entry.eligible || !entry.source) {
                skippedDirs.push({ cacheDir: entry.cacheDir,
                    reason: entry.reason || "Cache directory is not eligible for cleanup",
                    source: entry.source });
                continue;
            }

            await this.cleanCacheDirectoryContents(entry.source);
            cleanedDirs.push(entry.cacheDir);
        }

        return {
            cleanedDirs,
            skippedDirs,
        };
    }

    private async previewDeclaredCacheDirsFromMounts(inspect : DockerContainerInspect, cacheDirs : string[]) {
        const mounts = inspect.Mounts || [];
        const entries : Array<{
            cacheDir: string;
            source?: string;
            eligible: boolean;
            reason?: string;
            estimatedBytes: number;
            fileCount: number;
            truncated: boolean;
        }> = [];

        for (const cacheDir of Array.from(new Set(cacheDirs.map(item => item.trim()).filter(Boolean)))) {
            const mount = mounts.find(item => item.Destination === cacheDir);
            if (!mount) {
                entries.push({ cacheDir,
                    eligible: false,
                    reason: "No mount matches the declared cache directory",
                    estimatedBytes: 0,
                    fileCount: 0,
                    truncated: false });
                continue;
            }
            const source = mount.Source || mount.Name;
            if (mount.Type !== "bind") {
                entries.push({ cacheDir,
                    source,
                    eligible: false,
                    reason: "Only bind-mounted cache directories can be cleaned",
                    estimatedBytes: 0,
                    fileCount: 0,
                    truncated: false });
                continue;
            }
            if (!mount.Source) {
                entries.push({ cacheDir,
                    eligible: false,
                    reason: "Bind mount source is missing",
                    estimatedBytes: 0,
                    fileCount: 0,
                    truncated: false });
                continue;
            }
            if (!this.isPathSafeForCacheCleanup(mount.Source)) {
                entries.push({ cacheDir,
                    source: mount.Source,
                    eligible: false,
                    reason: "Bind mount source is not a safe cleanup target",
                    estimatedBytes: 0,
                    fileCount: 0,
                    truncated: false });
                continue;
            }

            try {
                const sourcePath = await fs.promises.realpath(mount.Source);
                const stat = await fs.promises.lstat(mount.Source);
                if (stat.isSymbolicLink() || sourcePath !== path.resolve(mount.Source)) {
                    throw new ValidationError("Symbolic-link cache sources are not allowed");
                }
                if (!stat.isDirectory()) {
                    throw new ValidationError("Bind mount source is not a directory");
                }
                if (!this.isPathSafeForCacheCleanup(sourcePath)) {
                    throw new ValidationError("Resolved bind mount source is not a safe cleanup target");
                }
                const estimate = await this.measureCacheDirectory(sourcePath);
                entries.push({ cacheDir,
                    source: sourcePath,
                    eligible: true,
                    estimatedBytes: estimate.estimatedBytes,
                    fileCount: estimate.fileCount,
                    truncated: estimate.truncated });
            } catch (error) {
                entries.push({ cacheDir,
                    source: mount.Source,
                    eligible: false,
                    reason: error instanceof Error ? error.message : "Cache source cannot be inspected",
                    estimatedBytes: 0,
                    fileCount: 0,
                    truncated: false });
            }
        }

        return entries;
    }

    private async measureCacheDirectory(sourcePath : string) {
        const pending = [ sourcePath ];
        let estimatedBytes = 0;
        let fileCount = 0;
        let visitedEntries = 0;
        let truncated = false;

        while (pending.length > 0) {
            const current = pending.pop() as string;
            const children = await fs.promises.readdir(current, { withFileTypes: true });
            for (const child of children) {
                visitedEntries += 1;
                if (visitedEntries > 100000) {
                    truncated = true;
                    return { estimatedBytes,
                        fileCount,
                        truncated };
                }
                const childPath = path.join(current, child.name);
                if (child.isDirectory() && !child.isSymbolicLink()) {
                    pending.push(childPath);
                    continue;
                }
                const stat = await fs.promises.lstat(childPath);
                estimatedBytes += stat.size;
                fileCount += 1;
            }
        }

        return { estimatedBytes,
            fileCount,
            truncated };
    }

    private async cleanCacheDirectoryContents(sourcePath : string) {
        const resolved = await fs.promises.realpath(sourcePath);
        const stat = await fs.promises.lstat(sourcePath);
        if (stat.isSymbolicLink() || resolved !== path.resolve(sourcePath) || !stat.isDirectory() || !this.isPathSafeForCacheCleanup(resolved)) {
            throw new ValidationError("Cache source changed after preview and is no longer safe");
        }
        const children = await fs.promises.readdir(resolved);
        for (const child of children) {
            await fs.promises.rm(path.join(resolved, child), {
                recursive: true,
                force: true,
            });
        }
    }

    private isPathSafeForCacheCleanup(sourcePath : string) {
        if (!path.isAbsolute(sourcePath)) {
            return false;
        }

        const normalized = path.resolve(sourcePath);
        if (normalized === path.parse(normalized).root) {
            return false;
        }
        const canonical = normalized.replace(/\\/g, "/");
        const compared = process.platform === "win32" ? canonical.toLocaleLowerCase() : canonical;
        const protectedPaths = new Set([
            "/",
            "/app",
            "/app/data",
            "/bin",
            "/boot",
            "/dev",
            "/etc",
            "/home",
            "/lib",
            "/lib64",
            "/opt",
            "/proc",
            "/root",
            "/run",
            "/sbin",
            "/sys",
            "/tmp",
            "/usr",
            "/var",
            "/var/lib/docker",
            "/var/run",
        ]);

        if (protectedPaths.has(compared)) {
            return false;
        }

        const protectedPrefixes = [
            "/app/data/",
            "/bin/",
            "/boot/",
            "/dev/",
            "/etc/",
            "/lib/",
            "/lib64/",
            "/proc/",
            "/root/",
            "/run/",
            "/sbin/",
            "/sys/",
            "/usr/",
            "/var/lib/docker/",
            "/var/run/",
        ];

        return !protectedPrefixes.some(prefix => compared.startsWith(prefix));
    }

    private validateCacheContainerId(input : unknown) {
        const value = input && typeof input === "object" && !Array.isArray(input)
            ? (input as Record<string, unknown>).containerId
            : input;
        if (typeof value !== "string" || !value.trim() || value.length > 255 || /[\s\u0000-\u001f]/.test(value)) {
            throw new ValidationError("Container ID is invalid");
        }
        return value.trim();
    }

    private extractServiceCacheDirs(service : unknown) : string[] {
        if (!service || typeof service !== "object") {
            return [];
        }

        const serviceObj = service as Record<string, unknown>;
        const extension = serviceObj["x-dockerbridge"] as { cacheDirs?: unknown } | undefined;
        const rawCacheDirs = extension?.cacheDirs;

        return Array.isArray(rawCacheDirs) ? rawCacheDirs.filter((item): item is string => typeof item === "string") : [];
    }

    private extractContainerCacheDirs(container : DockerContainerInspect) : string[] {
        const labels = container.Config?.Labels || {};
        const raw = labels["dockerbridge.cacheDirs"] || labels["com.dockerbridge.cacheDirs"] || "";

        if (!raw) {
            return [];
        }

        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                return parsed.filter((item): item is string => typeof item === "string" && item.trim() !== "").map(item => item.trim());
            }
        } catch (e) {
            // Fall back to comma/newline separated labels for simple docker run usage.
        }

        return raw.split(/[\n,]/)
            .map(item => item.trim())
            .filter(Boolean);
    }

    private assertNoDuplicatePublishedPorts(service : Record<string, unknown>) {
        const ports = service.ports;
        if (!Array.isArray(ports)) {
            return;
        }

        const publishedPorts = new Set<string>();
        for (const port of ports) {
            const publishedPort = this.getPublishedPort(port);
            if (!publishedPort) {
                continue;
            }

            if (publishedPorts.has(publishedPort)) {
                throw new ValidationError(`Duplicate host port ${publishedPort} in the same service`);
            }
            publishedPorts.add(publishedPort);
        }
    }

    private assertNoDuplicateContainerPortBindings(portBindings : Record<string, DockerPortBinding[] | null>) {
        const publishedPorts = new Set<string>();
        for (const bindings of Object.values(portBindings)) {
            for (const binding of bindings || []) {
                if (!binding.HostPort) {
                    continue;
                }

                const key = `${binding.HostIp || "0.0.0.0"}:${binding.HostPort}`;
                if (publishedPorts.has(key)) {
                    throw new ValidationError(`Duplicate host port ${binding.HostPort} in the same container`);
                }
                publishedPorts.add(key);
            }
        }
    }

    private clonePortBindings(portBindings : Record<string, DockerPortBinding[] | null>) {
        return Object.fromEntries(Object.entries(portBindings).map(([ key, bindings ]) => [
            key,
            bindings ? bindings.map(binding => ({ ...binding })) : null,
        ]));
    }

    private getEffectivePortBindings(inspect : DockerContainerInspect) {
        const result = this.clonePortBindings(inspect.HostConfig?.PortBindings || {});
        const runtimePorts = inspect.NetworkSettings?.Ports || {};

        for (const [ key, bindings ] of Object.entries(runtimePorts)) {
            if (!bindings || bindings.length === 0) {
                continue;
            }

            const configuredBindings = result[key];
            if (!configuredBindings || configuredBindings.length === 0) {
                result[key] = bindings.map(binding => ({ ...binding }));
                continue;
            }

            result[key] = configuredBindings.map((binding, index) => {
                const runtimeBinding = bindings[index] || bindings[0];
                return {
                    HostIp: binding.HostIp || runtimeBinding.HostIp,
                    HostPort: binding.HostPort || runtimeBinding.HostPort,
                };
            });
        }

        return result;
    }

    private getPublishedPort(port : unknown) : string {
        if (typeof port === "string") {
            return this.parseComposePortString(port)?.hostPort || "";
        }

        if (port && typeof port === "object") {
            const portObj = port as Record<string, unknown>;
            return String(portObj.published || "");
        }

        return "";
    }

    private findComposeFile(stackPath : string) : string {
        for (const filename of acceptedComposeFileNames) {
            const file = path.join(stackPath, filename);
            if (fs.existsSync(file)) {
                return file;
            }
        }

        throw new ValidationError("Managed compose file was not found for this stack");
    }

    private createBackupFile(server : DockgeServer, sourceFile : string, scope : string) {
        const backupDir = path.join(server.config.dataDir, "dockerbridge-backups", scope);
        fs.mkdirSync(backupDir, {
            recursive: true,
        });

        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        return path.join(backupDir, `${path.basename(sourceFile)}.${timestamp}.bak`);
    }

    private validatePortUpdatePayload(payload : unknown) : DockerBridgePortUpdate {
        if (!payload || typeof payload !== "object") {
            throw new ValidationError("Invalid port update payload");
        }

        const data = payload as Record<string, unknown>;
        const containerId = this.stringValue(data.containerId);
        const containerPort = this.stringValue(data.containerPort);
        const protocol = this.stringValue(data.protocol) || "tcp";
        const hostPort = this.stringValue(data.hostPort);
        const currentHostPort = this.stringValue(data.currentHostPort);
        const hostIp = this.stringValue(data.hostIp);

        if (!containerId || !containerPort || !hostPort) {
            throw new ValidationError("Container ID, container port and host port are required");
        }

        return {
            containerId,
            containerPort,
            protocol,
            hostPort,
            currentHostPort,
            hostIp,
        };
    }

    private validateRollbackPayload(payload : unknown) : DockerBridgeRollback {
        if (!payload || typeof payload !== "object") {
            throw new ValidationError("Invalid rollback payload");
        }

        const data = payload as Record<string, unknown>;
        const rollback = {
            kind: this.stringValue(data.kind) === "container" ? "container" as const : "compose" as const,
            backupFile: this.stringValue(data.backupFile),
            composeFile: this.stringValue(data.composeFile) || undefined,
            stack: this.stringValue(data.stack) || undefined,
            service: this.stringValue(data.service) || undefined,
            containerName: this.stringValue(data.containerName) || undefined,
        };

        if (!rollback.backupFile) {
            throw new ValidationError("Rollback payload is incomplete");
        }

        if (rollback.kind === "compose" && (!rollback.composeFile || !rollback.stack || !rollback.service)) {
            throw new ValidationError("Compose rollback payload is incomplete");
        }

        return rollback;
    }

    private assertRollbackBackupPath(server : DockgeServer, rollback : DockerBridgeRollback) {
        const backupRoot = path.resolve(server.config.dataDir, "dockerbridge-backups");
        const backupFile = path.resolve(rollback.backupFile);
        const relative = path.relative(backupRoot, backupFile);
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
            throw new ValidationError("Rollback backup must be a DockerBridge-managed backup file");
        }
        const expectedScope = rollback.kind === "compose" ? "ports" : "container-ports";
        if (relative.split(path.sep)[0] !== expectedScope || !backupFile.endsWith(".bak")) {
            throw new ValidationError("Rollback backup scope is invalid");
        }
        if (!fs.existsSync(backupFile) || !fs.statSync(backupFile).isFile()) {
            throw new ValidationError("Rollback backup file was not found");
        }
    }

    private validateLogTail(options : unknown) {
        if (!options || typeof options === "function") {
            return 300;
        }

        if (typeof options !== "object") {
            throw new ValidationError("Invalid log options");
        }

        const tail = Number((options as { tail?: unknown }).tail ?? 300);
        if (!Number.isInteger(tail) || tail < 50 || tail > 5000) {
            throw new ValidationError("Log tail must be an integer between 50 and 5000");
        }

        return tail;
    }

    private validateOperationLogQuery(input : unknown) : DockerBridgeOperationLogQuery {
        if (input == null) {
            input = {};
        }
        if (typeof input !== "object" || Array.isArray(input)) {
            throw new ValidationError("Invalid operation log query");
        }

        const data = input as Record<string, unknown>;
        const page = Number(data.page ?? 1);
        const pageSize = Number(data.pageSize ?? 50);
        const search = this.stringValue(data.search).trim().slice(0, 160);
        const action = this.stringValue(data.action).trim().slice(0, 80);
        const objectType = this.stringValue(data.objectType).trim().slice(0, 80);
        const result = this.stringValue(data.result).trim();
        const from = this.validateOperationLogDate(data.from, "Start time");
        const to = this.validateOperationLogDate(data.to, "End time");

        if (!Number.isInteger(page) || page < 1) {
            throw new ValidationError("Page must be a positive integer");
        }
        if (!Number.isInteger(pageSize) || pageSize < 10 || pageSize > 200) {
            throw new ValidationError("Page size must be between 10 and 200");
        }
        if (result && ![ "success", "failed", "skipped" ].includes(result)) {
            throw new ValidationError("Invalid operation result filter");
        }
        if (from && to && from > to) {
            throw new ValidationError("Start time must not be later than end time");
        }

        return {
            page,
            pageSize,
            search,
            action,
            objectType,
            result,
            from,
            to,
        };
    }

    private validateOperationLogDate(value : unknown, label : string) {
        const text = this.stringValue(value).trim();
        if (!text) {
            return "";
        }
        const date = new Date(text);
        if (Number.isNaN(date.getTime())) {
            throw new ValidationError(`${label} is invalid`);
        }
        return date.toISOString();
    }

    private validateImageReference(value : unknown, label : string) {
        if (typeof value !== "string") {
            throw new ValidationError(`${label} is required`);
        }
        const reference = value.trim();
        if (!reference || reference.length > 512 || reference.startsWith("-") || /[\s\u0000-\u001f]/.test(reference)) {
            throw new ValidationError(`${label} is invalid`);
        }
        return reference;
    }

    private validateImagePruneMode(input : unknown) {
        if (input == null) {
            return false;
        }
        if (typeof input !== "object" || Array.isArray(input)) {
            throw new ValidationError("Invalid image prune options");
        }
        const allUnused = (input as Record<string, unknown>).allUnused ?? false;
        if (typeof allUnused !== "boolean") {
            throw new ValidationError("Image prune mode must be a boolean");
        }
        return allUnused;
    }

    private async inspectContainer(containerId : string) : Promise<DockerContainerInspect> {
        const result = JSON.parse(await this.runDocker([ "inspect", containerId ])) as DockerContainerInspect[];
        if (!result[0]) {
            throw new ValidationError("Container not found");
        }
        return result[0];
    }

    private async writeOperationLog(actionType : string, objectType : string, objectId : string, before : unknown, after : unknown, result : "success" | "failed" | "skipped", error? : unknown, socket? : DockgeSocket, startedAt? : number) {
        await safelyWriteOperationLog({
            actionType,
            objectType,
            objectId,
            before,
            after,
            result,
            error,
            socket,
            startedAt,
        });
    }

    private getDockerDaemonConfigPath() {
        return process.env.DOCKERBRIDGE_DAEMON_JSON || "/etc/docker/daemon.json";
    }

    private getDockerDaemonConfigAccess() : DockerBridgeDockerConfigAccess {
        if (!process.env.DOCKERBRIDGE_DAEMON_JSON) {
            return {
                editable: false,
                reason: "Set DOCKERBRIDGE_DAEMON_JSON to an explicitly mounted host daemon.json path to enable editing.",
            };
        }

        const configPath = this.getDockerDaemonConfigPath();
        try {
            const dir = path.dirname(configPath);
            if (!fs.existsSync(dir)) {
                return {
                    editable: false,
                    reason: `Config directory does not exist: ${dir}`,
                };
            }

            fs.accessSync(dir, fs.constants.W_OK);
            if (fs.existsSync(configPath)) {
                fs.accessSync(configPath, fs.constants.R_OK | fs.constants.W_OK);
            }
            return {
                editable: true,
            };
        } catch (e) {
            return {
                editable: false,
                reason: this.errorMessage("Docker daemon config is not writable", e).replace(/^: /, ""),
            };
        }
    }

    private assertDockerDaemonConfigEditable() {
        const access = this.getDockerDaemonConfigAccess();
        if (!access.editable) {
            throw new ValidationError(access.reason || "Docker daemon config editing is not enabled");
        }
    }

    private getDockerRestartCommand() {
        return process.env.DOCKERBRIDGE_DOCKER_RESTART_CMD || "systemctl restart docker";
    }

    private readDockerDaemonConfig() : Record<string, unknown> {
        const configPath = this.getDockerDaemonConfigPath();

        if (!fs.existsSync(configPath)) {
            return {};
        }

        const content = fs.readFileSync(configPath, "utf-8").trim();
        if (!content) {
            return {};
        }

        const config = JSON.parse(content);
        if (!config || typeof config !== "object" || Array.isArray(config)) {
            throw new ValidationError("Docker daemon config must be a JSON object");
        }

        return config as Record<string, unknown>;
    }

    private configToForm(config : Record<string, unknown>) : DockerBridgeDockerConfigForm {
        const proxies = config.proxies && typeof config.proxies === "object" ? config.proxies as Record<string, unknown> : {};
        const logOpts = config["log-opts"] && typeof config["log-opts"] === "object" ? config["log-opts"] as Record<string, unknown> : {};

        return {
            registryMirrors: this.stringArrayValue(config["registry-mirrors"]),
            httpProxy: this.stringValue(proxies["http-proxy"]),
            httpsProxy: this.stringValue(proxies["https-proxy"]),
            noProxy: this.stringValue(proxies["no-proxy"]),
            dns: this.stringArrayValue(config.dns),
            insecureRegistries: this.stringArrayValue(config["insecure-registries"]),
            logDriver: this.stringValue(config["log-driver"]),
            logMaxSize: this.stringValue(logOpts["max-size"]),
            logMaxFile: this.stringValue(logOpts["max-file"]),
        };
    }

    private mergeDockerConfig(current : Record<string, unknown>, form : DockerBridgeDockerConfigForm) {
        const next = {
            ...current,
        };

        this.setArrayOrDelete(next, "registry-mirrors", form.registryMirrors);
        this.setArrayOrDelete(next, "dns", form.dns);
        this.setArrayOrDelete(next, "insecure-registries", form.insecureRegistries);
        this.setStringOrDelete(next, "log-driver", form.logDriver);

        const proxies : Record<string, string> = {};
        if (form.httpProxy) {
            proxies["http-proxy"] = form.httpProxy;
        }
        if (form.httpsProxy) {
            proxies["https-proxy"] = form.httpsProxy;
        }
        if (form.noProxy) {
            proxies["no-proxy"] = form.noProxy;
        }
        if (Object.keys(proxies).length > 0) {
            next.proxies = proxies;
        } else {
            delete next.proxies;
        }

        const logOpts : Record<string, string> = {};
        if (form.logMaxSize) {
            logOpts["max-size"] = form.logMaxSize;
        }
        if (form.logMaxFile) {
            logOpts["max-file"] = form.logMaxFile;
        }
        if (Object.keys(logOpts).length > 0) {
            next["log-opts"] = logOpts;
        } else {
            delete next["log-opts"];
        }

        JSON.parse(JSON.stringify(next));
        return next;
    }

    private validateDockerConfigForm(form : unknown) : DockerBridgeDockerConfigForm {
        if (!form || typeof form !== "object") {
            throw new ValidationError("Invalid Docker config form");
        }

        const data = form as Record<string, unknown>;
        const validated = {
            registryMirrors: this.stringArrayValue(data.registryMirrors),
            httpProxy: this.stringValue(data.httpProxy),
            httpsProxy: this.stringValue(data.httpsProxy),
            noProxy: this.stringValue(data.noProxy),
            dns: this.stringArrayValue(data.dns),
            insecureRegistries: this.stringArrayValue(data.insecureRegistries),
            logDriver: this.stringValue(data.logDriver),
            logMaxSize: this.stringValue(data.logMaxSize),
            logMaxFile: this.stringValue(data.logMaxFile),
        };

        this.validateDockerConfigSemantics(validated);
        return validated;
    }

    private validateDockerConfigSemantics(form : DockerBridgeDockerConfigForm) {
        for (const mirror of form.registryMirrors) {
            this.assertURL(mirror, "Registry mirror");
        }

        for (const proxy of [ form.httpProxy, form.httpsProxy ]) {
            if (proxy) {
                this.assertURL(proxy, "Proxy");
            }
        }

        for (const dns of form.dns) {
            if (net.isIP(dns) === 0) {
                throw new ValidationError(`DNS must be an IP address: ${dns}`);
            }
        }

        for (const registry of form.insecureRegistries) {
            if (!/^[a-zA-Z0-9.-]+(?::[0-9]{1,5})?$/.test(registry) && !/^([0-9]{1,3}\.){3}[0-9]{1,3}(?::[0-9]{1,5})?$/.test(registry)) {
                throw new ValidationError(`Invalid insecure registry: ${registry}`);
            }
        }

        const allowedLogDrivers = [ "json-file", "local", "journald", "syslog", "none" ];
        if (form.logDriver && !allowedLogDrivers.includes(form.logDriver)) {
            throw new ValidationError(`Unsupported log driver: ${form.logDriver}`);
        }

        if (form.logMaxSize && !/^[1-9][0-9]*(k|m|g)$/i.test(form.logMaxSize)) {
            throw new ValidationError("Log max size must look like 10m, 100m or 1g");
        }

        if (form.logMaxFile && (!/^[1-9][0-9]*$/.test(form.logMaxFile) || Number(form.logMaxFile) > 1000)) {
            throw new ValidationError("Log max file must be a positive integer");
        }
    }

    private assertURL(value : string, label : string) {
        try {
            const url = new URL(value);
            if (![ "http:", "https:" ].includes(url.protocol)) {
                throw new Error("unsupported protocol");
            }
        } catch (e) {
            throw new ValidationError(`${label} must be a valid http or https URL: ${value}`);
        }
    }

    private backupDockerConfig(server : DockgeServer, configPath : string) {
        const backupDir = path.join(server.config.dataDir, "dockerbridge-backups", "docker-config");
        fs.mkdirSync(backupDir, {
            recursive: true,
        });

        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const backupFile = path.join(backupDir, `daemon.json.${timestamp}.bak`);

        if (fs.existsSync(configPath)) {
            fs.copyFileSync(configPath, backupFile);
        } else {
            fs.writeFileSync(backupFile, "{}\n");
        }

        return backupFile;
    }

    private getDockerConfigBackups(server : DockgeServer) {
        const backupDir = path.join(server.config.dataDir, "dockerbridge-backups", "docker-config");
        if (!fs.existsSync(backupDir)) {
            return [];
        }

        return fs.readdirSync(backupDir)
            .filter(filename => filename.endsWith(".bak"))
            .map(filename => {
                const file = path.join(backupDir, filename);
                const stat = fs.statSync(file);
                return {
                    file,
                    filename,
                    createdAt: stat.mtime.toISOString(),
                    size: stat.size,
                };
            })
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }

    private assertDockerConfigBackupPath(server : DockgeServer, backupFile : string) {
        const backupRoot = path.resolve(server.config.dataDir, "dockerbridge-backups", "docker-config");
        const resolvedBackup = path.resolve(backupFile);
        const relative = path.relative(backupRoot, resolvedBackup);
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || relative.includes(path.sep) || !resolvedBackup.endsWith(".bak")) {
            throw new ValidationError("Docker config backup must be a DockerBridge-managed backup file");
        }
        if (!fs.existsSync(resolvedBackup) || !fs.statSync(resolvedBackup).isFile()) {
            throw new ValidationError("Docker config backup file was not found");
        }
    }

    private setArrayOrDelete(target : Record<string, unknown>, key : string, value : string[]) {
        if (value.length > 0) {
            target[key] = value;
        } else {
            delete target[key];
        }
    }

    private setStringOrDelete(target : Record<string, unknown>, key : string, value : string) {
        if (value) {
            target[key] = value;
        } else {
            delete target[key];
        }
    }

    private async runDocker(args : string[], cwd? : string) : Promise<string> {
        const res = await childProcessAsync.spawn("docker", args, {
            encoding: "utf-8",
            maxBuffer: 32 * 1024 * 1024,
            cwd,
        });

        return res.stdout?.toString() || "";
    }

    private runDockerStreaming(args : string[], onProgress : (stream: "stdout" | "stderr", message: string) => void, cwd? : string) : Promise<string> {
        return new Promise((resolve, reject) => {
            const process = spawnProcess("docker", args, {
                cwd,
                windowsHide: true,
            });
            const chunks : Buffer[] = [];
            let bufferedBytes = 0;
            let settled = false;
            const finish = (error? : Error) => {
                if (settled) {
                    return;
                }
                settled = true;
                const output = Buffer.concat(chunks).toString("utf-8");
                if (error) {
                    reject(error.message ? new Error(`${error.message}${output.trim() ? `\n${output.trim()}` : ""}`) : error);
                } else {
                    resolve(output);
                }
            };
            const receive = (stream : "stdout" | "stderr", chunk : Buffer) => {
                bufferedBytes += chunk.length;
                if (bufferedBytes > 32 * 1024 * 1024) {
                    process.kill();
                    finish(new Error("Docker output exceeded the 32 MiB safety limit"));
                    return;
                }
                chunks.push(chunk);
                const message = chunk.toString("utf-8").replace(/\r/g, "\n").trim();
                if (message) {
                    onProgress(stream, message.slice(-12000));
                }
            };

            process.stdout.on("data", (chunk : Buffer) => receive("stdout", chunk));
            process.stderr.on("data", (chunk : Buffer) => receive("stderr", chunk));
            process.on("error", error => finish(error));
            process.on("close", code => {
                if (code === 0) {
                    finish();
                    return;
                }
                finish(new Error(`docker ${args[0] || "command"} exited with code ${code ?? "unknown"}`));
            });
        });
    }

    private runDockerLogs(containerId : string, tail : number) : Promise<string> {
        return new Promise((resolve, reject) => {
            const process = spawnProcess("docker", [ "logs", "--tail", String(tail), containerId ], {
                windowsHide: true,
            });
            const chunks : Buffer[] = [];

            process.stdout.on("data", (chunk : Buffer) => chunks.push(chunk));
            process.stderr.on("data", (chunk : Buffer) => chunks.push(chunk));
            process.on("error", reject);
            process.on("close", code => {
                const output = Buffer.concat(chunks).toString("utf-8");
                if (code === 0) {
                    resolve(output);
                    return;
                }

                reject(new Error(output.trim() || `docker logs exited with code ${code ?? "unknown"}`));
            });
        });
    }

    private getHostCPUPercent() : number {
        const cpus = os.cpus().length || 1;
        const load = os.loadavg()[0] || 0;
        return Math.min(100, Math.round((load / cpus) * 1000) / 10);
    }

    private shortImageId(imageId : string) : string {
        return imageId.replace(/^sha256:/, "").slice(0, 12);
    }

    private stringValue(value : unknown) : string {
        return typeof value === "string" ? value : "";
    }

    private stringArrayValue(value : unknown) : string[] {
        if (!Array.isArray(value)) {
            return [];
        }

        return value.filter((item): item is string => typeof item === "string" && item.trim() !== "")
            .map(item => item.trim());
    }

    private errorMessage(prefix : string, error : unknown) : string {
        if (error instanceof Error) {
            return `${prefix}: ${error.message}`;
        }
        return prefix;
    }
}
