import assert from "node:assert/strict";
import fs from "node:fs";
// @ts-ignore
import notp from "notp";
import yaml from "yaml";
import { sanitizeOperationLogValue } from "../backend/operation-log";
import { DockerBridgeSocketHandler } from "../backend/socket-handlers/dockerbridge-socket-handler";

const deployment = yaml.parse(fs.readFileSync("compose.yaml", "utf-8")) as {
    services?: {
        dockerbridge?: {
            environment?: unknown;
            pid?: unknown;
            privileged?: unknown;
        };
    };
};
const deploymentService = deployment.services?.dockerbridge;
assert.ok(deploymentService, "compose.yaml must define the dockerbridge service");
assert.notEqual(deploymentService.pid, "host", "base deployment must not join the host PID namespace");
assert.notEqual(deploymentService.privileged, true, "base deployment must not run privileged");
assert.ok(Array.isArray(deploymentService.environment), "dockerbridge environment must remain a list");
assert.equal(deploymentService.environment.some(value => /^DOCKERBRIDGE_ENABLE_CONSOLE=(?:true|1)$/i.test(String(value))), true, "base deployment must enable the authenticated runtime terminal");
assert.equal(deploymentService.environment.some(value => /^DOCKERBRIDGE_CONSOLE_TARGET=host$/i.test(String(value))), false, "base deployment must not target the host terminal");
assert.equal(deploymentService.environment.some(value => /^DOCKERBRIDGE_CONSOLE_TARGET=runtime$/i.test(String(value))), true, "base deployment terminal must remain inside the runtime container");

const sanitized = sanitizeOperationLogValue({
    Config: {
        Env: [ "DATABASE_PASSWORD=super-secret", "PUBLIC_NAME=demo" ],
        Labels: {
            "com.example.api-token": "label-secret",
            "com.example.public": "visible",
        },
    },
    composeENV: "PRIVATE_KEY=private-value",
    proxy: "https://proxy-user:proxy-password@proxy.example:8443",
    error: "request failed: {\"password\":\"json-secret\"}; https://api.example.test?token=query-secret&name=public",
    headers: "Authorization: Bearer bearer-secret\nContent-Type: application/json",
    nested: {
        password: "account-password",
        token: "access-token",
    },
});
const serialized = JSON.stringify(sanitized);
for (const secret of [ "super-secret", "label-secret", "private-value", "proxy-password", "json-secret", "query-secret", "bearer-secret", "account-password", "access-token" ]) {
    assert.equal(serialized.includes(secret), false, `operation log retained secret: ${secret}`);
}
assert.match(serialized, /<redacted>/);
assert.match(serialized, /com\.example\.public/);
assert.match(serialized, /visible/);

const shared = { value: "visible-shared-value" };
assert.deepEqual(sanitizeOperationLogValue({ first: shared,
    second: shared }), { first: shared,
    second: shared });

interface StandaloneRecreateTestAccess {
    assertStandaloneRecreateSupported(inspect : unknown): void;
    buildStandaloneCreateArgs(inspect : unknown, portBindings : Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>): string[];
}

const handler = new DockerBridgeSocketHandler() as unknown as StandaloneRecreateTestAccess;
const basicInspect = {
    Name: "/demo",
    Config: {
        Image: "example/demo:latest",
        Env: [ "APP_ENV=production" ],
        ExposedPorts: { "80/tcp": {} },
    },
    HostConfig: {
        NetworkMode: "bridge",
        RestartPolicy: { Name: "unless-stopped" },
        LogConfig: { Type: "json-file",
            Config: {} },
        IpcMode: "private",
        CgroupnsMode: "private",
        Runtime: "runc",
        MemorySwappiness: -1,
        PidsLimit: 0,
        ShmSize: 128 * 1024 * 1024,
    },
    NetworkSettings: {
        Networks: {
            bridge: {
                Aliases: [],
                IPAddress: "172.17.0.2",
                Gateway: "172.17.0.1",
                MacAddress: "02:42:ac:11:00:02",
                IPAMConfig: null,
            },
        },
    },
    Mounts: [],
};

assert.doesNotThrow(() => handler.assertStandaloneRecreateSupported(basicInspect));
const createArgs = handler.buildStandaloneCreateArgs(basicInspect, {});
assert.deepEqual(createArgs.slice(0, 3), [ "create", "--name", "demo" ]);
assert.ok(createArgs.includes("--shm-size"));
assert.ok(createArgs.includes("--expose"));
assert.ok(createArgs.includes("80/tcp"));

assert.throws(() => handler.assertStandaloneRecreateSupported({
    ...basicInspect,
    HostConfig: { ...basicInspect.HostConfig,
        Memory: 256 * 1024 * 1024 },
}), /resource limits/);

assert.throws(() => handler.assertStandaloneRecreateSupported({
    ...basicInspect,
    HostConfig: { ...basicInspect.HostConfig,
        MemorySwappiness: 0 },
}), /resource limits/);

assert.throws(() => handler.assertStandaloneRecreateSupported({
    ...basicInspect,
    NetworkSettings: { Networks: { ...basicInspect.NetworkSettings.Networks,
        extra: { Aliases: [] } } },
}), /multiple\/static network attachments/);

assert.throws(() => handler.assertStandaloneRecreateSupported({
    ...basicInspect,
    Config: { ...basicInspect.Config,
        Healthcheck: { Test: [ "CMD", "curl", "--fail", "http://localhost" ] } },
}), /healthcheck/);

const totpKey = "dockerbridge-test-key";
const token = notp.totp.gen(totpKey, { time: 30 });
assert.match(token, /^\d{6}$/);
assert.ok(notp.totp.verify(token, totpKey, { time: 30,
    window: 1 }));

const dockerIgnorePatterns = fs.readFileSync(new URL("../.dockerignore", import.meta.url), "utf-8")
    .split(/\r?\n/)
    .map(line => line.trim());
assert.ok(dockerIgnorePatterns.includes("/*.png"), "root screenshots should stay out of the Docker context");
assert.equal(dockerIgnorePatterns.includes("*.png"), false, "recursive PNG ignores would remove frontend-dist runtime icons");

console.log("security hardening: audit redaction, standalone recreate guards and TOTP runtime passed");
