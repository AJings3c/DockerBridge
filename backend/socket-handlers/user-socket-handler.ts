import { passwordStrength } from "check-password-strength";
import { Knex } from "knex";
import { R } from "redbean-node";
import { generatePasswordHash } from "../password-hash";
import { safelyWriteOperationLog } from "../operation-log";
import { SocketHandler } from "../socket-handler";
import { DockgeServer } from "../dockge-server";
import { callbackError, callbackResult, checkPermission, DockgeSocket, UserRole, ValidationError } from "../util-server";

interface UserRow {
    id: number;
    username: string;
    active: number | boolean;
    role: UserRole;
}

export class UserSocketHandler extends SocketHandler {
    create(socket : DockgeSocket, server : DockgeServer) {
        socket.on("getDockerBridgeUsers", async (callback : unknown) => {
            try {
                checkPermission(socket, "users");
                callbackResult({ ok: true,
                    users: await this.listUsers() }, callback);
            } catch (error) {
                callbackError(error, callback);
            }
        });

        socket.on("createDockerBridgeUser", async (payload : unknown, callback : unknown) => {
            const startedAt = Date.now();
            let username = "unknown";
            try {
                checkPermission(socket, "users");
                const data = this.validateCreate(payload);
                username = data.username;
                const existing = await R.knex("user").where("username", data.username).first();
                if (existing) {
                    throw new ValidationError(`User ${data.username} already exists`);
                }
                const ids = await R.knex("user").insert({
                    username: data.username,
                    password: generatePasswordHash(data.password),
                    active: true,
                    role: data.role,
                    twofa_status: false,
                });
                await safelyWriteOperationLog({
                    actionType: "create_user",
                    objectType: "user",
                    objectId: data.username,
                    after: { id: Number(ids[0]),
                        role: data.role,
                        active: true },
                    result: "success",
                    socket,
                    startedAt,
                });
                callbackResult({ ok: true,
                    users: await this.listUsers(),
                    msg: `User ${data.username} created` }, callback);
            } catch (error) {
                await safelyWriteOperationLog({
                    actionType: "create_user",
                    objectType: "user",
                    objectId: username,
                    result: "failed",
                    error,
                    socket,
                    startedAt,
                });
                callbackError(error, callback);
            }
        });

        socket.on("updateDockerBridgeUser", async (payload : unknown, callback : unknown) => {
            const startedAt = Date.now();
            let username = "unknown";
            try {
                checkPermission(socket, "users");
                const data = this.validateUpdate(payload);
                const current = await R.knex.transaction(async (trx : Knex.Transaction) => {
                    const current = await trx("user").where("id", data.id).first() as UserRow | undefined;
                    if (!current) {
                        throw new ValidationError("User not found");
                    }
                    username = current.username;
                    if (data.id === socket.userID && !data.active) {
                        throw new ValidationError("You cannot disable your own account");
                    }
                    if (current.role === "admin" && Boolean(current.active) && (data.role !== "admin" || !data.active)) {
                        const adminCount = Number((await trx("user").where({ role: "admin",
                            active: true }).count("id as count").first())?.count || 0);
                        if (adminCount <= 1) {
                            throw new ValidationError("The last active administrator cannot be demoted or disabled");
                        }
                    }
                    await trx("user").where("id", data.id).update({ role: data.role,
                        active: data.active });
                    return current;
                });
                await safelyWriteOperationLog({
                    actionType: "update_user",
                    objectType: "user",
                    objectId: current.username,
                    before: { role: current.role,
                        active: Boolean(current.active) },
                    after: { role: data.role,
                        active: data.active },
                    result: "success",
                    socket,
                    startedAt,
                });
                callbackResult({ ok: true,
                    users: await this.listUsers(),
                    msg: `User ${current.username} updated` }, callback);
                if (current.role !== data.role || Boolean(current.active) !== data.active) {
                    setTimeout(() => server.disconnectAllSocketClients(data.id), 100);
                }
            } catch (error) {
                await safelyWriteOperationLog({
                    actionType: "update_user",
                    objectType: "user",
                    objectId: username,
                    result: "failed",
                    error,
                    socket,
                    startedAt,
                });
                callbackError(error, callback);
            }
        });

        socket.on("resetDockerBridgeUserPassword", async (payload : unknown, callback : unknown) => {
            const startedAt = Date.now();
            let username = "unknown";
            try {
                checkPermission(socket, "users");
                const data = this.validatePasswordReset(payload);
                const current = await R.knex("user").where("id", data.id).first() as UserRow | undefined;
                if (!current) {
                    throw new ValidationError("User not found");
                }
                username = current.username;
                await R.knex("user").where("id", data.id).update({ password: generatePasswordHash(data.password) });
                await safelyWriteOperationLog({
                    actionType: "reset_user_password",
                    objectType: "user",
                    objectId: current.username,
                    after: { passwordReset: true },
                    result: "success",
                    socket,
                    startedAt,
                });
                callbackResult({ ok: true,
                    msg: `Password reset for ${current.username}` }, callback);
                setTimeout(() => server.disconnectAllSocketClients(data.id), 100);
            } catch (error) {
                await safelyWriteOperationLog({
                    actionType: "reset_user_password",
                    objectType: "user",
                    objectId: username,
                    result: "failed",
                    error,
                    socket,
                    startedAt,
                });
                callbackError(error, callback);
            }
        });
    }

    private async listUsers() {
        const rows = await R.knex("user").select("id", "username", "active", "role").orderBy("username") as UserRow[];
        return rows.map(user => ({ id: Number(user.id),
            username: String(user.username),
            active: Boolean(user.active),
            role: this.role(user.role) }));
    }

    private validateCreate(payload : unknown) {
        const data = this.object(payload);
        const username = this.username(data.username);
        const password = this.password(data.password);
        return { username,
            password,
            role: this.role(data.role) };
    }

    private validateUpdate(payload : unknown) {
        const data = this.object(payload);
        const id = Number(data.id);
        if (!Number.isInteger(id) || id < 1 || typeof data.active !== "boolean") {
            throw new ValidationError("Invalid user update");
        }
        return { id,
            active: data.active,
            role: this.role(data.role) };
    }

    private validatePasswordReset(payload : unknown) {
        const data = this.object(payload);
        const id = Number(data.id);
        if (!Number.isInteger(id) || id < 1) {
            throw new ValidationError("Invalid user ID");
        }
        return { id,
            password: this.password(data.password) };
    }

    private object(payload : unknown) : Record<string, unknown> {
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
            throw new ValidationError("Invalid user request");
        }
        return payload as Record<string, unknown>;
    }

    private username(value : unknown) {
        if (typeof value !== "string" || !/^[a-zA-Z0-9._-]{3,64}$/.test(value)) {
            throw new ValidationError("Username must be 3-64 letters, numbers, dots, underscores, or hyphens");
        }
        return value;
    }

    private password(value : unknown) {
        if (typeof value !== "string" || passwordStrength(value).value === "Too weak") {
            throw new ValidationError("Password is too weak; use at least six characters with letters and numbers");
        }
        return value;
    }

    private role(value : unknown) : UserRole {
        if (value !== "viewer" && value !== "operator" && value !== "admin") {
            throw new ValidationError("Invalid user role");
        }
        return value;
    }
}
