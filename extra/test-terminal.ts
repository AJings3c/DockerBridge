import assert from "node:assert/strict";
import { createConsoleTerminalName } from "../frontend-react/src/services/terminal";
import { DockgeServer } from "../backend/dockge-server";
import { MainTerminal, resolveConsoleCommand, Terminal } from "../backend/terminal";
import { DockgeSocket, permissionForAgentEvent } from "../backend/util-server";

const server = {
    config: {
        enableConsole: true,
        consoleTarget: "runtime",
        consoleIdleTimeoutSeconds: 30,
        consoleMaxSessions: 2,
    },
    stacksDir: process.cwd(),
} as unknown as DockgeServer;

const command = resolveConsoleCommand(server);
assert.ok(command.file, "a runtime shell must be available");
assert.equal(permissionForAgentEvent("mainTerminal"), "terminal");

const names = [ createConsoleTerminalName(), createConsoleTerminalName() ];
assert.notEqual(names[0], names[1]);
assert.match(names[0], /^console_[0-9]+_[A-Za-z0-9]+$/);

const output: string[] = [];
const socket = {
    id: "terminal-test-socket",
    userID: 1,
    userRole: "admin",
    connected: true,
    emitAgent(eventName : string, ...args : unknown[]) {
        if (eventName === "terminalWrite" && typeof args[1] === "string") {
            output.push(args[1]);
        }
    },
} as unknown as DockgeSocket;
const otherSocket = {
    ...socket,
    id: "terminal-other-socket",
} as unknown as DockgeSocket;

const terminal = new MainTerminal(server, names[0], socket);
assert.equal(terminal.belongsTo(socket), true);
assert.equal(terminal.belongsTo(otherSocket), false);
terminal.join(socket);
const closed = new Promise<{ reason: string }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("terminal did not exit")), 20000);
    terminal.onClose(event => {
        clearTimeout(timeout);
        resolve(event);
    });
});
terminal.start();
terminal.write(process.platform === "win32" ? "Write-Output DOCKERBRIDGE_TERMINAL_TEST\r" : "printf 'DOCKERBRIDGE_TERMINAL_TEST\\n'\r");

const outputDeadline = Date.now() + 20000;
while (!output.join("").includes("DOCKERBRIDGE_TERMINAL_TEST") && Date.now() < outputDeadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
}
terminal.close("test_complete");

const closeEvent = await closed;
assert.equal(closeEvent.reason, "test_complete");
assert.ok(output.join("").includes("DOCKERBRIDGE_TERMINAL_TEST"), "terminal output must reach the socket");
assert.equal(MainTerminal.getTerminal(names[0]), undefined);

const shutdownTerminal = new MainTerminal(server, names[1], socket);
shutdownTerminal.join(socket);
const shutdownClosed = new Promise<{ reason: string }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("shutdown terminal did not exit")), 20000);
    shutdownTerminal.onClose(event => {
        clearTimeout(timeout);
        resolve(event);
    });
});
shutdownTerminal.start();
Terminal.closeAll("server_shutdown");
assert.equal((await shutdownClosed).reason, "server_shutdown");
assert.equal(Terminal.getTerminalCount(), 0);

console.log(`terminal integration: ${command.platform} ${terminal.transport} shell startup, ownership, input/output and shutdown cleanup passed`);
