import { AgentSocket } from "../../common/agent-socket";
import { AgentDiagnostics } from "../agent-diagnostics";
import { AgentSocketHandler } from "../agent-socket-handler";
import { DockgeServer } from "../dockge-server";
import { callbackError, callbackResult, checkLogin, DockgeSocket } from "../util-server";

export class AgentDiagnosticsSocketHandler extends AgentSocketHandler {
    create(socket : DockgeSocket, server : DockgeServer, agentSocket : AgentSocket) {
        agentSocket.on("getAgentDiagnostics", async (callback : unknown) => {
            try {
                checkLogin(socket);
                callbackResult({ ok: true,
                    diagnostics: await new AgentDiagnostics(server).collect() }, callback);
            } catch (error) {
                callbackError(error, callback);
            }
        });
    }
}
