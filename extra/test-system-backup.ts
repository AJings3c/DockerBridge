import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { BackupManager } from "../backend/backup-manager";
import { Database } from "../backend/database";
import { DockgeServer } from "../backend/dockge-server";
import { Settings } from "../backend/settings";

const root = path.resolve(".tmp", `system-backup-test-${process.pid}`);
const dataDir = path.join(root, "data");
const stacksDir = path.join(root, "stacks");
const stackFile = path.join(stacksDir, "demo", "compose.yaml");
const extraFile = path.join(stacksDir, "later", "compose.yaml");
const server = {
    config: { dataDir,
        stacksDir },
    stacksDir,
    packageJSON: { version: "test" },
} as unknown as DockgeServer;

let databaseOpen = false;

try {
    await fs.rm(root, { recursive: true,
        force: true });
    await fs.mkdir(dataDir, { recursive: true });
    await fs.mkdir(path.dirname(stackFile), { recursive: true });
    await fs.writeFile(stackFile, "services:\n  app:\n    image: example/original\n");

    await Database.init(server);
    databaseOpen = true;
    await Settings.set("systemBackupTest", "original", "general");

    const manager = new BackupManager(server);
    const created = await manager.createBackup();
    assert.equal(created.status, "valid");
    assert.equal(created.stackFileCount, 1);
    assert.equal((await manager.validateBackup(created.id)).summary.id, created.id);

    await Settings.set("systemBackupTest", "changed", "general");
    await fs.writeFile(stackFile, "services:\n  app:\n    image: example/changed\n");
    await fs.mkdir(path.dirname(extraFile), { recursive: true });
    await fs.writeFile(extraFile, "services:\n  later:\n    image: example/later\n");

    const preview = await manager.previewRestore(created.id);
    assert.equal(preview.stackFiles, 1);
    assert.equal(preview.mergeStrategy, "overwrite-backed-up-files");
    await manager.stageRestore(created.id);

    await Database.close();
    databaseOpen = false;
    const applied = await BackupManager.applyPendingRestore(server);
    assert.equal(applied.status, "applied");

    await Database.init(server);
    databaseOpen = true;
    Settings.deleteCache([ "systemBackupTest" ]);
    assert.equal(await Settings.get("systemBackupTest"), "original");
    assert.match(await fs.readFile(stackFile, "utf-8"), /example\/original/);
    assert.match(await fs.readFile(extraFile, "utf-8"), /example\/later/);

    const packageStackFile = path.join(dataDir, "dockerbridge-backups", "system", created.id, "stacks", "demo", "compose.yaml");
    await fs.appendFile(packageStackFile, "# tampered\n");
    await assert.rejects(() => manager.validateBackup(created.id), /size mismatch|checksum mismatch/);
    await manager.deleteBackup(created.id);
    assert.equal((await manager.listBackups()).length, 0);

    console.log("system backup integration: create, validate, restore, merge, tamper detection, delete passed");
} finally {
    Settings.stopCacheCleaner();
    if (databaseOpen) {
        await Database.close();
    }
    await fs.rm(root, { recursive: true,
        force: true });
}
