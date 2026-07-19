import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ComposeEditor } from "../backend/compose-editor";
import { DockgeServer } from "../backend/dockge-server";
import { permissionForAgentEvent } from "../backend/util-server";

const root = path.resolve(".tmp", `compose-editor-test-${process.pid}`);
const dataDir = path.join(root, "data");
const stacksDir = path.join(root, "stacks");
const server = { config: { dataDir,
    stacksDir },
stacksDir } as unknown as DockgeServer;
const editor = new ComposeEditor(server);

const source1 = `services:
  web:
    image: nginx:alpine
    ports:
      - "8080:80"
`;
const source2 = `services:
  web:
    image: nginx:stable-alpine
    ports:
      - "8081:80"
  worker:
    image: busybox:stable
    command: ["sleep", "3600"]
`;
const environment1 = `APP_ENV=production
MULTILINE='first
second'
`;

try {
    await fs.rm(root, { recursive: true,
        force: true });
    await fs.mkdir(dataDir, { recursive: true });
    await fs.mkdir(stacksDir, { recursive: true });

    assert.equal(permissionForAgentEvent("getComposeEditor"), "destructive");
    assert.equal(permissionForAgentEvent("saveComposeEditorDraft"), "destructive");
    assert.equal(permissionForAgentEvent("restoreComposeRevision"), "destructive");

    const newPreview = await editor.preview({ name: "demo",
        composeYAML: source1,
        composeENV: environment1,
        isAdd: true,
        expectedSourceVersion: "new" });
    assert.equal(newPreview.changed, true);
    assert.deepEqual(newPreview.validation.serviceNames, [ "web" ]);
    assert.ok([ "valid", "unavailable" ].includes(newPreview.validation.docker));

    const first = await editor.commit({ name: "demo",
        composeYAML: source1,
        composeENV: environment1,
        isAdd: true,
        expectedSourceVersion: "new" }, "save");
    assert.equal(await fs.readFile(path.join(stacksDir, "demo", "compose.yaml"), "utf-8"), source1);
    assert.equal(await fs.readFile(path.join(stacksDir, "demo", ".env"), "utf-8"), environment1);
    assert.equal(first.revision.status, "valid");

    const loaded = await editor.load("demo");
    assert.equal(loaded.sourceVersion, first.sourceVersion);
    assert.equal(loaded.revisions.length, 1);

    const secondPreview = await editor.preview({ name: "demo",
        composeYAML: source2,
        composeENV: "APP_ENV=staging\n",
        isAdd: false,
        expectedSourceVersion: loaded.sourceVersion });
    assert.deepEqual(secondPreview.changes.servicesAdded, [ "worker" ]);
    assert.deepEqual(secondPreview.changes.servicesChanged, [ "web" ]);
    assert.deepEqual(secondPreview.changes.environmentKeysChanged, [ "APP_ENV" ]);

    const second = await editor.commit({ name: "demo",
        composeYAML: source2,
        composeENV: "APP_ENV=staging\n",
        isAdd: false,
        expectedSourceVersion: loaded.sourceVersion }, "deploy");
    assert.equal(second.previousRevision?.sourceVersion, first.sourceVersion);
    assert.equal((await editor.list("demo")).length, 2);

    const rollbackPreview = await editor.previewRevision("demo", first.revision.id);
    assert.equal(rollbackPreview.proposedSourceVersion, first.sourceVersion);
    assert.deepEqual(rollbackPreview.changes.servicesRemoved, [ "worker" ]);
    const restored = await editor.restoreRevision("demo", first.revision.id, second.sourceVersion);
    assert.equal(restored.sourceVersion, first.sourceVersion);
    assert.equal(await fs.readFile(path.join(stacksDir, "demo", "compose.yaml"), "utf-8"), source1);
    assert.equal(await fs.readFile(path.join(stacksDir, "demo", ".env"), "utf-8"), environment1);

    await assert.rejects(() => editor.preview({ name: "../escape",
        composeYAML: source1,
        composeENV: "",
        isAdd: true,
        expectedSourceVersion: "new" }), /project name/);
    await assert.rejects(() => editor.load("../escape"), /project name|Stack name/);
    await assert.rejects(() => editor.preview({ name: "invalid-yaml",
        composeYAML: "services: [",
        composeENV: "",
        isAdd: true,
        expectedSourceVersion: "new" }), /YAML is invalid/);
    await assert.rejects(() => editor.preview({ name: "invalid-env",
        composeYAML: source1,
        composeENV: "not valid syntax!\n",
        isAdd: true,
        expectedSourceVersion: "new" }), /env syntax/);

    await fs.writeFile(path.join(stacksDir, "demo", "compose.yaml"), source2);
    await assert.rejects(() => editor.commit({ name: "demo",
        composeYAML: source1,
        composeENV: environment1,
        isAdd: false,
        expectedSourceVersion: restored.sourceVersion }, "save"), /changed after it was loaded/);

    const revisionRoot = path.join(dataDir, "dockerbridge-backups", "compose-revisions");
    const projectDirectories = await fs.readdir(revisionRoot);
    const tamperedRevision = path.join(revisionRoot, projectDirectories[0], second.revision.id, "compose.yaml");
    await fs.appendFile(tamperedRevision, "# tampered\n");
    await assert.rejects(() => editor.previewRevision("demo", second.revision.id), /checksum validation/);

    console.log("compose editor integration: create, env, preview, revisions, restore, stale-write and tamper guards passed");
} finally {
    await fs.rm(root, { recursive: true,
        force: true });
}
