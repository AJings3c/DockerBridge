import { ComposeRepository, ComposeRepositoryQuery } from "../compose-repository";
import { DockgeServer } from "../dockge-server";
import { SocketHandler } from "../socket-handler";
import { callbackError, callbackResult, checkPermission, DockgeSocket, ValidationError } from "../util-server";

export class ComposeRepositorySocketHandler extends SocketHandler {
    create(socket : DockgeSocket, server : DockgeServer) {
        socket.on("getComposeRepository", async (query : unknown, callback : unknown) => {
            try {
                checkPermission(socket, "read");
                if (query !== undefined && (query === null || typeof query !== "object" || Array.isArray(query))) {
                    throw new ValidationError("Invalid Compose repository query");
                }
                const result = await ComposeRepository.query(server, (query || {}) as ComposeRepositoryQuery);
                callbackResult(result, callback);
            } catch (error) {
                callbackError(error, callback);
            }
        });
    }
}
