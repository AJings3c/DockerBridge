import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/primitives/Button";
import { EmptyState } from "@/components/primitives/EmptyState";
import { StatusBadge } from "@/components/primitives/StatusBadge";
import { Icon } from "@/components/Icon";
import { FailureDialog, Notice, PageHeader, Panel, SearchField, SegmentedControl, Toolbar, useModalDialog } from "@/components/ui";
import { cleanContainerCache, containerAction, imageAction, onImagePullProgress, preflightHostPort, previewContainerCache, previewImagePrune, pruneImages, queryContainerLogs, refreshSnapshot, rollbackHostPort, tagImage, updateHostPort } from "@/services/runtime";
import { useAppSelector } from "@/store/hooks";
import { CacheCleanupPreviewResponse, DockerContainer, DockerPort, DockerPortPreflightResponse, DockerPortRollback, DockerPortUpdatePayload, ImagePrunePreviewResponse } from "@/types/domain";
import styles from "./Page.module.css";
import detailStyles from "./ContainerDetail.module.css";
import resourceStyles from "./ContainersPage.module.css";

type ContainerAction = "start" | "stop" | "restart" | "recreate";

interface ActionFailure {
    name: string;
    action: string;
    message: string;
}

interface ImageFailure {
    target: string;
    action: string;
    message: string;
}

interface PortEditState {
    port: DockerPort;
    hostPort: string;
    preflight?: DockerPortPreflightResponse;
}

interface PortFailure {
    action: string;
    message: string;
    rollback?: DockerPortRollback;
}

function formatDate(value : string) {
    if (!value) {
        return "—";
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatBytes(value : number) {
    if (value <= 0) {
        return "未知";
    }
    const units = [ "B", "KiB", "MiB", "GiB", "TiB" ];
    let amount = value;
    let unit = 0;
    while (amount >= 1024 && unit < units.length - 1) {
        amount /= 1024;
        unit += 1;
    }
    return `${amount.toFixed(unit === 0 ? 0 : amount < 10 ? 1 : 0)} ${units[unit]}`;
}

function ContainerDetailDialog({ container, onClose, onUpdated } : { container: DockerContainer; onClose: () => void; onUpdated: () => Promise<unknown> }) {
    const permissions = useAppSelector(state => state.session.permissions);
    const navigate = useNavigate();
    const canDestructive = permissions.includes("destructive");
    const dialogRef = useModalDialog();
    const [ section, setSection ] = useState<"overview" | "logs" | "cache">("overview");
    const [ tail, setTail ] = useState(300);
    const [ logs, setLogs ] = useState("");
    const [ loadingLogs, setLoadingLogs ] = useState(false);
    const [ logError, setLogError ] = useState("");
    const [ portEdit, setPortEdit ] = useState<PortEditState>();
    const [ portBusy, setPortBusy ] = useState<"preflight" | "apply" | "rollback" | "">("");
    const [ portFeedback, setPortFeedback ] = useState("");
    const [ lastRollback, setLastRollback ] = useState<DockerPortRollback>();
    const [ portFailure, setPortFailure ] = useState<PortFailure>();
    const [ cachePreview, setCachePreview ] = useState<CacheCleanupPreviewResponse>();
    const [ cacheBusy, setCacheBusy ] = useState<"preview" | "clean" | "">("");
    const [ cacheFeedback, setCacheFeedback ] = useState("");
    const [ cacheFailure, setCacheFailure ] = useState<PortFailure>();

    useEffect(() => {
        if (section !== "logs") {
            return;
        }
        let active = true;
        setLoadingLogs(true);
        setLogError("");
        void queryContainerLogs(container.id, tail).then(response => {
            if (!active) {
                return;
            }
            if (response.ok) {
                setLogs(response.logs || "");
            } else {
                setLogError(response.msg || "无法读取容器日志");
            }
            setLoadingLogs(false);
        });
        return () => {
            active = false;
        };
    }, [ container.id, section, tail ]);

    const refreshLogs = async () => {
        setLoadingLogs(true);
        setLogError("");
        const response = await queryContainerLogs(container.id, tail);
        if (response.ok) {
            setLogs(response.logs || "");
        } else {
            setLogError(response.msg || "无法读取容器日志");
        }
        setLoadingLogs(false);
    };

    const previewCache = async () => {
        setCacheBusy("preview");
        setCacheFailure(undefined);
        setCacheFeedback("");
        const response = await previewContainerCache(container.id);
        setCacheBusy("");
        if (!response.ok) {
            setCacheFailure({ action: "预览缓存清理",
                message: response.msg || "缓存清理预览失败" });
            return;
        }
        setCachePreview(response);
    };

    const applyCacheCleanup = async () => {
        const eligible = cachePreview?.entries.filter(entry => entry.eligible && entry.source) || [];
        if (eligible.length === 0 || !window.confirm(`确认清理 ${container.name} 的 ${eligible.length} 个已声明缓存目录？预计删除 ${eligible.reduce((total, entry) => total + entry.fileCount, 0)} 个文件。`)) {
            return;
        }
        setCacheBusy("clean");
        setCacheFailure(undefined);
        const response = await cleanContainerCache(container.id, eligible.map(entry => ({ cacheDir: entry.cacheDir,
            source: entry.source as string })));
        setCacheBusy("");
        if (!response.ok) {
            setCacheFailure({ action: "清理缓存",
                message: response.msg || "缓存清理失败" });
            return;
        }
        setCacheFeedback(`已清理 ${response.cleaned.length} 个声明目录、${response.fileCount} 个文件，预计释放 ${formatBytes(response.totalBytes)}。`);
        setCachePreview(undefined);
        await onUpdated();
    };

    const portPayload = (edit : PortEditState) : DockerPortUpdatePayload => ({
        containerId: container.id,
        containerPort: edit.port.containerPort,
        protocol: edit.port.protocol,
        hostPort: edit.hostPort.trim(),
        currentHostPort: edit.port.hostPort,
        hostIp: edit.port.hostIp,
    });

    const preflightPort = async () => {
        if (!portEdit) {
            return;
        }
        setPortBusy("preflight");
        setPortFeedback("");
        setPortFailure(undefined);
        const response = await preflightHostPort(portPayload(portEdit));
        setPortBusy("");
        if (!response.ok) {
            setPortFailure({ action: "端口预检",
                message: response.msg || "端口预检失败" });
            return;
        }
        setPortEdit({ ...portEdit,
            preflight: response });
    };

    const applyPort = async () => {
        if (!portEdit?.preflight) {
            return;
        }
        setPortBusy("apply");
        setPortFailure(undefined);
        const response = await updateHostPort(portPayload(portEdit));
        setPortBusy("");
        if (!response.ok) {
            setPortFailure({ action: "修改端口",
                message: response.msg || "端口修改失败",
                rollback: response.rollback });
            return;
        }
        setLastRollback(response.rollback);
        setPortFeedback(`宿主机端口已修改为 ${portEdit.hostPort}，容器已重建。`);
        setPortEdit(undefined);
        await onUpdated();
    };

    const rollbackPort = async (rollback = lastRollback) => {
        if (!rollback) {
            return;
        }
        setPortBusy("rollback");
        const response = await rollbackHostPort(rollback);
        setPortBusy("");
        if (!response.ok) {
            setPortFailure({ action: "回滚端口",
                message: response.msg || "端口回滚失败",
                rollback });
            return;
        }
        setPortFailure(undefined);
        setLastRollback(undefined);
        setPortFeedback("端口配置已从 DockerBridge 备份恢复。");
        await onUpdated();
    };

    return (
        <dialog
            aria-labelledby="container-detail-title"
            className={detailStyles.dialog}
            onCancel={event => {
                event.preventDefault();
                onClose();
            }}
            onClick={event => {
                if (event.target === event.currentTarget) {
                    onClose();
                }
            }}
            ref={dialogRef}
        >
            <div className={detailStyles.content}>
                <header className={detailStyles.header}>
                    <div><span className={detailStyles.eyebrow}>{container.shortId}</span><h2 id="container-detail-title">{container.name}</h2><p>{container.image}</p></div>
                    <div className={detailStyles.headerStatus}><StatusBadge label={container.statusText || container.status} status={container.status} /><button aria-label="关闭详情" className={detailStyles.closeButton} onClick={onClose} type="button"><Icon name="close" /></button></div>
                </header>
                <div className={detailStyles.tabs}>
                    <Button aria-pressed={section === "overview"} size="compact" variant={section === "overview" ? "primary" : "ghost"} onClick={() => setSection("overview")}>运行详情</Button>
                    <Button aria-pressed={section === "logs"} size="compact" variant={section === "logs" ? "primary" : "ghost"} onClick={() => setSection("logs")}>最近日志</Button>
                    <Button aria-pressed={section === "cache"} disabled={!canDestructive} size="compact" title={!canDestructive ? "仅管理员可清理缓存" : undefined} variant={section === "cache" ? "primary" : "ghost"} onClick={() => setSection("cache")}>缓存清理 {container.cacheDirs.length > 0 ? container.cacheDirs.length : ""}</Button>
                </div>
                {section === "overview" ? <div className={detailStyles.body}>
                    <dl className={detailStyles.facts}>
                        <div><dt>运行身份</dt><dd>{container.runAs}</dd></div><div><dt>工作目录</dt><dd>{container.workingDir}</dd></div><div><dt>重启策略</dt><dd>{container.restartPolicy}</dd></div><div><dt>网络模式</dt><dd>{container.networkMode}</dd></div>
                        <div><dt>健康状态</dt><dd>{container.health}</dd></div><div><dt>退出码</dt><dd>{container.exitCode ?? "—"}</dd></div><div><dt>创建时间</dt><dd>{formatDate(container.createdAt)}</dd></div><div><dt>启动时间</dt><dd>{formatDate(container.startedAt)}</dd></div>
                    </dl>
                    <div className={detailStyles.resourceStrip}><div><span>CPU</span><strong>{container.cpuPercent}</strong></div><div><span>内存</span><strong>{container.memoryUsage}</strong></div><div><span>网络 I/O</span><strong>{container.networkIO}</strong></div><div><span>磁盘 I/O</span><strong>{container.blockIO}</strong></div></div>
                    <section className={detailStyles.command}><h3>启动命令</h3><pre>{[ ...container.entrypoint, ...container.command ].join(" ") || "镜像默认命令"}</pre></section>
                    <div className={detailStyles.detailGrid}>
                        <section><h3>端口</h3>{portFeedback && <Notice className={detailStyles.inlineNotice}>{portFeedback}{lastRollback && <Button className={detailStyles.noticeAction} loading={portBusy === "rollback"} size="compact" onClick={() => void rollbackPort()}>撤销修改</Button>}</Notice>}{container.ports.length === 0 ? <p className={detailStyles.emptyCopy}>没有声明端口。</p> : <table><thead><tr><th>容器</th><th>宿主机</th><th aria-label="操作" /></tr></thead><tbody>{container.ports.map(port => {
                            const key = `${port.containerPort}-${port.protocol}-${port.hostIp}-${port.hostPort}`;
                            const editing = portEdit?.port === port;
                            return <tr key={key}><td>{port.containerPort}/{port.protocol}</td><td>{editing ? <input aria-label={`宿主机端口 ${port.containerPort}`} className={detailStyles.portInput} inputMode="numeric" max="65535" min="1" onChange={event => setPortEdit({ ...portEdit,
                                hostPort: event.target.value,
                                preflight: undefined })} value={portEdit.hostPort} /> : port.published ? `${port.hostIp || "0.0.0.0"}:${port.hostPort}` : "未发布"}</td><td>{port.published && (editing ? <Button disabled={Boolean(portBusy)} size="compact" variant="ghost" onClick={() => setPortEdit(undefined)}>取消</Button> : <Button disabled={Boolean(portBusy) || !canDestructive} size="compact" variant="ghost" onClick={() => {
                                setPortFeedback("");
                                setPortEdit({ port,
                                    hostPort: port.hostPort });
                            }} title={!canDestructive ? "仅管理员可修改端口" : undefined}>修改</Button>)}</td></tr>;
                        })}</tbody></table>}{portEdit && <div className={detailStyles.portEditor}><div><strong>{portEdit.port.hostIp || "0.0.0.0"}:{portEdit.hostPort || "—"}</strong><span>{portEdit.preflight ? `${portEdit.preflight.target} 可使用该端口；应用会重建容器${portEdit.preflight.cacheCleanup.eligibleCount > 0 ? `，并清理 ${portEdit.preflight.cacheCleanup.eligibleCount} 个声明缓存目录（预计 ${formatBytes(portEdit.preflight.cacheCleanup.totalBytes)}）` : ""}，现有连接将短暂中断。` : "先执行冲突预检，不会修改当前容器。"}</span></div>{portEdit.preflight ? <Button loading={portBusy === "apply"} size="compact" variant="primary" onClick={() => void applyPort()}>确认重建并应用</Button> : <Button disabled={!portEdit.hostPort.trim()} loading={portBusy === "preflight"} size="compact" onClick={() => void preflightPort()}>检查端口</Button>}</div>}</section>
                        <section><h3>网络</h3>{container.networks.length === 0 ? <p className={detailStyles.emptyCopy}>没有加入网络。</p> : <table><thead><tr><th>名称</th><th>地址</th></tr></thead><tbody>{container.networks.map(network => <tr key={network.name}><td><Button size="compact" variant="ghost" onClick={() => navigate(`/resources?tab=networks&resource=${encodeURIComponent(network.name)}&endpoint=local`)}>{network.name}</Button></td><td>{network.ipAddress || "—"}</td></tr>)}</tbody></table>}</section>
                    </div>
                    <section className={detailStyles.mounts}><h3>挂载</h3>{container.mounts.length === 0 ? <p className={detailStyles.emptyCopy}>没有挂载卷或目录。</p> : <table><thead><tr><th>类型</th><th>来源</th><th>容器路径</th><th>缓存声明</th></tr></thead><tbody>{container.mounts.map((mount, index) => <tr key={`${mount.destination}-${index}`}><td>{mount.type}</td><td title={mount.source}>{mount.type === "volume" && mount.name ? <Button size="compact" variant="ghost" onClick={() => navigate(`/resources?tab=volumes&resource=${encodeURIComponent(mount.name)}&endpoint=local`)}>{mount.name}</Button> : mount.name || mount.source || "—"}</td><td>{mount.destination}</td><td>{mount.cache ? <StatusBadge label="可清理缓存" status="created" /> : "—"}</td></tr>)}</tbody></table>}</section>
                </div> : section === "logs" ? <div className={detailStyles.logsBody}>
                    <div className={detailStyles.logToolbar}><label>最近<select onChange={event => setTail(Number(event.target.value))} value={tail}><option value={100}>100 行</option><option value={300}>300 行</option><option value={1000}>1000 行</option><option value={5000}>5000 行</option></select></label><Button loading={loadingLogs} size="compact" onClick={() => void refreshLogs()}><Icon name="refresh" size={14} />刷新日志</Button></div>
                    {logError && <Notice tone="error">{logError}</Notice>}
                    <pre className={detailStyles.logOutput}>{loadingLogs && !logs ? "正在读取日志…" : logs || "当前没有日志输出。"}</pre>
                </div> : <div className={detailStyles.cacheBody}>
                    {container.cacheDirs.length === 0 ? <EmptyState description="只有通过 Compose x-dockerbridge.cacheDirs 或容器标签 dockerbridge.cacheDirs 显式声明的 bind mount 才能清理。" title="没有声明缓存目录" /> : <>
                        <div className={detailStyles.cacheToolbar}><div><strong>显式声明的缓存目录</strong><span>先解析 bind mount、检查路径边界并估算文件，再允许删除。</span></div><Button loading={cacheBusy === "preview"} onClick={() => void previewCache()}><Icon name="refresh" size={14} />生成预览</Button></div>
                        {cacheFeedback && <Notice>{cacheFeedback}</Notice>}
                        {!cachePreview ? <div className={detailStyles.cacheDeclarations}>{container.cacheDirs.map(cacheDir => <code key={cacheDir}>{cacheDir}</code>)}</div> : <>
                            <div className={detailStyles.cacheSummary}><span>可清理 <strong>{cachePreview.eligibleCount}</strong> 个目录</span><span>预计 <strong>{formatBytes(cachePreview.totalBytes)}</strong></span><span>预览于 <strong>{new Date(cachePreview.generatedAt).toLocaleTimeString()}</strong></span><Button disabled={cachePreview.eligibleCount === 0} loading={cacheBusy === "clean"} variant="danger" onClick={() => void applyCacheCleanup()}>确认清理</Button></div>
                            <div className={detailStyles.cacheTableScroller}><table className={detailStyles.cacheTable}><thead><tr><th>容器目录</th><th>宿主机绑定源</th><th>估算</th><th>结果</th></tr></thead><tbody>{cachePreview.entries.map(entry => <tr key={entry.cacheDir}><td><code>{entry.cacheDir}</code></td><td><code>{entry.source || "—"}</code></td><td>{entry.eligible ? `${formatBytes(entry.estimatedBytes)} · ${entry.fileCount} 文件${entry.truncated ? "+" : ""}` : "—"}</td><td>{entry.eligible ? <StatusBadge label={entry.truncated ? "可清理，估算已截断" : "可清理"} status="running" /> : <span className={detailStyles.skipReason}>{entry.reason || "已跳过"}</span>}</td></tr>)}</tbody></table></div>
                        </>}
                    </>}
                </div>}
                <footer className={detailStyles.actions}><Button autoFocus variant="primary" onClick={onClose}>关闭</Button></footer>
            </div>
            {portFailure && <FailureDialog actionLabel={portFailure.rollback ? "从备份回滚" : undefined} actionLoading={portBusy === "rollback"} description="端口配置操作未完成，DockerBridge 保留了后端返回的原始错误。" details={[{ label: "容器",
                value: container.name }, { label: "操作",
                value: portFailure.action }]} message={portFailure.message} onAction={portFailure.rollback ? () => void rollbackPort(portFailure.rollback) : undefined} onClose={() => setPortFailure(undefined)} open title={`${portFailure.action}失败`} />}
            {cacheFailure && <FailureDialog description="缓存目录未删除；DockerBridge 保留了路径校验或文件系统返回的原始错误。" details={[{ label: "容器",
                value: container.name }, { label: "操作",
                value: cacheFailure.action }]} message={cacheFailure.message} onClose={() => setCacheFailure(undefined)} open title={`${cacheFailure.action}失败`} />}
        </dialog>
    );
}

export function ContainersPage() {
    const { snapshot, loadingSnapshot, snapshotError } = useAppSelector(state => state.runtime);
    const permissions = useAppSelector(state => state.session.permissions);
    const canOperate = permissions.includes("operate");
    const canDestructive = permissions.includes("destructive");
    const [ searchParams ] = useSearchParams();
    const [ tab, setTab ] = useState<"containers" | "images">("containers");
    const [ search, setSearch ] = useState("");
    const [ pending, setPending ] = useState("");
    const [ feedback, setFeedback ] = useState("");
    const [ failure, setFailure ] = useState<ActionFailure>();
    const [ selectedContainerName, setSelectedContainerName ] = useState("");
    const [ deepLinkNotice, setDeepLinkNotice ] = useState<{ message: string; tone: "default" | "error" }>();
    const [ imageRef, setImageRef ] = useState("");
    const [ pullingImage, setPullingImage ] = useState("");
    const [ pullProgress, setPullProgress ] = useState<string[]>([]);
    const [ tagEdit, setTagEdit ] = useState<{ source: string; target: string }>();
    const [ tagging, setTagging ] = useState(false);
    const [ pruneMode, setPruneMode ] = useState<"dangling" | "all-unused">("dangling");
    const [ prunePreview, setPrunePreview ] = useState<ImagePrunePreviewResponse>();
    const [ pruneBusy, setPruneBusy ] = useState<"preview" | "delete" | "">("");
    const [ imageFailure, setImageFailure ] = useState<ImageFailure>();
    const handledDeepLink = useRef("");
    const activePull = useRef("");

    useEffect(() => {
        if (!snapshot) {
            void refreshSnapshot();
        }
    }, [ snapshot ]);

    useEffect(() => {
        if (!snapshot || loadingSnapshot) {
            return;
        }
        const containerTarget = searchParams.get("container")?.trim() || "";
        const imageTarget = searchParams.get("image")?.trim() || "";
        const requestedTab = searchParams.get("tab") === "images" ? "images" : containerTarget ? "containers" : "";
        const deepLinkKey = `${requestedTab}:${containerTarget}:${imageTarget}`;
        if (!deepLinkKey.replaceAll(":", "") || handledDeepLink.current === deepLinkKey) {
            return;
        }
        handledDeepLink.current = deepLinkKey;
        if (requestedTab === "images" || imageTarget) {
            setTab("images");
            if (!imageTarget) {
                return;
            }
            const image = snapshot.images.find(item => item.id === imageTarget || item.id.startsWith(imageTarget) || item.repoTags.includes(imageTarget) || `${item.repository}:${item.tag}` === imageTarget);
            if (!image) {
                setDeepLinkNotice({ message: `未找到审计记录指向的镜像 ${imageTarget}。镜像可能已被删除或本地状态尚未同步。`,
                    tone: "error" });
                return;
            }
            const label = image.repoTags[0] || `${image.repository}:${image.tag}`;
            setSearch(label);
            setDeepLinkNotice({ message: `已定位镜像 ${label}。`,
                tone: "default" });
            return;
        }
        if (containerTarget) {
            setTab("containers");
            const container = snapshot.containers.find(item => item.id === containerTarget || item.shortId === containerTarget || item.id.startsWith(containerTarget) || item.name === containerTarget);
            if (!container) {
                setDeepLinkNotice({ message: `未找到审计记录指向的容器 ${containerTarget}。容器可能已被重建、删除或本地状态尚未同步。`,
                    tone: "error" });
                return;
            }
            setSearch("");
            setSelectedContainerName(container.name);
            setDeepLinkNotice({ message: `已从操作审计定位到容器 ${container.name}。`,
                tone: "default" });
        }
    }, [ loadingSnapshot, searchParams, snapshot ]);

    useEffect(() => onImagePullProgress(progress => {
        if (!activePull.current || progress.imageRef !== activePull.current) {
            return;
        }
        const lines = progress.message.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        setPullProgress(current => [ ...current, ...lines ].slice(-120));
    }), []);

    const containers = useMemo(() => (snapshot?.containers || []).filter(container => [ container.name, container.image, container.stack, container.service ].join(" ").toLocaleLowerCase().includes(search.toLocaleLowerCase())), [ snapshot, search ]);
    const images = useMemo(() => (snapshot?.images || []).filter(image => [ image.id, image.repository, image.tag, ...image.repoTags ].join(" ").toLocaleLowerCase().includes(search.toLocaleLowerCase())), [ snapshot, search ]);
    const selectedContainer = snapshot?.containers.find(container => container.name === selectedContainerName);

    const actOnContainer = async (containerId : string, name : string, action : ContainerAction) => {
        if (action === "stop" && !window.confirm(`确认停止容器 ${name}？`)) {
            return;
        }
        if (action === "recreate") {
            const preview = await previewContainerCache(containerId);
            if (!preview.ok) {
                setFailure({ name,
                    action: "重建预览",
                    message: preview.msg || "无法检查重建前的缓存清理范围" });
                return;
            }
            const skipped = preview.entries.length - preview.eligibleCount;
            const impact = preview.eligibleCount > 0
                ? `重建前将清理 ${preview.eligibleCount} 个声明缓存目录，预计 ${formatBytes(preview.totalBytes)}${skipped > 0 ? `；另有 ${skipped} 个目录因安全校验跳过` : ""}。`
                : "没有符合安全规则的声明缓存目录会被清理。";
            if (!window.confirm(`确认重建容器 ${name}？${impact}`)) {
                return;
            }
        }
        setFailure(undefined);
        setPending(`${containerId}:${action}`);
        try {
            const response = await containerAction(containerId, action);
            const message = response.ok ? `${name} 操作完成` : response.msg || "操作失败";
            setFeedback(message);
            if (!response.ok) {
                setFailure({ name,
                    action,
                    message });
                return;
            }
            await refreshSnapshot();
        } catch (error) {
            const message = error instanceof Error ? error.message : "操作失败";
            setFeedback(message);
            setFailure({ name,
                action,
                message });
        } finally {
            setPending("");
        }
    };

    const deleteImage = async (id : string, label : string) => {
        if (!window.confirm(`删除镜像 ${label}？正在使用的镜像不会被删除。`)) {
            return;
        }
        setPending(id);
        const response = await imageAction("delete", id);
        setFeedback(response.ok ? `${label} 已删除` : response.msg || "删除失败");
        setPending("");
        if (!response.ok) {
            setImageFailure({ target: label,
                action: "删除镜像",
                message: response.msg || "删除失败" });
            return;
        }
        await refreshSnapshot();
    };

    const pullImage = async (event : FormEvent) => {
        event.preventDefault();
        const reference = imageRef.trim();
        if (!reference) {
            return;
        }
        setImageFailure(undefined);
        setFeedback("");
        setPullProgress([]);
        setPullingImage(reference);
        activePull.current = reference;
        const response = await imageAction("pull", reference);
        setPullingImage("");
        activePull.current = "";
        if (!response.ok) {
            setImageFailure({ target: reference,
                action: "拉取镜像",
                message: response.msg || "镜像拉取失败" });
            return;
        }
        setFeedback(`${reference} 拉取完成`);
        setImageRef("");
        await refreshSnapshot();
    };

    const saveTag = async (event : FormEvent) => {
        event.preventDefault();
        if (!tagEdit?.target.trim()) {
            return;
        }
        setTagging(true);
        setImageFailure(undefined);
        const response = await tagImage(tagEdit.source, tagEdit.target.trim());
        setTagging(false);
        if (!response.ok) {
            setImageFailure({ target: tagEdit.target,
                action: "添加镜像标签",
                message: response.msg || "镜像标签创建失败" });
            return;
        }
        setFeedback(`已创建标签 ${tagEdit.target.trim()}`);
        setTagEdit(undefined);
        await refreshSnapshot();
    };

    const previewPrune = async () => {
        setPruneBusy("preview");
        setImageFailure(undefined);
        const response = await previewImagePrune(pruneMode === "all-unused");
        setPruneBusy("");
        if (!response.ok) {
            setImageFailure({ target: pruneMode === "all-unused" ? "全部未使用镜像" : "悬空镜像",
                action: "预览镜像清理",
                message: response.msg || "镜像清理预览失败" });
            return;
        }
        setPrunePreview(response);
    };

    const applyPrune = async () => {
        if (!prunePreview || prunePreview.candidates.length === 0 || !window.confirm(`确认删除预览中的 ${prunePreview.candidates.length} 个镜像？执行前会再次校验候选集合。`)) {
            return;
        }
        setPruneBusy("delete");
        setImageFailure(undefined);
        const response = await pruneImages(prunePreview.allUnused, prunePreview.candidates.map(image => image.id));
        setPruneBusy("");
        if (!response.ok) {
            setImageFailure({ target: prunePreview.allUnused ? "全部未使用镜像" : "悬空镜像",
                action: "清理镜像",
                message: response.msg || "镜像清理失败" });
            return;
        }
        setFeedback(`已删除 ${response.deleted} 个镜像，预计释放 ${formatBytes(response.totalBytes)}。`);
        setPrunePreview(undefined);
        await refreshSnapshot();
    };

    const openDependentContainer = (name : string) => {
        const container = snapshot?.containers.find(item => item.name === name);
        setTab("containers");
        setSearch("");
        if (container) {
            setSelectedContainerName(container.name);
            return;
        }
        setDeepLinkNotice({ message: `依赖容器 ${name} 已不在当前快照中，请刷新后重试。`,
            tone: "error" });
    };

    return (
        <div className={styles.page}>
            <PageHeader
                actions={<Button loading={loadingSnapshot} onClick={() => void refreshSnapshot()}><Icon name="refresh" size={16} />刷新</Button>}
                description="搜索、检查并执行常用生命周期操作。"
                title="Docker 资源"
            />
            {(snapshotError || feedback) && <Notice tone={snapshotError ? "error" : "default"}>{snapshotError || feedback}</Notice>}
            {deepLinkNotice && <Notice tone={deepLinkNotice.tone}>{deepLinkNotice.message}</Notice>}
            {!canOperate && <Notice tone="warning">当前账户为只读角色，可以查看详情、日志和依赖关系，但不能发送容器或镜像操作。</Notice>}
            <Toolbar>
                <SegmentedControl aria-label="资源类型">
                    <Button aria-pressed={tab === "containers"} size="compact" variant={tab === "containers" ? "primary" : "ghost"} onClick={() => setTab("containers")}><Icon name="box" size={15} />容器 {snapshot?.summary.containerTotal || 0}</Button>
                    <Button aria-pressed={tab === "images"} size="compact" variant={tab === "images" ? "primary" : "ghost"} onClick={() => setTab("images")}><Icon name="image" size={15} />镜像 {snapshot?.summary.imageTotal || 0}</Button>
                </SegmentedControl>
                <SearchField label="搜索资源" onChange={event => setSearch(event.target.value)} placeholder="搜索名称、镜像或项目" value={search} />
            </Toolbar>
            {tab === "images" && <Panel className={resourceStyles.imageWorkbench} flush>
                <div className={resourceStyles.imageTools}>
                    <form className={resourceStyles.pullForm} onSubmit={pullImage}><div><strong>拉取镜像</strong><span>实时显示 Docker 层进度，完成后自动刷新镜像清单。</span></div><input aria-label="镜像名称" disabled={Boolean(pullingImage) || !canOperate} onChange={event => setImageRef(event.target.value)} placeholder="registry.example.com/team/image:tag" value={imageRef} /><Button disabled={!imageRef.trim() || !canOperate} loading={Boolean(pullingImage)} title={!canOperate ? "只读账户不能拉取镜像" : undefined} variant="primary" type="submit"><Icon name="download" size={15} />拉取</Button></form>
                    <div className={resourceStyles.pruneControls}><div><strong>安全清理</strong><span>先生成精确候选清单，再二次校验并删除。</span></div><select aria-label="镜像清理范围" disabled={Boolean(pruneBusy) || !canDestructive} onChange={event => {
                        setPruneMode(event.target.value as "dangling" | "all-unused");
                        setPrunePreview(undefined);
                    }} value={pruneMode}><option value="dangling">仅悬空镜像</option><option value="all-unused">全部未使用镜像</option></select><Button disabled={!canDestructive} loading={pruneBusy === "preview"} title={!canDestructive ? "仅管理员可清理镜像" : undefined} onClick={() => void previewPrune()}>生成预览</Button></div>
                </div>
                {pullProgress.length > 0 && <section className={resourceStyles.progress}><header><strong>{pullingImage ? `正在拉取 ${pullingImage}` : "最近一次拉取输出"}</strong><span>{pullProgress.length} 条状态</span></header><pre>{pullProgress.join("\n")}</pre></section>}
                {tagEdit && <form className={resourceStyles.tagEditor} onSubmit={saveTag}><div><strong>为镜像添加标签</strong><span className={styles.mono}>{tagEdit.source}</span></div><input aria-label="新镜像标签" autoFocus disabled={tagging} onChange={event => setTagEdit({ ...tagEdit,
                    target: event.target.value })} placeholder="repository/image:new-tag" value={tagEdit.target} /><Button disabled={!tagEdit.target.trim()} loading={tagging} variant="primary" type="submit">保存标签</Button><Button disabled={tagging} variant="ghost" onClick={() => setTagEdit(undefined)} type="button">取消</Button></form>}
                {prunePreview && <section className={resourceStyles.prunePreview}><header><div><strong>{prunePreview.candidates.length === 0 ? "没有可清理镜像" : `将删除 ${prunePreview.candidates.length} 个镜像`}</strong><span>预计释放 {formatBytes(prunePreview.totalBytes)} · 预览于 {new Date(prunePreview.generatedAt).toLocaleTimeString()}</span></div><Button disabled={prunePreview.candidates.length === 0} loading={pruneBusy === "delete"} variant="danger" onClick={() => void applyPrune()}>确认清理</Button></header>{prunePreview.candidates.length > 0 && <ul>{prunePreview.candidates.slice(0, 12).map(image => <li key={image.id}><code>{image.id}</code><span>{image.repoTags.join(", ") || "悬空镜像"}</span><small>{image.size || formatBytes(image.sizeBytes)}</small></li>)}</ul>}{prunePreview.candidates.length > 12 && <p>另有 {prunePreview.candidates.length - 12} 个候选镜像未展开显示。</p>}</section>}
            </Panel>}
            <Panel>
                {tab === "containers" ? (
                    containers.length === 0 ? <EmptyState title="没有匹配的容器" description={search ? "调整搜索条件，或清空搜索查看全部容器。" : "Docker 当前没有可管理的容器。"} /> : <div className={styles.tableScroller}><table className={styles.table}><thead><tr><th>容器</th><th>状态</th><th className={styles.mobileOptional}>资源</th><th className={styles.mobileOptional}>端口</th><th className={styles.mobileOptional}>项目</th><th aria-label="操作" /></tr></thead><tbody>{containers.map(container => <tr key={container.id}><td><div className={styles.primaryCell}><strong>{container.name}</strong><small>{container.image}</small></div></td><td><StatusBadge status={container.status} label={container.statusText || container.status} /></td><td className={styles.mobileOptional}><div className={styles.primaryCell}><span className={styles.mono}>CPU {container.cpuPercent || "—"}</span><small>{container.memoryUsage || "无采样"}</small></div></td><td className={`${styles.mono} ${styles.mobileOptional}`}>{container.ports.filter(port => port.published).map(port => port.hostPort).join(", ") || "—"}</td><td className={styles.mobileOptional}>{container.stack || "独立容器"}</td><td><div className={styles.rowActions}><Button size="compact" variant="ghost" onClick={() => setSelectedContainerName(container.name)}>详情</Button>{container.status === "running" ? <Button disabled={!canOperate || pending.startsWith(container.id)} loading={pending === `${container.id}:stop`} size="compact" onClick={() => void actOnContainer(container.id, container.name, "stop")} title={!canOperate ? "只读账户不能停止容器" : undefined}><Icon name="stop" size={14} />停止</Button> : <Button disabled={!canOperate || pending.startsWith(container.id)} loading={pending === `${container.id}:start`} size="compact" onClick={() => void actOnContainer(container.id, container.name, "start")} title={!canOperate ? "只读账户不能启动容器" : undefined}><Icon name="play" size={14} />启动</Button>}<Button disabled={!canOperate || pending.startsWith(container.id)} loading={pending === `${container.id}:restart`} size="compact" onClick={() => void actOnContainer(container.id, container.name, "restart")} title={!canOperate ? "只读账户不能重启容器" : undefined}><Icon name="restart" size={14} />重启</Button></div></td></tr>)}</tbody></table></div>
                ) : (
                    images.length === 0 ? <EmptyState title="没有匹配的镜像" description={search ? "调整搜索条件，或清空搜索查看全部镜像。" : "本机暂时没有镜像，可在上方输入镜像引用直接拉取。"} /> : <div className={styles.tableScroller}><table className={styles.table}><thead><tr><th>镜像</th><th>大小</th><th className={styles.mobileOptional}>端口</th><th className={styles.mobileOptional}>使用方</th><th className={styles.mobileOptional}>创建时间</th><th aria-label="操作" /></tr></thead><tbody>{images.map(image => {
                        const label = image.repoTags[0] || image.id;
                        return <tr key={`${image.id}-${label}`}><td><div className={styles.primaryCell}><strong>{label}</strong><small className={styles.mono}>{image.id.slice(0, 19)}{image.dangling ? " · 悬空" : ""}</small></div></td><td className={styles.mono}>{image.size}</td><td className={`${styles.mono} ${styles.mobileOptional}`}>{image.exposedPorts.join(", ") || "—"}</td><td className={styles.mobileOptional}>{image.usedBy.length > 0 ? <div className={resourceStyles.usageList}>{image.usedBy.slice(0, 2).map(name => <button key={name} onClick={() => openDependentContainer(name)} type="button">{name}</button>)}{image.usedBy.length > 2 && <span>+{image.usedBy.length - 2}</span>}</div> : <span className={styles.muted}>未使用</span>}</td><td className={styles.mobileOptional}>{image.createdAt ? new Date(image.createdAt).toLocaleDateString() : "—"}</td><td><div className={styles.rowActions}><Button disabled={!canOperate} size="compact" title={!canOperate ? "只读账户不能添加标签" : undefined} variant="ghost" onClick={() => setTagEdit({ source: label,
                            target: "" })}>添加标签</Button><Button disabled={pending === image.id || image.usedBy.length > 0 || !canDestructive} loading={pending === image.id} size="compact" title={!canDestructive ? "仅管理员可删除镜像" : image.usedBy.length > 0 ? `由 ${image.usedBy.join(", ")} 使用，不能删除` : "删除未使用镜像"} variant="danger" onClick={() => void deleteImage(image.id, label)}>删除</Button></div></td></tr>;
                    })}</tbody></table></div>
                )}
            </Panel>
            {selectedContainer && <ContainerDetailDialog container={selectedContainer} onClose={() => setSelectedContainerName("")} onUpdated={refreshSnapshot} />}
            {failure && <FailureDialog description="运行服务返回了错误，当前容器操作未完成。" details={[{ label: "容器",
                value: failure.name }, { label: "操作",
                value: failure.action }]} message={failure.message} onClose={() => setFailure(undefined)} open title="容器操作失败" />}
            {imageFailure && <FailureDialog description="Docker 返回了原始镜像操作错误，未静默忽略失败。" details={[{ label: "对象",
                value: imageFailure.target }, { label: "操作",
                value: imageFailure.action }]} message={imageFailure.message} onClose={() => setImageFailure(undefined)} open title={`${imageFailure.action}失败`} />}
        </div>
    );
}
