import assert from "node:assert/strict";
import { DockerResourceManager } from "../backend/docker-resource-manager";
import { permissionForAgentEvent } from "../backend/util-server";

const containerId = "a".repeat(64);
const networkId = "b".repeat(64);
const bridgeId = "c".repeat(64);
const calls : string[][] = [];
const networks : Array<Record<string, unknown>> = [
    { Name: "app-net",
        Id: networkId,
        Driver: "bridge",
        Scope: "local",
        Created: "2026-07-15T00:00:00Z",
        Labels: { "com.docker.compose.project": "demo" },
        IPAM: { Config: [{ Subnet: "172.30.0.0/16",
            Gateway: "172.30.0.1" }] } },
    { Name: "bridge",
        Id: bridgeId,
        Driver: "bridge",
        Scope: "local",
        Labels: {} },
];
const volumes : Array<Record<string, unknown>> = [
    { Name: "demo-data",
        Driver: "local",
        Scope: "local",
        CreatedAt: "2026-07-15T00:00:00Z",
        Labels: { "com.docker.compose.project": "demo" } },
    { Name: "unused-data",
        Driver: "local",
        Scope: "local",
        Labels: {},
        Options: {} },
];
const containers : Array<Record<string, unknown>> = [
    { Id: containerId,
        Name: "/demo-web-1",
        Config: { Labels: { "com.docker.compose.project": "demo",
            "com.docker.compose.service": "web" } },
        State: { Status: "running",
            Running: true },
        NetworkSettings: { Networks: { "app-net": { NetworkID: networkId,
            IPAddress: "172.30.0.2" } } },
        Mounts: [{ Type: "volume",
            Name: "demo-data",
            Destination: "/var/lib/app",
            RW: true }] },
];

const runner = async (args : string[]) => {
    calls.push(args);
    const command = args.slice(0, 3).join(" ");
    if (command === "network ls --no-trunc") {
        return networks.map(network => network.Id).join("\n") + "\n";
    }
    if (command === "volume ls --quiet") {
        return volumes.map(volume => volume.Name).join("\n") + "\n";
    }
    if (command === "container ls --all") {
        return containers.map(container => container.Id).join("\n") + "\n";
    }
    if (args[0] === "network" && args[1] === "inspect") {
        return JSON.stringify(networks.filter(network => args.includes(String(network.Id))));
    }
    if (args[0] === "volume" && args[1] === "inspect") {
        return JSON.stringify(volumes.filter(volume => args.includes(String(volume.Name))));
    }
    if (args[0] === "container" && args[1] === "inspect") {
        return JSON.stringify(containers.filter(container => args.includes(String(container.Id))));
    }
    if (args[0] === "volume" && args[1] === "rm") {
        const index = volumes.findIndex(volume => volume.Name === args[2]);
        if (index >= 0) {
            volumes.splice(index, 1);
        }
        return `${args[2]}\n`;
    }
    if (args[0] === "network" && args[1] === "rm") {
        const index = networks.findIndex(network => network.Name === args[2]);
        if (index >= 0) {
            networks.splice(index, 1);
        }
        return `${args[2]}\n`;
    }
    if (args[0] === "network" && args[1] === "disconnect") {
        const container = containers.find(item => item.Id === args[3]);
        if (container) {
            const settings = container.NetworkSettings as { Networks: Record<string, unknown> };
            delete settings.Networks[args[2]];
        }
        return "";
    }
    if (args[0] === "network" && args[1] === "create") {
        const name = args.at(-1) as string;
        networks.push({ Name: name,
            Id: "d".repeat(64),
            Driver: args[args.indexOf("--driver") + 1],
            Scope: "local",
            Labels: { "com.dockerbridge.managed": "true" } });
        return "d".repeat(64) + "\n";
    }
    if (args[0] === "volume" && args[1] === "create") {
        const name = args.at(-1) as string;
        volumes.push({ Name: name,
            Driver: args[args.indexOf("--driver") + 1],
            Scope: "local",
            Labels: { "com.dockerbridge.managed": "true" } });
        return `${name}\n`;
    }
    throw new Error(`Unexpected Docker command: ${args.join(" ")}`);
};

const manager = new DockerResourceManager(runner);

assert.equal(permissionForAgentEvent("getDockerResourceInventory"), "read");
assert.equal(permissionForAgentEvent("removeDockerResource"), "destructive");
assert.equal(permissionForAgentEvent("disconnectDockerNetwork"), "destructive");

const inventory = await manager.inventory();
assert.equal(inventory.networks.length, 2);
assert.equal(inventory.volumes.length, 2);
assert.equal(inventory.networks.find(network => network.name === "app-net")?.dependencies[0].name, "demo-web-1");
assert.equal(inventory.networks.find(network => network.name === "bridge")?.builtin, true);
assert.equal(inventory.volumes.find(volume => volume.name === "demo-data")?.dependencies[0].target, "/var/lib/app");
assert.equal(inventory.volumes.find(volume => volume.name === "unused-data")?.orphaned, true);

const builtinPreview = await manager.previewRemoval("network", "bridge");
assert.equal(builtinPreview.canRemove, false);
assert.match(builtinPreview.blockers.join(" "), /built-in/);
const attachedVolume = await manager.previewRemoval("volume", "demo-data");
assert.equal(attachedVolume.canRemove, false);

const unusedPreview = await manager.previewRemoval("volume", "unused-data");
assert.equal(unusedPreview.canRemove, true);
assert.match(unusedPreview.warnings.join(" "), /permanently deletes/);
await assert.rejects(() => manager.remove("volume", "unused-data", unusedPreview.fingerprint, "wrong"), /exact volume name/);
(volumes.find(volume => volume.Name === "unused-data") as Record<string, unknown>).Options = { changed: "yes" };
await assert.rejects(() => manager.remove("volume", "unused-data", unusedPreview.fingerprint, "unused-data"), /changed after preview/);
const refreshedUnused = await manager.previewRemoval("volume", "unused-data");
await manager.remove("volume", "unused-data", refreshedUnused.fingerprint, "unused-data");
assert.equal(volumes.some(volume => volume.Name === "unused-data"), false);

const disconnectPreview = await manager.previewNetworkDisconnect("app-net", containerId);
assert.match(disconnectPreview.warnings.join(" "), /running/);
assert.match(disconnectPreview.warnings.join(" "), /only attached network/);
await assert.rejects(() => manager.disconnectNetwork("app-net", containerId, "0".repeat(64), "demo-web-1"), /changed after preview/);
await manager.disconnectNetwork("app-net", containerId, disconnectPreview.fingerprint, "demo-web-1");
assert.equal((await manager.previewRemoval("network", "app-net")).canRemove, true);

await manager.createNetwork({ name: "manual-net",
    driver: "bridge",
    internal: true,
    attachable: false,
    ipv6: false,
    subnet: "172.31.0.0/16",
    gateway: "172.31.0.1" });
await manager.createVolume({ name: "manual-data",
    driver: "local" });
assert.equal(networks.some(network => network.Name === "manual-net"), true);
assert.equal(volumes.some(volume => volume.Name === "manual-data"), true);
await assert.rejects(() => manager.createNetwork({ name: "bad/name" }), /name is invalid/);
await assert.rejects(() => manager.createNetwork({ name: "bad-subnet",
    subnet: "172.31.0.0/99" }), /valid IPv4 or IPv6 CIDR/);
await assert.rejects(() => manager.createNetwork({ name: "macvlan-no-parent",
    driver: "macvlan" }), /require a parent interface/);
assert.equal(calls.some(args => args.join(" ").includes("network disconnect app-net")), true);

console.log("docker resources integration: inventory, dependencies, stale previews, disconnect, create and safe removal passed");
