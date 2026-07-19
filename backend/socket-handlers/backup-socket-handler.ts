import { BackupManager } from "../backup-manager";
import { DockgeServer } from "../dockge-server";
import { log } from "../log";
import { safelyWriteOperationLog } from "../operation-log";
import { SocketHandler } from "../socket-handler";
import { callbackError, callbackResult, checkPermission, DockgeSocket, ValidationError } from "../util-server";

export class BackupSocketHandler extends SocketHandler {
    create(socket : DockgeSocket, server : DockgeServer) {
        const manager = new BackupManager(server);

        socket.on("getDockerBridgeSystemBackups", async (callback : unknown) => {
            try {
                checkPermission(socket, "admin");
                callbackResult({ ok: true,
                    backups: await manager.listBackups() }, callback);
            } catch (error) {
                callbackError(error, callback);
            }
        });

        socket.on("createDockerBridgeSystemBackup", async (callback : unknown) => {
            const startedAt = Date.now();
            try {
                checkPermission(socket, "admin");
                const backup = await manager.createBackup();
                await safelyWriteOperationLog({
                    actionType: "create_system_backup",
                    objectType: "system_backup",
                    objectId: backup.id,
                    after: { fileCount: backup.fileCount,
                        totalSize: backup.totalSize },
                    result: "success",
                    socket,
                    startedAt,
                });
                callbackResult({ ok: true,
                    backup,
                    backups: await manager.listBackups(),
                    msg: `System backup ${backup.id} created` }, callback);
            } catch (error) {
                await safelyWriteOperationLog({
                    actionType: "create_system_backup",
                    objectType: "system_backup",
                    objectId: "new",
                    result: "failed",
                    error,
                    socket,
                    startedAt,
                });
                callbackError(error, callback);
            }
        });

        socket.on("validateDockerBridgeSystemBackup", async (backupId : unknown, callback : unknown) => {
            try {
                checkPermission(socket, "admin");
                const id = this.backupId(backupId);
                const result = await manager.validateBackup(id);
                callbackResult({ ok: true,
                    backup: result.summary,
                    msg: `System backup ${id} passed checksum validation` }, callback);
            } catch (error) {
                callbackError(error, callback);
            }
        });

        socket.on("previewDockerBridgeSystemRestore", async (backupId : unknown, callback : unknown) => {
            try {
                checkPermission(socket, "admin");
                callbackResult({ ok: true,
                    ...(await manager.previewRestore(this.backupId(backupId))) }, callback);
            } catch (error) {
                callbackError(error, callback);
            }
        });

        socket.on("restoreDockerBridgeSystemBackup", async (backupId : unknown, callback : unknown) => {
            const startedAt = Date.now();
            let id = "unknown";
            try {
                checkPermission(socket, "admin");
                id = this.backupId(backupId);
                const pending = await manager.stageRestore(id);
                await safelyWriteOperationLog({
                    actionType: "stage_system_restore",
                    objectType: "system_backup",
                    objectId: id,
                    after: { requestedAt: pending.requestedAt,
                        restartScheduled: process.env.DOCKERBRIDGE_RESTORE_AUTO_RESTART !== "false" },
                    result: "success",
                    socket,
                    startedAt,
                });
                const restartScheduled = process.env.DOCKERBRIDGE_RESTORE_AUTO_RESTART !== "false";
                callbackResult({
                    ok: true,
                    backupId: id,
                    restartScheduled,
                    msg: restartScheduled
                        ? "Restore staged and service restart scheduled"
                        : "Restore staged; restart DockerBridge to apply it",
                }, callback);
                if (restartScheduled) {
                    setTimeout(() => {
                        try {
                            log.warn("system-backup", `Restarting DockerBridge to apply system backup ${id}`);
                            process.kill(process.pid, "SIGTERM");
                        } catch (error) {
                            log.error("system-backup", `Failed to request restart: ${error instanceof Error ? error.message : String(error)}`);
                        }
                    }, 1500);
                }
            } catch (error) {
                await safelyWriteOperationLog({
                    actionType: "stage_system_restore",
                    objectType: "system_backup",
                    objectId: id,
                    result: "failed",
                    error,
                    socket,
                    startedAt,
                });
                callbackError(error, callback);
            }
        });

        socket.on("deleteDockerBridgeSystemBackup", async (backupId : unknown, callback : unknown) => {
            const startedAt = Date.now();
            let id = "unknown";
            try {
                checkPermission(socket, "admin");
                id = this.backupId(backupId);
                await manager.deleteBackup(id);
                await safelyWriteOperationLog({
                    actionType: "delete_system_backup",
                    objectType: "system_backup",
                    objectId: id,
                    result: "success",
                    socket,
                    startedAt,
                });
                callbackResult({ ok: true,
                    backups: await manager.listBackups(),
                    msg: `System backup ${id} deleted` }, callback);
            } catch (error) {
                await safelyWriteOperationLog({
                    actionType: "delete_system_backup",
                    objectType: "system_backup",
                    objectId: id,
                    result: "failed",
                    error,
                    socket,
                    startedAt,
                });
                callbackError(error, callback);
            }
        });
    }

    private backupId(value : unknown) {
        if (typeof value !== "string" || !value) {
            throw new ValidationError("System backup ID is required");
        }
        return value;
    }
}
