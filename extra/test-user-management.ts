import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { R } from "redbean-node";
import { Database } from "../backend/database";
import { DockgeServer } from "../backend/dockge-server";
import { generatePasswordHash } from "../backend/password-hash";
import { UserSocketHandler } from "../backend/socket-handlers/user-socket-handler";
import { DockgeSocket } from "../backend/util-server";

const root = path.resolve(".tmp", `user-management-test-${process.pid}`);
const dataDir = path.join(root, "data");
const stacksDir = path.join(root, "stacks");
const handlers = new Map<string, (...args : unknown[]) => void>();
const server = {
    config: { dataDir,
        stacksDir },
    stacksDir,
    disconnectAllSocketClients: () => undefined,
} as unknown as DockgeServer;
const socket = {
    userID: 0,
    userRole: "admin",
    endpoint: "",
    instanceManager: {},
    emitAgent: () => undefined,
    on(event : string, callback : (...args : unknown[]) => void) {
        handlers.set(event, callback);
    },
} as unknown as DockgeSocket;
let databaseOpen = false;

try {
    await fs.rm(root, { recursive: true,
        force: true });
    await fs.mkdir(dataDir, { recursive: true });
    await fs.mkdir(stacksDir, { recursive: true });
    await Database.init(server);
    databaseOpen = true;

    await R.knex("user").insert([{
        username: "admin-one",
        password: generatePasswordHash("admin-one-password1"),
        active: true,
        role: "admin",
        twofa_status: false,
    }, {
        username: "admin-two",
        password: generatePasswordHash("admin-two-password1"),
        active: true,
        role: "admin",
        twofa_status: false,
    }]);
    const users = await R.knex("user")
        .select("id", "username")
        .whereIn("username", [ "admin-one", "admin-two" ]) as Array<{ id: number; username: string }>;
    const adminOne = users.find(user => user.username === "admin-one");
    const adminTwo = users.find(user => user.username === "admin-two");
    assert.ok(adminOne);
    assert.ok(adminTwo);
    socket.userID = Number(adminOne.id);

    new UserSocketHandler().create(socket, server);
    const update = handlers.get("updateDockerBridgeUser");
    assert.ok(update);
    const invoke = (id : number) => new Promise<unknown>(resolve => {
        update({ id,
            role: "operator",
            active: true }, resolve);
    });

    const results = await Promise.all([ invoke(Number(adminOne.id)), invoke(Number(adminTwo.id)) ]);
    assert.equal(results.filter(result => (result as { ok?: boolean }).ok === true).length, 1);
    assert.equal(results.filter(result => (result as { ok?: boolean }).ok === false).length, 1);
    assert.match(String((results.find(result => (result as { ok?: boolean }).ok === false) as { msg?: string }).msg), /last active administrator/i);

    const activeAdmins = await R.knex("user").where({ role: "admin",
        active: true }).count("id as count").first();
    assert.equal(Number(activeAdmins?.count || 0), 1);

    console.log("user management integration: concurrent last-admin protection passed");
} finally {
    if (databaseOpen) {
        await Database.close();
    }
    await fs.rm(root, { recursive: true,
        force: true });
}
