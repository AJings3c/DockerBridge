import "dotenv/config";
import { MainRouter } from "./routers/main-router";
import * as fs from "node:fs";
import { PackageJson } from "type-fest";
import { Database } from "./database";
import packageJSON from "../package.json";
import { log } from "./log";
import * as socketIO from "socket.io";
import express, { Express } from "express";
import { parse } from "ts-command-line-args";
import https from "https";
import http from "http";
import { Router } from "./router";
import { Socket } from "socket.io";
import { MainSocketHandler } from "./socket-handlers/main-socket-handler";
import { SocketHandler } from "./socket-handler";
import { Settings } from "./settings";
import checkVersion from "./check-version";
import dayjs from "dayjs";
import { R } from "redbean-node";
import { genSecret, isDev, LooseObject } from "../common/util-common";
import { generatePasswordHash } from "./password-hash";
import { Bean } from "redbean-node/dist/bean";
import { Arguments, checkPermission, Config, DockgeSocket, normalizeUserRole, permissionForAgentEvent, permissionsForRole } from "./util-server";
import { DockerSocketHandler } from "./agent-socket-handlers/docker-socket-handler";
import expressStaticGzip from "express-static-gzip";
import path from "path";
import { TerminalSocketHandler } from "./agent-socket-handlers/terminal-socket-handler";
import { Stack } from "./stack";
import { Cron } from "croner";
import gracefulShutdown from "http-graceful-shutdown";
import User from "./models/user";
import childProcessAsync from "promisify-child-process";
import { AgentManager } from "./agent-manager";
import { AgentProxySocketHandler } from "./socket-handlers/agent-proxy-socket-handler";
import { AgentSocketHandler } from "./agent-socket-handler";
import { AgentSocket } from "../common/agent-socket";
import { ManageAgentSocketHandler } from "./socket-handlers/manage-agent-socket-handler";
import { UserSocketHandler } from "./socket-handlers/user-socket-handler";
import { Terminal } from "./terminal";
import { DockerBridgeSocketHandler } from "./socket-handlers/dockerbridge-socket-handler";
import { ComposeRepositorySocketHandler } from "./socket-handlers/compose-repository-socket-handler";
import { BackupSocketHandler } from "./socket-handlers/backup-socket-handler";
import { BackupManager } from "./backup-manager";
import { DockerResourceSocketHandler } from "./agent-socket-handlers/docker-resource-socket-handler";
import { AgentDiagnosticsSocketHandler } from "./agent-socket-handlers/agent-diagnostics-socket-handler";
import { AGENT_PROTOCOL_VERSION } from "./agent-diagnostics";

export class DockgeServer {
    app : Express;
    httpServer : http.Server;
    packageJSON : PackageJson;
    io : socketIO.Server;
    config : Config;
    indexHTML : string = "";

    /**
     * List of express routers
     */
    routerList : Router[] = [
        new MainRouter(),
    ];

    /**
     * List of socket handlers (no agent support)
     */
    socketHandlerList : SocketHandler[] = [
        new MainSocketHandler(),
        new ManageAgentSocketHandler(),
        new UserSocketHandler(),
        new DockerBridgeSocketHandler(),
        new ComposeRepositorySocketHandler(),
        new BackupSocketHandler(),
    ];

    agentProxySocketHandler = new AgentProxySocketHandler();

    /**
     * List of socket handlers (support agent)
     */
    agentSocketHandlerList : AgentSocketHandler[] = [
        new AgentDiagnosticsSocketHandler(),
        new DockerSocketHandler(),
        new DockerResourceSocketHandler(),
        new TerminalSocketHandler(),
    ];

    /**
     * Show Setup Page
     */
    needSetup = false;

    jwtSecret : string = "";

    stacksDir : string = "";

    /**
     *
     */
    constructor() {
        // Catch unexpected errors here
        let unexpectedErrorHandler = (error : unknown) => {
            console.trace(error);
            console.error("If you keep encountering errors, please report to https://github.com/louislam/dockge");
        };
        process.addListener("unhandledRejection", unexpectedErrorHandler);
        process.addListener("uncaughtException", unexpectedErrorHandler);

        if (!process.env.NODE_ENV) {
            process.env.NODE_ENV = "production";
        }

        // Log NODE ENV
        log.info("server", "NODE_ENV: " + process.env.NODE_ENV);

        // Default stacks directory
        let defaultStacksDir;
        if (process.platform === "win32") {
            defaultStacksDir = "./stacks";
        } else {
            defaultStacksDir = "/opt/stacks";
        }

        // Define all possible arguments
        let args = parse<Arguments>({
            sslKey: {
                type: String,
                optional: true,
            },
            sslCert: {
                type: String,
                optional: true,
            },
            sslKeyPassphrase: {
                type: String,
                optional: true,
            },
            port: {
                type: Number,
                optional: true,
            },
            hostname: {
                type: String,
                optional: true,
            },
            dataDir: {
                type: String,
                optional: true,
            },
            stacksDir: {
                type: String,
                optional: true,
            },
            enableConsole: {
                type: Boolean,
                optional: true,
                defaultValue: false,
            },
            consoleTarget: {
                type: String,
                optional: true,
            },
            consoleShell: {
                type: String,
                optional: true,
            },
            consoleHostPid: {
                type: Number,
                optional: true,
            },
            consoleIdleTimeoutSeconds: {
                type: Number,
                optional: true,
            },
            consoleMaxSessions: {
                type: Number,
                optional: true,
            }
        });

        this.config = args as Config;

        // Load from environment variables or default values if args are not set
        this.config.sslKey = args.sslKey || process.env.DOCKGE_SSL_KEY || undefined;
        this.config.sslCert = args.sslCert || process.env.DOCKGE_SSL_CERT || undefined;
        this.config.sslKeyPassphrase = args.sslKeyPassphrase || process.env.DOCKGE_SSL_KEY_PASSPHRASE || undefined;
        this.config.port = args.port || Number(process.env.DOCKGE_PORT) || 8612;
        this.config.hostname = args.hostname || process.env.DOCKGE_HOSTNAME || undefined;
        this.config.dataDir = args.dataDir || process.env.DOCKGE_DATA_DIR || "./data/";
        this.config.stacksDir = args.stacksDir || process.env.DOCKGE_STACKS_DIR || defaultStacksDir;
        this.config.enableConsole = args.enableConsole || process.env.DOCKGE_ENABLE_CONSOLE === "true" || process.env.DOCKERBRIDGE_ENABLE_CONSOLE === "true" || false;
        this.config.consoleTarget = args.consoleTarget || process.env.DOCKERBRIDGE_CONSOLE_TARGET || "runtime";
        this.config.consoleShell = args.consoleShell || process.env.DOCKERBRIDGE_CONSOLE_SHELL || undefined;
        this.config.consoleHostPid = args.consoleHostPid || Number(process.env.DOCKERBRIDGE_CONSOLE_HOST_PID) || 1;
        this.config.consoleIdleTimeoutSeconds = this.integerConfig(args.consoleIdleTimeoutSeconds || Number(process.env.DOCKERBRIDGE_CONSOLE_IDLE_TIMEOUT_SECONDS) || 900, 1, 86400, "console idle timeout");
        this.config.consoleMaxSessions = this.integerConfig(args.consoleMaxSessions || Number(process.env.DOCKERBRIDGE_CONSOLE_MAX_SESSIONS) || 3, 1, 50, "console max sessions");
        this.stacksDir = this.config.stacksDir;

        log.info("server", `Web terminal: ${this.config.enableConsole ? `enabled (${this.config.consoleTarget})` : "disabled"}`);

        log.debug("server", this.config);

        this.packageJSON = packageJSON as PackageJson;

        try {
            this.indexHTML = fs.readFileSync("./frontend-dist/index.html").toString();
        } catch (e) {
            // "dist/index.html" is not necessary for development
            if (process.env.NODE_ENV !== "development") {
                log.error("server", "Error: Cannot find 'frontend-dist/index.html', did you install correctly?");
                process.exit(1);
            }
        }

        // Create express
        this.app = express();

        // Create HTTP server
        if (this.config.sslKey && this.config.sslCert) {
            log.info("server", "Server Type: HTTPS");
            this.httpServer = https.createServer({
                key: fs.readFileSync(this.config.sslKey),
                cert: fs.readFileSync(this.config.sslCert),
                passphrase: this.config.sslKeyPassphrase,
            }, this.app);
        } else {
            log.info("server", "Server Type: HTTP");
            this.httpServer = http.createServer(this.app);
        }

        // Binding Routers
        for (const router of this.routerList) {
            this.app.use(router.create(this.app, this));
        }

        // Static files
        this.app.use("/", expressStaticGzip("frontend-dist", {
            enableBrotli: true,
        }));

        // Universal Route Handler, must be at the end of all express routes.
        this.app.get("*", async (_request, response) => {
            response.send(this.indexHTML);
        });

        // Allow all CORS origins in development
        let cors = undefined;
        if (isDev) {
            cors = {
                origin: "*",
            };
        }

        // Create Socket.io
        this.io = new socketIO.Server(this.httpServer, {
            cors,
            allowRequest: (req, callback) => {
                let isOriginValid = true;
                const bypass = isDev || process.env.UPTIME_KUMA_WS_ORIGIN_CHECK === "bypass";

                if (!bypass) {
                    let host = req.headers.host;

                    // If this is set, it means the request is from the browser
                    let origin = req.headers.origin;

                    // If this is from the browser, check if the origin is allowed
                    if (origin) {
                        try {
                            let originURL = new URL(origin);

                            if (host !== originURL.host) {
                                isOriginValid = false;
                                log.error("auth", `Origin (${origin}) does not match host (${host}), IP: ${req.socket.remoteAddress}`);
                            }
                        } catch (e) {
                            // Invalid origin url, probably not from browser
                            isOriginValid = false;
                            log.error("auth", `Invalid origin url (${origin}), IP: ${req.socket.remoteAddress}`);
                        }
                    } else {
                        log.info("auth", `Origin is not set, IP: ${req.socket.remoteAddress}`);
                    }
                } else {
                    log.debug("auth", "Origin check is bypassed");
                }

                callback(null, isOriginValid);
            }
        });

        this.io.on("connection", async (socket: Socket) => {
            let dockgeSocket = socket as DockgeSocket;
            dockgeSocket.instanceManager = new AgentManager(dockgeSocket, this);
            dockgeSocket.emitAgent = (event : string, ...args : unknown[]) => {
                let obj = args[0];
                if (typeof(obj) === "object") {
                    let obj2 = obj as LooseObject;
                    obj2.endpoint = dockgeSocket.endpoint;
                }
                dockgeSocket.emit("agent", event, ...args);
            };

            if (typeof(socket.request.headers.endpoint) === "string") {
                dockgeSocket.endpoint = socket.request.headers.endpoint;
            } else {
                dockgeSocket.endpoint = "";
            }

            if (dockgeSocket.endpoint) {
                log.info("server", "Socket connected (agent), as endpoint " + dockgeSocket.endpoint);
            } else {
                log.info("server", "Socket connected (direct)");
            }

            this.sendInfo(dockgeSocket, true);

            if (this.needSetup) {
                log.info("server", "Redirect to setup page");
                dockgeSocket.emit("setup");
            }

            // Create socket handlers (original, no agent support)
            for (const socketHandler of this.socketHandlerList) {
                socketHandler.create(dockgeSocket, this);
            }

            // Create Agent Socket
            let agentSocket = new AgentSocket(eventName => checkPermission(dockgeSocket, permissionForAgentEvent(eventName)));

            // Create agent socket handlers
            for (const socketHandler of this.agentSocketHandlerList) {
                socketHandler.create(dockgeSocket, this, agentSocket);
            }

            // Create agent proxy socket handlers
            this.agentProxySocketHandler.create2(dockgeSocket, this, agentSocket);

            // ***************************
            // Better do anything after added all socket handlers here
            // ***************************

            log.debug("auth", "check auto login");
            if (await Settings.get("disableAuth")) {
                log.info("auth", "Disabled Auth: auto login to admin");
                this.afterLogin(dockgeSocket, await R.findOne("user") as User);
                dockgeSocket.emit("autoLogin");
            } else {
                log.debug("auth", "need auth");
            }

            // Socket disconnect
            dockgeSocket.on("disconnect", () => {
                log.info("server", "Socket disconnected!");
                dockgeSocket.instanceManager.disconnectAll();
            });

        });

        this.io.on("disconnect", () => {

        });

        if (isDev) {
            setInterval(() => {
                log.debug("terminal", "Terminal count: " + Terminal.getTerminalCount());
            }, 5000);
        }
    }

    private integerConfig(value : number, min : number, max : number, label : string) {
        if (!Number.isInteger(value) || value < min || value > max) {
            throw new Error(`${label} must be an integer between ${min} and ${max}`);
        }
        return value;
    }

    async afterLogin(socket : DockgeSocket, user : User) {
        socket.userID = user.id;
        socket.userRole = normalizeUserRole(user.role);
        socket.join(user.id.toString());

        this.sendInfo(socket);

        try {
            this.sendStackList();
        } catch (e) {
            log.error("server", e);
        }

        socket.instanceManager.sendAgentList();

        // Also connect to other dockge instances
        socket.instanceManager.connectAll();
    }

    /**
     *
     */
    async serve() {
        // Create all the necessary directories
        this.initDataDir();

        // A staged restore is applied before SQLite opens, so the live WAL-backed
        // database is never overwritten while it is in use.
        const restoreResult = await BackupManager.applyPendingRestore(this);
        if (restoreResult.status === "applied") {
            log.info("system-backup", restoreResult.message || "System restore applied");
        } else if (restoreResult.status === "failed") {
            log.error("system-backup", restoreResult.message || "System restore failed and was not applied");
        }

        // Connect to database
        try {
            await Database.init(this);
        } catch (e) {
            if (e instanceof Error) {
                log.error("server", "Failed to prepare your database: " + e.message);
            }
            process.exit(1);
        }

        // First time setup if needed
        let jwtSecretBean = await R.findOne("setting", " `key` = ? ", [
            "jwtSecret",
        ]);

        if (! jwtSecretBean) {
            log.info("server", "JWT secret is not found, generate one.");
            jwtSecretBean = await this.initJWTSecret();
            log.info("server", "Stored JWT secret into database");
        } else {
            log.debug("server", "Load JWT secret from database.");
        }

        this.jwtSecret = jwtSecretBean.value;

        const userCount = (await R.knex("user").count("id as count").first()).count;

        log.debug("server", "User count: " + userCount);

        // If there is no record in user table, it is a new Dockge instance, need to setup
        if (userCount == 0) {
            log.info("server", "No user, need setup");
            this.needSetup = true;
        }

        // Listen
        this.httpServer.listen(this.config.port, this.config.hostname, () => {
            if (this.config.hostname) {
                log.info( "server", `Listening on ${this.config.hostname}:${this.config.port}`);
            } else {
                log.info("server", `Listening on ${this.config.port}`);
            }

            // Run every 10 seconds
            Cron("*/10 * * * * *", {
                protect: true,  // Enabled over-run protection.
            }, () => {
                //log.debug("server", "Cron job running");
                this.sendStackList(true);
            });

            checkVersion.startInterval();
        });

        gracefulShutdown(this.httpServer, {
            signals: "SIGINT SIGTERM",
            timeout: 30000,                   // timeout: 30 secs
            development: false,               // not in dev mode
            forceExit: true,                  // triggers process.exit() at the end of shutdown process
            onShutdown: this.shutdownFunction,     // shutdown function (async) - e.g. for cleanup DB, ...
            finally: this.finalFunction,            // finally function (sync) - e.g. for logging
        });

    }

    /**
     * Emits the version information to the client.
     * @param socket Socket.io socket instance
     * @param hideVersion Should we hide the version information in the response?
     * @returns
     */
    async sendInfo(socket : Socket, hideVersion = false) {
        let versionProperty;
        let latestVersionProperty;
        let isContainer;

        if (!hideVersion) {
            versionProperty = packageJSON.version;
            latestVersionProperty = checkVersion.latestVersion;
            isContainer = (process.env.DOCKGE_IS_CONTAINER === "1");
        }

        const dockgeSocket = socket as DockgeSocket;
        socket.emit("info", {
            version: versionProperty,
            latestVersion: latestVersionProperty,
            isContainer,
            primaryHostname: await Settings.get("primaryHostname"),
            role: dockgeSocket.userID ? normalizeUserRole(dockgeSocket.userRole) : undefined,
            permissions: dockgeSocket.userID ? permissionsForRole(normalizeUserRole(dockgeSocket.userRole)) : undefined,
            protocolVersion: hideVersion ? undefined : AGENT_PROTOCOL_VERSION,
            capabilities: hideVersion ? undefined : [ "agent-rbac-v1", "compose-runtime-v1", "compose-editor-v1", "docker-resources-v1", "terminal-policy-v1", "operation-errors-v1" ],
            runtime: hideVersion ? undefined : {
                platform: process.platform,
                arch: process.arch,
                nodeVersion: process.version,
                isContainer: process.env.DOCKGE_IS_CONTAINER === "1",
            },
            console: hideVersion ? undefined : {
                enabled: Boolean(this.config.enableConsole),
                target: this.config.consoleTarget || "runtime",
            },
            //serverTimezone: await this.getTimezone(),
            //serverTimezoneOffset: this.getTimezoneOffset(),
        });
    }

    /**
     * Get the IP of the client connected to the socket
     * @param {Socket} socket Socket to query
     * @returns IP of client
     */
    async getClientIP(socket : Socket) : Promise<string> {
        let clientIP = socket.client.conn.remoteAddress;

        if (clientIP === undefined) {
            clientIP = "";
        }

        if (await Settings.get("trustProxy")) {
            const forwardedFor = socket.client.conn.request.headers["x-forwarded-for"];

            if (typeof forwardedFor === "string") {
                return forwardedFor.split(",")[0].trim();
            } else if (typeof socket.client.conn.request.headers["x-real-ip"] === "string") {
                return socket.client.conn.request.headers["x-real-ip"];
            }
        }
        return clientIP.replace(/^::ffff:/, "");
    }

    /**
     * Attempt to get the current server timezone
     * If this fails, fall back to environment variables and then make a
     * guess.
     * @returns {Promise<string>} Current timezone
     */
    async getTimezone() {
        // From process.env.TZ
        try {
            if (process.env.TZ) {
                this.checkTimezone(process.env.TZ);
                return process.env.TZ;
            }
        } catch (e) {
            if (e instanceof Error) {
                log.warn("timezone", e.message + " in process.env.TZ");
            }
        }

        const timezone = await Settings.get("serverTimezone");

        // From Settings
        try {
            log.debug("timezone", "Using timezone from settings: " + timezone);
            if (timezone) {
                this.checkTimezone(timezone);
                return timezone;
            }
        } catch (e) {
            if (e instanceof Error) {
                log.warn("timezone", e.message + " in settings");
            }
        }

        // Guess
        try {
            const guess = dayjs.tz.guess();
            log.debug("timezone", "Guessing timezone: " + guess);
            if (guess) {
                this.checkTimezone(guess);
                return guess;
            } else {
                return "UTC";
            }
        } catch (e) {
            // Guess failed, fall back to UTC
            log.debug("timezone", "Guessed an invalid timezone. Use UTC as fallback");
            return "UTC";
        }
    }

    /**
     * Get the current offset
     * @returns {string} Time offset
     */
    getTimezoneOffset() {
        return dayjs().format("Z");
    }

    /**
     * Throw an error if the timezone is invalid
     * @param {string} timezone Timezone to test
     * @returns {void}
     * @throws The timezone is invalid
     */
    checkTimezone(timezone : string) {
        try {
            dayjs.utc("2013-11-18 11:55").tz(timezone).format();
        } catch (e) {
            throw new Error("Invalid timezone:" + timezone);
        }
    }

    /**
     * Initialize the data directory
     */
    initDataDir() {
        if (! fs.existsSync(this.config.dataDir)) {
            fs.mkdirSync(this.config.dataDir, { recursive: true });
        }

        // Check if a directory
        if (!fs.lstatSync(this.config.dataDir).isDirectory()) {
            throw new Error(`Fatal error: ${this.config.dataDir} is not a directory`);
        }

        // Create data/stacks directory
        if (!fs.existsSync(this.stacksDir)) {
            fs.mkdirSync(this.stacksDir, { recursive: true });
        }

        log.info("server", `Data Dir: ${this.config.dataDir}`);
    }

    /**
     * Init or reset JWT secret
     * @returns  JWT secret
     */
    async initJWTSecret() : Promise<Bean> {
        let jwtSecretBean = await R.findOne("setting", " `key` = ? ", [
            "jwtSecret",
        ]);

        if (!jwtSecretBean) {
            jwtSecretBean = R.dispense("setting");
            jwtSecretBean.key = "jwtSecret";
        }

        jwtSecretBean.value = generatePasswordHash(genSecret());
        await R.store(jwtSecretBean);
        return jwtSecretBean;
    }

    /**
     * Send stack list to all connected sockets
     * @param useCache
     */
    async sendStackList(useCache = false) {
        const socketList = Array.from(this.io.sockets.sockets.values()).map(socket => socket as DockgeSocket);
        const loggedInSockets = socketList.filter(socket => socket.userID);
        if (loggedInSockets.length === 0) {
            return;
        }

        try {
            const stackList = await Stack.getStackList(this, useCache);
            const generatedAt = new Date().toISOString();
            for (const dockgeSocket of loggedInSockets) {
                const map : Map<string, object> = new Map();
                for (const [ stackName, stack ] of stackList) {
                    map.set(stackName, stack.toSimpleJSON(dockgeSocket.endpoint));
                }
                log.debug("server", "Send stack list to user: " + dockgeSocket.id + " (" + dockgeSocket.endpoint + ")");
                dockgeSocket.emitAgent("stackList", {
                    ok: true,
                    stackList: Object.fromEntries(map),
                    generatedAt,
                });
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : "Failed to synchronize Compose stack list";
            log.warn("server", `Stack list synchronization failed: ${message}`);
            for (const dockgeSocket of loggedInSockets) {
                dockgeSocket.emitAgent("stackListError", {
                    ok: false,
                    msg: message,
                    generatedAt: new Date().toISOString(),
                });
            }
        }
    }

    async getDockerNetworkList() : Promise<string[]> {
        let res = await childProcessAsync.spawn("docker", [ "network", "ls", "--format", "{{.Name}}" ], {
            encoding: "utf-8",
        });

        if (!res.stdout) {
            return [];
        }

        let list = res.stdout.toString().split("\n");

        // Remove empty string item
        list = list.filter((item) => {
            return item !== "";
        }).sort((a, b) => {
            return a.localeCompare(b);
        });

        return list;
    }

    async getDockerStats() : Promise<Map<string, object>> {
        let stats = new Map<string, object>();

        try {
            let res = await childProcessAsync.spawn("docker", [ "stats", "--format", "json", "--no-stream" ], {
                encoding: "utf-8",
            });

            if (!res.stdout) {
                return stats;
            }

            let lines = res.stdout?.toString().split("\n");

            for (let line of lines) {
                try {
                    let obj = JSON.parse(line);
                    stats.set(obj.Name, obj);
                } catch (e) {
                }
            }

            return stats;
        } catch (e) {
            log.error("getDockerStats", e);
            return stats;
        }
    }

    get stackDirFullPath() {
        return path.resolve(this.stacksDir);
    }

    /**
     * Shutdown the application
     * Stops all monitors and closes the database connection.
     * @param signal The signal that triggered this function to be called.
     */
    async shutdownFunction(signal : string | undefined) {
        log.info("server", "Shutdown requested");
        log.info("server", "Called signal: " + signal);

        Terminal.closeAll("server_shutdown");

        await Database.close();
        Settings.stopCacheCleaner();
    }

    /**
     * Final function called before application exits
     */
    finalFunction() {
        log.info("server", "Graceful shutdown successful!");
    }

    /**
     * Force connected sockets of a user to refresh and disconnect.
     * Used for resetting password.
     * @param {string} userID
     * @param {string?} currentSocketID
     */
    disconnectAllSocketClients(userID: number | undefined, currentSocketID? : string) {
        for (const rawSocket of this.io.sockets.sockets.values()) {
            let socket = rawSocket as DockgeSocket;
            if ((!userID || socket.userID === userID) && socket.id !== currentSocketID) {
                try {
                    socket.emit("refresh");
                    socket.disconnect();
                } catch (e) {

                }
            }
        }
    }

    isSSL() {
        return this.config.sslKey && this.config.sslCert;
    }

    getLocalWebSocketURL() {
        const protocol = this.isSSL() ? "wss" : "ws";
        const host = this.config.hostname || "localhost";
        return `${protocol}://${host}:${this.config.port}`;
    }

}
