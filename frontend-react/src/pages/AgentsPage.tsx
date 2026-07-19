import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/primitives/Button";
import { EmptyState } from "@/components/primitives/EmptyState";
import { StatusBadge } from "@/components/primitives/StatusBadge";
import { SkeletonRows } from "@/components/SkeletonRows";
import { Icon } from "@/components/Icon";
import { FailureDialog, MetricStrip, Notice, PageHeader, Panel, useModalDialog } from "@/components/ui";
import { addAgent, AgentConnectionRequest, diagnoseAgent, previewAgentRemoval, queryAgents, removeAgent, rotateAgentCredentials, testAgentConnection, updateAgent } from "@/services/runtime";
import { realtime } from "@/services/realtime/client";
import { AgentCompatibility, AgentDiagnostics, AgentManagementResponse, AgentManagementSummary, AgentRemovalPreview, AgentTestResult, EndpointConnectionStatus } from "@/types/domain";
import pageStyles from "./Page.module.css";
import styles from "./AgentsPage.module.css";

interface AgentFailure {
    action: string;
    message: string;
    endpoint?: string;
}

const emptyCandidate : AgentConnectionRequest = {
    name: "",
    url: "",
    username: "",
    password: "",
};

function formatTime(value : string | null | undefined) {
    if (!value) {
        return "从未";
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatBytes(value : number) {
    const units = [ "B", "KiB", "MiB", "GiB", "TiB" ];
    let size = Number.isFinite(value) ? value : 0;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
        size /= 1024;
        unit += 1;
    }
    return `${unit === 0 ? size : size.toFixed(1)} ${units[unit]}`;
}

function formatUptime(value : number | undefined) {
    if (!value || value < 0) {
        return "未知";
    }
    const days = Math.floor(value / 86400);
    const hours = Math.floor((value % 86400) / 3600);
    if (days > 0) {
        return `${days} 天 ${hours} 小时`;
    }
    return `${hours} 小时`;
}

function statusLabel(status : EndpointConnectionStatus) {
    return status === "online" ? "在线" : status === "connecting" ? "连接中" : "离线";
}

function compatibilityLabel(value : AgentCompatibility) {
    return {
        compatible: "兼容",
        legacy: "协议过旧",
        incompatible: "主版本不兼容",
        unknown: "尚未识别",
    }[value];
}

function compatibilityStatus(value : AgentCompatibility) {
    return value === "compatible" ? "running" : value === "unknown" ? "unknown" : value === "legacy" ? "created" : "abnormal";
}

function EnrollmentDialog({ open, candidate, testResult, busy, onChange, onClose, onTest, onAdd } : {
    open: boolean;
    candidate: AgentConnectionRequest;
    testResult?: AgentTestResult;
    busy: "test" | "add" | "";
    onChange: (candidate : AgentConnectionRequest) => void;
    onClose: () => void;
    onTest: () => void;
    onAdd: () => void;
}) {
    const dialogRef = useModalDialog(open);
    const valid = Boolean(candidate.name.trim() && candidate.url.trim() && candidate.username.trim() && candidate.password);

    const update = (key : keyof AgentConnectionRequest, value : string) => onChange({ ...candidate,
        [key]: value });

    return (
        <dialog aria-labelledby="agent-enrollment-title" className={styles.dialog} onCancel={event => {
            event.preventDefault();
            if (!busy) {
                onClose();
            }
        }} onClick={event => {
            if (event.target === event.currentTarget && !busy) {
                onClose();
            }
        }} ref={dialogRef}>
            <form className={styles.dialogContent} onSubmit={(event : FormEvent) => {
                event.preventDefault();
                if (valid && !busy) {
                    onAdd();
                }
            }}>
                <header className={styles.dialogHeader}><div><h2 id="agent-enrollment-title">注册远程 Agent</h2><p>凭据只发送到控制器，并以 AES-256-GCM 加密保存。</p></div><button aria-label="关闭" disabled={Boolean(busy)} onClick={onClose} type="button"><Icon name="close" /></button></header>
                <fieldset className={styles.formGrid} disabled={Boolean(busy)}>
                    <label><span>显示名称</span><input autoFocus maxLength={128} onChange={event => update("name", event.target.value)} placeholder="上海构建节点" value={candidate.name} /></label>
                    <label><span>Agent 地址</span><input autoComplete="url" onChange={event => update("url", event.target.value)} placeholder="https://agent.internal:5001" type="url" value={candidate.url} /><small>仅支持 HTTP/HTTPS，不要在 URL 中嵌入凭据。</small></label>
                    <label><span>登录账户</span><input autoComplete="username" onChange={event => update("username", event.target.value)} placeholder="dockerbridge-admin" value={candidate.username} /></label>
                    <label><span>登录密码</span><input autoComplete="new-password" onChange={event => update("password", event.target.value)} placeholder="输入 Agent 登录密码" type="password" value={candidate.password} /></label>
                </fieldset>
                {testResult && <div className={styles.testResult} role="status"><span><Icon name="activity" size={16} /></span><div><strong>连接测试成功</strong><p>{testResult.endpoint}，延迟 {testResult.latencyMs} ms，协议 {testResult.info?.protocolVersion || "未知"}，版本 {testResult.info?.version || "未知"}</p></div></div>}
                <footer className={styles.dialogActions}><Button disabled={Boolean(busy)} onClick={onClose} type="button">取消</Button><Button disabled={!valid || Boolean(busy)} loading={busy === "test"} onClick={onTest} type="button"><Icon name="activity" size={15} />测试连接</Button><Button disabled={!valid || Boolean(busy)} loading={busy === "add"} variant="primary" type="submit"><Icon name="plus" size={15} />注册 Agent</Button></footer>
            </form>
        </dialog>
    );
}

function RemovalDialog({ preview, busy, onClose, onConfirm } : {
    preview?: AgentRemovalPreview;
    busy: boolean;
    onClose: () => void;
    onConfirm: (confirmation : string) => void;
}) {
    const dialogRef = useModalDialog(Boolean(preview));
    const [ confirmation, setConfirmation ] = useState("");

    useEffect(() => {
        if (preview) {
            setConfirmation("");
        }
    }, [ preview?.endpoint ]);

    if (!preview) {
        return <dialog className={styles.dialog} ref={dialogRef} />;
    }

    return (
        <dialog aria-labelledby="agent-removal-title" className={styles.dialog} onCancel={event => {
            event.preventDefault();
            if (!busy) {
                onClose();
            }
        }} onClick={event => {
            if (event.target === event.currentTarget && !busy) {
                onClose();
            }
        }} ref={dialogRef}>
            <div className={styles.dialogContent}>
                <header className={styles.dialogHeader}><div><h2 id="agent-removal-title">移除 Agent 注册</h2><p>此操作只删除控制器登记，不会停止远程 Docker 工作负载。</p></div><button aria-label="关闭" disabled={busy} onClick={onClose} type="button"><Icon name="close" /></button></header>
                <dl className={styles.removalFacts}><div><dt>节点</dt><dd>{preview.name}</dd></div><div><dt>端点</dt><dd className={styles.mono}>{preview.endpoint}</dd></div><div><dt>连接</dt><dd>{statusLabel(preview.status)}</dd></div><div><dt>最后在线</dt><dd>{formatTime(preview.lastSeenAt)}</dd></div></dl>
                {preview.diagnostics && <div className={styles.removalImpact}><strong>远程运行态</strong><p>{preview.diagnostics.docker.containers} 个容器，{preview.diagnostics.docker.composeProjects} 个 Compose 项目，{preview.diagnostics.docker.images} 个镜像。</p></div>}
                {preview.warnings.length > 0 && <div className={styles.warningList}><strong>影响提示</strong>{preview.warnings.map(warning => <p key={warning}>{warning}</p>)}</div>}
                <label className={styles.confirmField}><span>输入 <code>{preview.endpoint}</code> 确认</span><input autoFocus autoComplete="off" disabled={busy} onChange={event => setConfirmation(event.target.value)} value={confirmation} /></label>
                <footer className={styles.dialogActions}><Button disabled={busy} onClick={onClose}>取消</Button><Button disabled={confirmation !== preview.endpoint} loading={busy} variant="danger" onClick={() => onConfirm(confirmation)}><Icon name="delete" size={15} />确认移除</Button></footer>
            </div>
        </dialog>
    );
}

function AgentDiagnosticsView({ agent, diagnostics } : { agent: AgentManagementSummary; diagnostics?: AgentDiagnostics }) {
    const runtime = diagnostics?.runtime || agent.runtimeInfo?.runtime;
    const consoleInfo = diagnostics?.console || agent.runtimeInfo?.console;
    const capabilities = diagnostics?.capabilities || agent.runtimeInfo?.capabilities || [];

    return (
        <section className={styles.detailSection}>
            <div className={styles.sectionHeading}><div><h3>连接诊断与能力</h3><p>{diagnostics ? `诊断生成于 ${formatTime(diagnostics.generatedAt)}` : "运行诊断后可读取 Docker、Compose 与主机信息。"}</p></div></div>
            <dl className={styles.factGrid}>
                <div><dt>Agent 版本</dt><dd>{diagnostics?.version || agent.runtimeInfo?.version || "未知"}</dd></div>
                <div><dt>协议版本</dt><dd>{diagnostics?.protocolVersion || agent.runtimeInfo?.protocolVersion || "未知"}</dd></div>
                <div><dt>主机名</dt><dd>{runtime?.hostname || "未知"}</dd></div>
                <div><dt>平台</dt><dd>{runtime?.platform ? `${runtime.platform}/${runtime.arch || "unknown"}` : "未知"}</dd></div>
                <div><dt>Node.js</dt><dd>{runtime?.nodeVersion || "未知"}</dd></div>
                <div><dt>进程运行时间</dt><dd>{formatUptime(runtime?.uptimeSeconds)}</dd></div>
                <div><dt>终端策略</dt><dd>{consoleInfo?.enabled ? `${consoleInfo.target || "runtime"}，最多 ${consoleInfo.maxSessions || 0} 会话` : "未启用"}</dd></div>
                <div><dt>部署形态</dt><dd>{runtime?.isContainer ? "容器" : runtime ? "宿主机进程" : "未知"}</dd></div>
            </dl>
            {diagnostics && <><div className={styles.dockerSummary}><div><span>Docker</span><strong>{diagnostics.docker.available ? diagnostics.docker.serverVersion || "可用" : "不可用"}</strong></div><div><span>容器</span><strong>{diagnostics.docker.runningContainers}/{diagnostics.docker.containers}</strong></div><div><span>镜像</span><strong>{diagnostics.docker.images}</strong></div><div><span>Compose 项目</span><strong>{diagnostics.docker.composeProjects}</strong></div><div><span>CPU</span><strong>{diagnostics.docker.cpuCount}</strong></div><div><span>内存</span><strong>{formatBytes(diagnostics.docker.memoryBytes)}</strong></div></div><dl className={styles.pathFacts}><div><dt>数据目录</dt><dd>{diagnostics.paths.dataDir}</dd></div><div><dt>Compose 目录</dt><dd>{diagnostics.paths.stacksDir}</dd></div><div><dt>存储驱动</dt><dd>{diagnostics.docker.storageDriver || "未知"}</dd></div><div><dt>Compose 版本</dt><dd>{diagnostics.docker.composeVersion || "未知"}</dd></div></dl>{diagnostics.errors.length > 0 && <Notice className={styles.inlineNotice} tone="warning">部分诊断命令失败：{diagnostics.errors.join("；")}</Notice>}</>}
            <div className={styles.capabilities}><span>能力清单</span>{capabilities.length > 0 ? <div>{capabilities.map(capability => <code key={capability}>{capability}</code>)}</div> : <p>尚未收到能力报告。</p>}</div>
        </section>
    );
}

export function AgentsPage() {
    const requestedEndpoint = useRef(new URLSearchParams(window.location.search).get("endpoint") || "");
    const [ snapshot, setSnapshot ] = useState<AgentManagementResponse>();
    const [ loading, setLoading ] = useState(true);
    const [ refreshBusy, setRefreshBusy ] = useState(false);
    const [ selectedEndpoint, setSelectedEndpoint ] = useState("");
    const [ feedback, setFeedback ] = useState("");
    const [ failure, setFailure ] = useState<AgentFailure>();
    const [ enrollmentOpen, setEnrollmentOpen ] = useState(false);
    const [ candidate, setCandidate ] = useState<AgentConnectionRequest>(emptyCandidate);
    const [ candidateBusy, setCandidateBusy ] = useState<"test" | "add" | "">("");
    const [ testResult, setTestResult ] = useState<AgentTestResult>();
    const [ editName, setEditName ] = useState("");
    const [ editActive, setEditActive ] = useState(true);
    const [ credentialUsername, setCredentialUsername ] = useState("");
    const [ credentialPassword, setCredentialPassword ] = useState("");
    const [ actionBusy, setActionBusy ] = useState("");
    const [ diagnostics, setDiagnostics ] = useState<Record<string, AgentDiagnostics>>({});
    const [ removalPreview, setRemovalPreview ] = useState<AgentRemovalPreview>();
    const [ removalBusy, setRemovalBusy ] = useState(false);

    const loadAgents = useCallback(async (silent = false) => {
        if (!silent) {
            setLoading(true);
        }
        const response = await queryAgents();
        if (!response.ok) {
            setFailure({ action: "读取 Agent 清单",
                message: response.msg || "读取 Agent 清单失败" });
        } else {
            setSnapshot(response);
            setSelectedEndpoint(current => {
                if (current && response.agents.some(agent => agent.endpoint === current)) {
                    return current;
                }
                if (requestedEndpoint.current && response.agents.some(agent => agent.endpoint === requestedEndpoint.current)) {
                    return requestedEndpoint.current;
                }
                return response.agents[0]?.endpoint || "";
            });
        }
        setLoading(false);
        setRefreshBusy(false);
    }, []);

    useEffect(() => {
        void loadAgents();
        const offStatus = realtime.on("agentStatus", (...args : unknown[]) => {
            const data = args[0] as { endpoint?: unknown; status?: unknown; changedAt?: unknown; lastSeenAt?: unknown; msg?: unknown };
            if (typeof data.endpoint !== "string" || ![ "connecting", "online", "offline" ].includes(String(data.status))) {
                return;
            }
            setSnapshot(current => current ? { ...current,
                agents: current.agents.map(agent => agent.endpoint === data.endpoint ? { ...agent,
                    status: { status: data.status as EndpointConnectionStatus,
                        changedAt: typeof data.changedAt === "string" ? data.changedAt : new Date().toISOString(),
                        lastSeenAt: typeof data.lastSeenAt === "string" || data.lastSeenAt === null ? data.lastSeenAt : agent.status.lastSeenAt,
                        msg: typeof data.msg === "string" ? data.msg : undefined } } : agent) } : current);
        });
        const offList = realtime.on("agentList", () => void loadAgents(true));
        return () => {
            offStatus();
            offList();
        };
    }, [ loadAgents ]);

    const agents = snapshot?.agents || [];
    const selected = agents.find(agent => agent.endpoint === selectedEndpoint);

    useEffect(() => {
        if (!selected) {
            setEditName("");
            setCredentialUsername("");
            setCredentialPassword("");
            return;
        }
        setEditName(selected.name);
        setEditActive(selected.active);
        setCredentialUsername(selected.username);
        setCredentialPassword("");
    }, [ selected?.active, selected?.endpoint, selected?.name, selected?.username ]);

    const testCandidate = async () => {
        setCandidateBusy("test");
        setTestResult(undefined);
        const response = await testAgentConnection(candidate);
        setCandidateBusy("");
        if (!response.ok) {
            setFailure({ action: "测试 Agent 连接",
                endpoint: candidate.url,
                message: response.msg || "Agent 连接测试失败" });
            return;
        }
        setTestResult(response.test);
    };

    const enrollAgent = async () => {
        setCandidateBusy("add");
        const response = await addAgent(candidate);
        setCandidateBusy("");
        if (!response.ok) {
            setFailure({ action: "注册 Agent",
                endpoint: candidate.url,
                message: response.msg || "Agent 注册失败" });
            return;
        }
        setFeedback(`Agent ${response.endpoint || candidate.name} 已注册，正在建立持续连接。`);
        setSelectedEndpoint(response.endpoint || "");
        setCandidate(emptyCandidate);
        setTestResult(undefined);
        setEnrollmentOpen(false);
        await loadAgents(true);
    };

    const saveAgent = async (event : FormEvent) => {
        event.preventDefault();
        if (!selected) {
            return;
        }
        setActionBusy("save");
        const response = await updateAgent(selected.endpoint, editName, editActive);
        setActionBusy("");
        if (!response.ok) {
            setFailure({ action: "更新 Agent",
                endpoint: selected.endpoint,
                message: response.msg || "更新 Agent 失败" });
            return;
        }
        setSnapshot(response);
        setFeedback(`Agent ${selected.endpoint} 的名称和连接策略已更新。`);
    };

    const rotateCredentials = async (event : FormEvent) => {
        event.preventDefault();
        if (!selected || !credentialPassword) {
            return;
        }
        setActionBusy("credentials");
        const response = await rotateAgentCredentials(selected.endpoint, credentialUsername, credentialPassword);
        setActionBusy("");
        if (!response.ok) {
            setFailure({ action: "轮换 Agent 凭据",
                endpoint: selected.endpoint,
                message: response.msg || "Agent 凭据轮换失败" });
            return;
        }
        setSnapshot(response);
        setCredentialPassword("");
        setFeedback(`Agent ${selected.endpoint} 的凭据已验证并轮换。`);
    };

    const runDiagnostics = async () => {
        if (!selected) {
            return;
        }
        setActionBusy("diagnostics");
        const response = await diagnoseAgent(selected.endpoint);
        setActionBusy("");
        if (!response.ok) {
            setFailure({ action: "运行 Agent 诊断",
                endpoint: selected.endpoint,
                message: response.msg || "Agent 诊断失败" });
            return;
        }
        setDiagnostics(current => ({ ...current,
            [selected.endpoint]: response.diagnostics }));
        setFeedback(`Agent ${selected.endpoint} 的诊断信息已刷新。`);
    };

    const prepareRemoval = async () => {
        if (!selected) {
            return;
        }
        setActionBusy("preview-remove");
        const response = await previewAgentRemoval(selected.endpoint);
        setActionBusy("");
        if (!response.ok) {
            setFailure({ action: "预检 Agent 移除",
                endpoint: selected.endpoint,
                message: response.msg || "Agent 移除预检失败" });
            return;
        }
        setRemovalPreview(response.preview);
    };

    const confirmRemoval = async (confirmation : string) => {
        if (!removalPreview) {
            return;
        }
        setRemovalBusy(true);
        const endpoint = removalPreview.endpoint;
        const response = await removeAgent(endpoint, removalPreview.fingerprint, confirmation);
        setRemovalBusy(false);
        if (!response.ok) {
            setFailure({ action: "移除 Agent",
                endpoint,
                message: response.msg || "Agent 移除失败" });
            return;
        }
        setSnapshot(response);
        setRemovalPreview(undefined);
        setDiagnostics(current => {
            const next = { ...current };
            delete next[endpoint];
            return next;
        });
        setFeedback(`Agent ${endpoint} 已从控制器移除，远程工作负载未被停止。`);
    };

    const onlineCount = agents.filter(agent => agent.status.status === "online").length;
    const compatibilityAttention = agents.filter(agent => [ "legacy", "incompatible" ].includes(agent.compatibility)).length;
    const disabledCount = agents.filter(agent => !agent.active).length;

    return (
        <div className={pageStyles.page}>
            <PageHeader actions={<><Button loading={refreshBusy} onClick={() => {
                setRefreshBusy(true);
                void loadAgents(true);
            }}><Icon name="refresh" size={15} />刷新</Button><Button variant="primary" onClick={() => setEnrollmentOpen(true)}><Icon name="plus" size={15} />注册 Agent</Button></>} description="注册远程节点，检查连接与版本兼容性，并安全轮换认证凭据。" title="Agent 节点" />
            <MetricStrip items={[{ label: "已注册节点",
                value: agents.length }, { label: "当前在线",
                value: onlineCount }, { label: "兼容性提醒",
                value: compatibilityAttention,
                tone: compatibilityAttention > 0 ? "warning" : "default" }, { label: "已停用",
                value: disabledCount,
                tone: disabledCount > 0 ? "warning" : "default" }]} />
            {snapshot && !snapshot.credentialEncryption.externalKeyConfigured && <Notice className={styles.securityNotice} tone="warning">Agent 凭据当前使用控制器密钥加密。生产环境建议配置 <code>DOCKERBRIDGE_AGENT_CREDENTIAL_KEY</code>，并在密钥变更前完成凭据轮换。</Notice>}
            {feedback && <Notice className={styles.feedback}>{feedback}</Notice>}
            <div className={styles.workspace}>
                <Panel className={styles.listPanel} flush>
                    <div className={styles.panelHeading}><div><h3>节点清单</h3><p>{snapshot ? `清单生成于 ${formatTime(snapshot.generatedAt)}` : "正在读取控制器登记信息"}</p></div><span>{snapshot?.credentialEncryption.algorithm || "AES-256-GCM"}</span></div>
                    {loading ? <SkeletonRows rows={5} /> : agents.length === 0 ? <EmptyState action={<Button variant="primary" onClick={() => setEnrollmentOpen(true)}>注册第一个 Agent</Button>} description="添加远程 DockerBridge 实例后，可在同一控制器中管理多个 Docker 节点。" title="尚未注册远程 Agent" /> : <div className={pageStyles.tableScroller}><table className={`${pageStyles.table} ${styles.agentTable}`}><thead><tr><th>节点</th><th>连接</th><th>兼容性</th><th className={pageStyles.mobileOptional}>版本</th><th className={pageStyles.mobileOptional}>最后在线</th><th aria-label="管理" /></tr></thead><tbody>{agents.map(agent => <tr className={agent.endpoint === selectedEndpoint ? styles.selectedRow : ""} key={agent.endpoint}><td><button aria-controls="agent-detail" aria-pressed={agent.endpoint === selectedEndpoint} className={styles.agentIdentity} onClick={() => setSelectedEndpoint(agent.endpoint)} type="button"><strong>{agent.name || agent.endpoint}</strong><small>{agent.endpoint}</small></button></td><td><StatusBadge label={agent.active ? statusLabel(agent.status.status) : "已停用"} status={agent.active ? agent.status.status : "offline"} /></td><td><StatusBadge label={compatibilityLabel(agent.compatibility)} status={compatibilityStatus(agent.compatibility)} /></td><td className={`${pageStyles.mono} ${pageStyles.mobileOptional}`}>{agent.runtimeInfo?.version || "未知"}</td><td className={`${styles.timeCell} ${pageStyles.mobileOptional}`}>{formatTime(agent.status.lastSeenAt)}</td><td><div className={pageStyles.rowActions}><Button aria-controls="agent-detail" aria-label={`管理 ${agent.name || agent.endpoint}`} aria-pressed={agent.endpoint === selectedEndpoint} size="compact" variant={agent.endpoint === selectedEndpoint ? "primary" : "ghost"} onClick={() => setSelectedEndpoint(agent.endpoint)}>管理</Button></div></td></tr>)}</tbody></table></div>}
                </Panel>
                <Panel className={styles.detailPanel} flush id="agent-detail">
                    {!selected ? <EmptyState description="从节点清单中选择一个 Agent，查看连接、版本、能力和凭据状态。" title="选择 Agent" /> : <><div className={styles.detailHeader}><div><span className={styles.statusLine}><StatusBadge label={selected.active ? statusLabel(selected.status.status) : "已停用"} status={selected.active ? selected.status.status : "offline"} /><StatusBadge label={compatibilityLabel(selected.compatibility)} status={compatibilityStatus(selected.compatibility)} /></span><h2>{selected.name}</h2><p>{selected.url}</p></div><div className={styles.detailActions}><Button disabled={!selected.active || selected.status.status !== "online"} loading={actionBusy === "diagnostics"} size="compact" onClick={() => void runDiagnostics()}><Icon name="activity" size={14} />运行诊断</Button><Button loading={actionBusy === "preview-remove"} size="compact" variant="danger" onClick={() => void prepareRemoval()}><Icon name="delete" size={14} />移除</Button></div></div><div className={styles.detailBody}><section className={styles.detailSection}><div className={styles.sectionHeading}><div><h3>登记与连接策略</h3><p>停用后控制器会断开连接，但不会修改远程节点。</p></div></div><form className={styles.inlineForm} onSubmit={saveAgent}><label><span>显示名称</span><input maxLength={128} onChange={event => setEditName(event.target.value)} value={editName} /></label><label className={styles.toggleField}><input checked={editActive} onChange={event => setEditActive(event.target.checked)} type="checkbox" /><span><strong>允许控制器连接此 Agent</strong><small>{editActive ? "保存后保持或重新建立连接" : "保存后断开并标记为停用"}</small></span></label><dl className={styles.credentialFacts}><div><dt>端点</dt><dd>{selected.endpoint}</dd></div><div><dt>登录账户</dt><dd>{selected.username}</dd></div><div><dt>凭据版本</dt><dd>{selected.credentialVersion}</dd></div><div><dt>加密状态</dt><dd>{selected.credentialEncrypted ? "已加密" : "待迁移"}</dd></div><div><dt>创建时间</dt><dd>{formatTime(selected.createdAt)}</dd></div><div><dt>更新时间</dt><dd>{formatTime(selected.updatedAt)}</dd></div></dl>{selected.status.msg && <Notice className={styles.inlineNotice} tone={selected.status.status === "offline" ? "warning" : "default"}>{selected.status.msg}</Notice>}<div className={styles.formActions}><Button disabled={!editName.trim() || actionBusy === "credentials"} loading={actionBusy === "save"} variant="primary" type="submit"><Icon name="save" size={15} />保存节点设置</Button></div></form></section><section className={styles.detailSection}><div className={styles.sectionHeading}><div><h3>认证凭据轮换</h3><p>新凭据会先通过远程登录验证，验证成功后才替换已保存凭据。</p></div></div><form className={styles.inlineForm} onSubmit={rotateCredentials}><div className={styles.twoColumns}><label><span>登录账户</span><input autoComplete="username" onChange={event => setCredentialUsername(event.target.value)} value={credentialUsername} /></label><label><span>新密码</span><input autoComplete="new-password" onChange={event => setCredentialPassword(event.target.value)} placeholder="输入新密码" type="password" value={credentialPassword} /></label></div><div className={styles.formActions}><Button disabled={!credentialUsername.trim() || !credentialPassword || actionBusy === "save"} loading={actionBusy === "credentials"} type="submit"><Icon name="restart" size={15} />验证并轮换</Button></div></form></section><AgentDiagnosticsView agent={selected} diagnostics={diagnostics[selected.endpoint]} /></div></>}
                </Panel>
            </div>
            <EnrollmentDialog busy={candidateBusy} candidate={candidate} onAdd={() => void enrollAgent()} onChange={value => {
                setCandidate(value);
                setTestResult(undefined);
            }} onClose={() => setEnrollmentOpen(false)} onTest={() => void testCandidate()} open={enrollmentOpen} testResult={testResult} />
            <RemovalDialog busy={removalBusy} onClose={() => setRemovalPreview(undefined)} onConfirm={confirmation => void confirmRemoval(confirmation)} preview={removalPreview} />
            <FailureDialog description="运行服务保留了原始 Agent 管理错误，可据此检查网络、版本、权限或凭据。" details={failure?.endpoint ? [{ label: "Agent",
                value: failure.endpoint }] : []} message={failure?.message || ""} onClose={() => setFailure(undefined)} open={Boolean(failure)} title={failure?.action || "Agent 操作失败"} />
        </div>
    );
}
