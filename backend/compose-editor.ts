import crypto from "node:crypto";
import fs, { promises as fsAsync } from "node:fs";
import path from "node:path";
import { spawn as spawnProcess } from "node:child_process";
import yaml from "yaml";
import { DockgeServer } from "./dockge-server";
import { Stack } from "./stack";
import { fileExists, ValidationError } from "./util-server";

const REVISION_VERSION = 1;
const REVISION_ID_PATTERN = /^\d{8}T\d{9}Z-[a-f0-9]{8}$/;
const MAX_COMPOSE_BYTES = 2 * 1024 * 1024;
const MAX_ENV_BYTES = 512 * 1024;

type RevisionReason = "save" | "deploy" | "rollback" | "pre-change";

interface ComposeRevisionManifest {
    version: number;
    id: string;
    stackName: string;
    composeFilePath: string;
    createdAt: string;
    reason: RevisionReason;
    sourceVersion: string;
    compose: {
        filename: string;
        size: number;
        sha256: string;
    };
    environment: {
        filename: string;
        size: number;
        sha256: string;
    };
}

export interface ComposeRevisionSummary {
    id: string;
    createdAt: string;
    reason: RevisionReason;
    sourceVersion: string;
    composeSize: number;
    environmentSize: number;
    status: "valid" | "invalid" | "unchecked";
    message?: string;
}

export interface ComposeDraftPayload {
    name: string;
    composeYAML: string;
    composeENV: string;
    isAdd: boolean;
    expectedSourceVersion?: string;
}

interface ComposeSource {
    composeYAML: string;
    composeENV: string;
}

interface FileState {
    path: string;
    exists: boolean;
    content: Buffer;
    mode?: number;
}

export class ComposeEditor {
    constructor(private server : DockgeServer) {
    }

    async load(stackName : string) {
        const stack = await this.existingStack(stackName);
        const source = await this.readStackSource(stack);
        return {
            name: stack.name,
            composeYAML: source.composeYAML,
            composeENV: source.composeENV,
            composeFilePath: stack.composeFilePath,
            endpointEditable: await this.isWritable(stack),
            discovered: stack.isDiscoveredCompose,
            sourceVersion: this.sourceVersion(source),
            revisions: await this.listRevisions(stack),
        };
    }

    async preview(payload : ComposeDraftPayload) {
        const draft = this.validatePayload(payload);
        const current = await this.currentSource(draft);
        this.assertExpectedVersion(draft.expectedSourceVersion, current.sourceVersion);
        const validation = await this.validateSource(draft.name, draft.composeYAML, draft.composeENV);
        return {
            name: draft.name,
            currentSourceVersion: current.sourceVersion,
            proposedSourceVersion: this.sourceVersion(draft),
            changed: current.sourceVersion !== this.sourceVersion(draft),
            validation,
            changes: this.describeChanges(current.source, draft),
        };
    }

    async commit(payload : ComposeDraftPayload, reason : "save" | "deploy" | "rollback") {
        const draft = this.validatePayload(payload);
        const current = await this.currentSource(draft);
        this.assertExpectedVersion(draft.expectedSourceVersion, current.sourceVersion);
        await this.validateSource(draft.name, draft.composeYAML, draft.composeENV);

        let previousRevision : ComposeRevisionSummary | undefined;
        if (current.stack) {
            previousRevision = await this.createRevision(current.stack, current.source, "pre-change", true);
        }

        const composeFilePath = current.stack?.composeFilePath;
        const stack = new Stack(this.server, draft.name, draft.composeYAML, draft.composeENV, false, composeFilePath);
        await this.writeSource(stack, draft, current.stack == null);
        const revision = await this.createRevision(stack, draft, reason, false);
        return {
            stack,
            revision,
            previousRevision,
            sourceVersion: this.sourceVersion(draft),
            revisions: await this.listRevisions(stack),
        };
    }

    async list(stackName : string) {
        return this.listRevisions(await this.existingStack(stackName));
    }

    async previewRevision(stackName : string, revisionId : string) {
        const stack = await this.existingStack(stackName);
        const current = await this.readStackSource(stack);
        const revision = await this.readRevision(stack, revisionId, true);
        const validation = await this.validateSource(stack.name, revision.source.composeYAML, revision.source.composeENV);
        return {
            revision: this.revisionSummary(revision.manifest, "valid"),
            composeYAML: revision.source.composeYAML,
            composeENV: revision.source.composeENV,
            currentSourceVersion: this.sourceVersion(current),
            proposedSourceVersion: revision.manifest.sourceVersion,
            changed: this.sourceVersion(current) !== revision.manifest.sourceVersion,
            validation,
            changes: this.describeChanges(current, revision.source),
        };
    }

    async restoreRevision(stackName : string, revisionId : string, expectedSourceVersion : string) {
        const stack = await this.existingStack(stackName);
        const revision = await this.readRevision(stack, revisionId, true);
        return this.commit({
            name: stack.name,
            composeYAML: revision.source.composeYAML,
            composeENV: revision.source.composeENV,
            isAdd: false,
            expectedSourceVersion,
        }, "rollback");
    }

    private async currentSource(draft : ComposeDraftPayload) {
        if (draft.isAdd) {
            await fsAsync.access(this.server.stacksDir, fs.constants.R_OK | fs.constants.W_OK).catch(error => {
                throw new ValidationError(`Managed stacks directory is not writable: ${error instanceof Error ? error.message : String(error)}`);
            });
            const stackPath = path.join(this.server.stacksDir, draft.name);
            if (await fileExists(stackPath)) {
                throw new ValidationError(`Compose project ${draft.name} already exists`);
            }
            const source = { composeYAML: "",
                composeENV: "" };
            return { stack: undefined,
                source,
                sourceVersion: "new" };
        }
        const stack = await this.existingStack(draft.name);
        const source = await this.readStackSource(stack);
        return { stack,
            source,
            sourceVersion: this.sourceVersion(source) };
    }

    private validatePayload(payload : ComposeDraftPayload) {
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
            throw new ValidationError("Invalid Compose draft request");
        }
        if (typeof payload.name !== "string" || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(payload.name)) {
            throw new ValidationError("Compose project name must be 1-63 lowercase letters, numbers, underscores, or hyphens");
        }
        if (typeof payload.composeYAML !== "string" || Buffer.byteLength(payload.composeYAML) > MAX_COMPOSE_BYTES) {
            throw new ValidationError("Compose YAML must be a string no larger than 2 MiB");
        }
        if (typeof payload.composeENV !== "string" || Buffer.byteLength(payload.composeENV) > MAX_ENV_BYTES) {
            throw new ValidationError("Compose environment must be a string no larger than 512 KiB");
        }
        if (typeof payload.isAdd !== "boolean") {
            throw new ValidationError("Compose draft isAdd must be a boolean");
        }
        if (payload.expectedSourceVersion !== undefined && typeof payload.expectedSourceVersion !== "string") {
            throw new ValidationError("Compose source version must be a string");
        }
        return payload;
    }

    private async validateSource(name : string, composeYAML : string, composeENV : string) {
        if (!composeYAML.trim()) {
            throw new ValidationError("Compose YAML cannot be empty");
        }
        const document = yaml.parseDocument(composeYAML, { prettyErrors: true,
            uniqueKeys: true });
        if (document.errors.length > 0) {
            throw new ValidationError(`Compose YAML is invalid: ${document.errors.map(error => error.message).join("; ")}`);
        }
        const parsed = document.toJS({ maxAliasCount: 100 });
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new ValidationError("Compose YAML must contain an object");
        }
        const config = parsed as Record<string, unknown>;
        const services = this.object(config.services);
        if (Object.keys(services).length === 0) {
            throw new ValidationError("Compose YAML must define at least one service");
        }
        for (const [ serviceName, service ] of Object.entries(services)) {
            if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(serviceName) || !service || typeof service !== "object" || Array.isArray(service)) {
                throw new ValidationError(`Compose service ${serviceName} is invalid`);
            }
        }
        const environment = this.parseEnvironment(composeENV);
        const dockerValidation = await this.validateWithDocker(name, composeYAML, composeENV);
        return {
            serviceNames: Object.keys(services),
            networkNames: Object.keys(this.object(config.networks)),
            volumeNames: Object.keys(this.object(config.volumes)),
            environmentKeys: Array.from(environment.keys),
            warnings: [ ...environment.warnings,
                ...dockerValidation.warnings ],
            docker: dockerValidation.status,
        };
    }

    private parseEnvironment(source : string) {
        const keys = new Set<string>();
        const warnings : string[] = [];
        let openQuote : "'" | "\"" | "" = "";
        let openQuoteLine = 0;
        source.split(/\r?\n/).forEach((line, index) => {
            const trimmed = line.trim();
            if (openQuote) {
                if (this.containsClosingQuote(line, openQuote)) {
                    openQuote = "";
                }
                return;
            }
            if (!trimmed || trimmed.startsWith("#")) {
                return;
            }
            const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)(?:\s*=\s*(.*))?$/);
            if (!match) {
                throw new ValidationError(`Invalid .env syntax at line ${index + 1}`);
            }
            if (keys.has(match[1])) {
                warnings.push(`Environment key ${match[1]} is declared more than once`);
            }
            keys.add(match[1]);
            const value = match[2] || "";
            const quote = value[0];
            if ((quote === "'" || quote === "\"") && !this.containsClosingQuote(value.slice(1), quote)) {
                openQuote = quote;
                openQuoteLine = index + 1;
            }
        });
        if (openQuote) {
            throw new ValidationError(`Unterminated quoted .env value starting at line ${openQuoteLine}`);
        }
        return { keys,
            warnings };
    }

    private containsClosingQuote(value : string, quote : "'" | "\"") {
        let escaped = false;
        for (const character of value) {
            if (quote === "\"" && character === "\\" && !escaped) {
                escaped = true;
                continue;
            }
            if (character === quote && !escaped) {
                return true;
            }
            escaped = false;
        }
        return false;
    }

    private async validateWithDocker(name : string, composeYAML : string, composeENV : string) : Promise<{ status: "valid" | "unavailable"; warnings: string[] }> {
        const validationRoot = path.join(this.server.config.dataDir, "dockerbridge-tmp", "compose-validation");
        const directory = path.join(validationRoot, `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
        await fsAsync.mkdir(directory, { recursive: true });
        await fsAsync.writeFile(path.join(directory, "compose.yaml"), composeYAML);
        await fsAsync.writeFile(path.join(directory, ".env"), composeENV);
        try {
            return await new Promise<{ status: "valid" | "unavailable"; warnings: string[] }>((resolve, reject) => {
                const output : Buffer[] = [];
                let settled = false;
                const finish = (action : () => void) => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    clearTimeout(timer);
                    action();
                };
                const child = spawnProcess("docker", [ "compose", "--project-name", name, "--project-directory", directory, "--file", "compose.yaml", "config", "--quiet" ], {
                    cwd: directory,
                    windowsHide: true,
                });
                child.stdout.on("data", (chunk : Buffer) => output.push(chunk));
                child.stderr.on("data", (chunk : Buffer) => output.push(chunk));
                child.on("error", error => {
                    finish(() => {
                        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                            resolve({ status: "unavailable",
                                warnings: [ "Docker CLI is unavailable; structural validation passed but docker compose config was not executed" ] });
                        } else {
                            reject(error);
                        }
                    });
                });
                child.on("close", code => {
                    finish(() => {
                        if (code === 0) {
                            resolve({ status: "valid",
                                warnings: [] });
                        } else {
                            const message = Buffer.concat(output).toString("utf-8").trim();
                            reject(new ValidationError(`docker compose config failed${message ? `: ${message}` : ` with exit code ${code}`}`));
                        }
                    });
                });
                const timer = setTimeout(() => {
                    child.kill();
                    finish(() => reject(new ValidationError("docker compose config timed out after 15 seconds")));
                }, 15000);
                timer.unref?.();
            });
        } finally {
            await fsAsync.rm(directory, { recursive: true,
                force: true });
        }
    }

    private describeChanges(before : ComposeSource, after : ComposeSource) {
        const beforeConfig = this.parseConfigForDiff(before.composeYAML);
        const afterConfig = this.parseConfigForDiff(after.composeYAML);
        const beforeServices = this.object(beforeConfig.services);
        const afterServices = this.object(afterConfig.services);
        const beforeNames = Object.keys(beforeServices);
        const afterNames = Object.keys(afterServices);
        const beforeEnvironment = this.environmentMap(before.composeENV);
        const afterEnvironment = this.environmentMap(after.composeENV);
        return {
            compose: this.lineDelta(before.composeYAML, after.composeYAML),
            environment: this.lineDelta(before.composeENV, after.composeENV),
            servicesAdded: afterNames.filter(name => !beforeNames.includes(name)),
            servicesRemoved: beforeNames.filter(name => !afterNames.includes(name)),
            servicesChanged: afterNames.filter(name => name in beforeServices && this.stableJSON(beforeServices[name]) !== this.stableJSON(afterServices[name])),
            environmentKeysAdded: Array.from(afterEnvironment.keys()).filter(key => !beforeEnvironment.has(key)),
            environmentKeysRemoved: Array.from(beforeEnvironment.keys()).filter(key => !afterEnvironment.has(key)),
            environmentKeysChanged: Array.from(afterEnvironment.keys()).filter(key => beforeEnvironment.has(key) && beforeEnvironment.get(key) !== afterEnvironment.get(key)),
        };
    }

    private lineDelta(before : string, after : string) {
        const beforeCounts = this.lineCounts(before);
        const afterCounts = this.lineCounts(after);
        let added = 0;
        let removed = 0;
        for (const [ line, count ] of afterCounts) {
            added += Math.max(0, count - (beforeCounts.get(line) || 0));
        }
        for (const [ line, count ] of beforeCounts) {
            removed += Math.max(0, count - (afterCounts.get(line) || 0));
        }
        return { added,
            removed,
            beforeLines: before ? before.split(/\r?\n/).length : 0,
            afterLines: after ? after.split(/\r?\n/).length : 0 };
    }

    private lineCounts(source : string) {
        const counts = new Map<string, number>();
        if (!source) {
            return counts;
        }
        for (const line of source.split(/\r?\n/)) {
            counts.set(line, (counts.get(line) || 0) + 1);
        }
        return counts;
    }

    private parseConfigForDiff(source : string) : Record<string, unknown> {
        if (!source.trim()) {
            return {};
        }
        try {
            const parsed = yaml.parse(source);
            return this.object(parsed);
        } catch (error) {
            return {};
        }
    }

    private environmentMap(source : string) {
        const values = new Map<string, string>();
        for (const line of source.split(/\r?\n/)) {
            const match = line.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
            if (match) {
                values.set(match[1], match[2]);
            }
        }
        return values;
    }

    private stableJSON(value : unknown) : string {
        if (Array.isArray(value)) {
            return `[${value.map(item => this.stableJSON(item)).join(",")}]`;
        }
        if (value && typeof value === "object") {
            const object = value as Record<string, unknown>;
            return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${this.stableJSON(object[key])}`).join(",")}}`;
        }
        return JSON.stringify(value);
    }

    private async writeSource(stack : Stack, source : ComposeSource, isAdd : boolean) {
        const directory = stack.path;
        if (isAdd) {
            await fsAsync.mkdir(directory);
        } else if (!await fileExists(directory)) {
            throw new ValidationError(`Compose project directory was not found: ${directory}`);
        }
        const composeState = await this.captureFile(stack.composeFilePath);
        const environmentPath = path.join(directory, ".env");
        const environmentState = await this.captureFile(environmentPath);
        try {
            await this.atomicWrite(stack.composeFilePath, source.composeYAML, composeState.mode);
            if (source.composeENV) {
                await this.atomicWrite(environmentPath, source.composeENV, environmentState.mode);
            } else {
                await fsAsync.rm(environmentPath, { force: true });
            }
            await this.applyOwnership(directory, stack.composeFilePath, source.composeENV ? environmentPath : undefined);
        } catch (error) {
            await this.restoreFile(composeState);
            await this.restoreFile(environmentState);
            if (isAdd) {
                await fsAsync.rm(directory, { recursive: true,
                    force: true });
            }
            throw error;
        }
    }

    private async captureFile(file : string) : Promise<FileState> {
        const stat = await fsAsync.lstat(file).catch(error => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return null;
            }
            throw error;
        });
        if (!stat) {
            return { path: file,
                exists: false,
                content: Buffer.alloc(0) };
        }
        if (!stat.isFile() || stat.isSymbolicLink()) {
            throw new ValidationError(`Compose editor refuses non-regular file: ${file}`);
        }
        return { path: file,
            exists: true,
            content: await fsAsync.readFile(file),
            mode: stat.mode & 0o777 };
    }

    private async restoreFile(state : FileState) {
        if (state.exists) {
            await this.atomicWrite(state.path, state.content, state.mode);
        } else {
            await fsAsync.rm(state.path, { force: true });
        }
    }

    private async atomicWrite(destination : string, content : string | Buffer, mode?: number) {
        const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${process.pid}.${crypto.randomBytes(5).toString("hex")}.tmp`);
        const handle = await fsAsync.open(temporary, "wx", mode || 0o600);
        try {
            await handle.writeFile(content);
            await handle.sync();
        } finally {
            await handle.close();
        }
        try {
            try {
                await fsAsync.rename(temporary, destination);
            } catch (error) {
                if (![ "EEXIST", "EPERM" ].includes((error as NodeJS.ErrnoException).code || "")) {
                    throw error;
                }
                await fsAsync.rm(destination, { force: true });
                await fsAsync.rename(temporary, destination);
            }
        } finally {
            await fsAsync.rm(temporary, { force: true });
        }
    }

    private async applyOwnership(directory : string, ...files : Array<string | undefined>) {
        if (!process.env.PUID || !process.env.PGID) {
            return;
        }
        const uid = Number(process.env.PUID);
        const gid = Number(process.env.PGID);
        if (!Number.isInteger(uid) || !Number.isInteger(gid)) {
            throw new ValidationError("PUID and PGID must be integers");
        }
        await fsAsync.chown(directory, uid, gid);
        for (const file of files.filter((value): value is string => Boolean(value))) {
            await fsAsync.chown(file, uid, gid);
        }
    }

    private async readStackSource(stack : Stack) : Promise<ComposeSource> {
        await this.assertReadableFile(stack.composeFilePath, "Compose YAML");
        const environmentPath = path.join(stack.path, ".env");
        const composeYAML = await fsAsync.readFile(stack.composeFilePath, "utf-8");
        const composeENV = await fileExists(environmentPath) ? await this.readOptionalRegularFile(environmentPath) : "";
        if (Buffer.byteLength(composeYAML) > MAX_COMPOSE_BYTES || Buffer.byteLength(composeENV) > MAX_ENV_BYTES) {
            throw new ValidationError("Compose source exceeds the editor size limit");
        }
        return { composeYAML,
            composeENV };
    }

    private async isWritable(stack : Stack) {
        try {
            await fsAsync.access(stack.composeFilePath, fs.constants.R_OK | fs.constants.W_OK);
            await fsAsync.access(stack.path, fs.constants.R_OK | fs.constants.W_OK);
            return true;
        } catch (error) {
            return false;
        }
    }

    private async assertReadableFile(file : string, label : string) {
        const stat = await fsAsync.lstat(file).catch(() => null);
        if (!stat?.isFile() || stat.isSymbolicLink()) {
            throw new ValidationError(`${label} is not a regular file: ${file}`);
        }
    }

    private async readOptionalRegularFile(file : string) {
        await this.assertReadableFile(file, "Compose environment");
        return fsAsync.readFile(file, "utf-8");
    }

    private sourceVersion(source : ComposeSource) {
        const hash = crypto.createHash("sha256");
        hash.update(source.composeYAML);
        hash.update("\0dockerbridge-env\0");
        hash.update(source.composeENV);
        return hash.digest("hex");
    }

    private assertExpectedVersion(expected : string | undefined, current : string) {
        if (expected !== undefined && expected !== current) {
            throw new ValidationError("Compose source changed after it was loaded; reload before saving to avoid overwriting another edit");
        }
    }

    private async existingStack(stackName : string) {
        if (typeof stackName !== "string" || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(stackName)) {
            throw new ValidationError("Compose project name is invalid");
        }
        return Stack.getStack(this.server, stackName);
    }

    private async createRevision(stack : Stack, source : ComposeSource, reason : RevisionReason, reuseLatest : boolean) : Promise<ComposeRevisionSummary> {
        const sourceVersion = this.sourceVersion(source);
        const existing = await this.listRevisions(stack);
        if (reuseLatest && existing[0]?.sourceVersion === sourceVersion && existing[0].status !== "invalid") {
            return existing[0];
        }
        const id = this.newRevisionId();
        const revisionDirectory = path.join(this.revisionRoot(stack), id);
        const temporaryDirectory = path.join(this.revisionRoot(stack), `.creating-${id}`);
        await fsAsync.mkdir(temporaryDirectory, { recursive: true });
        try {
            const composeFile = path.join(temporaryDirectory, "compose.yaml");
            const environmentFile = path.join(temporaryDirectory, ".env");
            await fsAsync.writeFile(composeFile, source.composeYAML);
            await fsAsync.writeFile(environmentFile, source.composeENV);
            const composeStat = await fsAsync.stat(composeFile);
            const environmentStat = await fsAsync.stat(environmentFile);
            const manifest : ComposeRevisionManifest = {
                version: REVISION_VERSION,
                id,
                stackName: stack.name,
                composeFilePath: path.resolve(stack.composeFilePath),
                createdAt: new Date().toISOString(),
                reason,
                sourceVersion,
                compose: { filename: "compose.yaml",
                    size: composeStat.size,
                    sha256: await this.sha256(composeFile) },
                environment: { filename: ".env",
                    size: environmentStat.size,
                    sha256: await this.sha256(environmentFile) },
            };
            await fsAsync.writeFile(path.join(temporaryDirectory, "manifest.json"), JSON.stringify(manifest, null, 4) + "\n");
            await fsAsync.rename(temporaryDirectory, revisionDirectory);
            await this.pruneRevisions(stack);
            return this.revisionSummary(manifest, "valid");
        } catch (error) {
            await fsAsync.rm(temporaryDirectory, { recursive: true,
                force: true });
            throw error;
        }
    }

    private async listRevisions(stack : Stack) : Promise<ComposeRevisionSummary[]> {
        const root = this.revisionRoot(stack);
        const entries = await fsAsync.readdir(root, { withFileTypes: true }).catch(error => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return [];
            }
            throw error;
        });
        const revisions : ComposeRevisionSummary[] = [];
        for (const entry of entries) {
            if (!entry.isDirectory() || !REVISION_ID_PATTERN.test(entry.name)) {
                continue;
            }
            try {
                const manifest = await this.readRevisionManifest(stack, entry.name);
                revisions.push(this.revisionSummary(manifest, "unchecked"));
            } catch (error) {
                revisions.push({ id: entry.name,
                    createdAt: "",
                    reason: "save",
                    sourceVersion: "",
                    composeSize: 0,
                    environmentSize: 0,
                    status: "invalid",
                    message: error instanceof Error ? error.message : String(error) });
            }
        }
        return revisions.sort((left, right) => right.id.localeCompare(left.id));
    }

    private async readRevision(stack : Stack, revisionId : string, validateChecksum : boolean) {
        const manifest = await this.readRevisionManifest(stack, revisionId);
        const directory = path.join(this.revisionRoot(stack), revisionId);
        const composeFile = path.join(directory, manifest.compose.filename);
        const environmentFile = path.join(directory, manifest.environment.filename);
        await this.assertReadableFile(composeFile, "Revision Compose YAML");
        await this.assertReadableFile(environmentFile, "Revision environment");
        const source = { composeYAML: await fsAsync.readFile(composeFile, "utf-8"),
            composeENV: await fsAsync.readFile(environmentFile, "utf-8") };
        if (validateChecksum) {
            const composeStat = await fsAsync.stat(composeFile);
            const environmentStat = await fsAsync.stat(environmentFile);
            if (composeStat.size !== manifest.compose.size || environmentStat.size !== manifest.environment.size || await this.sha256(composeFile) !== manifest.compose.sha256 || await this.sha256(environmentFile) !== manifest.environment.sha256 || this.sourceVersion(source) !== manifest.sourceVersion) {
                throw new ValidationError(`Compose revision ${revisionId} failed checksum validation`);
            }
        }
        return { manifest,
            source };
    }

    private async readRevisionManifest(stack : Stack, revisionId : string) {
        this.assertRevisionId(revisionId);
        const revisionDirectory = path.join(this.revisionRoot(stack), revisionId);
        const directoryStat = await fsAsync.lstat(revisionDirectory).catch(() => null);
        if (!directoryStat?.isDirectory() || directoryStat.isSymbolicLink()) {
            throw new ValidationError(`Compose revision directory is invalid: ${revisionId}`);
        }
        const manifestFile = path.join(revisionDirectory, "manifest.json");
        await this.assertReadableFile(manifestFile, "Compose revision manifest");
        const manifest = JSON.parse(await fsAsync.readFile(manifestFile, "utf-8")) as ComposeRevisionManifest;
        if (!manifest || manifest.version !== REVISION_VERSION || manifest.id !== revisionId || manifest.stackName !== stack.name || !manifest.compose || !manifest.environment || typeof manifest.createdAt !== "string" || ![ "save", "deploy", "rollback", "pre-change" ].includes(manifest.reason) || !Number.isSafeInteger(manifest.compose.size) || manifest.compose.size < 0 || !Number.isSafeInteger(manifest.environment.size) || manifest.environment.size < 0 || !/^[a-f0-9]{64}$/.test(manifest.sourceVersion || "") || !/^[a-f0-9]{64}$/.test(manifest.compose.sha256 || "") || !/^[a-f0-9]{64}$/.test(manifest.environment.sha256 || "")) {
            throw new ValidationError(`Compose revision manifest is invalid: ${revisionId}`);
        }
        if (manifest.compose.filename !== "compose.yaml" || manifest.environment.filename !== ".env") {
            throw new ValidationError(`Compose revision filenames are invalid: ${revisionId}`);
        }
        return manifest;
    }

    private async pruneRevisions(stack : Stack) {
        const retention = this.boundedInteger(Number(process.env.DOCKERBRIDGE_COMPOSE_REVISION_RETENTION), 50, 5, 500);
        const revisions = await this.listRevisions(stack);
        for (const revision of revisions.slice(retention)) {
            await fsAsync.rm(path.join(this.revisionRoot(stack), revision.id), { recursive: true,
                force: true });
        }
    }

    private revisionSummary(manifest : ComposeRevisionManifest, status : ComposeRevisionSummary["status"]) : ComposeRevisionSummary {
        return { id: manifest.id,
            createdAt: manifest.createdAt,
            reason: manifest.reason,
            sourceVersion: manifest.sourceVersion,
            composeSize: manifest.compose.size,
            environmentSize: manifest.environment.size,
            status };
    }

    private revisionRoot(stack : Stack) {
        const safeName = stack.name.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 48) || "stack";
        const identity = crypto.createHash("sha256").update(`${stack.name}\0${path.resolve(stack.composeFilePath)}`).digest("hex").slice(0, 16);
        return path.resolve(this.server.config.dataDir, "dockerbridge-backups", "compose-revisions", `${safeName}-${identity}`);
    }

    private newRevisionId() {
        return `${new Date().toISOString().replace(/[-:.]/g, "")}-${crypto.randomBytes(4).toString("hex")}`;
    }

    private assertRevisionId(revisionId : string) {
        if (!REVISION_ID_PATTERN.test(revisionId)) {
            throw new ValidationError("Invalid Compose revision ID");
        }
    }

    private async sha256(file : string) {
        const hash = crypto.createHash("sha256");
        const stream = fs.createReadStream(file);
        for await (const chunk of stream) {
            hash.update(chunk);
        }
        return hash.digest("hex");
    }

    private object(value : unknown) : Record<string, unknown> {
        return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    }

    private boundedInteger(value : number, fallback : number, min : number, max : number) {
        return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
    }
}
