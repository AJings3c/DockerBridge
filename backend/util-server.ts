import { Socket } from "socket.io";
import { Terminal } from "./terminal";
import { log } from "./log";
import { ERROR_TYPE_VALIDATION } from "../common/util-common";
import { R } from "redbean-node";
import { verifyPassword } from "./password-hash";
import fs from "fs";
import { AgentManager } from "./agent-manager";

export interface JWTDecoded {
    username : string;
    h? : string;
}

export type UserRole = "viewer" | "operator" | "admin";
export type UserPermission = "read" | "operate" | "destructive" | "terminal" | "settings" | "users" | "agents" | "admin";

const ROLE_PERMISSIONS : Record<UserRole, ReadonlySet<UserPermission>> = {
    viewer: new Set([ "read" ]),
    operator: new Set([ "read", "operate" ]),
    admin: new Set([ "read", "operate", "destructive", "terminal", "settings", "users", "agents", "admin" ]),
};

export function normalizeUserRole(value : unknown) : UserRole {
    return value === "viewer" || value === "operator" || value === "admin" ? value : "viewer";
}

export function permissionsForRole(role : UserRole) {
    return Array.from(ROLE_PERMISSIONS[role]);
}

export interface DockgeSocket extends Socket {
    userID: number;
    userRole: UserRole;
    consoleTerminal? : Terminal;
    instanceManager : AgentManager;
    endpoint : string;
    emitAgent : (eventName : string, ...args : unknown[]) => void;
}

// For command line arguments, so they are nullable
export interface Arguments {
    sslKey? : string;
    sslCert? : string;
    sslKeyPassphrase? : string;
    port? : number;
    hostname? : string;
    dataDir? : string;
    stacksDir? : string;
    enableConsole? : boolean;
    consoleTarget? : string;
    consoleShell? : string;
    consoleHostPid? : number;
    consoleIdleTimeoutSeconds? : number;
    consoleMaxSessions? : number;
}

// Some config values are required
export interface Config extends Arguments {
    dataDir : string;
    stacksDir : string;
}

export function checkLogin(socket : DockgeSocket) {
    if (!socket.userID) {
        throw new Error("You are not logged in.");
    }
}

export class AuthorizationError extends Error {
    code = "FORBIDDEN";
}

export function checkPermission(socket : DockgeSocket, permission : UserPermission) {
    checkLogin(socket);
    const role = normalizeUserRole(socket.userRole);
    if (!ROLE_PERMISSIONS[role].has(permission)) {
        throw new AuthorizationError(`Role ${role} does not have permission: ${permission}`);
    }
}

export function permissionForAgentEvent(eventName : string) : UserPermission {
    if ([ "getStackRuntimeDetail", "getStackServiceLogs", "requestStackList", "serviceStatusList", "dockerStats", "getDockerNetworkList", "getDockerResourceInventory" ].includes(eventName)) {
        return "read";
    }
    if ([ "startStack", "stopStack", "restartStack", "updateStack", "startService", "stopService", "restartService" ].includes(eventName)) {
        return "operate";
    }
    if ([ "getStack", "getComposeEditor", "previewComposeEditorDraft", "saveComposeEditorDraft", "getComposeRevisions", "previewComposeRevision", "restoreComposeRevision", "deployStack", "saveStack", "deleteStack", "downStack", "previewDockerResourceRemoval", "removeDockerResource", "previewDockerNetworkDisconnect", "disconnectDockerNetwork", "createDockerNetwork", "createDockerVolume", "getAgentDiagnostics" ].includes(eventName)) {
        return "destructive";
    }
    if ([ "terminalInput", "mainTerminal", "checkMainTerminal", "interactiveTerminal", "terminalJoin", "leaveCombinedTerminal", "closeMainTerminal", "terminalResize" ].includes(eventName)) {
        return "terminal";
    }
    return "admin";
}

export class ValidationError extends Error {
    constructor(message : string) {
        super(message);
    }
}

export function callbackError(error : unknown, callback : unknown) {
    if (typeof(callback) !== "function") {
        log.error("console", "Callback is not a function");
        return;
    }

    if (error instanceof AuthorizationError) {
        callback({
            ok: false,
            code: error.code,
            msg: error.message,
            msgi18n: false,
        });
    } else if (error instanceof ValidationError) {
        callback({
            ok: false,
            type: ERROR_TYPE_VALIDATION,
            msg: error.message,
            msgi18n: true,
        });
    } else if (error instanceof Error) {
        callback({
            ok: false,
            msg: error.message,
            msgi18n: true,
        });
    } else {
        const message = typeof error === "string" ? error : "Unknown runtime error";
        log.warn("console", message);
        callback({
            ok: false,
            msg: message,
            msgi18n: false,
        });
    }
}

export function callbackResult(result : unknown, callback : unknown) {
    if (typeof(callback) !== "function") {
        log.error("console", "Callback is not a function");
        return;
    }
    callback(result);
}

export async function doubleCheckPassword(socket : DockgeSocket, currentPassword : unknown) {
    if (typeof currentPassword !== "string") {
        throw new Error("Wrong data type?");
    }

    let user = await R.findOne("user", " id = ? AND active = 1 ", [
        socket.userID,
    ]);

    if (!user || !verifyPassword(currentPassword, user.password)) {
        throw new Error("Incorrect current password");
    }

    return user;
}

export function fileExists(file : string) {
    return fs.promises.access(file, fs.constants.F_OK)
        .then(() => true)
        .catch(() => false);
}
