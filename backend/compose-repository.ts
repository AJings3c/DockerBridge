import fs, { promises as fsAsync } from "fs";
import path from "path";
import childProcessAsync from "promisify-child-process";
import yaml from "yaml";
import { DockgeServer } from "./dockge-server";

export type ComposeRepositoryStatus = "running" | "exited" | "created" | "inactive" | "unknown";

export interface ComposeRepositoryQuery {
    page?: number;
    pageSize?: number;
    search?: string;
    source?: string;
    status?: ComposeRepositoryStatus | "all";
    refresh?: boolean;
}

export interface ComposeRepositoryItem {
    id: string;
    projectName: string;
    fileName: string;
    filePath: string;
    directory: string;
    source: string;
    sourcePath: string;
    services: string[];
    serviceCount: number;
    modifiedAt: string;
    size: number;
    status: ComposeRepositoryStatus;
    statusText: string;
    readable: boolean;
    editable: boolean;
    managed: boolean;
}

interface ComposeRepositoryIndex {
    generatedAt: string;
    items: ComposeRepositoryItem[];
    sources: Array<{
        name: string;
        path: string;
        count: number;
    }>;
    scannedYamlFiles: number;
    invalidYamlFiles: number;
    truncated: boolean;
}

interface ComposeRuntimeEntry {
    name: string;
    status: ComposeRepositoryStatus;
    statusText: string;
}

interface ComposeRuntimeIndex {
    byName: Map<string, ComposeRuntimeEntry>;
    byPath: Map<string, ComposeRuntimeEntry>;
}

const SKIPPED_DIRECTORY_NAMES = new Set([
    ".cache",
    ".git",
    ".hg",
    ".next",
    ".nuxt",
    ".svn",
    ".turbo",
    ".vite",
    "build",
    "coverage",
    "dist",
    "frontend-dist",
    "node_modules",
    "vendor",
]);

const SKIPPED_PATH_PREFIXES = [
    "/dev",
    "/proc",
    "/run",
    "/sys",
    "/tmp",
    "/var/lib/docker",
    "/var/run",
];

export class ComposeRepository {
    private static cache : ComposeRepositoryIndex | undefined;
    private static cacheCreatedAt = 0;
    private static scanPromise : Promise<ComposeRepositoryIndex> | undefined;

    static async query(server : DockgeServer, query : ComposeRepositoryQuery = {}) {
        const page = this.toBoundedInteger(query.page, 1, 1, 100000);
        const pageSize = this.toBoundedInteger(query.pageSize, 50, 10, 200);
        const search = typeof query.search === "string" ? query.search.trim().toLocaleLowerCase() : "";
        const source = typeof query.source === "string" ? query.source.trim() : "";
        const status = this.isStatus(query.status) ? query.status : "all";
        const index = await this.getIndex(server, query.refresh === true);

        const filteredItems = index.items.filter((item) => {
            if (source && item.sourcePath !== source) {
                return false;
            }
            if (status !== "all" && item.status !== status) {
                return false;
            }
            if (!search) {
                return true;
            }
            const haystack = [
                item.projectName,
                item.fileName,
                item.filePath,
                item.source,
                ...item.services,
            ].join("\n").toLocaleLowerCase();
            return haystack.includes(search);
        });

        const total = filteredItems.length;
        const pageCount = Math.max(1, Math.ceil(total / pageSize));
        const safePage = Math.min(page, pageCount);
        const start = (safePage - 1) * pageSize;

        return {
            ok: true,
            generatedAt: index.generatedAt,
            items: filteredItems.slice(start, start + pageSize),
            pagination: {
                page: safePage,
                pageSize,
                pageCount,
                total,
            },
            summary: {
                total: index.items.length,
                running: index.items.filter(item => item.status === "running").length,
                inactive: index.items.filter(item => item.status === "inactive").length,
                unreadable: index.items.filter(item => !item.readable).length,
                scannedYamlFiles: index.scannedYamlFiles,
                invalidYamlFiles: index.invalidYamlFiles,
                truncated: index.truncated,
            },
            sources: index.sources,
        };
    }

    private static async getIndex(server : DockgeServer, refresh : boolean) : Promise<ComposeRepositoryIndex> {
        const cacheDuration = this.toBoundedInteger(
            Number(process.env.DOCKERBRIDGE_COMPOSE_REPOSITORY_CACHE_MS),
            30000,
            5000,
            300000
        );
        if (!refresh && this.cache && Date.now() - this.cacheCreatedAt < cacheDuration) {
            return this.cache;
        }
        if (!this.scanPromise) {
            this.scanPromise = this.scan(server).finally(() => {
                this.scanPromise = undefined;
            });
        }
        this.cache = await this.scanPromise;
        this.cacheCreatedAt = Date.now();
        return this.cache;
    }

    private static async scan(server : DockgeServer) : Promise<ComposeRepositoryIndex> {
        const scanRoots = await this.getScanRoots(server);
        const runtime = await this.getRuntimeEntries();
        const maxDepth = this.toBoundedInteger(Number(process.env.DOCKERBRIDGE_COMPOSE_SCAN_DEPTH), 10, 1, 30);
        const maxYamlFiles = this.toBoundedInteger(Number(process.env.DOCKERBRIDGE_COMPOSE_SCAN_LIMIT), 10000, 100, 100000);
        const maxFileSize = this.toBoundedInteger(Number(process.env.DOCKERBRIDGE_COMPOSE_SCAN_MAX_FILE_SIZE), 2 * 1024 * 1024, 1024, 20 * 1024 * 1024);
        const visitedDirectories = new Set<string>();
        const seenFiles = new Set<string>();
        const items : ComposeRepositoryItem[] = [];
        let scannedYamlFiles = 0;
        let invalidYamlFiles = 0;
        let truncated = false;

        const walk = async (directory : string, depth : number) => {
            if (depth > maxDepth || truncated || this.shouldSkipDirectory(directory)) {
                return;
            }
            let realDirectory : string;
            try {
                realDirectory = await fsAsync.realpath(directory);
            } catch (error) {
                return;
            }
            if (visitedDirectories.has(realDirectory)) {
                return;
            }
            visitedDirectories.add(realDirectory);

            let entries : fs.Dirent[];
            try {
                entries = await fsAsync.readdir(realDirectory, { withFileTypes: true });
            } catch (error) {
                return;
            }

            for (const entry of entries) {
                if (truncated) {
                    return;
                }
                const entryPath = path.join(realDirectory, entry.name);
                if (entry.isDirectory()) {
                    await walk(entryPath, depth + 1);
                    continue;
                }
                if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) {
                    continue;
                }
                scannedYamlFiles += 1;
                if (scannedYamlFiles > maxYamlFiles) {
                    truncated = true;
                    return;
                }
                const item = await this.inspectComposeFile(server, entryPath, scanRoots, runtime, maxFileSize);
                if (item && !seenFiles.has(item.filePath)) {
                    seenFiles.add(item.filePath);
                    items.push(item);
                } else if (!item) {
                    invalidYamlFiles += 1;
                }
            }
        };

        for (const root of scanRoots) {
            await walk(root.path, 0);
            if (truncated) {
                break;
            }
        }

        items.sort((left, right) => {
            const sourceOrder = left.source.localeCompare(right.source, "zh-CN");
            return sourceOrder || right.modifiedAt.localeCompare(left.modifiedAt) || left.filePath.localeCompare(right.filePath, "zh-CN");
        });

        return {
            generatedAt: new Date().toISOString(),
            items,
            sources: scanRoots.map(root => ({
                ...root,
                count: items.filter(item => item.sourcePath === root.path).length,
            })),
            scannedYamlFiles,
            invalidYamlFiles,
            truncated,
        };
    }

    private static async inspectComposeFile(
        server : DockgeServer,
        filePath : string,
        scanRoots : Array<{ name: string; path: string }>,
        runtime : ComposeRuntimeIndex,
        maxFileSize : number
    ) : Promise<ComposeRepositoryItem | undefined> {
        let realFile : string;
        let stat : fs.Stats;
        try {
            realFile = await fsAsync.realpath(filePath);
            stat = await fsAsync.stat(realFile);
            if (stat.size > maxFileSize) {
                return undefined;
            }
        } catch (error) {
            return undefined;
        }

        let content : string;
        try {
            content = await fsAsync.readFile(realFile, "utf-8");
        } catch (error) {
            return undefined;
        }

        let compose : Record<string, unknown>;
        try {
            const parsed = yaml.parse(content);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                return undefined;
            }
            compose = parsed as Record<string, unknown>;
        } catch (error) {
            return undefined;
        }

        const services = compose.services;
        if (!services || typeof services !== "object" || Array.isArray(services)) {
            return undefined;
        }
        const serviceNames = Object.keys(services).filter(service => service.trim()).sort((left, right) => left.localeCompare(right));
        if (serviceNames.length === 0) {
            return undefined;
        }

        const configuredName = typeof compose.name === "string" ? compose.name.trim() : "";
        const inferredName = configuredName || path.basename(path.dirname(realFile));
        const source = this.findSource(realFile, scanRoots);
        const runtimeEntry = runtime.byPath.get(path.resolve(realFile)) || runtime.byName.get(inferredName.toLocaleLowerCase());
        const projectName = configuredName || runtimeEntry?.name || inferredName;
        const readable = await this.canAccess(realFile, fs.constants.R_OK);
        const editable = await this.canAccess(realFile, fs.constants.W_OK);

        return {
            id: Buffer.from(realFile).toString("base64url"),
            projectName,
            fileName: path.basename(realFile),
            filePath: realFile,
            directory: path.dirname(realFile),
            source: source.name,
            sourcePath: source.path,
            services: serviceNames,
            serviceCount: serviceNames.length,
            modifiedAt: stat.mtime.toISOString(),
            size: stat.size,
            status: runtimeEntry?.status || "inactive",
            statusText: runtimeEntry?.statusText || "未运行",
            readable,
            editable,
            managed: this.isInsidePath(realFile, server.stacksDir),
        };
    }

    private static async getScanRoots(server : DockgeServer) {
        const configuredRoots = (process.env.DOCKERBRIDGE_COMPOSE_SCAN_DIRS || "")
            .split(/[;,]/)
            .map(item => item.trim())
            .filter(Boolean);
        const roots = configuredRoots.length > 0
            ? [ server.stacksDir, ...configuredRoots ]
            : [ server.stacksDir, "/opt/stacks", "/root", "/data" ];
        const uniqueRoots = new Map<string, { name: string; path: string }>();

        for (const root of roots) {
            try {
                const realRoot = await fsAsync.realpath(path.resolve(root));
                if (!uniqueRoots.has(realRoot) && (await fsAsync.stat(realRoot)).isDirectory()) {
                    uniqueRoots.set(realRoot, {
                        name: this.sourceName(realRoot),
                        path: realRoot,
                    });
                }
            } catch (error) {
            }
        }
        return Array.from(uniqueRoots.values()).sort((left, right) => right.path.length - left.path.length);
    }

    private static async getRuntimeEntries() : Promise<ComposeRuntimeIndex> {
        const runtime : ComposeRuntimeIndex = {
            byName: new Map<string, ComposeRuntimeEntry>(),
            byPath: new Map<string, ComposeRuntimeEntry>(),
        };
        try {
            const result = await childProcessAsync.spawn("docker", [ "compose", "ls", "--all", "--format", "json" ], {
                encoding: "utf-8",
            });
            if (!result.stdout) {
                return runtime;
            }
            const projects = JSON.parse(result.stdout.toString());
            if (!Array.isArray(projects)) {
                return runtime;
            }
            for (const project of projects) {
                if (!project || typeof project !== "object") {
                    continue;
                }
                const statusText = typeof project.Status === "string" ? project.Status : "";
                const configFiles = typeof project.ConfigFiles === "string" ? project.ConfigFiles.split(",") : [];
                for (const configFile of configFiles) {
                    if (configFile.trim()) {
                        const runtimeEntry = {
                            name: typeof project.Name === "string" ? project.Name : "",
                            status: this.runtimeStatus(statusText),
                            statusText: statusText || "状态未知",
                        };
                        runtime.byPath.set(path.resolve(configFile.trim()), runtimeEntry);
                        if (runtimeEntry.name) {
                            runtime.byName.set(runtimeEntry.name.toLocaleLowerCase(), runtimeEntry);
                        }
                    }
                }
            }
        } catch (error) {
        }
        return runtime;
    }

    private static runtimeStatus(status : string) : ComposeRepositoryStatus {
        if (status.includes("exited")) {
            return "exited";
        }
        if (status.startsWith("running")) {
            return "running";
        }
        if (status.startsWith("created")) {
            return "created";
        }
        return "unknown";
    }

    private static findSource(filePath : string, roots : Array<{ name: string; path: string }>) {
        return roots.find(root => this.isInsidePath(filePath, root.path)) || {
            name: path.parse(filePath).root,
            path: path.parse(filePath).root,
        };
    }

    private static isInsidePath(target : string, root : string) : boolean {
        const relative = path.relative(path.resolve(root), path.resolve(target));
        return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    }

    private static sourceName(root : string) : string {
        if (root === path.parse(root).root) {
            return root;
        }
        return path.basename(root) || root;
    }

    private static shouldSkipDirectory(directory : string) : boolean {
        const resolved = path.resolve(directory).replace(/\\/g, "/");
        const name = path.basename(resolved).toLocaleLowerCase();
        return SKIPPED_DIRECTORY_NAMES.has(name)
            || SKIPPED_PATH_PREFIXES.some(prefix => resolved === prefix || resolved.startsWith(prefix + "/"));
    }

    private static async canAccess(filePath : string, mode : number) : Promise<boolean> {
        try {
            await fsAsync.access(filePath, mode);
            return true;
        } catch (error) {
            return false;
        }
    }

    private static toBoundedInteger(value : number | undefined, fallback : number, minimum : number, maximum : number) : number {
        if (!Number.isFinite(value)) {
            return fallback;
        }
        return Math.min(maximum, Math.max(minimum, Math.floor(value as number)));
    }

    private static isStatus(status : unknown) : status is ComposeRepositoryStatus | "all" {
        return [ "all", "running", "exited", "created", "inactive", "unknown" ].includes(String(status));
    }
}
