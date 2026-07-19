import { LooseObject } from "../../common/util-common";
import { DockgeServer } from "../dockge-server";
import { log } from "../log";
import { safelyWriteOperationLog } from "../operation-log";
import { SocketHandler } from "../socket-handler";
import { callbackError, callbackResult, checkPermission, DockgeSocket, ValidationError } from "../util-server";

export class ManageAgentSocketHandler extends SocketHandler {
    create(socket : DockgeSocket, server : DockgeServer) {
        socket.on("addAgent", async (requestData : unknown, callback : unknown) => {
            const startedAt = Date.now();
            let endpoint = "unknown";
            try {
                log.debug("manage-agent-socket-handler", "addAgent");
                checkPermission(socket, "agents");
                const data = this.object(requestData);
                const test = await socket.instanceManager.test(data.url, data.username, data.password);
                endpoint = test.endpoint;
                const agent = await socket.instanceManager.add(data.url, data.username, data.password, data.name);
                socket.instanceManager.connect(agent.url, agent.username, data.password);
                await safelyWriteOperationLog({ actionType: "add_agent",
                    objectType: "agent",
                    objectId: endpoint,
                    after: { name: agent.name,
                        url: agent.url,
                        username: agent.username,
                        latencyMs: test.latencyMs },
                    result: "success",
                    socket,
                    startedAt });
                await socket.instanceManager.sendAgentList();
                callbackResult({ ok: true,
                    msg: "Agent added successfully",
                    endpoint }, callback);
                setTimeout(() => server.disconnectAllSocketClients(undefined, socket.id), 200);
            } catch (error) {
                await safelyWriteOperationLog({ actionType: "add_agent",
                    objectType: "agent",
                    objectId: endpoint,
                    result: "failed",
                    error,
                    socket,
                    startedAt });
                callbackError(error, callback);
            }
        });

        socket.on("removeAgent", async (url : unknown, callback : unknown) => {
            try {
                checkPermission(socket, "agents");
                throw new ValidationError("Legacy Agent removal is disabled; use removal preview and confirmed removal");
            } catch (error) {
                callbackError(error, callback);
            }
        });

        socket.on("updateAgent", async (url : unknown, updatedName : unknown, callback : unknown) => {
            try {
                checkPermission(socket, "agents");
                if (typeof url !== "string" || typeof updatedName !== "string") {
                    throw new ValidationError("Agent URL and name must be strings");
                }
                await socket.instanceManager.update(url, updatedName);
                await socket.instanceManager.sendAgentList();
                callbackResult({ ok: true,
                    msg: "Agent updated successfully" }, callback);
            } catch (error) {
                callbackError(error, callback);
            }
        });

        socket.on("getDockerBridgeAgents", async (callback : unknown) => {
            try {
                checkPermission(socket, "agents");
                callbackResult({ ok: true,
                    ...(await socket.instanceManager.getManagementSnapshot()) }, callback);
            } catch (error) {
                callbackError(error, callback);
            }
        });

        socket.on("testDockerBridgeAgent", async (payload : unknown, callback : unknown) => {
            const startedAt = Date.now();
            let endpoint = "candidate";
            try {
                checkPermission(socket, "agents");
                const data = this.object(payload);
                const result = await socket.instanceManager.test(data.url, data.username, data.password, data.allowExisting === true);
                endpoint = result.endpoint;
                await safelyWriteOperationLog({ actionType: "test_agent_connection",
                    objectType: "agent",
                    objectId: endpoint,
                    after: { latencyMs: result.latencyMs,
                        version: result.info?.version,
                        protocolVersion: result.info?.protocolVersion },
                    result: "success",
                    socket,
                    startedAt });
                callbackResult({ ok: true,
                    test: result,
                    msg: `Agent connection succeeded in ${result.latencyMs} ms` }, callback);
            } catch (error) {
                await safelyWriteOperationLog({ actionType: "test_agent_connection",
                    objectType: "agent",
                    objectId: endpoint,
                    result: "failed",
                    error,
                    socket,
                    startedAt });
                callbackError(error, callback);
            }
        });

        socket.on("diagnoseDockerBridgeAgent", async (endpoint : unknown, callback : unknown) => {
            const startedAt = Date.now();
            const objectId = typeof endpoint === "string" ? endpoint : "unknown";
            try {
                checkPermission(socket, "agents");
                if (typeof endpoint !== "string" || !endpoint) {
                    throw new ValidationError("Agent endpoint is required");
                }
                const diagnostics = await socket.instanceManager.requestDiagnostics(endpoint);
                await safelyWriteOperationLog({ actionType: "diagnose_agent",
                    objectType: "agent",
                    objectId: endpoint,
                    after: { generatedAt: diagnostics.generatedAt,
                        version: diagnostics.version,
                        protocolVersion: diagnostics.protocolVersion },
                    result: "success",
                    socket,
                    startedAt });
                callbackResult({ ok: true,
                    diagnostics }, callback);
            } catch (error) {
                await safelyWriteOperationLog({ actionType: "diagnose_agent",
                    objectType: "agent",
                    objectId,
                    result: "failed",
                    error,
                    socket,
                    startedAt });
                callbackError(error, callback);
            }
        });

        socket.on("updateDockerBridgeAgent", async (payload : unknown, callback : unknown) => {
            const startedAt = Date.now();
            let endpoint = "unknown";
            try {
                checkPermission(socket, "agents");
                const data = this.object(payload);
                endpoint = this.string(data.endpoint, "Agent endpoint");
                const name = this.string(data.name, "Agent name");
                if (typeof data.active !== "boolean") {
                    throw new ValidationError("Agent active state must be a boolean");
                }
                const agent = await socket.instanceManager.updateManaged(endpoint, name, data.active);
                await safelyWriteOperationLog({ actionType: "update_agent",
                    objectType: "agent",
                    objectId: endpoint,
                    after: { name: agent.name,
                        active: Boolean(agent.active) },
                    result: "success",
                    socket,
                    startedAt });
                callbackResult({ ok: true,
                    ...(await socket.instanceManager.getManagementSnapshot()),
                    msg: `Agent ${endpoint} updated` }, callback);
            } catch (error) {
                await safelyWriteOperationLog({ actionType: "update_agent",
                    objectType: "agent",
                    objectId: endpoint,
                    result: "failed",
                    error,
                    socket,
                    startedAt });
                callbackError(error, callback);
            }
        });

        socket.on("rotateDockerBridgeAgentCredentials", async (payload : unknown, callback : unknown) => {
            const startedAt = Date.now();
            let endpoint = "unknown";
            try {
                checkPermission(socket, "agents");
                const data = this.object(payload);
                endpoint = this.string(data.endpoint, "Agent endpoint");
                const result = await socket.instanceManager.rotateCredentials(endpoint, this.string(data.username, "Agent username"), this.string(data.password, "Agent password"));
                await safelyWriteOperationLog({ actionType: "rotate_agent_credentials",
                    objectType: "agent",
                    objectId: endpoint,
                    after: { username: result.agent.username,
                        credentialVersion: Number(result.agent.credential_version),
                        latencyMs: result.test.latencyMs },
                    result: "success",
                    socket,
                    startedAt });
                callbackResult({ ok: true,
                    ...(await socket.instanceManager.getManagementSnapshot()),
                    msg: `Credentials rotated for ${endpoint}` }, callback);
            } catch (error) {
                await safelyWriteOperationLog({ actionType: "rotate_agent_credentials",
                    objectType: "agent",
                    objectId: endpoint,
                    result: "failed",
                    error,
                    socket,
                    startedAt });
                callbackError(error, callback);
            }
        });

        socket.on("previewDockerBridgeAgentRemoval", async (endpoint : unknown, callback : unknown) => {
            try {
                checkPermission(socket, "agents");
                if (typeof endpoint !== "string") {
                    throw new ValidationError("Agent endpoint is required");
                }
                callbackResult({ ok: true,
                    preview: await socket.instanceManager.previewRemoval(endpoint) }, callback);
            } catch (error) {
                callbackError(error, callback);
            }
        });

        socket.on("removeDockerBridgeAgent", async (payload : unknown, callback : unknown) => {
            const startedAt = Date.now();
            let endpoint = "unknown";
            try {
                checkPermission(socket, "agents");
                const data = this.object(payload);
                endpoint = this.string(data.endpoint, "Agent endpoint");
                const preview = await socket.instanceManager.removeManaged(endpoint, this.string(data.expectedFingerprint, "Expected fingerprint"), this.string(data.confirmation, "Confirmation"));
                await safelyWriteOperationLog({ actionType: "remove_agent",
                    objectType: "agent",
                    objectId: endpoint,
                    before: { name: preview.name,
                        url: preview.url,
                        active: preview.active,
                        lastSeenAt: preview.lastSeenAt },
                    result: "success",
                    socket,
                    startedAt });
                callbackResult({ ok: true,
                    ...(await socket.instanceManager.getManagementSnapshot()),
                    msg: `Agent ${endpoint} removed` }, callback);
            } catch (error) {
                await safelyWriteOperationLog({ actionType: "remove_agent",
                    objectType: "agent",
                    objectId: endpoint,
                    result: "failed",
                    error,
                    socket,
                    startedAt });
                callbackError(error, callback);
            }
        });
    }

    private object(value : unknown) : LooseObject {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            throw new ValidationError("Invalid Agent management request");
        }
        return value as LooseObject;
    }

    private string(value : unknown, label : string) {
        if (typeof value !== "string" || !value.trim()) {
            throw new ValidationError(`${label} is required`);
        }
        return value.trim();
    }
}
