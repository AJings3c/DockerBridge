import { store } from "@/store/store";
import { snapshotFailed, snapshotLoading, snapshotReceived } from "@/store/runtimeSlice";
import { repositoryFailed, repositoryLoading, repositoryReceived } from "@/store/repositorySlice";
import { AgentDiagnosticsResponse, AgentManagementResponse, AgentRemovalPreviewResponse, AgentTestResponse, ApiResponse, CacheCleanupPreviewResponse, CacheCleanupResponse, ComposeEditorMutationResponse, ComposeEditorPreviewResponse, ComposeEditorResponse, ComposeRepositoryResponse, ComposeRevisionListResponse, ComposeServiceLogsResponse, ComposeStackDetailResponse, ContainerLogsResponse, DockerDaemonConfigForm, DockerDaemonConfigMutationResponse, DockerDaemonConfigPreviewResponse, DockerDaemonConfigResponse, DockerNetworkDisconnectPreviewResponse, DockerPortMutationResponse, DockerPortPreflightResponse, DockerPortRollback, DockerPortUpdatePayload, DockerResourceInventoryResponse, DockerResourceRemovalPreviewResponse, DockerSnapshot, ImagePrunePreviewResponse, ImagePruneResponse, ImagePullProgress, OperationLogExportResponse, OperationLogResponse, SystemBackupListResponse, SystemRestorePreviewResponse, SystemRestoreResponse, UserListResponse, UserRole } from "@/types/domain";
import { emitAgentWithAck, emitWithAck, emitWithAckTimeout, realtime } from "./realtime/client";

export async function refreshSnapshot() {
    store.dispatch(snapshotLoading());
    const response = await emitWithAck<DockerSnapshot>("getDockerBridgeSnapshot");
    if (response.ok) {
        store.dispatch(snapshotReceived(response));
    } else {
        store.dispatch(snapshotFailed((response as unknown as ApiResponse).msg || "无法读取 Docker 运行状态"));
    }
    return response;
}

export async function containerAction(containerId : string, action : "start" | "stop" | "restart" | "recreate") {
    return emitWithAck<ApiResponse>("dockerBridgeContainerAction", containerId, action);
}

export function queryContainerLogs(containerId : string, tail = 300) {
    return emitWithAck<ContainerLogsResponse>("getDockerBridgeContainerLogs", containerId, { tail });
}

export function previewContainerCache(containerId : string) {
    return emitWithAck<CacheCleanupPreviewResponse>("previewDockerBridgeContainerCache", { containerId });
}

export function cleanContainerCache(containerId : string, expectedTargets : Array<{ cacheDir: string; source: string }>) {
    return emitWithAck<CacheCleanupResponse>("cleanDockerBridgeContainerCache", { containerId,
        expectedTargets });
}

export function preflightHostPort(payload : DockerPortUpdatePayload) {
    return emitWithAck<DockerPortPreflightResponse>("preflightDockerBridgeHostPort", payload);
}

export function updateHostPort(payload : DockerPortUpdatePayload) {
    return emitWithAck<DockerPortMutationResponse>("updateDockerBridgeHostPort", payload);
}

export function rollbackHostPort(rollback : DockerPortRollback) {
    return emitWithAck<DockerPortMutationResponse>("rollbackDockerBridgeHostPort", rollback);
}

export async function imageAction(action : "pull" | "delete", reference : string) {
    const event = action === "pull" ? "pullDockerBridgeImage" : "deleteDockerBridgeImage";
    return action === "pull"
        ? emitWithAckTimeout<ApiResponse>(30 * 60 * 1000, event, reference)
        : emitWithAck<ApiResponse>(event, reference);
}

export function tagImage(source : string, target : string) {
    return emitWithAck<ApiResponse>("tagDockerBridgeImage", { source,
        target });
}

export function previewImagePrune(allUnused : boolean) {
    return emitWithAck<ImagePrunePreviewResponse>("previewDockerBridgeImagePrune", { allUnused });
}

export function pruneImages(allUnused : boolean, expectedImageIds : string[]) {
    return emitWithAck<ImagePruneResponse>("pruneDockerBridgeImages", { allUnused,
        expectedImageIds });
}

export function onImagePullProgress(handler : (progress: ImagePullProgress) => void) {
    return realtime.on("dockerBridgeImagePullProgress", payload => handler(payload as ImagePullProgress));
}

export async function stackAction(endpoint : string, stackName : string, action : "start" | "stop" | "restart" | "update" | "down") {
    const event = `${action}Stack`;
    return emitAgentWithAck<ApiResponse>(endpoint, event, stackName);
}

export async function requestStackList() {
    const endpointState = store.getState().runtime.endpoints;
    const onlineEndpoints = Object.values(endpointState)
        .filter(endpoint => endpoint.status === "online")
        .map(endpoint => endpoint.endpoint);
    const endpoints = onlineEndpoints.length > 0 ? onlineEndpoints : [ "" ];
    const results = await Promise.all(endpoints.map(endpoint => emitAgentWithAck<ApiResponse>(endpoint, "requestStackList")));
    const failed = results.find(response => !response.ok);
    return failed || {
        ok: true,
        msg: `Requested stack refresh from ${results.length} endpoint(s)`,
    };
}

export function queryStackDetail(endpoint : string, stackName : string) {
    return emitAgentWithAck<ComposeStackDetailResponse>(endpoint, "getStackRuntimeDetail", stackName);
}

export function queryStackServiceLogs(endpoint : string, stackName : string, serviceName : string, tail = 300) {
    return emitAgentWithAck<ComposeServiceLogsResponse>(endpoint, "getStackServiceLogs", stackName, serviceName, { tail });
}

export function serviceAction(endpoint : string, stackName : string, serviceName : string, action : "start" | "stop" | "restart") {
    return emitAgentWithAck<ApiResponse>(endpoint, `${action}Service`, stackName, serviceName);
}

export interface ComposeDraftRequest {
    name: string;
    composeYAML: string;
    composeENV: string;
    isAdd: boolean;
    expectedSourceVersion?: string;
}

export function queryComposeEditor(endpoint : string, stackName : string) {
    return emitAgentWithAck<ComposeEditorResponse>(endpoint, "getComposeEditor", stackName);
}

export function previewComposeDraft(endpoint : string, payload : ComposeDraftRequest) {
    return emitAgentWithAck<ComposeEditorPreviewResponse>(endpoint, "previewComposeEditorDraft", payload);
}

export function saveComposeDraft(endpoint : string, payload : ComposeDraftRequest, deploy : boolean) {
    return emitAgentWithAck<ComposeEditorMutationResponse>(endpoint, "saveComposeEditorDraft", { ...payload,
        deploy });
}

export function queryComposeRevisions(endpoint : string, stackName : string) {
    return emitAgentWithAck<ComposeRevisionListResponse>(endpoint, "getComposeRevisions", stackName);
}

export function previewComposeRevision(endpoint : string, stackName : string, revisionId : string) {
    return emitAgentWithAck<ComposeEditorPreviewResponse>(endpoint, "previewComposeRevision", stackName, revisionId);
}

export function restoreComposeRevision(endpoint : string, stackName : string, revisionId : string, expectedSourceVersion : string, deploy : boolean) {
    return emitAgentWithAck<ComposeEditorMutationResponse>(endpoint, "restoreComposeRevision", { name: stackName,
        revisionId,
        expectedSourceVersion,
        deploy });
}

export interface RepositoryQuery {
    page: number;
    pageSize: number;
    search: string;
    source: string;
    status: string;
    refresh?: boolean;
}

export async function queryComposeRepository(query : RepositoryQuery) {
    store.dispatch(repositoryLoading());
    const response = await emitWithAck<ComposeRepositoryResponse>("getComposeRepository", query);
    if (response.ok) {
        store.dispatch(repositoryReceived(response));
    } else {
        store.dispatch(repositoryFailed(response.msg || "Compose 仓库扫描失败"));
    }
    return response;
}

export interface OperationLogQuery {
    page: number;
    pageSize: number;
    search: string;
    action: string;
    objectType: string;
    result: string;
    from: string;
    to: string;
}

export function queryOperationLogs(query : OperationLogQuery) {
    return emitWithAck<OperationLogResponse>("getDockerBridgeOperationLogs", query);
}

export function exportOperationLogs(query : OperationLogQuery) {
    return emitWithAck<OperationLogExportResponse>("exportDockerBridgeOperationLogs", query);
}

export function queryDockerDaemonConfig() {
    return emitWithAck<DockerDaemonConfigResponse>("getDockerBridgeDockerConfig");
}

export function previewDockerDaemonConfig(form : DockerDaemonConfigForm) {
    return emitWithAck<DockerDaemonConfigPreviewResponse>("previewDockerBridgeDockerConfig", form);
}

export function saveDockerDaemonConfig(form : DockerDaemonConfigForm) {
    return emitWithAck<DockerDaemonConfigMutationResponse>("saveDockerBridgeDockerConfig", form);
}

export function rollbackDockerDaemonConfig(backupFile : string) {
    return emitWithAck<DockerDaemonConfigMutationResponse>("rollbackDockerBridgeDockerConfig", backupFile);
}

export function restartDockerDaemon() {
    return emitWithAck<ApiResponse>("restartDockerBridgeDockerDaemon");
}

export function queryUsers() {
    return emitWithAck<UserListResponse>("getDockerBridgeUsers");
}

export function createUser(username : string, password : string, role : UserRole) {
    return emitWithAck<UserListResponse>("createDockerBridgeUser", { username,
        password,
        role });
}

export function updateUser(id : number, role : UserRole, active : boolean) {
    return emitWithAck<UserListResponse>("updateDockerBridgeUser", { id,
        role,
        active });
}

export function resetUserPassword(id : number, password : string) {
    return emitWithAck<ApiResponse>("resetDockerBridgeUserPassword", { id,
        password });
}

export interface AgentConnectionRequest {
    name: string;
    url: string;
    username: string;
    password: string;
}

export function queryAgents() {
    return emitWithAck<AgentManagementResponse>("getDockerBridgeAgents");
}

export function testAgentConnection(payload : Omit<AgentConnectionRequest, "name">, allowExisting = false) {
    return emitWithAck<AgentTestResponse>("testDockerBridgeAgent", { ...payload,
        allowExisting });
}

export function addAgent(payload : AgentConnectionRequest) {
    return emitWithAck<ApiResponse & { endpoint?: string }>("addAgent", payload);
}

export function diagnoseAgent(endpoint : string) {
    return emitWithAck<AgentDiagnosticsResponse>("diagnoseDockerBridgeAgent", endpoint);
}

export function updateAgent(endpoint : string, name : string, active : boolean) {
    return emitWithAck<AgentManagementResponse>("updateDockerBridgeAgent", { endpoint,
        name,
        active });
}

export function rotateAgentCredentials(endpoint : string, username : string, password : string) {
    return emitWithAck<AgentManagementResponse>("rotateDockerBridgeAgentCredentials", { endpoint,
        username,
        password });
}

export function previewAgentRemoval(endpoint : string) {
    return emitWithAck<AgentRemovalPreviewResponse>("previewDockerBridgeAgentRemoval", endpoint);
}

export function removeAgent(endpoint : string, expectedFingerprint : string, confirmation : string) {
    return emitWithAck<AgentManagementResponse>("removeDockerBridgeAgent", { endpoint,
        expectedFingerprint,
        confirmation });
}

export function queryDockerResources(endpoint : string) {
    return emitAgentWithAck<DockerResourceInventoryResponse>(endpoint, "getDockerResourceInventory");
}

export function previewDockerResourceRemoval(endpoint : string, kind : "network" | "volume", name : string) {
    return emitAgentWithAck<DockerResourceRemovalPreviewResponse>(endpoint, "previewDockerResourceRemoval", { kind,
        name });
}

export function removeDockerResource(endpoint : string, kind : "network" | "volume", name : string, expectedFingerprint : string, confirmation : string) {
    return emitAgentWithAck<ApiResponse>(endpoint, "removeDockerResource", { kind,
        name,
        expectedFingerprint,
        confirmation });
}

export function previewDockerNetworkDisconnect(endpoint : string, networkName : string, containerId : string) {
    return emitAgentWithAck<DockerNetworkDisconnectPreviewResponse>(endpoint, "previewDockerNetworkDisconnect", { networkName,
        containerId });
}

export function disconnectDockerNetwork(endpoint : string, networkName : string, containerId : string, expectedFingerprint : string, confirmation : string) {
    return emitAgentWithAck<ApiResponse>(endpoint, "disconnectDockerNetwork", { networkName,
        containerId,
        expectedFingerprint,
        confirmation });
}

export interface CreateDockerNetworkRequest {
    name: string;
    driver: string;
    internal: boolean;
    attachable: boolean;
    ipv6: boolean;
    subnet: string;
    gateway: string;
    parent: string;
}

export function createDockerNetwork(endpoint : string, payload : CreateDockerNetworkRequest) {
    return emitAgentWithAck<ApiResponse>(endpoint, "createDockerNetwork", payload);
}

export function createDockerVolume(endpoint : string, name : string, driver : string) {
    return emitAgentWithAck<ApiResponse>(endpoint, "createDockerVolume", { name,
        driver });
}

export function querySystemBackups() {
    return emitWithAck<SystemBackupListResponse>("getDockerBridgeSystemBackups");
}

export function createSystemBackup() {
    return emitWithAckTimeout<SystemBackupListResponse>(30 * 60 * 1000, "createDockerBridgeSystemBackup");
}

export function validateSystemBackup(backupId : string) {
    return emitWithAck<SystemBackupListResponse>("validateDockerBridgeSystemBackup", backupId);
}

export function previewSystemRestore(backupId : string) {
    return emitWithAck<SystemRestorePreviewResponse>("previewDockerBridgeSystemRestore", backupId);
}

export function restoreSystemBackup(backupId : string) {
    return emitWithAck<SystemRestoreResponse>("restoreDockerBridgeSystemBackup", backupId);
}

export function deleteSystemBackup(backupId : string) {
    return emitWithAck<SystemBackupListResponse>("deleteDockerBridgeSystemBackup", backupId);
}
