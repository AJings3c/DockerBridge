import crypto from "node:crypto";
import net from "node:net";
import { spawn as spawnProcess } from "node:child_process";
import { ValidationError } from "./util-server";

type ResourceKind = "network" | "volume";
type DockerRunner = (args: string[]) => Promise<string>;

interface DockerNetworkInspect {
    Name?: string;
    Id?: string;
    Created?: string;
    Scope?: string;
    Driver?: string;
    EnableIPv6?: boolean;
    Internal?: boolean;
    Attachable?: boolean;
    Ingress?: boolean;
    Labels?: Record<string, string>;
    IPAM?: {
        Config?: Array<{
            Subnet?: string;
            Gateway?: string;
            IPRange?: string;
        }>;
    };
}

interface DockerVolumeInspect {
    Name?: string;
    Driver?: string;
    Scope?: string;
    CreatedAt?: string;
    Labels?: Record<string, string>;
    Options?: Record<string, string>;
    UsageData?: {
        Size?: number;
        RefCount?: number;
    };
}

interface DockerContainerInspect {
    Id?: string;
    Name?: string;
    Config?: {
        Labels?: Record<string, string>;
    };
    State?: {
        Status?: string;
        Running?: boolean;
    };
    NetworkSettings?: {
        Networks?: Record<string, {
            NetworkID?: string;
            IPAddress?: string;
            GlobalIPv6Address?: string;
            MacAddress?: string;
        }>;
    };
    Mounts?: Array<{
        Type?: string;
        Name?: string;
        Destination?: string;
        RW?: boolean;
    }>;
}

export interface DockerResourceDependency {
    id: string;
    name: string;
    state: string;
    running: boolean;
    composeProject: string;
    composeService: string;
    target: string;
    readWrite: boolean;
    ipAddress: string;
    otherNetworks: string[];
}

export interface DockerNetworkResource {
    kind: "network";
    id: string;
    shortId: string;
    name: string;
    driver: string;
    scope: string;
    createdAt: string;
    internal: boolean;
    attachable: boolean;
    ipv6: boolean;
    ingress: boolean;
    builtin: boolean;
    composeProject: string;
    labelKeys: string[];
    subnets: Array<{
        subnet: string;
        gateway: string;
        ipRange: string;
    }>;
    dependencies: DockerResourceDependency[];
    orphaned: boolean;
    removable: boolean;
    fingerprint: string;
}

export interface DockerVolumeResource {
    kind: "volume";
    name: string;
    driver: string;
    scope: string;
    createdAt: string;
    composeProject: string;
    anonymous: boolean;
    labelKeys: string[];
    optionKeys: string[];
    sizeBytes: number | null;
    refCount: number;
    dependencies: DockerResourceDependency[];
    orphaned: boolean;
    removable: boolean;
    fingerprint: string;
}

export interface DockerResourceInventory {
    generatedAt: string;
    networks: DockerNetworkResource[];
    volumes: DockerVolumeResource[];
    summary: {
        networks: number;
        orphanedNetworks: number;
        volumes: number;
        orphanedVolumes: number;
        attachedContainers: number;
    };
}

export interface DockerResourceRemovalPreview {
    kind: ResourceKind;
    name: string;
    fingerprint: string;
    generatedAt: string;
    dependencies: DockerResourceDependency[];
    blockers: string[];
    warnings: string[];
    canRemove: boolean;
}

export interface DockerNetworkDisconnectPreview {
    networkName: string;
    networkFingerprint: string;
    containerId: string;
    containerName: string;
    fingerprint: string;
    generatedAt: string;
    blockers: string[];
    warnings: string[];
    dependency: DockerResourceDependency;
}

export class DockerResourceManager {
    private static activeOperations = new Set<string>();
    private readonly runner : DockerRunner;

    constructor(runner? : DockerRunner) {
        this.runner = runner || (args => this.runDocker(args));
    }

    async inventory() : Promise<DockerResourceInventory> {
        const [ networkIds, volumeNames, containerIds ] = await Promise.all([
            this.list([ "network", "ls", "--no-trunc", "--quiet" ]),
            this.list([ "volume", "ls", "--quiet" ]),
            this.list([ "container", "ls", "--all", "--no-trunc", "--quiet" ]),
        ]);
        const [ rawNetworks, rawVolumes, rawContainers ] = await Promise.all([
            this.inspectMany<DockerNetworkInspect>([ "network", "inspect" ], networkIds),
            this.inspectMany<DockerVolumeInspect>([ "volume", "inspect" ], volumeNames),
            this.inspectMany<DockerContainerInspect>([ "container", "inspect" ], containerIds),
        ]);
        const containers = rawContainers.map(container => this.container(container));
        const networks = rawNetworks.map(network => this.network(network, containers)).sort((left, right) => left.name.localeCompare(right.name));
        const volumes = rawVolumes.map(volume => this.volume(volume, containers)).sort((left, right) => left.name.localeCompare(right.name));
        return {
            generatedAt: new Date().toISOString(),
            networks,
            volumes,
            summary: {
                networks: networks.length,
                orphanedNetworks: networks.filter(network => network.orphaned).length,
                volumes: volumes.length,
                orphanedVolumes: volumes.filter(volume => volume.orphaned).length,
                attachedContainers: containers.length,
            },
        };
    }

    async previewRemoval(kind : ResourceKind, name : string) : Promise<DockerResourceRemovalPreview> {
        this.assertKind(kind);
        this.assertName(name, kind);
        const inventory = await this.inventory();
        const resource = this.findResource(inventory, kind, name);
        const blockers : string[] = [];
        const warnings : string[] = [];
        if (resource.dependencies.length > 0) {
            blockers.push(`${resource.dependencies.length} container(s) still depend on this ${kind}`);
        }
        if (kind === "network") {
            const network = resource as DockerNetworkResource;
            if (network.builtin) {
                blockers.push("Docker built-in networks cannot be removed");
            }
            if (network.ingress) {
                blockers.push("Swarm ingress networks cannot be removed from this operation");
            }
            if (network.scope !== "local") {
                blockers.push(`Network scope ${network.scope} is not locally removable`);
            }
            if (network.composeProject) {
                warnings.push(`Compose project ${network.composeProject} declared this network`);
            }
        } else {
            const volume = resource as DockerVolumeResource;
            if (volume.scope !== "local") {
                blockers.push(`Volume scope ${volume.scope} is not locally removable`);
            }
            warnings.push("Removing a volume permanently deletes all data stored in it");
            if (volume.composeProject) {
                warnings.push(`Compose project ${volume.composeProject} declared this volume`);
            }
            if (!volume.anonymous) {
                warnings.push("This is a named volume, not an anonymous runtime volume");
            }
        }
        return {
            kind,
            name,
            fingerprint: resource.fingerprint,
            generatedAt: inventory.generatedAt,
            dependencies: resource.dependencies,
            blockers,
            warnings,
            canRemove: blockers.length === 0,
        };
    }

    async remove(kind : ResourceKind, name : string, expectedFingerprint : string, confirmation : string) {
        const key = `remove:${kind}:${name}`;
        return this.exclusive(key, async () => {
            if (confirmation !== name) {
                throw new ValidationError(`Type the exact ${kind} name to confirm removal`);
            }
            const preview = await this.previewRemoval(kind, name);
            if (preview.fingerprint !== expectedFingerprint) {
                throw new ValidationError(`The ${kind} changed after preview; generate a new removal preview`);
            }
            if (!preview.canRemove) {
                throw new ValidationError(preview.blockers.join("; "));
            }
            const output = await this.runner([ kind, "rm", name ]);
            return { preview,
                output: output.trim() };
        });
    }

    async previewNetworkDisconnect(networkName : string, containerId : string) : Promise<DockerNetworkDisconnectPreview> {
        this.assertName(networkName, "network");
        this.assertContainerId(containerId);
        const inventory = await this.inventory();
        const network = this.findResource(inventory, "network", networkName) as DockerNetworkResource;
        const dependency = network.dependencies.find(item => item.id === containerId || item.id.startsWith(containerId));
        if (!dependency) {
            throw new ValidationError(`Container ${containerId} is not attached to network ${networkName}`);
        }
        const blockers : string[] = [];
        const warnings : string[] = [];
        if (network.builtin) {
            blockers.push("Containers cannot be disconnected from Docker built-in networks in this workflow");
        }
        if (network.ingress) {
            blockers.push("Containers cannot be disconnected from a Swarm ingress network here");
        }
        if (dependency.running) {
            warnings.push(`Container ${dependency.name} is running and may immediately lose connectivity`);
        }
        if (dependency.otherNetworks.length === 0) {
            warnings.push(`Network ${networkName} is the container's only attached network`);
        }
        if (dependency.composeProject) {
            warnings.push(`Compose may reconnect the container when project ${dependency.composeProject} is recreated`);
        }
        return {
            networkName,
            networkFingerprint: network.fingerprint,
            containerId: dependency.id,
            containerName: dependency.name,
            fingerprint: this.hash({ network: network.fingerprint,
                containerId: dependency.id,
                otherNetworks: dependency.otherNetworks,
                running: dependency.running }),
            generatedAt: inventory.generatedAt,
            blockers,
            warnings,
            dependency,
        };
    }

    async disconnectNetwork(networkName : string, containerId : string, expectedFingerprint : string, confirmation : string) {
        const key = `disconnect:${networkName}:${containerId}`;
        return this.exclusive(key, async () => {
            const preview = await this.previewNetworkDisconnect(networkName, containerId);
            if (confirmation !== preview.containerName) {
                throw new ValidationError("Type the exact container name to confirm network disconnection");
            }
            if (preview.fingerprint !== expectedFingerprint) {
                throw new ValidationError("Network attachment changed after preview; generate a new disconnect preview");
            }
            if (preview.blockers.length > 0) {
                throw new ValidationError(preview.blockers.join("; "));
            }
            const output = await this.runner([ "network", "disconnect", networkName, preview.containerId ]);
            return { preview,
                output: output.trim() };
        });
    }

    async createNetwork(payload : unknown) {
        const data = this.object(payload);
        const name = this.string(data.name, "Network name");
        this.assertName(name, "network");
        const driver = data.driver === undefined ? "bridge" : this.string(data.driver, "Network driver");
        if (![ "bridge", "overlay", "macvlan", "ipvlan" ].includes(driver)) {
            throw new ValidationError("Unsupported Docker network driver");
        }
        const internal = this.boolean(data.internal, false, "internal");
        const attachable = this.boolean(data.attachable, false, "attachable");
        const ipv6 = this.boolean(data.ipv6, false, "ipv6");
        const subnet = this.optionalString(data.subnet, "Subnet");
        const gateway = this.optionalString(data.gateway, "Gateway");
        const parent = this.optionalString(data.parent, "Parent interface");
        if (subnet) {
            this.assertCIDR(subnet);
        }
        if (gateway && net.isIP(gateway) === 0) {
            throw new ValidationError("Gateway must be a valid IPv4 or IPv6 address");
        }
        if (parent && !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,63}$/.test(parent)) {
            throw new ValidationError("Parent interface is invalid");
        }
        if ([ "macvlan", "ipvlan" ].includes(driver) && !parent) {
            throw new ValidationError(`${driver} networks require a parent interface`);
        }
        const inventory = await this.inventory();
        if (inventory.networks.some(network => network.name === name)) {
            throw new ValidationError(`Docker network ${name} already exists`);
        }
        const args = [ "network", "create", "--driver", driver ];
        if (internal) {
            args.push("--internal");
        }
        if (attachable) {
            args.push("--attachable");
        }
        if (ipv6) {
            args.push("--ipv6");
        }
        if (subnet) {
            args.push("--subnet", subnet);
        }
        if (gateway) {
            args.push("--gateway", gateway);
        }
        if (parent) {
            args.push("--opt", `parent=${parent}`);
        }
        args.push("--label", "com.dockerbridge.managed=true", name);
        return { name,
            driver,
            output: (await this.runner(args)).trim() };
    }

    async createVolume(payload : unknown) {
        const data = this.object(payload);
        const name = this.string(data.name, "Volume name");
        this.assertName(name, "volume");
        const driver = data.driver === undefined ? "local" : this.string(data.driver, "Volume driver");
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(driver)) {
            throw new ValidationError("Volume driver is invalid");
        }
        const inventory = await this.inventory();
        if (inventory.volumes.some(volume => volume.name === name)) {
            throw new ValidationError(`Docker volume ${name} already exists`);
        }
        return { name,
            driver,
            output: (await this.runner([ "volume", "create", "--driver", driver, "--label", "com.dockerbridge.managed=true", name ])).trim() };
    }

    private network(raw : DockerNetworkInspect, containers : ReturnType<DockerResourceManager["container"]>[]) : DockerNetworkResource {
        const name = String(raw.Name || "");
        const id = String(raw.Id || "");
        const labels = raw.Labels || {};
        const dependencies = containers.flatMap(container => {
            const attachment = container.networks[name] || Object.values(container.networks).find(network => network.networkId === id);
            return attachment ? [ this.dependency(container, {
                ipAddress: attachment.ipAddress,
                otherNetworks: Object.keys(container.networks).filter(networkName => networkName !== name) }) ] : [];
        }).sort((left, right) => left.name.localeCompare(right.name));
        const builtin = [ "bridge", "host", "none" ].includes(name);
        const base = {
            kind: "network" as const,
            id,
            shortId: id.slice(0, 12),
            name,
            driver: String(raw.Driver || "unknown"),
            scope: String(raw.Scope || "local"),
            createdAt: String(raw.Created || ""),
            internal: Boolean(raw.Internal),
            attachable: Boolean(raw.Attachable),
            ipv6: Boolean(raw.EnableIPv6),
            ingress: Boolean(raw.Ingress),
            builtin,
            composeProject: String(labels["com.docker.compose.project"] || ""),
            labelKeys: Object.keys(labels).sort(),
            subnets: (raw.IPAM?.Config || []).map(config => ({ subnet: String(config.Subnet || ""),
                gateway: String(config.Gateway || ""),
                ipRange: String(config.IPRange || "") })),
            dependencies,
            orphaned: dependencies.length === 0 && !builtin && !raw.Ingress,
            removable: dependencies.length === 0 && !builtin && !raw.Ingress && (raw.Scope || "local") === "local",
        };
        return { ...base,
            fingerprint: this.hash(base) };
    }

    private volume(raw : DockerVolumeInspect, containers : ReturnType<DockerResourceManager["container"]>[]) : DockerVolumeResource {
        const name = String(raw.Name || "");
        const labels = raw.Labels || {};
        const dependencies = containers.flatMap(container => container.mounts.filter(mount => mount.name === name).map(mount => this.dependency(container, {
            target: mount.destination,
            readWrite: mount.readWrite }))).sort((left, right) => left.name.localeCompare(right.name));
        const anonymous = /^[a-f0-9]{64}$/.test(name) && Object.keys(labels).length === 0;
        const size = raw.UsageData?.Size;
        const base = {
            kind: "volume" as const,
            name,
            driver: String(raw.Driver || "unknown"),
            scope: String(raw.Scope || "local"),
            createdAt: String(raw.CreatedAt || ""),
            composeProject: String(labels["com.docker.compose.project"] || ""),
            anonymous,
            labelKeys: Object.keys(labels).sort(),
            optionKeys: Object.keys(raw.Options || {}).sort(),
            sizeBytes: typeof size === "number" && size >= 0 ? size : null,
            refCount: typeof raw.UsageData?.RefCount === "number" ? raw.UsageData.RefCount : dependencies.length,
            dependencies,
            orphaned: dependencies.length === 0,
            removable: dependencies.length === 0 && (raw.Scope || "local") === "local",
        };
        return { ...base,
            fingerprint: this.hash(base) };
    }

    private container(raw : DockerContainerInspect) {
        const labels = raw.Config?.Labels || {};
        return {
            id: String(raw.Id || ""),
            name: String(raw.Name || "").replace(/^\//, ""),
            state: String(raw.State?.Status || "unknown"),
            running: Boolean(raw.State?.Running),
            composeProject: String(labels["com.docker.compose.project"] || ""),
            composeService: String(labels["com.docker.compose.service"] || ""),
            networks: Object.fromEntries(Object.entries(raw.NetworkSettings?.Networks || {}).map(([ name, network ]) => [ name, {
                networkId: String(network.NetworkID || ""),
                ipAddress: String(network.IPAddress || network.GlobalIPv6Address || ""),
                macAddress: String(network.MacAddress || ""),
            }])),
            mounts: (raw.Mounts || []).filter(mount => mount.Type === "volume" && mount.Name).map(mount => ({ name: String(mount.Name),
                destination: String(mount.Destination || ""),
                readWrite: mount.RW !== false })),
        };
    }

    private dependency(container : ReturnType<DockerResourceManager["container"]>, detail : { target?: string; readWrite?: boolean; ipAddress?: string; otherNetworks?: string[] }) : DockerResourceDependency {
        return {
            id: container.id,
            name: container.name,
            state: container.state,
            running: container.running,
            composeProject: container.composeProject,
            composeService: container.composeService,
            target: detail.target || "",
            readWrite: detail.readWrite !== false,
            ipAddress: detail.ipAddress || "",
            otherNetworks: detail.otherNetworks || Object.keys(container.networks),
        };
    }

    private findResource(inventory : DockerResourceInventory, kind : ResourceKind, name : string) {
        const resource = kind === "network"
            ? inventory.networks.find(network => network.name === name)
            : inventory.volumes.find(volume => volume.name === name);
        if (!resource) {
            throw new ValidationError(`Docker ${kind} ${name} was not found`);
        }
        return resource;
    }

    private async inspectMany<T>(prefix : string[], identities : string[]) : Promise<T[]> {
        const results : T[] = [];
        for (let index = 0; index < identities.length; index += 100) {
            const output = await this.runner([ ...prefix,
                ...identities.slice(index, index + 100) ]);
            const parsed = JSON.parse(output || "[]");
            if (!Array.isArray(parsed)) {
                throw new Error(`Docker ${prefix.join(" ")} returned an invalid response`);
            }
            results.push(...parsed as T[]);
        }
        return results;
    }

    private async list(args : string[]) {
        return (await this.runner(args)).split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    }

    private runDocker(args : string[]) : Promise<string> {
        return new Promise((resolve, reject) => {
            const process = spawnProcess("docker", args, { windowsHide: true });
            const stdout : Buffer[] = [];
            const stderr : Buffer[] = [];
            process.stdout.on("data", (chunk : Buffer) => stdout.push(chunk));
            process.stderr.on("data", (chunk : Buffer) => stderr.push(chunk));
            process.on("error", reject);
            process.on("close", code => {
                const output = Buffer.concat(stdout).toString("utf-8");
                const error = Buffer.concat(stderr).toString("utf-8").trim();
                if (code === 0) {
                    resolve(output);
                } else {
                    reject(new Error(error || `docker ${args.join(" ")} exited with code ${code}`));
                }
            });
        });
    }

    private assertKind(value : unknown) : asserts value is ResourceKind {
        if (value !== "network" && value !== "volume") {
            throw new ValidationError("Docker resource kind must be network or volume");
        }
    }

    private assertName(name : string, kind : ResourceKind) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name)) {
            throw new ValidationError(`Docker ${kind} name is invalid`);
        }
    }

    private assertContainerId(value : string) {
        if (!/^[a-f0-9]{12,64}$/.test(value)) {
            throw new ValidationError("Docker container ID is invalid");
        }
    }

    private assertCIDR(value : string) {
        const [ address, prefix, ...rest ] = value.split("/");
        const version = net.isIP(address);
        const prefixNumber = Number(prefix);
        if (rest.length > 0 || !version || !Number.isInteger(prefixNumber) || prefixNumber < 0 || prefixNumber > (version === 4 ? 32 : 128)) {
            throw new ValidationError("Subnet must be a valid IPv4 or IPv6 CIDR");
        }
    }

    private object(value : unknown) : Record<string, unknown> {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            throw new ValidationError("Invalid Docker resource request");
        }
        return value as Record<string, unknown>;
    }

    private string(value : unknown, label : string) {
        if (typeof value !== "string" || !value.trim()) {
            throw new ValidationError(`${label} is required`);
        }
        return value.trim();
    }

    private optionalString(value : unknown, label : string) {
        if (value === undefined || value === null || value === "") {
            return "";
        }
        if (typeof value !== "string") {
            throw new ValidationError(`${label} must be a string`);
        }
        return value.trim();
    }

    private boolean(value : unknown, fallback : boolean, label : string) {
        if (value === undefined) {
            return fallback;
        }
        if (typeof value !== "boolean") {
            throw new ValidationError(`${label} must be a boolean`);
        }
        return value;
    }

    private hash(value : unknown) {
        return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
    }

    private async exclusive<T>(key : string, action : () => Promise<T>) {
        if (DockerResourceManager.activeOperations.has(key)) {
            throw new ValidationError("The same Docker resource operation is already running");
        }
        DockerResourceManager.activeOperations.add(key);
        try {
            return await action();
        } finally {
            DockerResourceManager.activeOperations.delete(key);
        }
    }
}
