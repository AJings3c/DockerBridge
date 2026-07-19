import { FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/primitives/Button";
import { EmptyState } from "@/components/primitives/EmptyState";
import { StatusBadge } from "@/components/primitives/StatusBadge";
import { SkeletonRows } from "@/components/SkeletonRows";
import { Icon } from "@/components/Icon";
import { MetricStrip, Notice, PageHeader, Panel, SearchField, useModalDialog } from "@/components/ui";
import { exportOperationLogs, OperationLogQuery, queryOperationLogs } from "@/services/runtime";
import { OperationLogItem, OperationLogResponse } from "@/types/domain";
import pageStyles from "./Page.module.css";
import styles from "./OperationLogPage.module.css";

const initialQuery : OperationLogQuery = {
    page: 1,
    pageSize: 50,
    search: "",
    action: "",
    objectType: "",
    result: "",
    from: "",
    to: "",
};

const actionLabels : Record<string, string> = {
    start: "启动容器",
    stop: "停止容器",
    restart: "重启容器",
    recreate: "重建容器",
    start_stack: "启动 Compose",
    stop_stack: "停止 Compose",
    restart_stack: "重启 Compose",
    update_stack: "更新 Compose",
    down_stack: "下线 Compose",
    pull_image: "拉取镜像",
    delete_image: "删除镜像",
    tag_image: "添加镜像标签",
    prune_images: "清理镜像",
    update_port: "更新端口",
    rollback_port: "回滚端口",
    save_docker_config: "保存 Docker 配置",
    rollback_docker_config: "回滚 Docker 配置",
    restart_docker: "重启 Docker",
    restore_container: "恢复容器",
    clean_cache: "清理缓存",
    clean_cache_skipped: "跳过缓存清理",
    create_user: "创建账户",
    update_user: "更新账户权限",
    reset_user_password: "重置账户密码",
    create_system_backup: "创建系统备份",
    stage_system_restore: "暂存系统恢复",
    delete_system_backup: "删除系统备份",
    save_compose_revision: "保存 Compose 版本",
    deploy_compose_revision: "保存并部署 Compose",
    restore_compose_revision: "恢复 Compose 版本",
    create_docker_network: "创建 Docker 网络",
    create_docker_volume: "创建 Docker 卷",
    remove_docker_network: "删除 Docker 网络",
    remove_docker_volume: "删除 Docker 卷",
    disconnect_docker_network: "断开容器网络",
    test_agent_connection: "测试 Agent 连接",
    add_agent: "注册 Agent",
    diagnose_agent: "运行 Agent 诊断",
    update_agent: "更新 Agent",
    rotate_agent_credentials: "轮换 Agent 凭据",
    remove_agent: "移除 Agent",
};

const objectLabels : Record<string, string> = {
    container: "容器",
    compose_stack: "Compose 项目",
    compose_service: "Compose 服务",
    image: "镜像",
    image_collection: "镜像集合",
    docker_daemon: "Docker 服务",
    user: "账户",
    system_backup: "系统备份",
    docker_network: "Docker 网络",
    docker_volume: "Docker 卷",
    docker_network_attachment: "网络连接",
    agent: "Agent 节点",
};

function actionLabel(action : string) {
    return actionLabels[action] || action.replaceAll("_", " ");
}

function objectLabel(objectType : string) {
    return objectLabels[objectType] || objectType.replaceAll("_", " ");
}

function resultLabel(result : string) {
    return { success: "成功",
        failed: "失败",
        skipped: "已跳过" }[result] || result;
}

function resultStatus(result : string) {
    if (result === "success") {
        return "running";
    }
    if (result === "failed") {
        return "abnormal";
    }
    return "created";
}

function formatTime(value : string) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatDuration(value : number | null) {
    if (value == null) {
        return "—";
    }
    if (value < 1000) {
        return `${value} ms`;
    }
    return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)} s`;
}

function formatSnapshot(value : string | null) {
    if (!value) {
        return "无快照";
    }
    try {
        return JSON.stringify(JSON.parse(value), null, 2);
    } catch (error) {
        return value;
    }
}

function operationObjectTarget(item : OperationLogItem) {
    const params = new URLSearchParams();
    if (item.objectType === "container") {
        params.set("container", item.objectId);
        return `/containers?${params}`;
    }
    if (item.objectType === "image") {
        params.set("tab", "images");
        params.set("image", item.objectId);
        return `/containers?${params}`;
    }
    if (item.objectType === "compose_stack") {
        params.set("stack", item.objectId);
        params.set("endpoint", item.endpoint || "local");
        return `/compose?${params}`;
    }
    if (item.objectType === "compose_service") {
        const separator = item.objectId.indexOf("/");
        if (separator <= 0 || separator === item.objectId.length - 1) {
            return null;
        }
        params.set("stack", item.objectId.slice(0, separator));
        params.set("service", item.objectId.slice(separator + 1));
        params.set("endpoint", item.endpoint || "local");
        return `/compose?${params}`;
    }
    if (item.objectType === "docker_daemon") {
        return "/settings?section=docker";
    }
    if (item.objectType === "user") {
        return "/settings?section=access";
    }
    if (item.objectType === "agent") {
        return `/agents?endpoint=${encodeURIComponent(item.objectId)}`;
    }
    if (item.objectType === "terminal_session") {
        return "/console";
    }
    if (item.objectType === "system_backup") {
        return "/settings?section=backup";
    }
    if (item.objectType === "docker_network" || item.objectType === "docker_network_attachment") {
        const resource = item.objectType === "docker_network_attachment" ? item.objectId.split("/", 1)[0] : item.objectId;
        return `/resources?tab=networks&resource=${encodeURIComponent(resource)}&endpoint=${encodeURIComponent(item.endpoint || "local")}`;
    }
    if (item.objectType === "docker_volume") {
        return `/resources?tab=volumes&resource=${encodeURIComponent(item.objectId)}&endpoint=${encodeURIComponent(item.endpoint || "local")}`;
    }
    return null;
}

function csvCell(value : unknown) {
    let text = value == null ? "" : String(value);
    if (/^[=+\-@]/.test(text)) {
        text = "'" + text;
    }
    return `"${text.replaceAll("\"", "\"\"")}"`;
}

function downloadFile(content : string, type : string, filename : string) {
    const url = URL.createObjectURL(new Blob([ content ], { type }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
}

function OperationDetailDialog({ item, onClose, onOpenObject } : { item: OperationLogItem; onClose: () => void; onOpenObject?: () => void }) {
    const dialogRef = useModalDialog();

    return (
        <dialog
            aria-labelledby="operation-detail-title"
            className={styles.dialog}
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
            <div className={styles.dialogContent}>
                <header className={styles.dialogHeader}>
                    <div><span>操作 #{item.id}</span><h2 id="operation-detail-title">{actionLabel(item.actionType)}</h2><p>{objectLabel(item.objectType)} · {item.objectId}</p></div>
                    <button aria-label="关闭详情" className={styles.closeButton} onClick={onClose} type="button"><Icon name="close" /></button>
                </header>
                <dl className={styles.facts}>
                    <div><dt>结果</dt><dd><StatusBadge label={resultLabel(item.result)} status={resultStatus(item.result)} /></dd></div>
                    <div><dt>时间</dt><dd>{formatTime(item.time)}</dd></div>
                    <div><dt>耗时</dt><dd>{formatDuration(item.durationMs)}</dd></div>
                    <div><dt>操作者</dt><dd>{item.actor || "历史记录"}</dd></div>
                    <div><dt>节点</dt><dd>{item.endpoint || "本机"}</dd></div>
                </dl>
                {item.error && <section className={styles.errorBlock}><span>错误结果</span><pre>{item.error}</pre></section>}
                <div className={styles.snapshots}>
                    <section><h3>操作前</h3><pre>{formatSnapshot(item.beforeJson)}</pre></section>
                    <section><h3>操作后</h3><pre>{formatSnapshot(item.afterJson)}</pre></section>
                </div>
                <footer className={styles.dialogActions}>{onOpenObject && <Button onClick={onOpenObject}><Icon name="externalLink" size={15} />打开对象</Button>}<Button autoFocus variant="primary" onClick={onClose}>关闭</Button></footer>
            </div>
        </dialog>
    );
}

export function OperationLogPage() {
    const navigate = useNavigate();
    const [ query, setQuery ] = useState(initialQuery);
    const [ searchDraft, setSearchDraft ] = useState("");
    const [ data, setData ] = useState<OperationLogResponse>();
    const [ loading, setLoading ] = useState(true);
    const [ error, setError ] = useState("");
    const [ selected, setSelected ] = useState<OperationLogItem>();
    const [ refreshKey, setRefreshKey ] = useState(0);
    const [ exporting, setExporting ] = useState<"csv" | "json" | "">("");
    const [ exportNotice, setExportNotice ] = useState<{ message: string; tone: "default" | "error" | "warning" }>();

    useEffect(() => {
        let active = true;
        setLoading(true);
        setError("");
        void queryOperationLogs(query).then(response => {
            if (!active) {
                return;
            }
            if (response.ok) {
                setData(response);
            } else {
                setError(response.msg || "无法读取操作审计记录");
            }
            setLoading(false);
        });
        return () => {
            active = false;
        };
    }, [ query, refreshKey ]);

    const submitSearch = (event : FormEvent) => {
        event.preventDefault();
        setQuery(current => ({ ...current,
            page: 1,
            search: searchDraft.trim() }));
    };

    const openObject = (item : OperationLogItem) => {
        const target = operationObjectTarget(item);
        if (!target) {
            setExportNotice({ message: `对象类型 ${item.objectType} 暂不支持定位。`,
                tone: "warning" });
            return;
        }
        setSelected(undefined);
        navigate(target);
    };

    const exportLogs = async (format : "csv" | "json") => {
        setExporting(format);
        setExportNotice(undefined);
        try {
            const response = await exportOperationLogs(query);
            if (!response.ok) {
                setExportNotice({ message: response.msg || "审计记录导出失败",
                    tone: "error" });
                return;
            }
            const timestamp = response.generatedAt.replace(/[:.]/g, "-");
            if (format === "json") {
                downloadFile(JSON.stringify({ generatedAt: response.generatedAt,
                    total: response.total,
                    exported: response.exported,
                    truncated: response.truncated,
                    items: response.items }, null, 2), "application/json;charset=utf-8", `dockerbridge-audit-${timestamp}.json`);
            } else {
                const fields : Array<keyof OperationLogItem> = [ "id", "time", "actionType", "objectType", "objectId", "result", "error", "actor", "endpoint", "durationMs", "beforeJson", "afterJson" ];
                const rows = [ fields.map(csvCell).join(","), ...response.items.map(item => fields.map(field => csvCell(item[field])).join(",")) ];
                downloadFile(`\uFEFF${rows.join("\r\n")}`, "text/csv;charset=utf-8", `dockerbridge-audit-${timestamp}.csv`);
            }
            setExportNotice({ message: response.truncated ? `已导出最近 ${response.exported.toLocaleString()} 条；筛选结果共 ${response.total.toLocaleString()} 条，服务端上限为 10,000 条。` : `已导出当前筛选下的 ${response.exported.toLocaleString()} 条审计记录。`,
                tone: response.truncated ? "warning" : "default" });
        } catch (exportError) {
            setExportNotice({ message: exportError instanceof Error ? exportError.message : "审计记录导出失败",
                tone: "error" });
        } finally {
            setExporting("");
        }
    };

    return (
        <div className={pageStyles.page}>
            <PageHeader
                actions={<><Button loading={exporting === "csv"} onClick={() => void exportLogs("csv")}><Icon name="download" size={15} />CSV</Button><Button loading={exporting === "json"} onClick={() => void exportLogs("json")}><Icon name="download" size={15} />JSON</Button><Button loading={loading} onClick={() => setRefreshKey(value => value + 1)}><Icon name="refresh" size={16} />刷新记录</Button></>}
                description="追踪关键操作的结果、对象、节点和变更快照，优先定位失败与回滚线索。"
                title="操作审计"
            />
            <MetricStrip items={[
                { label: "筛选结果",
                    value: data?.summary.total ?? "—" },
                { label: "成功",
                    value: data?.summary.success ?? "—" },
                { label: "失败",
                    value: data?.summary.failed ?? "—",
                    tone: (data?.summary.failed || 0) > 0 ? "danger" : "default" },
                { label: "已跳过",
                    value: data?.summary.skipped ?? "—",
                    tone: (data?.summary.skipped || 0) > 0 ? "warning" : "default" },
            ]} />
            {error && <Notice tone="error">{error}</Notice>}
            {exportNotice && <Notice tone={exportNotice.tone}>{exportNotice.message}</Notice>}
            <Panel>
                <div className={styles.filters}>
                    <form className={styles.searchForm} onSubmit={submitSearch}>
                        <SearchField label="搜索审计记录" onChange={event => setSearchDraft(event.target.value)} placeholder="操作、对象、操作者、节点或错误" value={searchDraft} />
                        <Button size="compact" type="submit">搜索</Button>
                    </form>
                    <label className={styles.selectField}><span>结果</span><select onChange={event => setQuery(current => ({ ...current,
                        page: 1,
                        result: event.target.value }))} value={query.result}><option value="">全部结果</option><option value="success">成功</option><option value="failed">失败</option><option value="skipped">已跳过</option></select></label>
                    <label className={styles.selectField}><span>操作</span><select onChange={event => setQuery(current => ({ ...current,
                        page: 1,
                        action: event.target.value }))} value={query.action}><option value="">全部操作</option>{data?.options.actions.map(action => <option key={action} value={action}>{actionLabel(action)}</option>)}</select></label>
                    <label className={styles.selectField}><span>对象</span><select onChange={event => setQuery(current => ({ ...current,
                        page: 1,
                        objectType: event.target.value }))} value={query.objectType}><option value="">全部对象</option>{data?.options.objectTypes.map(objectType => <option key={objectType} value={objectType}>{objectLabel(objectType)}</option>)}</select></label>
                    <label className={styles.dateField}><span>开始时间</span><input onChange={event => setQuery(current => ({ ...current,
                        page: 1,
                        from: event.target.value ? new Date(event.target.value).toISOString() : "" }))} type="datetime-local" /></label>
                    <label className={styles.dateField}><span>结束时间</span><input onChange={event => setQuery(current => ({ ...current,
                        page: 1,
                        to: event.target.value ? new Date(event.target.value).toISOString() : "" }))} type="datetime-local" /></label>
                </div>
                {loading && !data ? <SkeletonRows rows={9} /> : data?.items.length === 0 ? <EmptyState title="没有匹配的操作记录" description="调整筛选条件，或执行一次容器、Compose、镜像或配置操作后再刷新。" /> : (
                    <div className={pageStyles.tableScroller}><table className={pageStyles.table}><thead><tr><th>时间</th><th>操作</th><th>对象</th><th>结果</th><th className={pageStyles.mobileOptional}>操作者 / 节点</th><th className={pageStyles.mobileOptional}>耗时</th><th aria-label="详情" /></tr></thead><tbody>{data?.items.map(item => <tr key={item.id}><td><span className={styles.time}>{formatTime(item.time)}</span></td><td><div className={pageStyles.primaryCell}><strong>{actionLabel(item.actionType)}</strong><small className={pageStyles.mono}>{item.actionType}</small></div></td><td><div className={pageStyles.primaryCell}><strong>{objectLabel(item.objectType)}</strong><small title={item.objectId}>{item.objectId}</small></div></td><td><StatusBadge label={resultLabel(item.result)} status={resultStatus(item.result)} /></td><td className={pageStyles.mobileOptional}><div className={pageStyles.primaryCell}><span>{item.actor || "历史记录"}</span><small>{item.endpoint || "本机"}</small></div></td><td className={`${pageStyles.mono} ${pageStyles.mobileOptional}`}>{formatDuration(item.durationMs)}</td><td><div className={styles.rowActions}>{operationObjectTarget(item) && <Button aria-label={`打开 ${item.objectId}`} size="compact" variant="ghost" onClick={() => openObject(item)}><Icon name="externalLink" size={14} /></Button>}<Button size="compact" variant={item.result === "failed" ? "danger" : "secondary"} onClick={() => setSelected(item)}>查看</Button></div></td></tr>)}</tbody></table></div>
                )}
                {data && <div className={styles.pagination}><span>第 {data.pagination.page} / {data.pagination.pageCount} 页，共 {data.pagination.total} 条</span><label>每页<select onChange={event => setQuery(current => ({ ...current,
                    page: 1,
                    pageSize: Number(event.target.value) }))} value={query.pageSize}><option value={25}>25</option><option value={50}>50</option><option value={100}>100</option></select></label><Button size="compact" disabled={data.pagination.page <= 1 || loading} onClick={() => setQuery(current => ({ ...current,
                    page: current.page - 1 }))}><Icon name="chevronLeft" size={15} />上一页</Button><Button size="compact" disabled={data.pagination.page >= data.pagination.pageCount || loading} onClick={() => setQuery(current => ({ ...current,
                    page: current.page + 1 }))}>下一页<Icon name="chevronRight" size={15} /></Button></div>}
            </Panel>
            {selected && <OperationDetailDialog item={selected} onClose={() => setSelected(undefined)} onOpenObject={operationObjectTarget(selected) ? () => openObject(selected) : undefined} />}
        </div>
    );
}
