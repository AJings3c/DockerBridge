import { AgentSocket } from "../../common/agent-socket";
import { AgentSocketHandler } from "../agent-socket-handler";
import { DockgeServer } from "../dockge-server";
import { DockerResourceManager } from "../docker-resource-manager";
import { safelyWriteOperationLog } from "../operation-log";
import { callbackError, callbackResult, checkLogin, DockgeSocket, ValidationError } from "../util-server";

export class DockerResourceSocketHandler extends AgentSocketHandler {
    create(socket : DockgeSocket, server : DockgeServer, agentSocket : AgentSocket) {
        const manager = new DockerResourceManager();

        agentSocket.on("getDockerResourceInventory", async (callback : unknown) => {
            try {
                checkLogin(socket);
                callbackResult({ ok: true,
                    inventory: await manager.inventory() }, callback);
            } catch (error) {
                callbackError(error, callback);
            }
        });

        agentSocket.on("previewDockerResourceRemoval", async (payload : unknown, callback : unknown) => {
            try {
                checkLogin(socket);
                const data = this.object(payload);
                callbackResult({ ok: true,
                    preview: await manager.previewRemoval(this.kind(data.kind), this.string(data.name, "Resource name")) }, callback);
            } catch (error) {
                callbackError(error, callback);
            }
        });

        agentSocket.on("removeDockerResource", async (payload : unknown, callback : unknown) => {
            const startedAt = Date.now();
            let objectType = "docker_resource";
            let objectId = "unknown";
            try {
                checkLogin(socket);
                const data = this.object(payload);
                const kind = this.kind(data.kind);
                const name = this.string(data.name, "Resource name");
                objectType = `docker_${kind}`;
                objectId = name;
                const result = await manager.remove(kind, name, this.string(data.expectedFingerprint, "Expected fingerprint"), this.string(data.confirmation, "Confirmation"));
                await safelyWriteOperationLog({ actionType: `remove_docker_${kind}`,
                    objectType,
                    objectId,
                    before: { dependencyCount: result.preview.dependencies.length,
                        fingerprint: result.preview.fingerprint },
                    result: "success",
                    socket,
                    startedAt });
                callbackResult({ ok: true,
                    output: result.output,
                    msg: `Docker ${kind} ${name} removed` }, callback);
            } catch (error) {
                await safelyWriteOperationLog({ actionType: objectType === "docker_volume" ? "remove_docker_volume" : objectType === "docker_network" ? "remove_docker_network" : "remove_docker_resource",
                    objectType,
                    objectId,
                    result: "failed",
                    error,
                    socket,
                    startedAt });
                callbackError(error, callback);
            }
        });

        agentSocket.on("previewDockerNetworkDisconnect", async (payload : unknown, callback : unknown) => {
            try {
                checkLogin(socket);
                const data = this.object(payload);
                callbackResult({ ok: true,
                    preview: await manager.previewNetworkDisconnect(this.string(data.networkName, "Network name"), this.string(data.containerId, "Container ID")) }, callback);
            } catch (error) {
                callbackError(error, callback);
            }
        });

        agentSocket.on("disconnectDockerNetwork", async (payload : unknown, callback : unknown) => {
            const startedAt = Date.now();
            let objectId = "unknown";
            try {
                checkLogin(socket);
                const data = this.object(payload);
                const networkName = this.string(data.networkName, "Network name");
                const containerId = this.string(data.containerId, "Container ID");
                objectId = `${networkName}/${containerId}`;
                const result = await manager.disconnectNetwork(networkName, containerId, this.string(data.expectedFingerprint, "Expected fingerprint"), this.string(data.confirmation, "Confirmation"));
                await safelyWriteOperationLog({ actionType: "disconnect_docker_network",
                    objectType: "docker_network_attachment",
                    objectId,
                    before: { networkName,
                        containerId: result.preview.containerId,
                        containerName: result.preview.containerName },
                    result: "success",
                    socket,
                    startedAt });
                callbackResult({ ok: true,
                    output: result.output,
                    msg: `Container ${result.preview.containerName} disconnected from ${networkName}` }, callback);
            } catch (error) {
                await safelyWriteOperationLog({ actionType: "disconnect_docker_network",
                    objectType: "docker_network_attachment",
                    objectId,
                    result: "failed",
                    error,
                    socket,
                    startedAt });
                callbackError(error, callback);
            }
        });

        agentSocket.on("createDockerNetwork", async (payload : unknown, callback : unknown) => {
            const startedAt = Date.now();
            let name = "unknown";
            try {
                checkLogin(socket);
                const data = this.object(payload);
                name = this.string(data.name, "Network name");
                const result = await manager.createNetwork(data);
                await safelyWriteOperationLog({ actionType: "create_docker_network",
                    objectType: "docker_network",
                    objectId: name,
                    after: { driver: result.driver },
                    result: "success",
                    socket,
                    startedAt });
                callbackResult({ ok: true,
                    output: result.output,
                    msg: `Docker network ${name} created` }, callback);
            } catch (error) {
                await safelyWriteOperationLog({ actionType: "create_docker_network",
                    objectType: "docker_network",
                    objectId: name,
                    result: "failed",
                    error,
                    socket,
                    startedAt });
                callbackError(error, callback);
            }
        });

        agentSocket.on("createDockerVolume", async (payload : unknown, callback : unknown) => {
            const startedAt = Date.now();
            let name = "unknown";
            try {
                checkLogin(socket);
                const data = this.object(payload);
                name = this.string(data.name, "Volume name");
                const result = await manager.createVolume(data);
                await safelyWriteOperationLog({ actionType: "create_docker_volume",
                    objectType: "docker_volume",
                    objectId: name,
                    after: { driver: result.driver },
                    result: "success",
                    socket,
                    startedAt });
                callbackResult({ ok: true,
                    output: result.output,
                    msg: `Docker volume ${name} created` }, callback);
            } catch (error) {
                await safelyWriteOperationLog({ actionType: "create_docker_volume",
                    objectType: "docker_volume",
                    objectId: name,
                    result: "failed",
                    error,
                    socket,
                    startedAt });
                callbackError(error, callback);
            }
        });
    }

    private object(value : unknown) : Record<string, unknown> {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            throw new ValidationError("Invalid Docker resource request");
        }
        return value as Record<string, unknown>;
    }

    private string(value : unknown, label : string) {
        if (typeof value !== "string" || !value.trim()) {
            throw new ValidationError(`${label} is required`);
        }
        return value.trim();
    }

    private kind(value : unknown) : "network" | "volume" {
        if (value !== "network" && value !== "volume") {
            throw new ValidationError("Resource kind must be network or volume");
        }
        return value;
    }
}
