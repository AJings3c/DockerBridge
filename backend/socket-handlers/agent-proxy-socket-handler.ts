import { SocketHandler } from "../socket-handler.js";
import { DockgeServer } from "../dockge-server";
import { log } from "../log";
import { callbackError, checkPermission, DockgeSocket, permissionForAgentEvent } from "../util-server";
import { AgentSocket } from "../../common/agent-socket";
import { ALL_ENDPOINTS } from "../../common/util-common";

export class AgentProxySocketHandler extends SocketHandler {

    create2(socket : DockgeSocket, server : DockgeServer, agentSocket : AgentSocket) {
        // Agent - proxying requests if needed
        socket.on("agent", async (endpoint : unknown, eventName : unknown, ...args : unknown[]) => {
            const callback = args.at(-1);
            try {
                // Check Type
                if (typeof(endpoint) !== "string") {
                    throw new Error("Endpoint must be a string: " + endpoint);
                }
                if (typeof(eventName) !== "string") {
                    throw new Error("Event name must be a string");
                }
                checkPermission(socket, permissionForAgentEvent(eventName));

                if (endpoint === ALL_ENDPOINTS) {      // Send to all endpoints
                    log.debug("agent", "Sending to all endpoints: " + eventName);
                    socket.instanceManager.emitToAllEndpoints(eventName, ...args);

                } else if (!endpoint || endpoint === socket.endpoint) {      // Direct connection or matching endpoint
                    log.debug("agent", "Matched endpoint: " + eventName);
                    if (!agentSocket.call(eventName, ...args)) {
                        throw new Error("Unsupported agent event: " + eventName);
                    }

                } else {
                    log.debug("agent", "Proxying request to " + endpoint + " for " + eventName);
                    await socket.instanceManager.emitToEndpoint(endpoint, eventName, ...args);
                }
            } catch (e) {
                if (e instanceof Error) {
                    log.warn("agent", e.message);
                }
                callbackError(e, callback);
            }
        });
    }

    create(socket : DockgeSocket, server : DockgeServer) {
        throw new Error("Method not implemented. Please use create2 instead.");
    }
}
