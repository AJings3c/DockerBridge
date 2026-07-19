import crypto from "node:crypto";
import fs, { promises as fsAsync } from "node:fs";
import path from "node:path";
import { R } from "redbean-node";
import { Database } from "./database";
import { DockgeServer } from "./dockge-server";
import { ValidationError } from "./util-server";

const MANIFEST_VERSION = 1;
const BACKUP_ID_PATTERN = /^\d{8}T\d{9}Z-[a-f0-9]{8}$/;

type BackupCategory = "database" | "database-config" | "stacks";

export interface SystemBackupFile {
    path: string;
    category: BackupCategory;
    size: number;
    sha256: string;
    mode: number;
    mtimeMs: number;
}

export interface SystemBackupManifest {
    version: number;
    id: string;
    createdAt: string;
    appVersion: string;
    source: {
        dataDir: string;
        stacksDir: string;
    };
    fileCount: number;
    totalSize: number;
    files: SystemBackupFile[];
}

export interface SystemBackupSummary {
    id: string;
    createdAt: string;
    appVersion: string;
    fileCount: number;
    stackFileCount: number;
    totalSize: number;
    status: "unchecked" | "valid" | "invalid";
    message?: string;
}

interface PendingRestore {
    version: number;
    backupId: string;
    requestedAt: string;
    manifestSha256: string;
}

interface RestoreRecord {
    destination: string;
    existed: boolean;
    rollbackFile?: string;
}

export interface PendingRestoreResult {
    status: "none" | "applied" | "failed";
    message?: string;
    backupId?: string;
}

export class BackupManager {
    private static activeOperation = "";

    constructor(private server : DockgeServer) {
    }

    async listBackups() : Promise<SystemBackupSummary[]> {
        await fsAsync.mkdir(this.systemBackupRoot, { recursive: true });
        const entries = await fsAsync.readdir(this.systemBackupRoot, { withFileTypes: true });
        const backups : SystemBackupSummary[] = [];
        for (const entry of entries) {
            if (!entry.isDirectory() || !BACKUP_ID_PATTERN.test(entry.name)) {
                continue;
            }
            try {
                const manifest = await this.readManifest(entry.name);
                backups.push(this.summary(manifest, "unchecked"));
            } catch (error) {
                backups.push({
                    id: entry.name,
                    createdAt: "",
                    appVersion: "unknown",
                    fileCount: 0,
                    stackFileCount: 0,
                    totalSize: 0,
                    status: "invalid",
                    message: this.errorMessage(error),
                });
            }
        }
        return backups.sort((left, right) => right.id.localeCompare(left.id));
    }

    async createBackup() : Promise<SystemBackupSummary> {
        return this.exclusive("create", async () => {
            if (Database.dbConfig.type !== "sqlite") {
                throw new ValidationError("System backups currently require the SQLite database backend");
            }
            await fsAsync.mkdir(this.systemBackupRoot, { recursive: true });
            const id = this.newBackupId();
            const temporaryDirectory = path.join(this.systemBackupRoot, `.creating-${id}`);
            const backupDirectory = this.backupDirectory(id);
            await fsAsync.rm(temporaryDirectory, { recursive: true,
                force: true });
            await fsAsync.mkdir(path.join(temporaryDirectory, "database"), { recursive: true });

            try {
                const databaseDestination = path.join(temporaryDirectory, "database", "dockge.db");
                await R.exec("VACUUM INTO ?", [ databaseDestination ]);

                const configSource = path.join(this.server.config.dataDir, "db-config.json");
                await this.copyRegularFile(configSource, path.join(temporaryDirectory, "database", "db-config.json"), "Database config");
                await this.copyStacks(temporaryDirectory);

                const files = await this.describeBackupFiles(temporaryDirectory);
                const manifest : SystemBackupManifest = {
                    version: MANIFEST_VERSION,
                    id,
                    createdAt: new Date().toISOString(),
                    appVersion: String(this.server.packageJSON.version || "unknown"),
                    source: {
                        dataDir: path.resolve(this.server.config.dataDir),
                        stacksDir: path.resolve(this.server.stacksDir),
                    },
                    fileCount: files.length,
                    totalSize: files.reduce((total, file) => total + file.size, 0),
                    files,
                };
                await this.writeJsonAtomic(path.join(temporaryDirectory, "manifest.json"), manifest);
                await fsAsync.rename(temporaryDirectory, backupDirectory);
                return this.summary(manifest, "valid");
            } catch (error) {
                await fsAsync.rm(temporaryDirectory, { recursive: true,
                    force: true });
                throw error;
            }
        });
    }

    async validateBackup(backupId : string) {
        this.assertBackupId(backupId);
        const manifest = await this.readManifest(backupId);
        const backupDirectory = this.backupDirectory(backupId);
        let totalSize = 0;
        const seen = new Set<string>();
        for (const file of manifest.files) {
            this.assertManifestFile(file, seen);
            const source = this.resolvePackagePath(backupDirectory, file.path);
            const stat = await fsAsync.lstat(source);
            if (!stat.isFile() || stat.isSymbolicLink()) {
                throw new ValidationError(`Backup entry is not a regular file: ${file.path}`);
            }
            if (stat.size !== file.size) {
                throw new ValidationError(`Backup size mismatch: ${file.path}`);
            }
            const digest = await this.sha256(source);
            if (!crypto.timingSafeEqual(Buffer.from(digest, "hex"), Buffer.from(file.sha256, "hex"))) {
                throw new ValidationError(`Backup checksum mismatch: ${file.path}`);
            }
            totalSize += stat.size;
        }
        if (manifest.fileCount !== manifest.files.length || manifest.totalSize !== totalSize) {
            throw new ValidationError("Backup manifest totals do not match its files");
        }
        if (!manifest.files.some(file => file.path === "database/dockge.db" && file.category === "database")) {
            throw new ValidationError("Backup does not contain a database snapshot");
        }
        if (!manifest.files.some(file => file.path === "database/db-config.json" && file.category === "database-config")) {
            throw new ValidationError("Backup does not contain database configuration");
        }
        return {
            summary: this.summary(manifest, "valid"),
            manifest,
        };
    }

    async previewRestore(backupId : string) {
        const { manifest, summary } = await this.validateBackup(backupId);
        let overwriteCount = 0;
        let newFileCount = 0;
        for (const file of manifest.files) {
            const destination = await this.restoreDestination(file, false);
            if (fs.existsSync(destination)) {
                overwriteCount += 1;
            } else {
                newFileCount += 1;
            }
        }
        return {
            backup: summary,
            overwriteCount,
            newFileCount,
            databaseFiles: manifest.files.filter(file => file.category !== "stacks").length,
            stackFiles: manifest.files.filter(file => file.category === "stacks").length,
            requiresRestart: true,
            mergeStrategy: "overwrite-backed-up-files",
        };
    }

    async stageRestore(backupId : string) {
        return this.exclusive("restore", async () => {
            await this.validateBackup(backupId);
            if (fs.existsSync(this.pendingRestorePath)) {
                throw new ValidationError("A system restore is already pending");
            }
            const manifestPath = path.join(this.backupDirectory(backupId), "manifest.json");
            const pending : PendingRestore = {
                version: MANIFEST_VERSION,
                backupId,
                requestedAt: new Date().toISOString(),
                manifestSha256: await this.sha256(manifestPath),
            };
            await this.writeJsonAtomic(this.pendingRestorePath, pending);
            return pending;
        });
    }

    async deleteBackup(backupId : string) {
        return this.exclusive("delete", async () => {
            this.assertBackupId(backupId);
            if (fs.existsSync(this.pendingRestorePath)) {
                const pending = await this.readPendingRestore();
                if (pending.backupId === backupId) {
                    throw new ValidationError("The backup is referenced by a pending restore and cannot be deleted");
                }
            }
            const backupDirectory = this.backupDirectory(backupId);
            const stat = await fsAsync.lstat(backupDirectory).catch(() => null);
            if (!stat?.isDirectory() || stat.isSymbolicLink()) {
                throw new ValidationError("System backup was not found");
            }
            await fsAsync.rm(backupDirectory, { recursive: true,
                force: false });
        });
    }

    static async applyPendingRestore(server : DockgeServer) : Promise<PendingRestoreResult> {
        const manager = new BackupManager(server);
        if (!fs.existsSync(manager.pendingRestorePath)) {
            return { status: "none" };
        }
        return manager.applyPendingRestore();
    }

    private async applyPendingRestore() : Promise<PendingRestoreResult> {
        const pending = await this.readPendingRestore();
        const manifestPath = path.join(this.backupDirectory(pending.backupId), "manifest.json");
        const currentManifestHash = await this.sha256(manifestPath);
        if (pending.version !== MANIFEST_VERSION || currentManifestHash !== pending.manifestSha256) {
            return this.rejectPendingRestore(pending, "Pending restore manifest changed after it was staged");
        }

        let manifest : SystemBackupManifest;
        try {
            manifest = (await this.validateBackup(pending.backupId)).manifest;
        } catch (error) {
            return this.rejectPendingRestore(pending, this.errorMessage(error));
        }

        const rollbackDirectory = path.join(this.backupRoot, "restore-rollback", `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
        const restoreRecords : RestoreRecord[] = [];
        await fsAsync.mkdir(rollbackDirectory, { recursive: true });
        try {
            for (const file of manifest.files) {
                const source = this.resolvePackagePath(this.backupDirectory(pending.backupId), file.path);
                const destination = await this.restoreDestination(file, true);
                const rollbackFile = path.join(rollbackDirectory, file.path.replaceAll("/", path.sep));
                const record = await this.captureRestoreTarget(destination, rollbackFile);
                restoreRecords.push(record);
                await this.copyAtomic(source, destination, file.mode, file.mtimeMs);
            }
            for (const suffix of [ "-wal", "-shm" ]) {
                const staleFile = `${Database.sqlitePath || path.join(this.server.config.dataDir, "dockge.db")}${suffix}`;
                if (fs.existsSync(staleFile)) {
                    const rollbackFile = path.join(rollbackDirectory, "database", `dockge.db${suffix}`);
                    restoreRecords.push(await this.captureRestoreTarget(staleFile, rollbackFile));
                    await fsAsync.rm(staleFile, { force: true });
                }
            }
            await fsAsync.rm(this.pendingRestorePath, { force: true });
            await this.writeJsonAtomic(path.join(this.backupRoot, "last-system-restore.json"), {
                backupId: pending.backupId,
                requestedAt: pending.requestedAt,
                appliedAt: new Date().toISOString(),
            });
            await fsAsync.rm(rollbackDirectory, { recursive: true,
                force: true });
            return {
                status: "applied",
                backupId: pending.backupId,
                message: `System backup ${pending.backupId} was restored`,
            };
        } catch (error) {
            const rollbackErrors : string[] = [];
            for (const record of restoreRecords.reverse()) {
                try {
                    if (record.existed && record.rollbackFile) {
                        await this.copyAtomic(record.rollbackFile, record.destination);
                    } else {
                        await fsAsync.rm(record.destination, { force: true });
                    }
                } catch (rollbackError) {
                    rollbackErrors.push(`${record.destination}: ${this.errorMessage(rollbackError)}`);
                }
            }
            if (rollbackErrors.length > 0) {
                throw new Error(`System restore failed and rollback was incomplete: ${this.errorMessage(error)}; ${rollbackErrors.join("; ")}`);
            }
            await fsAsync.rm(rollbackDirectory, { recursive: true,
                force: true });
            return this.rejectPendingRestore(pending, `System restore failed and was rolled back: ${this.errorMessage(error)}`);
        }
    }

    private async rejectPendingRestore(pending : PendingRestore, message : string) : Promise<PendingRestoreResult> {
        const failedPath = path.join(this.backupRoot, `system-restore.failed.${Date.now()}.json`);
        await this.writeJsonAtomic(failedPath, { ...pending,
            failedAt: new Date().toISOString(),
            error: message });
        await fsAsync.rm(this.pendingRestorePath, { force: true });
        return { status: "failed",
            backupId: pending.backupId,
            message };
    }

    private async copyStacks(temporaryDirectory : string) {
        const stacksRoot = await fsAsync.realpath(this.server.stacksDir);
        const excludedRoot = path.resolve(this.backupRoot);
        const visit = async (directory : string, relativeDirectory : string) : Promise<void> => {
            const entries = await fsAsync.readdir(directory, { withFileTypes: true });
            for (const entry of entries) {
                const source = path.join(directory, entry.name);
                const relative = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
                const stat = await fsAsync.lstat(source);
                if (stat.isSymbolicLink()) {
                    const realTarget = await fsAsync.realpath(source);
                    if (!this.isWithin(stacksRoot, realTarget)) {
                        throw new ValidationError(`Stack symlink escapes the managed root: ${relative}`);
                    }
                    continue;
                }
                if (stat.isDirectory()) {
                    if (this.isWithin(excludedRoot, source)) {
                        continue;
                    }
                    await visit(source, relative);
                    continue;
                }
                if (!stat.isFile()) {
                    continue;
                }
                const destination = path.join(temporaryDirectory, "stacks", relative);
                await fsAsync.mkdir(path.dirname(destination), { recursive: true });
                await fsAsync.copyFile(source, destination);
            }
        };
        await visit(stacksRoot, "");
    }

    private async describeBackupFiles(temporaryDirectory : string) {
        const files : SystemBackupFile[] = [];
        const visit = async (directory : string, relativeDirectory : string) : Promise<void> => {
            const entries = await fsAsync.readdir(directory, { withFileTypes: true });
            for (const entry of entries) {
                const absolute = path.join(directory, entry.name);
                const relative = relativeDirectory ? path.posix.join(relativeDirectory, entry.name) : entry.name;
                if (entry.isDirectory()) {
                    await visit(absolute, relative);
                    continue;
                }
                const stat = await fsAsync.lstat(absolute);
                if (!stat.isFile() || stat.isSymbolicLink()) {
                    throw new ValidationError(`Backup package contains an unsupported entry: ${relative}`);
                }
                files.push({
                    path: relative,
                    category: relative === "database/dockge.db" ? "database" : relative === "database/db-config.json" ? "database-config" : "stacks",
                    size: stat.size,
                    sha256: await this.sha256(absolute),
                    mode: stat.mode & 0o777,
                    mtimeMs: stat.mtimeMs,
                });
            }
        };
        await visit(temporaryDirectory, "");
        return files.sort((left, right) => left.path.localeCompare(right.path));
    }

    private async readManifest(backupId : string) : Promise<SystemBackupManifest> {
        this.assertBackupId(backupId);
        const manifestPath = path.join(this.backupDirectory(backupId), "manifest.json");
        const stat = await fsAsync.lstat(manifestPath).catch(() => null);
        if (!stat?.isFile() || stat.isSymbolicLink()) {
            throw new ValidationError("Backup manifest was not found or is not a regular file");
        }
        const manifest = JSON.parse(await fsAsync.readFile(manifestPath, "utf-8")) as SystemBackupManifest;
        if (!manifest || typeof manifest !== "object" || manifest.version !== MANIFEST_VERSION || manifest.id !== backupId || !Array.isArray(manifest.files)) {
            throw new ValidationError("Backup manifest is invalid or unsupported");
        }
        if (typeof manifest.createdAt !== "string" || typeof manifest.appVersion !== "string" || !Number.isSafeInteger(manifest.fileCount) || !Number.isSafeInteger(manifest.totalSize)) {
            throw new ValidationError("Backup manifest metadata is invalid");
        }
        return manifest;
    }

    private assertManifestFile(file : SystemBackupFile, seen : Set<string>) {
        if (!file || typeof file !== "object" || typeof file.path !== "string" || typeof file.sha256 !== "string") {
            throw new ValidationError("Backup manifest contains an invalid file entry");
        }
        const normalized = path.posix.normalize(file.path);
        if (normalized !== file.path || normalized.startsWith("../") || path.posix.isAbsolute(normalized) || seen.has(normalized)) {
            throw new ValidationError(`Backup manifest path is unsafe or duplicated: ${file.path}`);
        }
        if (!Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) {
            throw new ValidationError(`Backup manifest checksum metadata is invalid: ${file.path}`);
        }
        const expectedCategory : BackupCategory = file.path === "database/dockge.db" ? "database" : file.path === "database/db-config.json" ? "database-config" : "stacks";
        if (file.category !== expectedCategory || (expectedCategory === "stacks" && !file.path.startsWith("stacks/"))) {
            throw new ValidationError(`Backup manifest category is invalid: ${file.path}`);
        }
        seen.add(normalized);
    }

    private async restoreDestination(file : SystemBackupFile, createParents : boolean) {
        if (file.category === "database") {
            return this.safeDestination(this.server.config.dataDir, "dockge.db", createParents);
        }
        if (file.category === "database-config") {
            return this.safeDestination(this.server.config.dataDir, "db-config.json", createParents);
        }
        return this.safeDestination(this.server.stacksDir, file.path.slice("stacks/".length), createParents);
    }

    private async safeDestination(root : string, relative : string, createParents : boolean) {
        const rootPath = path.resolve(root);
        const destination = path.resolve(rootPath, relative);
        if (!this.isWithin(rootPath, destination) || destination === rootPath) {
            throw new ValidationError(`Restore destination escapes its managed root: ${relative}`);
        }
        const segments = path.relative(rootPath, path.dirname(destination)).split(path.sep).filter(Boolean);
        let current = rootPath;
        if (createParents) {
            await fsAsync.mkdir(current, { recursive: true });
        }
        for (const segment of segments) {
            current = path.join(current, segment);
            const stat = await fsAsync.lstat(current).catch(error => {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                    return null;
                }
                throw error;
            });
            if (!stat) {
                if (createParents) {
                    await fsAsync.mkdir(current);
                } else {
                    break;
                }
            } else if (!stat.isDirectory() || stat.isSymbolicLink()) {
                throw new ValidationError(`Restore destination contains a non-directory or symlink: ${current}`);
            }
        }
        const destinationStat = await fsAsync.lstat(destination).catch(error => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return null;
            }
            throw error;
        });
        if (destinationStat?.isSymbolicLink() || (destinationStat && !destinationStat.isFile())) {
            throw new ValidationError(`Restore destination is not a regular file: ${destination}`);
        }
        return destination;
    }

    private async captureRestoreTarget(destination : string, rollbackFile : string) : Promise<RestoreRecord> {
        const stat = await fsAsync.lstat(destination).catch(error => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return null;
            }
            throw error;
        });
        if (!stat) {
            return { destination,
                existed: false };
        }
        if (!stat.isFile() || stat.isSymbolicLink()) {
            throw new ValidationError(`Restore target is not a regular file: ${destination}`);
        }
        await fsAsync.mkdir(path.dirname(rollbackFile), { recursive: true });
        await fsAsync.copyFile(destination, rollbackFile);
        return { destination,
            existed: true,
            rollbackFile };
    }

    private async copyAtomic(source : string, destination : string, mode?: number, mtimeMs?: number) {
        await fsAsync.mkdir(path.dirname(destination), { recursive: true });
        const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.dockerbridge-${crypto.randomBytes(6).toString("hex")}.tmp`);
        try {
            await fsAsync.copyFile(source, temporary);
            if (Number.isInteger(mode)) {
                await fsAsync.chmod(temporary, mode as number);
            }
            if (Number.isFinite(mtimeMs)) {
                const time = new Date(mtimeMs as number);
                await fsAsync.utimes(temporary, time, time);
            }
            await fsAsync.rm(destination, { force: true });
            await fsAsync.rename(temporary, destination);
        } finally {
            await fsAsync.rm(temporary, { force: true });
        }
    }

    private async copyRegularFile(source : string, destination : string, label : string) {
        const stat = await fsAsync.lstat(source).catch(() => null);
        if (!stat?.isFile() || stat.isSymbolicLink()) {
            throw new ValidationError(`${label} is not a regular file: ${source}`);
        }
        await fsAsync.mkdir(path.dirname(destination), { recursive: true });
        await fsAsync.copyFile(source, destination);
    }

    private resolvePackagePath(backupDirectory : string, relative : string) {
        const resolved = path.resolve(backupDirectory, relative.replaceAll("/", path.sep));
        if (!this.isWithin(backupDirectory, resolved)) {
            throw new ValidationError(`Backup path escapes its package: ${relative}`);
        }
        return resolved;
    }

    private summary(manifest : SystemBackupManifest, status : SystemBackupSummary["status"]) : SystemBackupSummary {
        return {
            id: manifest.id,
            createdAt: manifest.createdAt,
            appVersion: manifest.appVersion,
            fileCount: manifest.fileCount,
            stackFileCount: manifest.files.filter(file => file.category === "stacks").length,
            totalSize: manifest.totalSize,
            status,
        };
    }

    private async readPendingRestore() : Promise<PendingRestore> {
        const pending = JSON.parse(await fsAsync.readFile(this.pendingRestorePath, "utf-8")) as PendingRestore;
        if (!pending || pending.version !== MANIFEST_VERSION || typeof pending.backupId !== "string" || typeof pending.manifestSha256 !== "string") {
            throw new ValidationError("Pending system restore marker is invalid");
        }
        this.assertBackupId(pending.backupId);
        return pending;
    }

    private async writeJsonAtomic(destination : string, value : unknown) {
        await fsAsync.mkdir(path.dirname(destination), { recursive: true });
        const temporary = `${destination}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
        try {
            await fsAsync.writeFile(temporary, JSON.stringify(value, null, 4) + "\n", { flag: "wx" });
            await fsAsync.rm(destination, { force: true });
            await fsAsync.rename(temporary, destination);
        } finally {
            await fsAsync.rm(temporary, { force: true });
        }
    }

    private async sha256(file : string) : Promise<string> {
        const hash = crypto.createHash("sha256");
        const stream = fs.createReadStream(file);
        for await (const chunk of stream) {
            hash.update(chunk);
        }
        return hash.digest("hex");
    }

    private assertBackupId(backupId : string) {
        if (!BACKUP_ID_PATTERN.test(backupId)) {
            throw new ValidationError("Invalid system backup ID");
        }
    }

    private newBackupId() {
        const timestamp = new Date().toISOString().replace(/[-:.]/g, "");
        return `${timestamp}-${crypto.randomBytes(4).toString("hex")}`;
    }

    private isWithin(root : string, candidate : string) {
        const relative = path.relative(path.resolve(root), path.resolve(candidate));
        return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
    }

    private async exclusive<T>(operation : string, action : () => Promise<T>) : Promise<T> {
        if (BackupManager.activeOperation) {
            throw new ValidationError(`System backup operation already running: ${BackupManager.activeOperation}`);
        }
        BackupManager.activeOperation = operation;
        try {
            return await action();
        } finally {
            BackupManager.activeOperation = "";
        }
    }

    private errorMessage(error : unknown) {
        return error instanceof Error ? error.message : String(error);
    }

    private backupDirectory(backupId : string) {
        this.assertBackupId(backupId);
        return path.join(this.systemBackupRoot, backupId);
    }

    private get backupRoot() {
        return path.resolve(this.server.config.dataDir, "dockerbridge-backups");
    }

    private get systemBackupRoot() {
        return path.join(this.backupRoot, "system");
    }

    private get pendingRestorePath() {
        return path.join(this.backupRoot, "system-restore.pending.json");
    }
}
