export interface ApiResponse {
    ok: boolean;
    msg?: string;
    msgi18n?: boolean;
    code?: string;
}

export type UserRole = "viewer" | "operator" | "admin";
export type UserPermission = "read" | "operate" | "destructive" | "terminal" | "settings" | "users" | "agents" | "admin";

export interface UserSummary {
    id: number;
    username: string;
    active: boolean;
    role: UserRole;
}

export interface UserListResponse extends ApiResponse {
    users: UserSummary[];
}

export interface StackSummary {
    name: string;
    status: number;
    endpoint: string;
    isManagedByDockge: boolean;
    isDiscoveredCompose: boolean;
    composeFileName: string;
    composeFilePath: string;
    syncedAt?: string;
}

export type EndpointConnectionStatus = "connecting" | "online" | "offline";

export interface EndpointSummary {
    endpoint: string;
    name: string;
    url: string;
    status: EndpointConnectionStatus;
    changedAt: string;
    lastSeenAt: string | null;
    message: string;
}

export type AgentCompatibility = "compatible" | "legacy" | "incompatible" | "unknown";

export interface AgentRuntimeInfo {
    version: string;
    protocolVersion: number;
    capabilities: string[];
    runtime?: Partial<AgentRuntimeDetails>;
    console?: Partial<AgentConsoleDetails>;
}

export interface AgentRuntimeDetails {
    platform: string;
    arch: string;
    nodeVersion: string;
    hostname: string;
    uptimeSeconds: number;
    isContainer: boolean;
}

export interface AgentConsoleDetails {
    enabled: boolean;
    target: string;
    idleTimeoutSeconds: number;
    maxSessions: number;
}

export interface AgentDockerDetails {
    available: boolean;
    clientVersion: string;
    serverVersion: string;
    apiVersion: string;
    operatingSystem: string;
    osType: string;
    architecture: string;
    storageDriver: string;
    swarmState: string;
    containers: number;
    runningContainers: number;
    images: number;
    cpuCount: number;
    memoryBytes: number;
    composeVersion: string;
    composeProjects: number;
}

export interface AgentDiagnostics {
    generatedAt: string;
    protocolVersion: number;
    version: string;
    runtime: AgentRuntimeDetails;
    paths: {
        dataDir: string;
        stacksDir: string;
    };
    console: AgentConsoleDetails;
    docker: AgentDockerDetails;
    capabilities: string[];
    errors: string[];
}

export interface AgentManagementSummary {
    id: number;
    url: string;
    username: string;
    endpoint: string;
    name: string;
    active: boolean;
    credentialVersion: number;
    credentialConfigured: boolean;
    credentialEncrypted: boolean;
    createdAt: string | null;
    updatedAt: string | null;
    status: {
        status: EndpointConnectionStatus;
        changedAt: string;
        lastSeenAt: string | null;
        msg?: string;
    };
    runtimeInfo?: AgentRuntimeInfo;
    compatibility: AgentCompatibility;
    fingerprint: string;
}

export interface AgentManagementResponse extends ApiResponse {
    generatedAt: string;
    credentialEncryption: {
        algorithm: string;
        externalKeyConfigured: boolean;
    };
    agents: AgentManagementSummary[];
}

export interface AgentTestResult {
    endpoint: string;
    url: string;
    latencyMs: number;
    info?: AgentRuntimeInfo;
    diagnostics?: AgentDiagnostics;
}

export interface AgentTestResponse extends ApiResponse {
    test: AgentTestResult;
}

export interface AgentDiagnosticsResponse extends ApiResponse {
    diagnostics: AgentDiagnostics;
}

export interface AgentRemovalPreview {
    endpoint: string;
    name: string;
    url: string;
    username: string;
    active: boolean;
    status: EndpointConnectionStatus;
    lastSeenAt: string | null;
    fingerprint: string;
    diagnostics?: AgentDiagnostics;
    diagnosticError: string;
    warnings: string[];
}

export interface AgentRemovalPreviewResponse extends ApiResponse {
    preview: AgentRemovalPreview;
}

export interface ComposeServiceRuntime {
    name: string;
    image: string;
    hasBuild: boolean;
    command: string;
    entrypoint: string;
    ports: string[];
    networks: string[];
    dependencies: string[];
    environmentKeys: string[];
    volumeCount: number;
    restart: string;
    containers: Array<{
        name: string;
        status: string;
    }>;
    running: number;
}

export interface ComposeStackDetail {
    name: string;
    endpoint: string;
    composeFilePath: string;
    discovered: boolean;
    services: ComposeServiceRuntime[];
    serviceCount: number;
    runningCount: number;
    networkNames: string[];
    volumeNames: string[];
}

export interface ComposeStackDetailResponse extends ApiResponse {
    detail: ComposeStackDetail;
}

export interface ComposeServiceLogsResponse extends ApiResponse {
    logs: string;
    tail: number;
    service: string;
}

export type ComposeRevisionReason = "save" | "deploy" | "rollback" | "pre-change";

export interface ComposeRevisionSummary {
    id: string;
    createdAt: string;
    reason: ComposeRevisionReason;
    sourceVersion: string;
    composeSize: number;
    environmentSize: number;
    status: "valid" | "invalid" | "unchecked";
    message?: string;
}

export interface ComposeEditorData {
    name: string;
    composeYAML: string;
    composeENV: string;
    composeFilePath: string;
    endpointEditable: boolean;
    discovered: boolean;
    sourceVersion: string;
    revisions: ComposeRevisionSummary[];
}

export interface ComposeChangeSummary {
    compose: {
        added: number;
        removed: number;
        beforeLines: number;
        afterLines: number;
    };
    environment: {
        added: number;
        removed: number;
        beforeLines: number;
        afterLines: number;
    };
    servicesAdded: string[];
    servicesRemoved: string[];
    servicesChanged: string[];
    environmentKeysAdded: string[];
    environmentKeysRemoved: string[];
    environmentKeysChanged: string[];
}

export interface ComposeValidationSummary {
    serviceNames: string[];
    networkNames: string[];
    volumeNames: string[];
    environmentKeys: string[];
    warnings: string[];
    docker: "valid" | "unavailable";
}

export interface ComposeEditorPreview {
    name?: string;
    currentSourceVersion: string;
    proposedSourceVersion: string;
    changed: boolean;
    validation: ComposeValidationSummary;
    changes: ComposeChangeSummary;
    revision?: ComposeRevisionSummary;
    composeYAML?: string;
    composeENV?: string;
}

export interface ComposeEditorResponse extends ApiResponse {
    editor: ComposeEditorData;
}

export interface ComposeEditorPreviewResponse extends ApiResponse {
    preview: ComposeEditorPreview;
}

export interface ComposeRevisionListResponse extends ApiResponse {
    revisions: ComposeRevisionSummary[];
}

export interface ComposeEditorMutationResponse extends ApiResponse {
    revision: ComposeRevisionSummary;
    previousRevision?: ComposeRevisionSummary;
    sourceVersion: string;
    revisions: ComposeRevisionSummary[];
    deployed?: boolean;
    saved?: boolean;
}

export interface DockerPort {
    containerPort: string;
    protocol: string;
    hostIp: string;
    hostPort: string;
    published: boolean;
}

export interface DockerPortUpdatePayload {
    containerId: string;
    containerPort: string;
    protocol: string;
    hostPort: string;
    currentHostPort: string;
    hostIp: string;
}

export interface DockerPortRollback {
    kind: "compose" | "container";
    backupFile: string;
    composeFile?: string;
    stack?: string;
    service?: string;
    containerName?: string;
}

export interface DockerPortPreflightResponse extends ApiResponse {
    containerId: string;
    containerName: string;
    managedBy: "compose" | "container";
    target: string;
    hostPort: string;
    currentHostPort: string;
    requiresRecreate: boolean;
    cacheCleanup: {
        entries: CacheCleanupEntry[];
        eligibleCount: number;
        totalBytes: number;
    };
}

export interface DockerPortMutationResponse extends ApiResponse {
    rollback?: DockerPortRollback;
}

export interface DockerContainer {
    id: string;
    shortId: string;
    name: string;
    stack: string;
    service: string;
    status: "running" | "stopped" | "abnormal" | "restarting";
    dockerState: string;
    statusText: string;
    image: string;
    imageId: string;
    imageTag: string;
    ports: DockerPort[];
    mounts: Array<{
        type: string;
        name: string;
        source: string;
        destination: string;
        cache: boolean;
    }>;
    networks: Array<{
        name: string;
        aliases: string[];
        ipAddress: string;
        gateway: string;
        macAddress: string;
    }>;
    cacheDirs: string[];
    command: string[];
    entrypoint: string[];
    workingDir: string;
    runAs: string;
    restartPolicy: string;
    networkMode: string;
    createdAt: string;
    startedAt: string;
    cpuPercent: string;
    memoryUsage: string;
    memoryPercent: string;
    networkIO: string;
    blockIO: string;
    volumeCount: number;
    health: string;
    exitCode: number | null;
    canEditPorts: boolean;
    managedBy: "compose" | "container";
}

export interface ContainerLogsResponse extends ApiResponse {
    logs: string;
    tail: number;
}

export interface CacheCleanupEntry {
    cacheDir: string;
    source?: string;
    eligible: boolean;
    reason?: string;
    estimatedBytes: number;
    fileCount: number;
    truncated: boolean;
}

export interface CacheCleanupPreviewResponse extends ApiResponse {
    containerId: string;
    entries: CacheCleanupEntry[];
    eligibleCount: number;
    totalBytes: number;
    generatedAt: string;
}

export interface CacheCleanupResponse extends ApiResponse {
    cleaned: Array<{
        cacheDir: string;
        source: string;
        estimatedBytes: number;
        fileCount: number;
    }>;
    totalBytes: number;
    fileCount: number;
}

export interface DockerImage {
    id: string;
    repository: string;
    tag: string;
    repoTags: string[];
    size: string;
    sizeBytes: number;
    dangling: boolean;
    createdAt: string;
    recentPulledAt: string;
    exposedPorts: string[];
    usedBy: string[];
}

export interface ImagePullProgress {
    imageRef: string;
    phase: "starting" | "running" | "completed" | "failed";
    stream?: "stdout" | "stderr";
    message: string;
    receivedAt: string;
}

export interface ImagePruneCandidate {
    id: string;
    repoTags: string[];
    size: string;
    sizeBytes: number;
    dangling: boolean;
}

export interface ImagePrunePreviewResponse extends ApiResponse {
    allUnused: boolean;
    candidates: ImagePruneCandidate[];
    totalBytes: number;
    generatedAt: string;
}

export interface ImagePruneResponse extends ApiResponse {
    deleted: number;
    totalBytes: number;
    output: string;
}

export interface DockerSnapshot {
    ok: boolean;
    dockerAvailable: boolean;
    generatedAt: string;
    summary: {
        cpuPercent: number;
        memoryTotal: number;
        memoryUsed: number;
        memoryPercent: number;
        containerTotal: number;
        running: number;
        stopped: number;
        abnormal: number;
        restarting: number;
        imageTotal: number;
        disk: Array<Record<string, unknown>>;
    };
    containers: DockerContainer[];
    images: DockerImage[];
    errors: string[];
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

export interface DockerResourceInventoryResponse extends ApiResponse {
    inventory: DockerResourceInventory;
}

export interface DockerResourceRemovalPreview {
    kind: "network" | "volume";
    name: string;
    fingerprint: string;
    generatedAt: string;
    dependencies: DockerResourceDependency[];
    blockers: string[];
    warnings: string[];
    canRemove: boolean;
}

export interface DockerResourceRemovalPreviewResponse extends ApiResponse {
    preview: DockerResourceRemovalPreview;
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

export interface DockerNetworkDisconnectPreviewResponse extends ApiResponse {
    preview: DockerNetworkDisconnectPreview;
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
    status: "running" | "exited" | "created" | "inactive" | "unknown";
    statusText: string;
    readable: boolean;
    editable: boolean;
    managed: boolean;
}

export interface ComposeRepositoryResponse extends ApiResponse {
    generatedAt: string;
    items: ComposeRepositoryItem[];
    pagination: {
        page: number;
        pageSize: number;
        pageCount: number;
        total: number;
    };
    summary: {
        total: number;
        running: number;
        inactive: number;
        unreadable: number;
        scannedYamlFiles: number;
        invalidYamlFiles: number;
        truncated: boolean;
    };
    sources: Array<{
        name: string;
        path: string;
        count: number;
    }>;
}

export interface OperationLogItem {
    id: number;
    time: string;
    actionType: string;
    objectType: string;
    objectId: string;
    beforeJson: string | null;
    afterJson: string | null;
    result: "success" | "failed" | "skipped" | string;
    error: string | null;
    actor: string | null;
    endpoint: string | null;
    durationMs: number | null;
}

export interface OperationLogResponse extends ApiResponse {
    items: OperationLogItem[];
    pagination: {
        page: number;
        pageSize: number;
        pageCount: number;
        total: number;
    };
    summary: {
        total: number;
        success: number;
        failed: number;
        skipped: number;
    };
    options: {
        actions: string[];
        objectTypes: string[];
    };
}

export interface OperationLogExportResponse extends ApiResponse {
    items: OperationLogItem[];
    total: number;
    exported: number;
    truncated: boolean;
    generatedAt: string;
}

export interface DockerDaemonConfigForm {
    registryMirrors: string[];
    httpProxy: string;
    httpsProxy: string;
    noProxy: string;
    dns: string[];
    insecureRegistries: string[];
    logDriver: string;
    logMaxSize: string;
    logMaxFile: string;
}

export interface DockerDaemonConfigBackup {
    file: string;
    filename: string;
    createdAt: string;
    size: number;
}

export interface DockerDaemonConfigResponse extends ApiResponse {
    configPath: string;
    restartCommand: string;
    editable: boolean;
    reason?: string;
    config: Record<string, unknown>;
    form: DockerDaemonConfigForm;
    backups: DockerDaemonConfigBackup[];
}

export interface DockerDaemonConfigMutationResponse extends ApiResponse {
    backupFile?: string;
    config: Record<string, unknown>;
    form: DockerDaemonConfigForm;
    backups: DockerDaemonConfigBackup[];
}

export interface DockerDaemonConfigPreviewResponse extends ApiResponse {
    beforeConfig: Record<string, unknown>;
    nextConfig: Record<string, unknown>;
    changedKeys: string[];
    changed: boolean;
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

export interface SystemBackupListResponse extends ApiResponse {
    backups: SystemBackupSummary[];
    backup?: SystemBackupSummary;
}

export interface SystemRestorePreviewResponse extends ApiResponse {
    backup: SystemBackupSummary;
    overwriteCount: number;
    newFileCount: number;
    databaseFiles: number;
    stackFiles: number;
    requiresRestart: boolean;
    mergeStrategy: "overwrite-backed-up-files";
}

export interface SystemRestoreResponse extends ApiResponse {
    backupId: string;
    restartScheduled: boolean;
}
