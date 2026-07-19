import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "@/components/primitives/Button";
import { EmptyState } from "@/components/primitives/EmptyState";
import { StatusBadge } from "@/components/primitives/StatusBadge";
import { Icon } from "@/components/Icon";
import { FailureDialog, MetricStrip, Notice, PageHeader, Panel, SearchField, Toolbar, useModalDialog } from "@/components/ui";
import { queryStackDetail, queryStackServiceLogs, requestStackList, serviceAction, stackAction } from "@/services/runtime";
import { endpointFor, formatLastSeen, isEndpointOperational, isStackStale } from "@/services/endpoints";
import { useAppSelector } from "@/store/hooks";
import { ComposeStackDetail, StackSummary } from "@/types/domain";
import { ComposeEditorDialog } from "./ComposeEditorDialog";
import detailStyles from "./ComposeDetail.module.css";
import styles from "./Page.module.css";

type StackAction = "start" | "stop" | "restart" | "update" | "down";
type ServiceAction = "start" | "stop" | "restart";

interface PendingStackAction {
    endpoint: string;
    stackName: string;
    action: StackAction;
}

interface ActionFeedback {
    message: string;
    tone: "default" | "error";
}

interface ActionFailure {
    target: string;
    endpoint: string;
    action: string;
    message: string;
}

const actionLabels : Record<StackAction, string> = {
    start: "启动",
    stop: "停止",
    restart: "重启",
    update: "更新",
    down: "停止并移除",
};

const serviceActionLabels : Record<ServiceAction, string> = {
    start: "启动服务",
    stop: "停止服务",
    restart: "重启服务",
};

function stackStatus(status : number) {
    if (status === 3) {
        return { status: "running",
            label: "运行中" };
    }
    if (status === 4) {
        return { status: "exited",
            label: "已退出" };
    }
    if (status === 2) {
        return { status: "created",
            label: "已创建" };
    }
    return { status: "inactive",
        label: "未运行" };
}

function serviceStatus(detail : ComposeStackDetail["services"][number]) {
    const status = detail.containers[0]?.status || "inactive";
    if (detail.running > 0) {
        return { status: "running",
            label: status };
    }
    if (detail.containers.length > 0) {
        return { status: "exited",
            label: status };
    }
    return { status: "inactive",
        label: "未创建" };
}

function StackDetailDialog({ stack, endpointOnline, initialService, onClose, onFailure } : { stack: StackSummary; endpointOnline: boolean; initialService?: string; onClose: () => void; onFailure: (failure: ActionFailure) => void }) {
    const dialogRef = useModalDialog();
    const [ detail, setDetail ] = useState<ComposeStackDetail>();
    const [ loading, setLoading ] = useState(true);
    const [ error, setError ] = useState("");
    const [ section, setSection ] = useState<"services" | "logs">("services");
    const [ selectedService, setSelectedService ] = useState("");
    const [ tail, setTail ] = useState(300);
    const [ logs, setLogs ] = useState("");
    const [ logsLoading, setLogsLoading ] = useState(false);
    const [ logsError, setLogsError ] = useState("");
    const [ pendingService, setPendingService ] = useState("");

    const loadDetail = async () => {
        if (!endpointOnline) {
            setError("运行节点已离线，详情数据已冻结。节点恢复后关闭并重新打开详情。");
            return;
        }
        setLoading(true);
        setError("");
        const response = await queryStackDetail(stack.endpoint, stack.name);
        if (response.ok) {
            setDetail(response.detail);
            const requestedService = initialService ? response.detail.services.find(service => service.name === initialService) : undefined;
            if (initialService && !requestedService) {
                setError(`项目 ${stack.name} 中未找到审计记录指向的服务 ${initialService}。服务可能已重命名或从 Compose 配置中移除。`);
            } else {
                setSelectedService(current => requestedService?.name || current || response.detail.services[0]?.name || "");
                if (requestedService) {
                    setSection("logs");
                }
            }
        } else {
            setError(response.msg || "无法读取 Compose 项目详情");
        }
        setLoading(false);
    };

    const loadLogs = async () => {
        if (!selectedService || !endpointOnline) {
            if (!endpointOnline) {
                setLogsError("运行节点已离线，无法刷新服务日志。");
            }
            return;
        }
        setLogsLoading(true);
        setLogsError("");
        const response = await queryStackServiceLogs(stack.endpoint, stack.name, selectedService, tail);
        if (response.ok) {
            setLogs(response.logs || "");
        } else {
            setLogsError(response.msg || "无法读取服务日志");
        }
        setLogsLoading(false);
    };

    useEffect(() => {
        void loadDetail();
    }, []);

    useEffect(() => {
        if (section === "logs" && selectedService) {
            void loadLogs();
        }
    }, [ section, selectedService, tail ]);

    const actOnService = async (serviceName : string, action : ServiceAction) => {
        if (!endpointOnline) {
            onFailure({
                target: `${stack.name}/${serviceName}`,
                endpoint: stack.endpoint,
                action: serviceActionLabels[action],
                message: "运行节点已离线，未发送服务操作。",
            });
            return;
        }
        if (action === "stop" && !window.confirm(`确认停止服务 ${stack.name}/${serviceName}？`)) {
            return;
        }
        setPendingService(`${serviceName}:${action}`);
        const response = await serviceAction(stack.endpoint, stack.name, serviceName, action);
        setPendingService("");
        if (!response.ok) {
            onFailure({
                target: `${stack.name}/${serviceName}`,
                endpoint: stack.endpoint,
                action: serviceActionLabels[action],
                message: response.msg || `${serviceActionLabels[action]}失败`,
            });
            return;
        }
        await loadDetail();
        if (section === "logs") {
            await loadLogs();
        }
    };

    return <dialog aria-labelledby="compose-detail-title" className={detailStyles.dialog} onCancel={event => {
        event.preventDefault();
        onClose();
    }} onClick={event => {
        if (event.target === event.currentTarget) {
            onClose();
        }
    }} ref={dialogRef}>
        <div className={detailStyles.content}>
            <header className={detailStyles.header}>
                <div><span>{stack.endpoint || "本机"}</span><h2 id="compose-detail-title">{stack.name}</h2><p>{stack.composeFilePath || stack.composeFileName}</p></div>
                <div className={detailStyles.headerActions}>{detail && <StatusBadge label={`${detail.runningCount}/${detail.serviceCount} 服务运行`} status={detail.runningCount === detail.serviceCount ? "running" : "created"} />}<button aria-label="关闭详情" className={detailStyles.closeButton} onClick={onClose} type="button"><Icon name="close" /></button></div>
            </header>
            <div className={detailStyles.tabs}>
                <Button aria-pressed={section === "services"} size="compact" variant={section === "services" ? "primary" : "ghost"} onClick={() => setSection("services")}>服务拓扑</Button>
                <Button aria-pressed={section === "logs"} disabled={!detail?.services.length || !endpointOnline} size="compact" variant={section === "logs" ? "primary" : "ghost"} onClick={() => setSection("logs")}>服务日志</Button>
                <Button className={detailStyles.refreshButton} disabled={!endpointOnline} loading={loading} size="compact" onClick={() => void loadDetail()}><Icon name="refresh" size={14} />刷新状态</Button>
            </div>
            {error && <div className={detailStyles.notice}><Notice tone="error">{error}</Notice></div>}
            {section === "services" ? <div className={detailStyles.body}>
                {loading && !detail ? <p className={detailStyles.loadingCopy}>正在读取 Compose 配置和服务状态…</p> : detail && <>
                    <dl className={detailStyles.facts}><div><dt>服务</dt><dd>{detail.serviceCount}</dd></div><div><dt>运行中</dt><dd>{detail.runningCount}</dd></div><div><dt>网络</dt><dd>{detail.networkNames.length}</dd></div><div><dt>命名卷</dt><dd>{detail.volumeNames.length}</dd></div></dl>
                    {detail.services.length === 0 ? <EmptyState description="Compose 文件中没有可识别的 services 配置。" title="没有服务" /> : <div className={detailStyles.tableScroller}><table className={detailStyles.serviceTable}><thead><tr><th>服务</th><th>状态</th><th>镜像 / 构建</th><th>端口</th><th>依赖 / 网络</th><th aria-label="操作" /></tr></thead><tbody>{detail.services.map(service => {
                        const state = serviceStatus(service);
                        const isPending = pendingService.startsWith(`${service.name}:`);
                        return <tr key={service.name}><td><div className={detailStyles.primaryCell}><strong>{service.name}</strong><small>{service.containers.map(container => container.name).filter(Boolean).join(", ") || "尚未创建容器"}</small></div></td><td><StatusBadge label={state.label} status={state.status} /></td><td><div className={detailStyles.primaryCell}><span>{service.image || (service.hasBuild ? "本地构建" : "未声明")}</span><small>{service.restart !== "no" ? `重启策略 ${service.restart}` : `${service.volumeCount} 个挂载`}</small></div></td><td className={detailStyles.mono}>{service.ports.join(", ") || "—"}</td><td><div className={detailStyles.primaryCell}><span>{service.dependencies.join(", ") || "无依赖"}</span><small>{service.networks.join(", ") || "默认网络"}</small></div></td><td><div className={detailStyles.rowActions}>{service.running > 0 ? <Button disabled={isPending || !endpointOnline} loading={pendingService === `${service.name}:stop`} size="compact" onClick={() => void actOnService(service.name, "stop")}>停止</Button> : <Button disabled={isPending || !endpointOnline} loading={pendingService === `${service.name}:start`} size="compact" variant="primary" onClick={() => void actOnService(service.name, "start")}>启动</Button>}<Button disabled={isPending || !endpointOnline} loading={pendingService === `${service.name}:restart`} size="compact" onClick={() => void actOnService(service.name, "restart")}>重启</Button><Button disabled={!endpointOnline} size="compact" variant="ghost" onClick={() => {
                            setSelectedService(service.name);
                            setSection("logs");
                        }}>日志</Button></div></td></tr>;
                    })}</tbody></table></div>}
                    <div className={detailStyles.configSummary}><span>环境变量仅显示键名，不下发值</span><span>网络：{detail.networkNames.join(", ") || "默认"}</span><span>卷：{detail.volumeNames.join(", ") || "无命名卷"}</span></div>
                </>}
            </div> : <div className={detailStyles.logsBody}>
                <div className={detailStyles.logToolbar}><label>服务<select disabled={!endpointOnline} onChange={event => setSelectedService(event.target.value)} value={selectedService}>{detail?.services.map(service => <option key={service.name} value={service.name}>{service.name}</option>)}</select></label><label>最近<select disabled={!endpointOnline} onChange={event => setTail(Number(event.target.value))} value={tail}><option value={100}>100 行</option><option value={300}>300 行</option><option value={1000}>1000 行</option><option value={5000}>5000 行</option></select></label><Button disabled={!endpointOnline} loading={logsLoading} size="compact" onClick={() => void loadLogs()}><Icon name="refresh" size={14} />刷新日志</Button></div>
                {logsError && <Notice tone="error">{logsError}</Notice>}
                <pre className={detailStyles.logOutput}>{logsLoading && !logs ? "正在读取服务日志…" : logs || "当前没有日志输出。"}</pre>
            </div>}
            <footer className={detailStyles.actions}><Button variant="primary" onClick={onClose}>关闭</Button></footer>
        </div>
    </dialog>;
}

export function ComposeProjectsPage() {
    const { stacks: stackMap, endpoints, stackSyncErrors, stackSyncedAt } = useAppSelector(state => state.runtime);
    const permissions = useAppSelector(state => state.session.permissions);
    const [ searchParams ] = useSearchParams();
    const stacks = Object.values(stackMap);
    const [ search, setSearch ] = useState("");
    const [ pending, setPending ] = useState<PendingStackAction>();
    const [ feedback, setFeedback ] = useState<ActionFeedback>();
    const [ failure, setFailure ] = useState<ActionFailure>();
    const [ selectedStackKey, setSelectedStackKey ] = useState("");
    const [ selectedService, setSelectedService ] = useState("");
    const [ deepLinkNotice, setDeepLinkNotice ] = useState<{ message: string; tone: "default" | "error" }>();
    const [ editorTarget, setEditorTarget ] = useState<{ kind: "new" } | { kind: "existing"; stack: StackSummary }>();
    const [ now, setNow ] = useState(Date.now());
    const handledDeepLink = useRef("");
    const filtered = useMemo(() => stacks.filter(stack => [ stack.name, stack.composeFilePath, stack.endpoint ].join(" ").toLocaleLowerCase().includes(search.toLocaleLowerCase())), [ stacks, search ]);
    const running = stacks.filter(stack => stack.status === 3).length;
    const exited = stacks.filter(stack => stack.status === 4).length;
    const selectedStack = stacks.find(stack => `${stack.name}_${stack.endpoint}` === selectedStackKey);
    const endpointList = Object.values(endpoints);
    const offlineEndpoints = endpointList.filter(endpoint => endpoint.status === "offline");
    const connectingEndpoints = endpointList.filter(endpoint => endpoint.status === "connecting");
    const canEdit = permissions.includes("destructive");

    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 15_000);
        return () => window.clearInterval(timer);
    }, []);

    useEffect(() => {
        const stackTarget = searchParams.get("stack")?.trim() || "";
        const endpointTarget = searchParams.get("endpoint")?.trim() || "";
        const serviceTarget = searchParams.get("service")?.trim() || "";
        const deepLinkKey = `${stackTarget}:${endpointTarget}:${serviceTarget}`;
        if (!stackTarget || handledDeepLink.current === deepLinkKey) {
            return;
        }
        const normalizedEndpoint = endpointTarget === "local" ? "" : endpointTarget;
        const target = stacks.find(stack => stack.name === stackTarget && (!endpointTarget || stack.endpoint === normalizedEndpoint));
        if (target) {
            handledDeepLink.current = deepLinkKey;
            const operational = isEndpointOperational(endpoints, target.endpoint) && !isStackStale(target, now);
            if (!operational) {
                setDeepLinkNotice({ message: `已找到项目 ${target.name}，但节点 ${target.endpoint || "本机"} 当前离线、连接中或状态已过期，无法打开实时详情。`,
                    tone: "error" });
                return;
            }
            setSearch("");
            setSelectedService(serviceTarget);
            setSelectedStackKey(`${target.name}_${target.endpoint}`);
            setDeepLinkNotice({ message: serviceTarget ? `已从操作审计定位到 ${target.name}/${serviceTarget}。` : `已从操作审计定位到 Compose 项目 ${target.name}。`,
                tone: "default" });
            return;
        }
        const expectedEndpoint = endpointTarget ? normalizedEndpoint : "";
        const syncFinished = endpointTarget
            ? Boolean(stackSyncedAt[expectedEndpoint] || stackSyncErrors[expectedEndpoint])
            : Object.keys(stackSyncedAt).length > 0 || Object.keys(stackSyncErrors).length > 0;
        if (syncFinished) {
            handledDeepLink.current = deepLinkKey;
            setDeepLinkNotice({ message: `未找到审计记录指向的 Compose 项目 ${stackTarget}${endpointTarget ? `（节点 ${endpointTarget}）` : ""}。项目可能已移除或节点尚未同步。`,
                tone: "error" });
        }
    }, [ endpoints, now, searchParams, stackMap, stackSyncErrors, stackSyncedAt, stacks ]);

    const act = async (stackName : string, endpoint : string, action : StackAction) => {
        const stack = stacks.find(item => item.name === stackName && item.endpoint === endpoint);
        if (!isEndpointOperational(endpoints, endpoint) || !stack || isStackStale(stack)) {
            const message = `${endpoint || "本机"} 当前离线、连接中或状态已过期，请等待节点恢复并刷新后重试。`;
            setFailure({ target: stackName,
                endpoint,
                action: actionLabels[action],
                message });
            return;
        }
        if ([ "stop", "down" ].includes(action) && !window.confirm(`确认对 Compose 项目 ${stackName} 执行${action === "down" ? "停止并移除容器" : "停止"}？`)) {
            return;
        }
        setFeedback(undefined);
        setFailure(undefined);
        setPending({ endpoint,
            stackName,
            action });
        try {
            const response = await stackAction(endpoint, stackName, action);
            if (!response.ok) {
                const message = response.msg || `${stackName} ${actionLabels[action]}失败`;
                setFeedback({ message,
                    tone: "error" });
                setFailure({ target: stackName,
                    endpoint,
                    action: actionLabels[action],
                    message });
                return;
            }
            setFeedback({ message: `${stackName} 已${actionLabels[action]}`,
                tone: "default" });
            await requestStackList();
        } catch (error) {
            const message = error instanceof Error ? error.message : `${stackName} ${actionLabels[action]}失败`;
            setFeedback({ message,
                tone: "error" });
            setFailure({ target: stackName,
                endpoint,
                action: actionLabels[action],
                message });
        } finally {
            setPending(undefined);
        }
    };

    return <div className={styles.page}>
        <PageHeader actions={<div className={styles.rowActions}>{canEdit && <Button variant="primary" onClick={() => setEditorTarget({ kind: "new" })}><Icon name="plus" size={16} />新建项目</Button>}<Button onClick={() => void requestStackList()}><Icon name="refresh" size={16} />刷新状态</Button></div>} description="检查服务拓扑、最近日志并执行项目或服务级恢复操作。" title="已登记的 Compose 项目" />
        <MetricStrip items={[{ label: "项目总数",
            value: stacks.length }, { label: "运行中",
            value: running }, { label: "已退出",
            value: exited,
            tone: exited > 0 ? "warning" : "default" }, { label: "在线节点",
            value: endpointList.filter(endpoint => endpoint.status === "online").length }, { label: "异常节点",
            value: offlineEndpoints.length + connectingEndpoints.length,
            tone: offlineEndpoints.length > 0 ? "danger" : connectingEndpoints.length > 0 ? "warning" : "default" }]} />
        <Toolbar><span className={styles.muted}>按项目名、配置路径或运行节点筛选</span><SearchField label="搜索 Compose 项目" onChange={event => setSearch(event.target.value)} placeholder="搜索项目名、路径或节点" value={search} /></Toolbar>
        {offlineEndpoints.length > 0 && <Notice tone="error">{offlineEndpoints.length} 个运行节点离线。离线节点的项目状态已冻结，所有操作已禁用；最近在线时间显示在项目行中。</Notice>}
        {connectingEndpoints.length > 0 && <Notice tone="warning">{connectingEndpoints.length} 个运行节点正在连接，连接完成前不会发送操作。</Notice>}
        {Object.keys(stackSyncErrors).length > 0 && <Notice tone="error">{Object.entries(stackSyncErrors).map(([ endpoint, message ]) => `${endpoint || "本机"}: ${message}`).join("；")}</Notice>}
        {feedback && <Notice tone={feedback.tone}>{feedback.message}</Notice>}
        {deepLinkNotice && <Notice tone={deepLinkNotice.tone}>{deepLinkNotice.message}</Notice>}
        <Panel>{filtered.length === 0 ? <EmptyState title="没有匹配的 Compose 项目" description={search ? "清空搜索条件以查看全部已登记项目。" : "前往 Compose 仓库扫描配置文件，并在需要时启动项目。"} /> : <div className={styles.tableScroller}><table className={styles.table}><thead><tr><th>项目</th><th>状态</th><th className={styles.mobileOptional}>配置路径</th><th className={styles.mobileOptional}>来源</th><th aria-label="操作" /></tr></thead><tbody>{filtered.map(stack => {
            const state = stackStatus(stack.status);
            const key = `${stack.name}_${stack.endpoint}`;
            const isPending = pending?.stackName === stack.name && pending.endpoint === stack.endpoint;
            const endpoint = endpointFor(endpoints, stack.endpoint);
            const operational = isEndpointOperational(endpoints, stack.endpoint);
            const stale = isStackStale(stack, now);
            const unavailable = !operational || stale;
            const displayState = endpoint.status === "offline"
                ? { status: "offline",
                    label: "节点离线" }
                : endpoint.status === "connecting"
                    ? { status: "connecting",
                        label: "连接中" }
                    : stale
                        ? { status: "stale",
                            label: "状态过期" }
                        : state;
            return <tr className={unavailable ? styles.staleRow : ""} key={key}><td><div className={styles.primaryCell}><strong>{stack.name}</strong><small>{stack.isDiscoveredCompose ? "外部发现" : "平台目录"}</small></div></td><td><StatusBadge status={displayState.status} label={displayState.label} /></td><td className={`${styles.mono} ${styles.mobileOptional}`}>{stack.composeFilePath || stack.composeFileName}</td><td className={styles.mobileOptional}><div className={styles.primaryCell}><span>{endpoint.name || stack.endpoint || "本机"}</span><small>{endpoint.status === "online" ? `同步于 ${stack.syncedAt ? new Date(stack.syncedAt).toLocaleTimeString() : "未知"}` : `最后在线 ${formatLastSeen(endpoint.lastSeenAt)}`}</small></div></td><td><div className={styles.rowActions}><Button disabled={unavailable} size="compact" title={unavailable ? "节点恢复并刷新状态后可用" : undefined} variant="ghost" onClick={() => setSelectedStackKey(key)}>详情</Button>{canEdit && <Button disabled={unavailable} size="compact" variant="ghost" onClick={() => setEditorTarget({ kind: "existing",
                stack })}><Icon name="edit" size={14} />编辑</Button>}{stack.status === 3 ? <Button disabled={isPending || unavailable} loading={isPending && pending?.action === "stop"} size="compact" onClick={() => void act(stack.name, stack.endpoint, "stop")}><Icon name="stop" size={14} />停止</Button> : <Button disabled={isPending || unavailable} loading={isPending && pending?.action === "start"} size="compact" variant="primary" onClick={() => void act(stack.name, stack.endpoint, "start")}><Icon name="play" size={14} />启动</Button>}<Button disabled={isPending || unavailable} loading={isPending && pending?.action === "restart"} size="compact" onClick={() => void act(stack.name, stack.endpoint, "restart")}><Icon name="restart" size={14} />重启</Button></div></td></tr>;
        })}</tbody></table></div>}</Panel>
        {selectedStack && <StackDetailDialog endpointOnline={isEndpointOperational(endpoints, selectedStack.endpoint) && !isStackStale(selectedStack, now)} initialService={selectedService} onClose={() => {
            setSelectedStackKey("");
            setSelectedService("");
        }} onFailure={setFailure} stack={selectedStack} />}
        {editorTarget && <ComposeEditorDialog endpoints={endpointList} stack={editorTarget.kind === "existing" ? editorTarget.stack : undefined} onClose={() => setEditorTarget(undefined)} onSaved={() => void requestStackList()} />}
        {failure && <FailureDialog description="运行服务返回了错误，当前操作未完成。" details={[{ label: "对象",
            value: failure.target }, { label: "节点",
            value: failure.endpoint || "本机" }, { label: "操作",
            value: failure.action }]} message={failure.message} onClose={() => setFailure(undefined)} open title={`${failure.action}失败`} />}
    </div>;
}
