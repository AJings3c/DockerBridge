import { DockgeServer } from "./dockge-server";
import fs, { promises as fsAsync } from "fs";
import { log } from "./log";
import yaml from "yaml";
import { DockgeSocket, fileExists, ValidationError } from "./util-server";
import path from "path";
import {
    acceptedComposeFileNames,
    COMBINED_TERMINAL_COLS,
    COMBINED_TERMINAL_ROWS,
    CREATED_FILE,
    CREATED_STACK,
    EXITED, getCombinedTerminalName,
    getComposeTerminalName, getContainerExecTerminalName,
    RUNNING, TERMINAL_ROWS,
    UNKNOWN
} from "../common/util-common";
import { InteractiveTerminal, Terminal } from "./terminal";
import childProcessAsync from "promisify-child-process";
import { Settings } from "./settings";

export class Stack {

    name: string;
    protected _status: number = UNKNOWN;
    protected _composeYAML?: string;
    protected _composeENV?: string;
    protected _composeFilePath?: string;
    protected _composeFileName: string = "compose.yaml";
    protected _isDiscoveredCompose = false;
    protected server: DockgeServer;

    protected combinedTerminal? : Terminal;

    protected static managedStackList: Map<string, Stack> = new Map();

    constructor(server : DockgeServer, name : string, composeYAML? : string, composeENV? : string, skipFSOperations = false, composeFilePath? : string) {
        this.name = name;
        this.server = server;
        this._composeYAML = composeYAML;
        this._composeENV = composeENV;

        if (composeFilePath) {
            this._composeFilePath = path.resolve(composeFilePath);
            this._composeFileName = path.basename(this._composeFilePath);
            this._isDiscoveredCompose = !this.isPathInStacksDir(path.dirname(this._composeFilePath));
            return;
        }

        if (!skipFSOperations) {
            // Check if compose file name is different from compose.yaml
            for (const filename of acceptedComposeFileNames) {
                if (fs.existsSync(path.join(this.path, filename))) {
                    this._composeFileName = filename;
                    break;
                }
            }
        }
    }

    async toJSON(endpoint : string) : Promise<object> {

        // Since we have multiple agents now, embed primary hostname in the stack object too.
        let primaryHostname = await Settings.get("primaryHostname");
        if (!primaryHostname) {
            if (!endpoint) {
                primaryHostname = "localhost";
            } else {
                // Use the endpoint as the primary hostname
                try {
                    primaryHostname = (new URL("https://" + endpoint).hostname);
                } catch (e) {
                    // Just in case if the endpoint is in a incorrect format
                    primaryHostname = "localhost";
                }
            }
        }

        let obj = this.toSimpleJSON(endpoint);
        return {
            ...obj,
            composeYAML: this.composeYAML,
            composeENV: this.composeENV,
            primaryHostname,
        };
    }

    toSimpleJSON(endpoint : string) : object {
        return {
            name: this.name,
            status: this._status,
            tags: [],
            isManagedByDockge: this.isManagedByDockge,
            isDiscoveredCompose: this.isDiscoveredCompose,
            composeFileName: this._composeFileName,
            composeFilePath: this.composeFilePath,
            endpoint,
        };
    }

    /**
     * Get the status of the stack from `docker compose ps --format json`
     */
    async ps() : Promise<object> {
        let res = await childProcessAsync.spawn("docker", this.getComposeOptions("ps", "--format", "json"), {
            cwd: this.path,
            encoding: "utf-8",
        });
        if (!res.stdout) {
            return {};
        }
        return JSON.parse(res.stdout.toString());
    }

    get isManagedByDockge() : boolean {
        return this.isDiscoveredCompose || (fs.existsSync(this.path) && fs.statSync(this.path).isDirectory());
    }

    get isDiscoveredCompose() : boolean {
        return this._isDiscoveredCompose;
    }

    get status() : number {
        return this._status;
    }

    validate() {
        // Check name, allows [a-z][0-9] _ - only
        if (!this.name.match(/^[a-z0-9_-]+$/)) {
            throw new ValidationError("Stack name can only contain [a-z][0-9] _ - only");
        }

        // Check YAML format
        yaml.parse(this.composeYAML);

        let lines = this.composeENV.split("\n");

        // Check if the .env is able to pass docker-compose
        // Prevent "setenv: The parameter is incorrect"
        // It only happens when there is one line and it doesn't contain "="
        if (lines.length === 1 && !lines[0].includes("=") && lines[0].length > 0) {
            throw new ValidationError("Invalid .env format");
        }
    }

    get composeYAML() : string {
        if (this._composeYAML === undefined) {
            try {
                this._composeYAML = fs.readFileSync(this.composeFilePath, "utf-8");
            } catch (e) {
                this._composeYAML = "";
            }
        }
        return this._composeYAML;
    }

    get composeENV() : string {
        if (this._composeENV === undefined) {
            try {
                this._composeENV = fs.readFileSync(path.join(this.path, ".env"), "utf-8");
            } catch (e) {
                this._composeENV = "";
            }
        }
        return this._composeENV;
    }

    get path() : string {
        if (this._composeFilePath) {
            return path.dirname(this._composeFilePath);
        }
        return path.join(this.server.stacksDir, this.name);
    }

    get composeFilePath() : string {
        return this._composeFilePath || path.join(this.path, this._composeFileName);
    }

    get fullPath() : string {
        let dir = this.path;

        // Compose up via node-pty
        let fullPathDir;

        // if dir is relative, make it absolute
        if (!path.isAbsolute(dir)) {
            fullPathDir = path.join(process.cwd(), dir);
        } else {
            fullPathDir = dir;
        }
        return fullPathDir;
    }

    /**
     * Save the stack to the disk
     * @param isAdd
     */
    async save(isAdd : boolean) {
        this.validate();

        let dir = this.path;

        // Check if the name is used if isAdd
        if (isAdd) {
            if (await fileExists(dir)) {
                throw new ValidationError("Stack name already exists");
            }

            // Create the stack folder
            await fsAsync.mkdir(dir);
        } else {
            if (!await fileExists(dir)) {
                throw new ValidationError("Stack not found");
            }
        }

        // Write or overwrite the compose yaml.
        fs.writeFileSync(this.composeFilePath, this.composeYAML);
        if (process.env.PUID && process.env.PGID) {
            const uid = Number(process.env.PUID);
            const gid = Number(process.env.PGID);
            fs.lchownSync(dir, uid, gid);
            fs.chownSync(this.composeFilePath, uid, gid);
        }
    }

    async deploy(socket : DockgeSocket) : Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        const result = await Terminal.execWithOutput(this.server, socket, terminalName, "docker", this.getComposeOptions("up", "-d", "--remove-orphans"), this.path);
        if (result.exitCode !== 0) {
            throw new Error(this.operationError("Failed to deploy Compose project", result.output));
        }
        return result.exitCode;
    }

    async delete(socket: DockgeSocket) : Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        const result = await Terminal.execWithOutput(this.server, socket, terminalName, "docker", this.getComposeOptions("down", "--remove-orphans"), this.path);
        if (result.exitCode !== 0) {
            throw new Error(this.operationError("Failed to remove Compose project", result.output));
        }

        if (!this.isDiscoveredCompose) {
            // Remove the stack folder
            await fsAsync.rm(this.path, {
                recursive: true,
                force: true
            });
        }

        return result.exitCode;
    }

    async updateStatus() {
        let statusList = await Stack.getStatusList();
        let status = statusList.get(this.name);

        if (status) {
            this._status = status;
        } else {
            this._status = UNKNOWN;
        }
    }

    /**
     * Checks if a compose file exists in the specified directory.
     * @async
     * @static
     * @param {string} stacksDir - The directory of the stack.
     * @param {string} filename - The name of the directory to check for the compose file.
     * @returns {Promise<boolean>} A promise that resolves to a boolean indicating whether any compose file exists.
     */
    static async composeFileExists(stacksDir : string, filename : string) : Promise<boolean> {
        let filenamePath = path.join(stacksDir, filename);
        // Check if any compose file exists
        for (const filename of acceptedComposeFileNames) {
            let composeFile = path.join(filenamePath, filename);
            if (await fileExists(composeFile)) {
                return true;
            }
        }
        return false;
    }

    static async getStackList(server : DockgeServer, useCacheForManaged = false) : Promise<Map<string, Stack>> {
        let stackList : Map<string, Stack>;

        // Use cached stack list?
        if (useCacheForManaged && this.managedStackList.size > 0) {
            stackList = this.managedStackList;
        } else {
            stackList = new Map<string, Stack>();

            await this.addManagedStacks(server, stackList);
        }

        // Get status from docker compose ls
        let res = await childProcessAsync.spawn("docker", [ "compose", "ls", "--all", "--format", "json" ], {
            encoding: "utf-8",
        });

        if (!res.stdout) {
            return stackList;
        }

        let composeList = JSON.parse(res.stdout.toString());

        for (let composeStack of composeList) {
            let stack = stackList.get(composeStack.Name);

            // This stack probably is not managed by Dockge, but we still want to show it
            if (!stack) {
                // Skip the dockge stack if it is not managed by Dockge
                if (composeStack.Name === "dockge") {
                    continue;
                }
                const configFilePath = this.firstComposeConfigFile(composeStack.ConfigFiles);
                stack = new Stack(server, composeStack.Name, undefined, undefined, false, configFilePath);
                stackList.set(composeStack.Name, stack);
            }

            stack._status = this.statusConvert(composeStack.Status);
            const configFilePath = this.firstComposeConfigFile(composeStack.ConfigFiles);
            if (configFilePath && !stack._composeFilePath) {
                stack._composeFilePath = configFilePath;
                stack._composeFileName = path.basename(configFilePath);
                stack._isDiscoveredCompose = !stack.isPathInStacksDir(path.dirname(configFilePath));
            }
        }

        // Cache by copying
        this.managedStackList = new Map(stackList);

        return stackList;
    }

    /**
     * Get the status list, it will be used to update the status of the stacks
     * Not all status will be returned, only the stack that is deployed or created to `docker compose` will be returned
     */
    static async getStatusList() : Promise<Map<string, number>> {
        let statusList = new Map<string, number>();

        let res = await childProcessAsync.spawn("docker", [ "compose", "ls", "--all", "--format", "json" ], {
            encoding: "utf-8",
        });

        if (!res.stdout) {
            return statusList;
        }

        let composeList = JSON.parse(res.stdout.toString());

        for (let composeStack of composeList) {
            statusList.set(composeStack.Name, this.statusConvert(composeStack.Status));
        }

        return statusList;
    }

    /**
     * Convert the status string from `docker compose ls` to the status number
     * Input Example: "exited(1), running(1)"
     * @param status
     */
    static statusConvert(status : string) : number {
        if (status.startsWith("created")) {
            return CREATED_STACK;
        } else if (status.includes("exited")) {
            // If one of the service is exited, we consider the stack is exited
            return EXITED;
        } else if (status.startsWith("running")) {
            // If there is no exited services, there should be only running services
            return RUNNING;
        } else {
            return UNKNOWN;
        }
    }

    static async getStack(server: DockgeServer, stackName: string, skipFSOperations = false) : Promise<Stack> {
        if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(stackName)) {
            throw new ValidationError("Stack name is invalid");
        }
        let dir = path.join(server.stacksDir, stackName);
        const managedDirectory = await fsAsync.lstat(dir).catch(error => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return null;
            }
            throw error;
        });
        if (managedDirectory?.isSymbolicLink()) {
            throw new ValidationError("Managed stack directory cannot be a symbolic link");
        }

        if (!skipFSOperations) {
            if (!await fileExists(dir) || !(await fsAsync.stat(dir)).isDirectory()) {
                // Maybe it is a stack managed by docker compose directly
                let stackList = await this.getStackList(server, true);
                let stack = stackList.get(stackName);

                if (stack) {
                    return stack;
                } else {
                    // Really not found
                    throw new ValidationError("Stack not found");
                }
            }
        } else {
            //log.debug("getStack", "Skip FS operations");
        }

        let stack : Stack;

        if (!skipFSOperations) {
            stack = new Stack(server, stackName);
        } else {
            stack = new Stack(server, stackName, undefined, undefined, true);
        }

        stack._status = UNKNOWN;
        return stack;
    }

    getComposeOptions(command : string, ...extraOptions : string[]) {
        let options = [ "compose" ];
        const globalEnv = path.join(this.server.stacksDir, "global.env");
        const localEnv = path.join(this.path, ".env");
        if (fs.existsSync(globalEnv)) {
            options.push("--env-file", globalEnv);
            if (fs.existsSync(localEnv)) {
                options.push("--env-file", localEnv);
            }
        }
        if (this.isDiscoveredCompose || this._composeFileName !== "compose.yaml") {
            options.push("--file", this.composeFilePath);
        }
        if (this.isDiscoveredCompose) {
            options.push("--project-name", this.name);
        }
        options.push(command, ...extraOptions);
        return options;
    }

    async start(socket: DockgeSocket) {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        const result = await Terminal.execWithOutput(this.server, socket, terminalName, "docker", this.getComposeOptions("up", "-d", "--remove-orphans"), this.path);
        if (result.exitCode !== 0) {
            throw new Error(this.operationError("Failed to start Compose project", result.output));
        }
        return result.exitCode;
    }

    async stop(socket: DockgeSocket) : Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        const result = await Terminal.execWithOutput(this.server, socket, terminalName, "docker", this.getComposeOptions("stop"), this.path);
        if (result.exitCode !== 0) {
            throw new Error(this.operationError("Failed to stop Compose project", result.output));
        }
        return result.exitCode;
    }

    async restart(socket: DockgeSocket) : Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        const result = await Terminal.execWithOutput(this.server, socket, terminalName, "docker", this.getComposeOptions("restart"), this.path);
        if (result.exitCode !== 0) {
            throw new Error(this.operationError("Failed to restart Compose project", result.output));
        }
        return result.exitCode;
    }

    async down(socket: DockgeSocket) : Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        const result = await Terminal.execWithOutput(this.server, socket, terminalName, "docker", this.getComposeOptions("down"), this.path);
        if (result.exitCode !== 0) {
            throw new Error(this.operationError("Failed to remove Compose project containers", result.output));
        }
        return result.exitCode;
    }

    async update(socket: DockgeSocket) {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        const pullResult = await Terminal.execWithOutput(this.server, socket, terminalName, "docker", this.getComposeOptions("pull"), this.path);
        if (pullResult.exitCode !== 0) {
            throw new Error(this.operationError("Failed to pull Compose images", pullResult.output));
        }

        // If the stack is not running, we don't need to restart it
        await this.updateStatus();
        log.debug("update", "Status: " + this.status);
        if (this.status !== RUNNING) {
            return pullResult.exitCode;
        }

        const deployResult = await Terminal.execWithOutput(this.server, socket, terminalName, "docker", this.getComposeOptions("up", "-d", "--remove-orphans"), this.path);
        if (deployResult.exitCode !== 0) {
            throw new Error(this.operationError("Failed to recreate Compose project after image pull", deployResult.output));
        }
        return deployResult.exitCode;
    }

    async joinCombinedTerminal(socket: DockgeSocket) {
        const terminalName = getCombinedTerminalName(socket.endpoint, this.name);
        const terminal = Terminal.getOrCreateTerminal(this.server, terminalName, "docker", this.getComposeOptions("logs", "-f", "--tail", "100"), this.path);
        terminal.enableKeepAlive = true;
        terminal.rows = COMBINED_TERMINAL_ROWS;
        terminal.cols = COMBINED_TERMINAL_COLS;
        terminal.join(socket);
        terminal.start();
    }

    async leaveCombinedTerminal(socket: DockgeSocket) {
        const terminalName = getCombinedTerminalName(socket.endpoint, this.name);
        const terminal = Terminal.getTerminal(terminalName);
        if (terminal) {
            terminal.leave(socket);
        }
    }

    async joinContainerTerminal(socket: DockgeSocket, serviceName: string, shell : string = "sh", index: number = 0) {
        const terminalName = getContainerExecTerminalName(socket.endpoint, this.name, serviceName, index);
        let terminal = Terminal.getTerminal(terminalName);

        if (!terminal) {
            terminal = new InteractiveTerminal(this.server, terminalName, "docker", this.getComposeOptions("exec", serviceName, shell), this.path);
            terminal.rows = TERMINAL_ROWS;
            log.debug("joinContainerTerminal", "Terminal created");
        }

        terminal.join(socket);
        terminal.start();
    }

    async getServiceStatusList() {
        let statusList = new Map<string, Array<object>>();

        try {
            let res = await childProcessAsync.spawn("docker", this.getComposeOptions("ps", "--format", "json"), {
                cwd: this.path,
                encoding: "utf-8",
            });

            if (!res.stdout) {
                return statusList;
            }

            let lines = res.stdout?.toString().split("\n");

            const addLine = (obj: { Service: string, State: string, Name: string, Health: string }) => {
                if (!statusList.has(obj.Service)) {
                    statusList.set(obj.Service, []);
                }
                statusList.get(obj.Service)?.push({
                    status: obj.Health || obj.State,
                    name: obj.Name
                });
            };

            for (let line of lines) {
                try {
                    let obj = JSON.parse(line);
                    if (obj instanceof Array) {
                        obj.forEach(addLine);
                    } else {
                        addLine(obj);
                    }
                } catch (e) {
                }
            }

            return statusList;
        } catch (e) {
            log.error("getServiceStatusList", e);
            return statusList;
        }
    }

    async startService(socket: DockgeSocket, serviceName: string) {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        const result = await Terminal.execWithOutput(this.server, socket, terminalName, "docker", this.getComposeOptions("up", "-d", serviceName), this.path);
        if (result.exitCode !== 0) {
            throw new Error(this.operationError(`Failed to start service ${serviceName}`, result.output));
        }

        return result.exitCode;
    }

    async stopService(socket: DockgeSocket, serviceName: string): Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        const result = await Terminal.execWithOutput(this.server, socket, terminalName, "docker", this.getComposeOptions("stop", serviceName), this.path);
        if (result.exitCode !== 0) {
            throw new Error(this.operationError(`Failed to stop service ${serviceName}`, result.output));
        }

        return result.exitCode;
    }

    async restartService(socket: DockgeSocket, serviceName: string): Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        const result = await Terminal.execWithOutput(this.server, socket, terminalName, "docker", this.getComposeOptions("restart", serviceName), this.path);
        if (result.exitCode !== 0) {
            throw new Error(this.operationError(`Failed to restart service ${serviceName}`, result.output));
        }

        return result.exitCode;
    }

    private operationError(message : string, output : string) {
        const details = output.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "").trim().slice(-32768);
        return details ? `${message}:\n${details}` : `${message} (docker exited without output)`;
    }

    private isPathInStacksDir(targetPath : string) : boolean {
        const relative = path.relative(path.resolve(this.server.stacksDir), path.resolve(targetPath));
        return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    }

    private static async addManagedStacks(server : DockgeServer, stackList : Map<string, Stack>) {
        const stacksDir = server.stacksDir;
        let filenameList : string[] = [];

        try {
            filenameList = await fsAsync.readdir(stacksDir);
        } catch (e) {
            if (e instanceof Error) {
                log.warn("getStackList", `Failed to scan stacks dir ${stacksDir}, error: ${e.message}`);
            }
            return;
        }

        for (let filename of filenameList) {
            try {
                // Check if it is a directory
                let stat = await fsAsync.stat(path.join(stacksDir, filename));
                if (!stat.isDirectory()) {
                    continue;
                }
                // If no compose file exists, skip it
                if (!await Stack.composeFileExists(stacksDir, filename)) {
                    continue;
                }
                let stack = await this.getStack(server, filename);
                stack._status = CREATED_FILE;
                stackList.set(filename, stack);
            } catch (e) {
                if (e instanceof Error) {
                    log.warn("getStackList", `Failed to get stack ${filename}, error: ${e.message}`);
                }
            }
        }
    }

    private static async addDiscoveredStacks(server : DockgeServer, stackList : Map<string, Stack>) {
        const existingComposeFiles = new Set(Array.from(stackList.values()).map(stack => path.resolve(stack.composeFilePath)));
        const composeFiles = await this.discoverComposeFiles(server);

        for (const composeFile of composeFiles) {
            const resolvedComposeFile = path.resolve(composeFile);
            if (existingComposeFiles.has(resolvedComposeFile)) {
                continue;
            }

            try {
                const composeYAML = await fsAsync.readFile(resolvedComposeFile, "utf-8");
                if (!this.looksLikeComposeYAML(composeYAML)) {
                    continue;
                }

                const stackName = this.uniqueStackName(stackList, this.projectNameFromComposeFile(resolvedComposeFile, composeYAML));
                const stack = new Stack(server, stackName, undefined, undefined, false, resolvedComposeFile);
                stack._status = CREATED_FILE;
                stackList.set(stackName, stack);
                existingComposeFiles.add(resolvedComposeFile);
            } catch (e) {
                if (e instanceof Error) {
                    log.warn("getStackList", `Failed to import compose file ${resolvedComposeFile}, error: ${e.message}`);
                }
            }
        }
    }

    private static async discoverComposeFiles(server : DockgeServer) : Promise<string[]> {
        const scanDirs = this.getComposeScanDirs(server);
        const result = new Set<string>();
        const maxDepth = Number(process.env.DOCKERBRIDGE_COMPOSE_SCAN_DEPTH || 8);
        const maxFiles = Number(process.env.DOCKERBRIDGE_COMPOSE_SCAN_LIMIT || 1000);
        const visited = new Set<string>();

        for (const scanDir of scanDirs) {
            await this.walkComposeDir(scanDir, 0, maxDepth, maxFiles, visited, result);
            if (result.size >= maxFiles) {
                break;
            }
        }

        return Array.from(result);
    }

    private static async walkComposeDir(dir : string, depth : number, maxDepth : number, maxFiles : number, visited : Set<string>, result : Set<string>) : Promise<void> {
        if (depth > maxDepth || result.size >= maxFiles || this.shouldSkipScanDir(dir)) {
            return;
        }

        let resolvedDir : string;
        try {
            resolvedDir = await fsAsync.realpath(dir);
        } catch (e) {
            return;
        }

        if (visited.has(resolvedDir)) {
            return;
        }
        visited.add(resolvedDir);

        let entries : fs.Dirent[];
        try {
            entries = await fsAsync.readdir(resolvedDir, {
                withFileTypes: true,
            });
        } catch (e) {
            return;
        }

        for (const entry of entries) {
            const entryPath = path.join(resolvedDir, entry.name);
            if (entry.isDirectory()) {
                await this.walkComposeDir(entryPath, depth + 1, maxDepth, maxFiles, visited, result);
            } else if (entry.isFile() && this.isComposeCandidateFile(entry.name)) {
                result.add(entryPath);
                if (result.size >= maxFiles) {
                    return;
                }
            }
        }
    }

    private static getComposeScanDirs(server : DockgeServer) : string[] {
        const envDirs = (process.env.DOCKERBRIDGE_COMPOSE_SCAN_DIRS || "")
            .split(/[;,]/)
            .map(item => item.trim())
            .filter(Boolean);

        const defaultDirs = [
            server.stacksDir,
            process.cwd(),
            "/opt",
            "/srv",
            "/home",
            "/root",
        ];

        return Array.from(new Set([ ...defaultDirs, ...envDirs ].map(item => path.resolve(item))))
            .filter(item => fs.existsSync(item));
    }

    private static shouldSkipScanDir(dir : string) : boolean {
        const normalized = path.resolve(dir).replace(/\\/g, "/");
        const basename = path.basename(normalized);
        const skippedNames = new Set([
            ".git",
            ".hg",
            ".svn",
            ".cache",
            "node_modules",
            "dist",
            "build",
            "frontend-dist",
        ]);
        const skippedPrefixes = [
            "/proc",
            "/sys",
            "/dev",
            "/run",
            "/tmp",
            "/var/lib/docker",
            "/var/run",
        ];

        return skippedNames.has(basename) || skippedPrefixes.some(prefix => normalized === prefix || normalized.startsWith(prefix + "/"));
    }

    private static isComposeCandidateFile(filename : string) : boolean {
        const lowered = filename.toLowerCase();
        return acceptedComposeFileNames.includes(lowered) || /(?:docker|compose).*\.(ya?ml)$/.test(lowered);
    }

    private static looksLikeComposeYAML(content : string) : boolean {
        try {
            const config = yaml.parse(content);
            return Boolean(config && typeof config === "object" && !Array.isArray(config) && config.services && typeof config.services === "object" && !Array.isArray(config.services));
        } catch (e) {
            return false;
        }
    }

    private static projectNameFromComposeFile(composeFile : string, composeYAML : string) : string {
        try {
            const config = yaml.parse(composeYAML);
            if (config && typeof config === "object" && typeof config.name === "string" && config.name.trim()) {
                return this.normalizeStackName(config.name.trim());
            }
        } catch (e) {
        }

        return this.normalizeStackName(path.basename(path.dirname(composeFile)));
    }

    private static normalizeStackName(name : string) : string {
        const normalized = name.toLowerCase()
            .replace(/[^a-z0-9_-]/g, "-")
            .replace(/^[^a-z0-9]+/, "")
            .replace(/-+/g, "-")
            .slice(0, 48);

        return normalized || "compose";
    }

    private static uniqueStackName(stackList : Map<string, Stack>, baseName : string) : string {
        let stackName = baseName;
        let index = 2;

        while (stackList.has(stackName)) {
            stackName = `${baseName}-${index}`;
            index += 1;
        }

        return stackName;
    }

    private static firstComposeConfigFile(configFiles : unknown) : string | undefined {
        if (typeof configFiles !== "string" || !configFiles.trim()) {
            return undefined;
        }

        return configFiles.split(",").map(item => item.trim()).find(item => item && fs.existsSync(item));
    }
}
