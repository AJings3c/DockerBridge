import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { AgentManager } from "../backend/agent-manager";
import { Database } from "../backend/database";
import { DockgeServer } from "../backend/dockge-server";
import { Agent } from "../backend/models/agent";
import { DockgeSocket } from "../backend/util-server";

const root = path.resolve(".tmp", `agent-management-test-${process.pid}`);
const dataDir = path.join(root, "data");
const stacksDir = path.join(root, "stacks");
const emitted : unknown[][] = [];
const server = {
    config: { dataDir,
        stacksDir },
    stacksDir,
    packageJSON: { version: "1.5.0" },
    jwtSecret: "agent-management-test-secret",
} as unknown as DockgeServer;
const socket = {
    emit: (...args : unknown[]) => emitted.push(args),
} as unknown as DockgeSocket;
let databaseOpen = false;

try {
    await fs.rm(root, { recursive: true,
        force: true });
    await fs.mkdir(dataDir, { recursive: true });
    await fs.mkdir(stacksDir, { recursive: true });
    await Database.init(server);
    databaseOpen = true;

    const manager = new AgentManager(socket, server);
    const agent = await manager.add("https://agent.example:8612", "operator", "remote-password", "Build node");
    assert.equal(agent.endpoint, "agent.example:8612");
    assert.equal(agent.password, "");
    assert.match(String(agent.credential), /^v1:[^:]+:[^:]+:[^:]+$/);

    const snapshot = await manager.getManagementSnapshot();
    assert.equal(snapshot.agents.length, 1);
    assert.equal(snapshot.agents[0].endpoint, "agent.example:8612");
    assert.equal(snapshot.agents[0].credentialEncrypted, true);
    assert.equal(snapshot.agents[0].status.status, "connecting");
    assert.equal(snapshot.credentialEncryption.algorithm, "AES-256-GCM");

    await manager.updateManaged(agent.endpoint, "Build node disabled", false);
    const updated = await manager.getManagementSnapshot();
    assert.equal(updated.agents[0].name, "Build node disabled");
    assert.equal(updated.agents[0].active, false);
    assert.equal(updated.agents[0].credentialVersion, 1);

    const preview = await manager.previewRemoval(agent.endpoint);
    assert.equal(preview.endpoint, agent.endpoint);
    assert.equal(preview.active, false);
    assert.match(preview.warnings[0], /only unregisters/i);
    await assert.rejects(() => manager.removeManaged(agent.endpoint, preview.fingerprint, "wrong"), /exact Agent endpoint/);
    await manager.removeManaged(agent.endpoint, preview.fingerprint, agent.endpoint);
    assert.equal((await Agent.getAgentList())[agent.endpoint], undefined);
    assert.equal((await manager.getManagementSnapshot()).agents.length, 0);
    assert.ok(emitted.some(args => args[0] === "agentList"));

    console.log("agent management integration: encrypted enrollment, snapshot, removal preview, exact confirmation and removal passed");
} finally {
    if (databaseOpen) {
        await Database.close();
    }
    await fs.rm(root, { recursive: true,
        force: true });
}
