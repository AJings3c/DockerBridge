import { FormEvent, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/primitives/Button";
import { EmptyState } from "@/components/primitives/EmptyState";
import { StatusBadge } from "@/components/primitives/StatusBadge";
import { FailureDialog, MetricStrip, Notice, PageHeader, Panel, SearchField, SegmentedControl, Toolbar, useModalDialog } from "@/components/ui";
import { createDockerNetwork, createDockerVolume, disconnectDockerNetwork, previewDockerNetworkDisconnect, previewDockerResourceRemoval, queryDockerResources, removeDockerResource } from "@/services/runtime";
import { endpointFor, isEndpointOperational } from "@/services/endpoints";
import { useAppSelector } from "@/store/hooks";
import { DockerNetworkDisconnectPreview, DockerNetworkResource, DockerResourceDependency, DockerResourceInventory, DockerResourceRemovalPreview, DockerVolumeResource } from "@/types/domain";
import pageStyles from "./Page.module.css";
import styles from "./DockerResourcesPage.module.css";

type ResourceTab = "networks" | "volumes";
type DockerResource = DockerNetworkResource | DockerVolumeResource;

interface ResourceFailure {
    action: string;
    target: string;
    message: string;
}

function formatBytes(value : number | null) {
    if (value === null) {
        return "未采样";
    }
    const units = [ "B", "KiB", "MiB", "GiB", "TiB" ];
    let size = value;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
        size /= 1024;
        unit += 1;
    }
    return `${unit === 0 ? size : size.toFixed(1)} ${units[unit]}`;
}

function dependencyLabel(dependency : DockerResourceDependency) {
    return dependency.composeProject ? `${dependency.composeProject}/${dependency.composeService || dependency.name}` : dependency.name;
}

function ConfirmOperationDialog({ title, description, target, confirmationLabel, blockers, warnings, busy, onClose, onConfirm } : { title: string; description: string; target: string; confirmationLabel: string; blockers: string[]; warnings: string[]; busy: boolean; onClose: () => void; onConfirm: (confirmation: string) => void }) {
    const dialogRef = useModalDialog();
    const [ confirmation, setConfirmation ] = useState("");

    return <dialog aria-labelledby="resource-confirm-title" className={styles.confirmDialog} onCancel={event => {
        event.preventDefault();
        onClose();
    }} ref={dialogRef}><div className={styles.confirmContent}><header><span><Icon name={blockers.length > 0 ? "alert" : "delete"} size={20} /></span><div><h2 id="resource-confirm-title">{title}</h2><p>{description}</p></div></header><dl><div><dt>目标</dt><dd>{target}</dd></div><div><dt>预检</dt><dd>{blockers.length > 0 ? `${blockers.length} 个阻断项` : "允许执行"}</dd></div></dl>{blockers.length > 0 && <section className={styles.blockers}><strong>阻断项</strong>{blockers.map(blocker => <p key={blocker}>{blocker}</p>)}</section>}{warnings.length > 0 && <section className={styles.warnings}><strong>影响提示</strong>{warnings.map(warning => <p key={warning}>{warning}</p>)}</section>}<label className={styles.confirmInput}><span>输入 <code>{confirmationLabel}</code> 确认</span><input autoFocus autoComplete="off" disabled={busy || blockers.length > 0} onChange={event => setConfirmation(event.target.value)} value={confirmation} /></label><footer><Button disabled={busy} onClick={onClose}>取消</Button><Button disabled={blockers.length > 0 || confirmation !== confirmationLabel} loading={busy} variant="danger" onClick={() => onConfirm(confirmation)}>确认执行</Button></footer></div></dialog>;
}

function CreateResourceDialog({ tab, endpoint, onClose, onCreated, onFailure } : { tab: ResourceTab; endpoint: string; onClose: () => void; onCreated: (message: string) => void; onFailure: (failure: ResourceFailure) => void }) {
    const dialogRef = useModalDialog();
    const [ busy, setBusy ] = useState(false);
    const [ network, setNetwork ] = useState({ name: "",
        driver: "bridge",
        internal: false,
        attachable: false,
        ipv6: false,
        subnet: "",
        gateway: "",
        parent: "" });
    const [ volume, setVolume ] = useState({ name: "",
        driver: "local" });

    const submit = async (event : FormEvent) => {
        event.preventDefault();
        setBusy(true);
        const response = tab === "networks"
            ? await createDockerNetwork(endpoint, network)
            : await createDockerVolume(endpoint, volume.name, volume.driver);
        setBusy(false);
        if (!response.ok) {
            onFailure({ action: tab === "networks" ? "创建 Docker 网络" : "创建 Docker 卷",
                target: tab === "networks" ? network.name : volume.name,
                message: response.msg || "Docker 资源创建失败" });
            return;
        }
        onCreated(response.msg || "Docker 资源已创建");
    };

    return <dialog aria-labelledby="resource-create-title" className={styles.createDialog} onCancel={event => {
        event.preventDefault();
        onClose();
    }} ref={dialogRef}><form onSubmit={submit}><header><div><span>{tab === "networks" ? "NETWORK" : "VOLUME"}</span><h2 id="resource-create-title">{tab === "networks" ? "创建 Docker 网络" : "创建 Docker 卷"}</h2></div><button aria-label="关闭" onClick={onClose} type="button"><Icon name="close" /></button></header>{tab === "networks" ? <fieldset disabled={busy}><label><span>名称</span><input autoFocus onChange={event => setNetwork(current => ({ ...current,
            name: event.target.value }))} placeholder="application-net" value={network.name} /></label><label><span>驱动</span><select onChange={event => setNetwork(current => ({ ...current,
            driver: event.target.value }))} value={network.driver}><option value="bridge">bridge</option><option value="overlay">overlay</option><option value="macvlan">macvlan</option><option value="ipvlan">ipvlan</option></select></label><label><span>子网 CIDR</span><input onChange={event => setNetwork(current => ({ ...current,
            subnet: event.target.value }))} placeholder="172.30.0.0/16" value={network.subnet} /></label><label><span>网关</span><input onChange={event => setNetwork(current => ({ ...current,
            gateway: event.target.value }))} placeholder="172.30.0.1" value={network.gateway} /></label>{[ "macvlan", "ipvlan" ].includes(network.driver) && <label><span>父接口</span><input onChange={event => setNetwork(current => ({ ...current,
            parent: event.target.value }))} placeholder="eth0" value={network.parent} /></label>}<label className={styles.toggle}><input checked={network.internal} onChange={event => setNetwork(current => ({ ...current,
            internal: event.target.checked }))} type="checkbox" /><span>内部网络</span></label><label className={styles.toggle}><input checked={network.attachable} onChange={event => setNetwork(current => ({ ...current,
            attachable: event.target.checked }))} type="checkbox" /><span>允许手动连接</span></label><label className={styles.toggle}><input checked={network.ipv6} onChange={event => setNetwork(current => ({ ...current,
            ipv6: event.target.checked }))} type="checkbox" /><span>启用 IPv6</span></label></fieldset> : <fieldset disabled={busy}><label><span>名称</span><input autoFocus onChange={event => setVolume(current => ({ ...current,
            name: event.target.value }))} placeholder="application-data" value={volume.name} /></label><label><span>驱动</span><input onChange={event => setVolume(current => ({ ...current,
            driver: event.target.value }))} value={volume.driver} /></label></fieldset>}<footer><Button disabled={busy} type="button" onClick={onClose}>取消</Button><Button disabled={tab === "networks" ? !network.name.trim() : !volume.name.trim()} loading={busy} variant="primary" type="submit"><Icon name="plus" size={15} />创建</Button></footer></form></dialog>;
}

function ResourceDetailDialog({ resource, canManage, onClose, onRemove, onDisconnect } : { resource: DockerResource; canManage: boolean; onClose: () => void; onRemove: () => void; onDisconnect: (dependency: DockerResourceDependency) => void }) {
    const dialogRef = useModalDialog();
    const navigate = useNavigate();

    return <dialog aria-labelledby="resource-detail-title" className={styles.detailDialog} onCancel={event => {
        event.preventDefault();
        onClose();
    }} onClick={event => {
        if (event.target === event.currentTarget) {
            onClose();
        }
    }} ref={dialogRef}><div className={styles.detailContent}><header><div><span>{resource.kind === "network" ? "DOCKER NETWORK" : "DOCKER VOLUME"}</span><h2 id="resource-detail-title">{resource.name}</h2><p>{resource.composeProject || "Docker 独立资源"}</p></div><button aria-label="关闭详情" onClick={onClose} type="button"><Icon name="close" /></button></header><dl className={styles.facts}><div><dt>驱动</dt><dd>{resource.driver}</dd></div><div><dt>作用域</dt><dd>{resource.scope}</dd></div><div><dt>依赖容器</dt><dd>{resource.dependencies.length}</dd></div><div><dt>状态</dt><dd>{resource.orphaned ? "孤立" : resource.kind === "network" && resource.builtin ? "内置" : "使用中"}</dd></div></dl>{resource.kind === "network" && <section className={styles.addresses}><h3>地址配置</h3>{resource.subnets.length === 0 ? <p>Docker 未返回 IPAM 子网。</p> : <table><thead><tr><th>子网</th><th>网关</th><th>地址池</th></tr></thead><tbody>{resource.subnets.map((subnet, index) => <tr key={`${subnet.subnet}-${index}`}><td>{subnet.subnet || "—"}</td><td>{subnet.gateway || "—"}</td><td>{subnet.ipRange || "—"}</td></tr>)}</tbody></table>}<div className={styles.flags}>{resource.internal && <span>内部</span>}{resource.attachable && <span>可连接</span>}{resource.ipv6 && <span>IPv6</span>}{resource.ingress && <span>Ingress</span>}{resource.builtin && <span>Docker 内置</span>}</div></section>}{resource.kind === "volume" && <section className={styles.addresses}><h3>卷属性</h3><div className={styles.volumeFacts}><span>估算大小 <strong>{formatBytes(resource.sizeBytes)}</strong></span><span>引用计数 <strong>{resource.refCount}</strong></span><span>类型 <strong>{resource.anonymous ? "匿名卷" : "命名卷"}</strong></span><span>选项键 <strong>{resource.optionKeys.join(", ") || "无"}</strong></span></div></section>}<section className={styles.dependencies}><h3>容器依赖</h3>{resource.dependencies.length === 0 ? <p className={styles.emptyDependency}>当前没有容器引用此资源。</p> : <div className={styles.dependencyMap}>{resource.dependencies.map(dependency => <article key={dependency.id}><div className={styles.relation}><span>{resource.kind === "network" ? <Icon name="network" size={15} /> : <Icon name="volume" size={15} />}</span><i /><span><Icon name="box" size={15} /></span></div><div><strong>{dependencyLabel(dependency)}</strong><small>{resource.kind === "network" ? dependency.ipAddress || "无 IP 地址" : `${dependency.target || "未知路径"} · ${dependency.readWrite ? "读写" : "只读"}`}</small></div><StatusBadge label={dependency.state} status={dependency.running ? "running" : "exited"} /><div className={styles.dependencyActions}><Button size="compact" variant="ghost" onClick={() => navigate(`/containers?container=${encodeURIComponent(dependency.name)}`)}>容器详情</Button>{canManage && resource.kind === "network" && <Button size="compact" variant="danger" onClick={() => onDisconnect(dependency)}><Icon name="disconnect" size={13} />断开</Button>}</div></article>)}</div>}</section><footer><Button onClick={onClose}>关闭</Button>{canManage && <Button variant="danger" onClick={onRemove}><Icon name="delete" size={14} />删除预检</Button>}</footer></div></dialog>;
}

export function DockerResourcesPage() {
    const [ searchParams, setSearchParams ] = useSearchParams();
    const endpoints = useAppSelector(state => state.runtime.endpoints);
    const permissions = useAppSelector(state => state.session.permissions);
    const endpointList = Object.values(endpoints);
    const initialEndpoint = searchParams.get("endpoint") === "local" ? "" : searchParams.get("endpoint") || endpointList.find(endpoint => endpoint.status === "online")?.endpoint || "";
    const [ endpoint, setEndpoint ] = useState(initialEndpoint);
    const [ tab, setTab ] = useState<ResourceTab>(searchParams.get("tab") === "volumes" ? "volumes" : "networks");
    const [ search, setSearch ] = useState("");
    const [ orphanedOnly, setOrphanedOnly ] = useState(false);
    const [ inventory, setInventory ] = useState<DockerResourceInventory>();
    const [ loading, setLoading ] = useState(true);
    const [ feedback, setFeedback ] = useState("");
    const [ failure, setFailure ] = useState<ResourceFailure>();
    const [ selected, setSelected ] = useState<DockerResource>();
    const [ removalPreview, setRemovalPreview ] = useState<DockerResourceRemovalPreview>();
    const [ disconnectPreview, setDisconnectPreview ] = useState<DockerNetworkDisconnectPreview>();
    const [ confirmBusy, setConfirmBusy ] = useState(false);
    const [ createOpen, setCreateOpen ] = useState(false);
    const endpointSummary = endpointFor(endpoints, endpoint);
    const endpointOnline = isEndpointOperational(endpoints, endpoint);
    const canManage = permissions.includes("destructive");

    const load = async () => {
        setLoading(true);
        setFeedback("");
        const response = await queryDockerResources(endpoint);
        setLoading(false);
        if (!response.ok) {
            setFailure({ action: "读取 Docker 网络与卷",
                target: endpointSummary.name || endpoint || "本机",
                message: response.msg || "Docker 资源读取失败" });
            return;
        }
        setInventory(response.inventory);
        setSelected(current => current ? (current.kind === "network" ? response.inventory.networks : response.inventory.volumes).find(resource => resource.name === current?.name) : undefined);
    };

    useEffect(() => {
        if (endpointOnline) {
            void load();
        } else {
            setLoading(false);
        }
    }, [ endpoint, endpointOnline ]);

    useEffect(() => {
        const target = searchParams.get("resource") || "";
        if (!target || !inventory) {
            return;
        }
        const resource = tab === "networks" ? inventory.networks.find(item => item.name === target) : inventory.volumes.find(item => item.name === target);
        if (resource) {
            setSelected(resource);
        }
    }, [ inventory, searchParams, tab ]);

    const selectTab = (next : ResourceTab) => {
        setTab(next);
        setSelected(undefined);
        setRemovalPreview(undefined);
        setSearchParams(current => {
            current.set("tab", next);
            current.delete("resource");
            return current;
        });
    };

    const resources = useMemo(() => {
        const source : DockerResource[] = tab === "networks" ? inventory?.networks || [] : inventory?.volumes || [];
        const query = search.toLocaleLowerCase();
        return source.filter(resource => (!orphanedOnly || resource.orphaned) && [ resource.name, resource.driver, resource.scope, resource.composeProject, ...resource.dependencies.map(dependency => dependency.name) ].join(" ").toLocaleLowerCase().includes(query));
    }, [ inventory, orphanedOnly, search, tab ]);

    const previewRemoval = async (resource : DockerResource) => {
        setFeedback("");
        const response = await previewDockerResourceRemoval(endpoint, resource.kind, resource.name);
        if (!response.ok) {
            setFailure({ action: "生成资源删除预览",
                target: resource.name,
                message: response.msg || "删除预览失败" });
            return;
        }
        setRemovalPreview(response.preview);
    };

    const remove = async (confirmation : string) => {
        if (!removalPreview) {
            return;
        }
        setConfirmBusy(true);
        const response = await removeDockerResource(endpoint, removalPreview.kind, removalPreview.name, removalPreview.fingerprint, confirmation);
        setConfirmBusy(false);
        if (!response.ok) {
            setRemovalPreview(undefined);
            setFailure({ action: "删除 Docker 资源",
                target: removalPreview.name,
                message: response.msg || "Docker 资源删除失败" });
            return;
        }
        setRemovalPreview(undefined);
        setSelected(undefined);
        setFeedback(response.msg || "Docker 资源已删除");
        await load();
    };

    const previewDisconnect = async (resource : DockerNetworkResource, dependency : DockerResourceDependency) => {
        const response = await previewDockerNetworkDisconnect(endpoint, resource.name, dependency.id);
        if (!response.ok) {
            setFailure({ action: "生成网络断开预览",
                target: `${resource.name}/${dependency.name}`,
                message: response.msg || "网络断开预览失败" });
            return;
        }
        setDisconnectPreview(response.preview);
    };

    const disconnect = async (confirmation : string) => {
        if (!disconnectPreview) {
            return;
        }
        setConfirmBusy(true);
        const response = await disconnectDockerNetwork(endpoint, disconnectPreview.networkName, disconnectPreview.containerId, disconnectPreview.fingerprint, confirmation);
        setConfirmBusy(false);
        if (!response.ok) {
            setDisconnectPreview(undefined);
            setFailure({ action: "断开 Docker 网络",
                target: `${disconnectPreview.networkName}/${disconnectPreview.containerName}`,
                message: response.msg || "Docker 网络断开失败" });
            return;
        }
        setDisconnectPreview(undefined);
        setFeedback(response.msg || "容器网络连接已断开");
        await load();
    };

    const openResource = (resource : DockerResource) => {
        setSelected(resource);
        setSearchParams(current => {
            current.set("tab", tab);
            current.set("resource", resource.name);
            current.set("endpoint", endpoint || "local");
            return current;
        });
    };

    return <div className={pageStyles.page}>
        <PageHeader actions={<div className={pageStyles.rowActions}>{canManage && <Button disabled={!endpointOnline} variant="primary" onClick={() => setCreateOpen(true)}><Icon name="plus" size={15} />创建{tab === "networks" ? "网络" : "卷"}</Button>}<Button disabled={!endpointOnline} loading={loading} onClick={() => void load()}><Icon name="refresh" size={15} />刷新</Button></div>} description="检查 Docker 网络、持久卷和容器依赖，再执行可验证的资源变更。" title="网络与卷" />
        <MetricStrip items={[{ label: "网络",
            value: inventory?.summary.networks || 0 }, { label: "孤立网络",
            value: inventory?.summary.orphanedNetworks || 0,
            tone: inventory?.summary.orphanedNetworks ? "warning" : "default" }, { label: "卷",
            value: inventory?.summary.volumes || 0 }, { label: "孤立卷",
            value: inventory?.summary.orphanedVolumes || 0,
            tone: inventory?.summary.orphanedVolumes ? "warning" : "default" }]} />
        <Toolbar><SegmentedControl><Button aria-pressed={tab === "networks"} size="compact" variant={tab === "networks" ? "primary" : "ghost"} onClick={() => selectTab("networks")}><Icon name="network" size={14} />网络</Button><Button aria-pressed={tab === "volumes"} size="compact" variant={tab === "volumes" ? "primary" : "ghost"} onClick={() => selectTab("volumes")}><Icon name="volume" size={14} />卷</Button><Button aria-pressed={orphanedOnly} size="compact" variant={orphanedOnly ? "primary" : "ghost"} onClick={() => setOrphanedOnly(current => !current)}>仅孤立</Button></SegmentedControl><div className={styles.toolbarTools}><label>节点<select onChange={event => setEndpoint(event.target.value)} value={endpoint}>{endpointList.map(item => <option key={item.endpoint || "local"} value={item.endpoint}>{item.name || item.endpoint || "本机"} · {item.status === "online" ? "在线" : item.status === "connecting" ? "连接中" : "离线"}</option>)}</select></label><SearchField label="搜索 Docker 资源" onChange={event => setSearch(event.target.value)} placeholder="名称、驱动、项目或容器" value={search} /></div></Toolbar>
        {!endpointOnline && <Notice tone="error">节点 {endpointSummary.name || endpoint || "本机"} 当前不可用，资源操作已禁用。</Notice>}
        {feedback && <Notice>{feedback}</Notice>}
        <Panel>{loading ? <div className={styles.loading}>正在读取 Docker 资源与依赖…</div> : resources.length === 0 ? <EmptyState title={orphanedOnly ? "没有孤立资源" : `没有${tab === "networks" ? "网络" : "卷"}`} description={search ? "调整搜索条件后重试。" : orphanedOnly ? "当前资源均有依赖或属于 Docker 内置设施。" : "所选节点没有返回此类 Docker 资源。"} /> : <div className={pageStyles.tableScroller}><table className={`${pageStyles.table} ${styles.table}`}><thead><tr><th>名称</th><th>驱动 / 作用域</th><th>{tab === "networks" ? "地址" : "容量"}</th><th>依赖</th><th>归属</th><th>状态</th><th aria-label="操作" /></tr></thead><tbody>{resources.map(resource => <tr key={resource.name}><td><div className={pageStyles.primaryCell}><strong>{resource.name}</strong><small className={pageStyles.mono}>{resource.kind === "network" ? resource.shortId : resource.anonymous ? "匿名卷" : "命名卷"}</small></div></td><td><div className={pageStyles.primaryCell}><span>{resource.driver}</span><small>{resource.scope}</small></div></td><td className={pageStyles.mono}>{resource.kind === "network" ? resource.subnets.map(subnet => subnet.subnet).filter(Boolean).join(", ") || "—" : formatBytes(resource.sizeBytes)}</td><td><div className={pageStyles.primaryCell}><strong>{resource.dependencies.length} 个容器</strong><small>{resource.dependencies.slice(0, 2).map(dependency => dependency.name).join(", ") || "无依赖"}</small></div></td><td>{resource.composeProject || (resource.kind === "network" && resource.builtin ? "Docker 内置" : "独立资源")}</td><td><StatusBadge label={resource.orphaned ? "孤立" : resource.kind === "network" && resource.builtin ? "内置" : "使用中"} status={resource.orphaned ? "created" : resource.kind === "network" && resource.builtin ? "inactive" : "running"} /></td><td><div className={pageStyles.rowActions}><Button size="compact" variant="ghost" onClick={() => openResource(resource)}>详情</Button>{canManage && <Button size="compact" variant="danger" onClick={() => void previewRemoval(resource)}><Icon name="delete" size={13} />预检</Button>}</div></td></tr>)}</tbody></table></div>}</Panel>
        {selected && <ResourceDetailDialog canManage={canManage} resource={selected} onClose={() => {
            setSelected(undefined);
            setSearchParams(current => {
                current.delete("resource");
                return current;
            });
        }} onDisconnect={dependency => selected.kind === "network" && void previewDisconnect(selected, dependency)} onRemove={() => void previewRemoval(selected)} />}
        {removalPreview && <ConfirmOperationDialog blockers={removalPreview.blockers} busy={confirmBusy} confirmationLabel={removalPreview.name} description={removalPreview.kind === "volume" ? "卷中的数据将被永久删除。" : "网络定义将从当前 Docker 节点删除。"} target={removalPreview.name} title={`删除 Docker ${removalPreview.kind === "network" ? "网络" : "卷"}`} warnings={removalPreview.warnings} onClose={() => setRemovalPreview(undefined)} onConfirm={confirmation => void remove(confirmation)} />}
        {disconnectPreview && <ConfirmOperationDialog blockers={disconnectPreview.blockers} busy={confirmBusy} confirmationLabel={disconnectPreview.containerName} description="容器将立即失去此网络连接。" target={`${disconnectPreview.networkName} → ${disconnectPreview.containerName}`} title="断开容器网络" warnings={disconnectPreview.warnings} onClose={() => setDisconnectPreview(undefined)} onConfirm={confirmation => void disconnect(confirmation)} />}
        {createOpen && <CreateResourceDialog endpoint={endpoint} tab={tab} onClose={() => setCreateOpen(false)} onCreated={message => {
            setCreateOpen(false);
            setFeedback(message);
            void load();
        }} onFailure={error => {
            setCreateOpen(false);
            setFailure(error);
        }} />}
        {failure && <FailureDialog description="Docker 节点返回了原始错误，资源操作未按预期完成。" details={[{ label: "操作",
            value: failure.action }, { label: "目标",
            value: failure.target }, { label: "节点",
            value: endpointSummary.name || endpoint || "本机" }]} message={failure.message} onClose={() => setFailure(undefined)} open title={`${failure.action}失败`} />}
    </div>;
}
