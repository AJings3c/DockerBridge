import { DockgeServer } from "../dockge-server";
import { callbackError, callbackResult, checkLogin, DockgeSocket, ValidationError } from "../util-server";
import { log } from "../log";
import { InteractiveTerminal, MainTerminal, Terminal } from "../terminal";
import { Stack } from "../stack";
import { AgentSocketHandler } from "../agent-socket-handler";
import { AgentSocket } from "../../common/agent-socket";
import { safelyWriteOperationLog } from "../operation-log";

export class TerminalSocketHandler extends AgentSocketHandler {
    create(socket : DockgeSocket, server : DockgeServer, agentSocket : AgentSocket) {

        agentSocket.on("terminalInput", async (terminalName : unknown, cmd : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(terminalName) !== "string") {
                    throw new Error("Terminal name must be a string.");
                }

                if (typeof(cmd) !== "string") {
                    throw new Error("Command must be a string.");
                }

                let terminal = Terminal.getTerminal(terminalName);
                if (terminal instanceof InteractiveTerminal) {
                    if (terminal instanceof MainTerminal && !terminal.belongsTo(socket)) {
                        throw new ValidationError("Terminal session belongs to another connection.");
                    }
                    //log.debug("terminalInput", "Terminal found, writing to terminal.");
                    terminal.write(cmd);
                    callbackResult({
                        ok: true,
                    }, callback);
                } else {
                    throw new Error("Terminal not found or it is not a Interactive Terminal.");
                }
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Main Terminal
        agentSocket.on("mainTerminal", async (terminalName : unknown, callback) => {
            try {
                checkLogin(socket);

                // Throw an error if console is not enabled
                if (!server.config.enableConsole) {
                    throw new ValidationError("Console is not enabled.");
                }

                if (typeof(terminalName) !== "string" || !/^console_[a-zA-Z0-9_-]{1,80}$/.test(terminalName)) {
                    throw new ValidationError("Terminal name must be a string.");
                }

                log.debug("mainTerminal", "Terminal name: " + terminalName);

                const existingTerminal = Terminal.getTerminal(terminalName);
                let terminal : MainTerminal;
                let created = false;

                if (!existingTerminal) {
                    const activeSessions = Terminal.getTerminalList().filter(item => item instanceof MainTerminal).length;
                    const maxSessions = server.config.consoleMaxSessions || 3;
                    if (activeSessions >= maxSessions) {
                        throw new ValidationError(`Console session limit reached (${activeSessions}/${maxSessions}). Close an existing session before opening another.`);
                    }
                    terminal = new MainTerminal(server, terminalName, socket);
                    terminal.rows = 50;
                    created = true;
                    log.debug("mainTerminal", "Terminal created");
                } else if (existingTerminal instanceof MainTerminal) {
                    if (!existingTerminal.belongsTo(socket)) {
                        throw new ValidationError("Terminal session belongs to another connection.");
                    }
                    terminal = existingTerminal;
                } else {
                    throw new ValidationError("Terminal name is already in use.");
                }

                terminal.join(socket);
                terminal.start();

                if (created) {
                    const openedAt = Date.now();
                    await safelyWriteOperationLog({
                        actionType: "terminal_open",
                        objectType: "terminal_session",
                        objectId: terminal.name,
                        after: {
                            target: terminal.profile.target,
                            platform: terminal.profile.platform,
                            shell: terminal.profile.shell,
                            transport: terminal.transport,
                            idleTimeoutSeconds: terminal.idleTimeoutSeconds,
                        },
                        result: "success",
                        socket,
                        startedAt: openedAt,
                    });
                    terminal.onClose(event => {
                        void safelyWriteOperationLog({
                            actionType: "terminal_close",
                            objectType: "terminal_session",
                            objectId: terminal.name,
                            before: {
                                target: terminal.profile.target,
                                platform: terminal.profile.platform,
                                shell: terminal.profile.shell,
                                transport: terminal.transport,
                            },
                            after: {
                                reason: event.reason,
                                exitCode: event.exitCode,
                                durationMs: Math.max(0, Date.now() - openedAt),
                            },
                            result: "success",
                            socket,
                            startedAt: openedAt,
                        });
                    });
                }

                callbackResult({
                    ok: true,
                    terminalName,
                    profile: {
                        ...terminal.profile,
                        transport: terminal.transport,
                    },
                    policy: {
                        idleTimeoutSeconds: terminal.idleTimeoutSeconds,
                        maxSessions: server.config.consoleMaxSessions || 3,
                    },
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Check if MainTerminal is enabled
        agentSocket.on("checkMainTerminal", async (callback) => {
            try {
                checkLogin(socket);
                if (!server.config.enableConsole) {
                    callbackResult({
                        ok: false,
                        msg: "Console is not enabled.",
                    }, callback);
                    return;
                }
                const terminal = new MainTerminal(server, `console_check_${Date.now()}`, socket);
                Terminal.removeTerminal(terminal.name);
                terminal.close("profile_check");
                callbackResult({
                    ok: true,
                    profile: terminal.profile,
                    policy: {
                        idleTimeoutSeconds: terminal.idleTimeoutSeconds,
                        maxSessions: server.config.consoleMaxSessions || 3,
                    },
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Interactive Terminal for containers
        agentSocket.on("interactiveTerminal", async (stackName : unknown, serviceName : unknown, shell : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string.");
                }

                if (typeof(serviceName) !== "string") {
                    throw new ValidationError("Service name must be a string.");
                }

                if (typeof(shell) !== "string") {
                    throw new ValidationError("Shell must be a string.");
                }

                log.debug("interactiveTerminal", "Stack name: " + stackName);
                log.debug("interactiveTerminal", "Service name: " + serviceName);

                // Get stack
                const stack = await Stack.getStack(server, stackName);
                stack.joinContainerTerminal(socket, serviceName, shell);

                callbackResult({
                    ok: true,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Join Output Terminal
        agentSocket.on("terminalJoin", async (terminalName : unknown, callback) => {
            if (typeof(callback) !== "function") {
                log.debug("console", "Callback is not a function.");
                return;
            }

            try {
                checkLogin(socket);
                if (typeof(terminalName) !== "string") {
                    throw new ValidationError("Terminal name must be a string.");
                }

                const terminal = Terminal.getTerminal(terminalName);
                if (terminal instanceof MainTerminal && !terminal.belongsTo(socket)) {
                    throw new ValidationError("Terminal session belongs to another connection.");
                }
                let buffer : string = terminal?.getBuffer() ?? "";

                if (!buffer) {
                    log.debug("console", "No buffer found.");
                }

                callback({
                    ok: true,
                    buffer,
                });
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Leave Combined Terminal
        agentSocket.on("leaveCombinedTerminal", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);

                log.debug("leaveCombinedTerminal", "Stack name: " + stackName);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string.");
                }

                const stack = await Stack.getStack(server, stackName);
                await stack.leaveCombinedTerminal(socket);

                callbackResult({
                    ok: true,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("closeMainTerminal", async (terminalName : unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof terminalName !== "string") {
                    throw new ValidationError("Terminal name must be a string.");
                }
                const terminal = Terminal.getTerminal(terminalName);
                if (!(terminal instanceof MainTerminal)) {
                    callbackResult({
                        ok: true,
                        alreadyClosed: true,
                    }, callback);
                    return;
                }
                if (!terminal.belongsTo(socket)) {
                    throw new ValidationError("Terminal session belongs to another connection.");
                }
                terminal.close("client_close");
                callbackResult({
                    ok: true,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Resize Terminal
        agentSocket.on("terminalResize", async (terminalName: unknown, rows: unknown, cols: unknown, callback) => {
            log.info("terminalResize", `Terminal: ${terminalName}`);
            try {
                checkLogin(socket);
                if (typeof terminalName !== "string") {
                    throw new Error("Terminal name must be a string.");
                }

                if (typeof rows !== "number") {
                    throw new Error("Command must be a number.");
                }
                if (typeof cols !== "number") {
                    throw new Error("Command must be a number.");
                }

                let terminal = Terminal.getTerminal(terminalName);

                // log.info("terminal", terminal);
                if (terminal instanceof Terminal) {
                    if (terminal instanceof MainTerminal && !terminal.belongsTo(socket)) {
                        throw new ValidationError("Terminal session belongs to another connection.");
                    }
                    //log.debug("terminalInput", "Terminal found, writing to terminal.");
                    terminal.rows = rows;
                    terminal.cols = cols;
                    if (terminal instanceof MainTerminal) {
                        terminal.touch();
                    }
                    if (typeof callback === "function") {
                        callbackResult({
                            ok: true,
                        }, callback);
                    }
                } else {
                    throw new Error(`${terminalName} Terminal not found.`);
                }
            } catch (e) {
                if (typeof callback === "function") {
                    callbackError(e, callback);
                } else if (e instanceof Error) {
                    log.debug("terminalResize", `Error on ${String(terminalName)}: ${e.message}`);
                }
            }
        });

        socket.once("disconnect", () => {
            for (const terminal of Terminal.getTerminalList()) {
                if (terminal instanceof MainTerminal && terminal.belongsTo(socket)) {
                    terminal.close("socket_disconnect");
                }
            }
        });
    }
}
