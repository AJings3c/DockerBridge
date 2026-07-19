import { AgentSocketHandler } from "../agent-socket-handler";
import { DockgeServer } from "../dockge-server";
import { callbackError, callbackResult, checkLogin, DockgeSocket, ValidationError } from "../util-server";
import { Stack } from "../stack";
import { AgentSocket } from "../../common/agent-socket";
import { safelyWriteOperationLog } from "../operation-log";
import { spawn as spawnProcess } from "node:child_process";
import yaml from "yaml";
import { ComposeDraftPayload, ComposeEditor } from "../compose-editor";

type ComposeConfig = Record<string, unknown>;

export class DockerSocketHandler extends AgentSocketHandler {
    create(socket : DockgeSocket, server : DockgeServer, agentSocket : AgentSocket) {
        // Do not call super.create()

        agentSocket.on("deployStack", async (name : unknown, composeYAML : unknown, composeENV : unknown, isAdd : unknown, callback) => {
            try {
                checkLogin(socket);
                const stack = await this.saveStack(server, name, composeYAML, composeENV, isAdd, "deploy");
                await stack.deploy(socket);
                server.sendStackList();
                callbackResult({
                    ok: true,
                    msg: "Deployed",
                    msgi18n: true,
                }, callback);
                stack.joinCombinedTerminal(socket);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("saveStack", async (name : unknown, composeYAML : unknown, composeENV : unknown, isAdd : unknown, callback) => {
            try {
                checkLogin(socket);
                await this.saveStack(server, name, composeYAML, composeENV, isAdd, "save");
                callbackResult({
                    ok: true,
                    msg: "Saved",
                    msgi18n: true,
                }, callback);
                server.sendStackList();
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("deleteStack", async (name : unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof(name) !== "string") {
                    throw new ValidationError("Name must be a string");
                }
                const stack = await Stack.getStack(server, name);

                try {
                    await stack.delete(socket);
                } catch (e) {
                    server.sendStackList();
                    throw e;
                }

                server.sendStackList();
                callbackResult({
                    ok: true,
                    msg: "Deleted",
                    msgi18n: true,
                }, callback);

            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("getStack", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);

                if (stack.isManagedByDockge) {
                    stack.joinCombinedTerminal(socket);
                }

                callbackResult({
                    ok: true,
                    stack: await stack.toJSON(socket.endpoint),
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("getComposeEditor", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof stackName !== "string") {
                    throw new ValidationError("Compose project name must be a string");
                }
                callbackResult({ ok: true,
                    editor: await new ComposeEditor(server).load(stackName) }, callback);
            } catch (error) {
                callbackError(error, callback);
            }
        });

        agentSocket.on("previewComposeEditorDraft", async (payload : unknown, callback) => {
            try {
                checkLogin(socket);
                callbackResult({ ok: true,
                    preview: await new ComposeEditor(server).preview(this.composeDraft(payload)) }, callback);
            } catch (error) {
                callbackError(error, callback);
            }
        });

        agentSocket.on("saveComposeEditorDraft", async (payload : unknown, callback) => {
            const startedAt = Date.now();
            let name = "unknown";
            try {
                checkLogin(socket);
                const request = this.composeDraft(payload);
                const deploy = this.booleanProperty(payload, "deploy");
                name = request.name;
                const result = await new ComposeEditor(server).commit(request, deploy ? "deploy" : "save");
                if (deploy) {
                    try {
                        await result.stack.deploy(socket);
                    } catch (deployError) {
                        await safelyWriteOperationLog({ actionType: "deploy_compose_revision",
                            objectType: "compose_stack",
                            objectId: name,
                            after: { revisionId: result.revision.id,
                                saved: true,
                                deployed: false },
                            result: "failed",
                            error: deployError,
                            socket,
                            startedAt });
                        callbackResult({ ok: false,
                            code: "DEPLOY_FAILED_AFTER_SAVE",
                            saved: true,
                            revision: result.revision,
                            previousRevision: result.previousRevision,
                            sourceVersion: result.sourceVersion,
                            revisions: result.revisions,
                            msg: deployError instanceof Error ? deployError.message : String(deployError) }, callback);
                        server.sendStackList();
                        return;
                    }
                }
                await safelyWriteOperationLog({ actionType: deploy ? "deploy_compose_revision" : "save_compose_revision",
                    objectType: "compose_stack",
                    objectId: name,
                    after: { revisionId: result.revision.id,
                        sourceVersion: result.sourceVersion,
                        deployed: deploy },
                    result: "success",
                    socket,
                    startedAt });
                callbackResult({ ok: true,
                    revision: result.revision,
                    previousRevision: result.previousRevision,
                    sourceVersion: result.sourceVersion,
                    revisions: result.revisions,
                    deployed: deploy,
                    msg: deploy ? "Compose project saved and deployed" : "Compose draft saved" }, callback);
                server.sendStackList();
                if (deploy) {
                    result.stack.joinCombinedTerminal(socket);
                }
            } catch (error) {
                await safelyWriteOperationLog({ actionType: "save_compose_revision",
                    objectType: "compose_stack",
                    objectId: name,
                    result: "failed",
                    error,
                    socket,
                    startedAt });
                callbackError(error, callback);
            }
        });

        agentSocket.on("getComposeRevisions", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof stackName !== "string") {
                    throw new ValidationError("Compose project name must be a string");
                }
                callbackResult({ ok: true,
                    revisions: await new ComposeEditor(server).list(stackName) }, callback);
            } catch (error) {
                callbackError(error, callback);
            }
        });

        agentSocket.on("previewComposeRevision", async (stackName : unknown, revisionId : unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof stackName !== "string" || typeof revisionId !== "string") {
                    throw new ValidationError("Compose project and revision IDs must be strings");
                }
                callbackResult({ ok: true,
                    preview: await new ComposeEditor(server).previewRevision(stackName, revisionId) }, callback);
            } catch (error) {
                callbackError(error, callback);
            }
        });

        agentSocket.on("restoreComposeRevision", async (payload : unknown, callback) => {
            const startedAt = Date.now();
            let name = "unknown";
            try {
                checkLogin(socket);
                const request = this.object(payload);
                if (typeof request.name !== "string" || typeof request.revisionId !== "string" || typeof request.expectedSourceVersion !== "string" || typeof request.deploy !== "boolean") {
                    throw new ValidationError("Invalid Compose revision restore request");
                }
                name = request.name;
                const result = await new ComposeEditor(server).restoreRevision(request.name, request.revisionId, request.expectedSourceVersion);
                if (request.deploy) {
                    try {
                        await result.stack.deploy(socket);
                    } catch (deployError) {
                        await safelyWriteOperationLog({ actionType: "restore_compose_revision",
                            objectType: "compose_stack",
                            objectId: name,
                            after: { fromRevisionId: request.revisionId,
                                revisionId: result.revision.id,
                                saved: true,
                                deployed: false },
                            result: "failed",
                            error: deployError,
                            socket,
                            startedAt });
                        callbackResult({ ok: false,
                            code: "DEPLOY_FAILED_AFTER_SAVE",
                            saved: true,
                            revision: result.revision,
                            previousRevision: result.previousRevision,
                            sourceVersion: result.sourceVersion,
                            revisions: result.revisions,
                            msg: deployError instanceof Error ? deployError.message : String(deployError) }, callback);
                        server.sendStackList();
                        return;
                    }
                }
                await safelyWriteOperationLog({ actionType: "restore_compose_revision",
                    objectType: "compose_stack",
                    objectId: name,
                    before: { revisionId: result.previousRevision?.id },
                    after: { fromRevisionId: request.revisionId,
                        revisionId: result.revision.id,
                        sourceVersion: result.sourceVersion,
                        deployed: request.deploy },
                    result: "success",
                    socket,
                    startedAt });
                callbackResult({ ok: true,
                    revision: result.revision,
                    previousRevision: result.previousRevision,
                    sourceVersion: result.sourceVersion,
                    revisions: result.revisions,
                    deployed: request.deploy,
                    msg: request.deploy ? "Compose revision restored and deployed" : "Compose revision restored as draft" }, callback);
                server.sendStackList();
                if (request.deploy) {
                    result.stack.joinCombinedTerminal(socket);
                }
            } catch (error) {
                await safelyWriteOperationLog({ actionType: "restore_compose_revision",
                    objectType: "compose_stack",
                    objectId: name,
                    result: "failed",
                    error,
                    socket,
                    startedAt });
                callbackError(error, callback);
            }
        });

        agentSocket.on("getStackRuntimeDetail", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof stackName !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);
                const config = this.readComposeConfig(stack);
                const statuses = await stack.getServiceStatusList();
                const services = this.composeServices(config, statuses);
                callbackResult({
                    ok: true,
                    detail: {
                        name: stack.name,
                        endpoint: socket.endpoint,
                        composeFilePath: stack.composeFilePath,
                        discovered: stack.isDiscoveredCompose,
                        services,
                        serviceCount: services.length,
                        runningCount: services.filter(service => service.running > 0).length,
                        networkNames: this.objectKeys(config.networks),
                        volumeNames: this.objectKeys(config.volumes),
                    },
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("getStackServiceLogs", async (stackName : unknown, serviceName : unknown, options : unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof stackName !== "string" || typeof serviceName !== "string") {
                    throw new ValidationError("Stack name and service name must be strings");
                }

                const tail = this.validateLogTail(options);
                const stack = await Stack.getStack(server, stackName);
                const config = this.readComposeConfig(stack);
                const services = this.configObject(config.services);
                if (!(serviceName in services)) {
                    throw new ValidationError(`Service ${serviceName} was not found in Compose project ${stackName}`);
                }

                const logs = await this.runComposeLogs(stack, serviceName, tail);
                callbackResult({
                    ok: true,
                    logs,
                    tail,
                    service: serviceName,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // requestStackList
        agentSocket.on("requestStackList", async (callback) => {
            try {
                checkLogin(socket);
                server.sendStackList();
                callbackResult({
                    ok: true,
                    msg: "Updated",
                    msgi18n: true,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // startStack
        agentSocket.on("startStack", async (stackName : unknown, callback) => {
            const startedAt = Date.now();
            const objectId = typeof stackName === "string" ? stackName : "";
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);
                await stack.start(socket);
                await safelyWriteOperationLog({ actionType: "start_stack",
                    objectType: "compose_stack",
                    objectId: stackName,
                    after: { action: "start" },
                    result: "success",
                    socket,
                    startedAt });
                callbackResult({
                    ok: true,
                    msg: "Started",
                    msgi18n: true,
                }, callback);
                server.sendStackList();

                stack.joinCombinedTerminal(socket);

            } catch (e) {
                await safelyWriteOperationLog({ actionType: "start_stack",
                    objectType: "compose_stack",
                    objectId,
                    after: { action: "start" },
                    result: "failed",
                    error: e,
                    socket,
                    startedAt });
                callbackError(e, callback);
            }
        });

        // stopStack
        agentSocket.on("stopStack", async (stackName : unknown, callback) => {
            const startedAt = Date.now();
            const objectId = typeof stackName === "string" ? stackName : "";
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);
                await stack.stop(socket);
                await safelyWriteOperationLog({ actionType: "stop_stack",
                    objectType: "compose_stack",
                    objectId: stackName,
                    after: { action: "stop" },
                    result: "success",
                    socket,
                    startedAt });
                callbackResult({
                    ok: true,
                    msg: "Stopped",
                    msgi18n: true,
                }, callback);
                server.sendStackList();

                stack.leaveCombinedTerminal(socket);
            } catch (e) {
                await safelyWriteOperationLog({ actionType: "stop_stack",
                    objectType: "compose_stack",
                    objectId,
                    after: { action: "stop" },
                    result: "failed",
                    error: e,
                    socket,
                    startedAt });
                callbackError(e, callback);
            }
        });

        // restartStack
        agentSocket.on("restartStack", async (stackName : unknown, callback) => {
            const startedAt = Date.now();
            const objectId = typeof stackName === "string" ? stackName : "";
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);
                await stack.restart(socket);
                await safelyWriteOperationLog({ actionType: "restart_stack",
                    objectType: "compose_stack",
                    objectId: stackName,
                    after: { action: "restart" },
                    result: "success",
                    socket,
                    startedAt });
                callbackResult({
                    ok: true,
                    msg: "Restarted",
                    msgi18n: true,
                }, callback);
                server.sendStackList();
            } catch (e) {
                await safelyWriteOperationLog({ actionType: "restart_stack",
                    objectType: "compose_stack",
                    objectId,
                    after: { action: "restart" },
                    result: "failed",
                    error: e,
                    socket,
                    startedAt });
                callbackError(e, callback);
            }
        });

        // updateStack
        agentSocket.on("updateStack", async (stackName : unknown, callback) => {
            const startedAt = Date.now();
            const objectId = typeof stackName === "string" ? stackName : "";
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);
                await stack.update(socket);
                await safelyWriteOperationLog({ actionType: "update_stack",
                    objectType: "compose_stack",
                    objectId: stackName,
                    after: { action: "update" },
                    result: "success",
                    socket,
                    startedAt });
                callbackResult({
                    ok: true,
                    msg: "Updated",
                    msgi18n: true,
                }, callback);
                server.sendStackList();
            } catch (e) {
                await safelyWriteOperationLog({ actionType: "update_stack",
                    objectType: "compose_stack",
                    objectId,
                    after: { action: "update" },
                    result: "failed",
                    error: e,
                    socket,
                    startedAt });
                callbackError(e, callback);
            }
        });

        // down stack
        agentSocket.on("downStack", async (stackName : unknown, callback) => {
            const startedAt = Date.now();
            const objectId = typeof stackName === "string" ? stackName : "";
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);
                await stack.down(socket);
                await safelyWriteOperationLog({ actionType: "down_stack",
                    objectType: "compose_stack",
                    objectId: stackName,
                    after: { action: "down" },
                    result: "success",
                    socket,
                    startedAt });
                callbackResult({
                    ok: true,
                    msg: "Downed",
                    msgi18n: true,
                }, callback);
                server.sendStackList();
            } catch (e) {
                await safelyWriteOperationLog({ actionType: "down_stack",
                    objectType: "compose_stack",
                    objectId,
                    after: { action: "down" },
                    result: "failed",
                    error: e,
                    socket,
                    startedAt });
                callbackError(e, callback);
            }
        });

        // Services status
        agentSocket.on("serviceStatusList", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                const stack = await Stack.getStack(server, stackName, true);
                const serviceStatusList = Object.fromEntries(await stack.getServiceStatusList());
                callbackResult({
                    ok: true,
                    serviceStatusList,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Docker stats
        agentSocket.on("dockerStats", async (callback) => {
            try {
                checkLogin(socket);

                const dockerStats = Object.fromEntries(await server.getDockerStats());
                callbackResult({
                    ok: true,
                    dockerStats,
                }, callback);
                server.sendStackList();
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Start a service
        agentSocket.on("startService", async (stackName: unknown, serviceName: unknown, callback) => {
            const startedAt = Date.now();
            const objectId = typeof stackName === "string" && typeof serviceName === "string" ? `${stackName}/${serviceName}` : "";
            try {
                checkLogin(socket);

                if (typeof (stackName) !== "string" || typeof (serviceName) !== "string") {
                    throw new ValidationError("Stack name and service name must be strings");
                }

                const stack = await Stack.getStack(server, stackName);
                await stack.startService(socket, serviceName);
                stack.joinCombinedTerminal(socket); // Ensure the combined terminal is joined
                await safelyWriteOperationLog({ actionType: "start_service",
                    objectType: "compose_service",
                    objectId,
                    after: { action: "start" },
                    result: "success",
                    socket,
                    startedAt });
                callbackResult({
                    ok: true,
                    msg: "Service " + serviceName + " started"
                }, callback);
                server.sendStackList();
            } catch (e) {
                await safelyWriteOperationLog({ actionType: "start_service",
                    objectType: "compose_service",
                    objectId,
                    after: { action: "start" },
                    result: "failed",
                    error: e,
                    socket,
                    startedAt });
                callbackError(e, callback);
            }
        });

        // Stop a service
        agentSocket.on("stopService", async (stackName: unknown, serviceName: unknown, callback) => {
            const startedAt = Date.now();
            const objectId = typeof stackName === "string" && typeof serviceName === "string" ? `${stackName}/${serviceName}` : "";
            try {
                checkLogin(socket);

                if (typeof (stackName) !== "string" || typeof (serviceName) !== "string") {
                    throw new ValidationError("Stack name and service name must be strings");
                }

                const stack = await Stack.getStack(server, stackName);
                await stack.stopService(socket, serviceName);
                await safelyWriteOperationLog({ actionType: "stop_service",
                    objectType: "compose_service",
                    objectId,
                    after: { action: "stop" },
                    result: "success",
                    socket,
                    startedAt });
                callbackResult({
                    ok: true,
                    msg: "Service " + serviceName + " stopped"
                }, callback);
                server.sendStackList();
            } catch (e) {
                await safelyWriteOperationLog({ actionType: "stop_service",
                    objectType: "compose_service",
                    objectId,
                    after: { action: "stop" },
                    result: "failed",
                    error: e,
                    socket,
                    startedAt });
                callbackError(e, callback);
            }
        });

        agentSocket.on("restartService", async (stackName: unknown, serviceName: unknown, callback) => {
            const startedAt = Date.now();
            const objectId = typeof stackName === "string" && typeof serviceName === "string" ? `${stackName}/${serviceName}` : "";
            try {
                checkLogin(socket);

                if (typeof stackName !== "string" || typeof serviceName !== "string") {
                    throw new Error("Invalid stackName or serviceName");
                }

                const stack = await Stack.getStack(server, stackName, true);
                await stack.restartService(socket, serviceName);
                await safelyWriteOperationLog({ actionType: "restart_service",
                    objectType: "compose_service",
                    objectId,
                    after: { action: "restart" },
                    result: "success",
                    socket,
                    startedAt });
                callbackResult({
                    ok: true,
                    msg: "Service " + serviceName + " restarted"
                }, callback);
            } catch (e) {
                await safelyWriteOperationLog({ actionType: "restart_service",
                    objectType: "compose_service",
                    objectId,
                    after: { action: "restart" },
                    result: "failed",
                    error: e,
                    socket,
                    startedAt });
                callbackError(e, callback);
            }
        });

        // getExternalNetworkList
        agentSocket.on("getDockerNetworkList", async (callback) => {
            try {
                checkLogin(socket);
                const dockerNetworkList = await server.getDockerNetworkList();
                callbackResult({
                    ok: true,
                    dockerNetworkList,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });
    }

    async saveStack(server : DockgeServer, name : unknown, composeYAML : unknown, composeENV : unknown, isAdd : unknown, reason : "save" | "deploy" = "save") : Promise<Stack> {
        // Check types
        if (typeof(name) !== "string") {
            throw new ValidationError("Name must be a string");
        }
        if (typeof(composeYAML) !== "string") {
            throw new ValidationError("Compose YAML must be a string");
        }
        if (typeof(composeENV) !== "string") {
            throw new ValidationError("Compose ENV must be a string");
        }
        if (typeof(isAdd) !== "boolean") {
            throw new ValidationError("isAdd must be a boolean");
        }

        const result = await new ComposeEditor(server).commit({ name,
            composeYAML,
            composeENV,
            isAdd }, reason);
        return result.stack;
    }

    private composeDraft(payload : unknown) : ComposeDraftPayload {
        const request = this.object(payload);
        return request as unknown as ComposeDraftPayload;
    }

    private booleanProperty(payload : unknown, property : string) {
        const value = this.object(payload)[property];
        if (typeof value !== "boolean") {
            throw new ValidationError(`${property} must be a boolean`);
        }
        return value;
    }

    private object(payload : unknown) : Record<string, unknown> {
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
            throw new ValidationError("Invalid Compose editor request");
        }
        return payload as Record<string, unknown>;
    }

    private readComposeConfig(stack : Stack) : ComposeConfig {
        const parsed = yaml.parse(stack.composeYAML);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new ValidationError(`Compose file for ${stack.name} must contain an object`);
        }
        return parsed as ComposeConfig;
    }

    private composeServices(config : ComposeConfig, statuses : Map<string, Array<object>>) {
        return Object.entries(this.configObject(config.services)).map(([ name, rawService ]) => {
            const service = this.configObject(rawService);
            const containers = (statuses.get(name) || []).map(item => {
                const state = item as { name?: unknown; status?: unknown };
                return {
                    name: typeof state.name === "string" ? state.name : "",
                    status: typeof state.status === "string" ? state.status : "unknown",
                };
            });
            const environment = service.environment;
            const environmentKeys = Array.isArray(environment)
                ? environment.map(value => typeof value === "string" ? value.split("=", 1)[0] : "").filter(Boolean)
                : this.objectKeys(environment);

            return {
                name,
                image: typeof service.image === "string" ? service.image : "",
                hasBuild: Boolean(service.build),
                command: this.commandText(service.command),
                entrypoint: this.commandText(service.entrypoint),
                ports: this.summaryList(service.ports),
                networks: Array.isArray(service.networks) ? this.stringList(service.networks) : this.objectKeys(service.networks),
                dependencies: Array.isArray(service.depends_on) ? this.stringList(service.depends_on) : this.objectKeys(service.depends_on),
                environmentKeys,
                volumeCount: Array.isArray(service.volumes) ? service.volumes.length : 0,
                restart: typeof service.restart === "string" ? service.restart : "no",
                containers,
                running: containers.filter(container => [ "running", "healthy" ].includes(container.status.toLowerCase())).length,
            };
        });
    }

    private runComposeLogs(stack : Stack, serviceName : string, tail : number) : Promise<string> {
        return new Promise((resolve, reject) => {
            const process = spawnProcess("docker", stack.getComposeOptions("logs", "--no-color", "--tail", String(tail), serviceName), {
                cwd: stack.path,
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
                reject(new Error(output.trim() || `docker compose logs exited with code ${code ?? "unknown"}`));
            });
        });
    }

    private validateLogTail(options : unknown) {
        if (!options || typeof options !== "object") {
            return 300;
        }
        const tail = Number((options as { tail?: unknown }).tail ?? 300);
        if (!Number.isInteger(tail) || tail < 50 || tail > 5000) {
            throw new ValidationError("Log tail must be an integer between 50 and 5000");
        }
        return tail;
    }

    private configObject(value : unknown) : ComposeConfig {
        return value && typeof value === "object" && !Array.isArray(value) ? value as ComposeConfig : {};
    }

    private objectKeys(value : unknown) {
        return Object.keys(this.configObject(value));
    }

    private stringList(value : unknown[]) {
        return value.filter((item): item is string => typeof item === "string");
    }

    private summaryList(value : unknown) {
        if (!Array.isArray(value)) {
            return [];
        }
        return value.map(item => typeof item === "string" ? item : JSON.stringify(item));
    }

    private commandText(value : unknown) {
        if (typeof value === "string") {
            return value;
        }
        if (Array.isArray(value)) {
            return value.map(item => String(item)).join(" ");
        }
        return "";
    }

}
