import { FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/primitives/Button";
import { EmptyState } from "@/components/primitives/EmptyState";
import { StatusBadge } from "@/components/primitives/StatusBadge";
import { SkeletonRows } from "@/components/SkeletonRows";
import { Icon } from "@/components/Icon";
import { MetricStrip, Notice, PageHeader, Panel, SearchField } from "@/components/ui";
import { queryComposeRepository, RepositoryQuery } from "@/services/runtime";
import { useAppSelector } from "@/store/hooks";
import styles from "./Page.module.css";
import repositoryStyles from "./ComposeRepositoryPage.module.css";

const initialQuery : RepositoryQuery = {
    page: 1,
    pageSize: 50,
    search: "",
    source: "",
    status: "all",
};

function statusLabel(status : string) {
    return {
        running: "运行中",
        exited: "已退出",
        created: "已创建",
        inactive: "未运行",
        unknown: "未知",
    }[status] || status;
}

function formatSize(bytes : number) {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function ComposeRepositoryPage() {
    const { data, loading, error } = useAppSelector(state => state.repository);
    const [ query, setQuery ] = useState(initialQuery);
    const [ searchDraft, setSearchDraft ] = useState("");

    useEffect(() => {
        void queryComposeRepository(query);
    }, [ query ]);

    const submitSearch = (event : FormEvent) => {
        event.preventDefault();
        setQuery(current => ({ ...current,
            page: 1,
            search: searchDraft.trim() }));
    };

    const refresh = () => {
        void queryComposeRepository({ ...query,
            refresh: true });
    };

    return (
        <div className={styles.page}>
            <PageHeader
                actions={<Button loading={loading} onClick={refresh}><Icon name="refresh" size={16} />重新扫描</Button>}
                description="扫描所有 YAML，仅收录顶层包含有效 services 的 Compose 配置。"
                title="Compose 配置索引"
            />
            <MetricStrip items={[
                { label: "Compose 配置",
                    value: data?.summary.total ?? "—" },
                { label: "运行中",
                    value: data?.summary.running ?? "—" },
                { label: "扫描 YAML",
                    value: data?.summary.scannedYamlFiles ?? "—" },
                { label: "不可读取",
                    value: data?.summary.unreadable ?? "—",
                    tone: (data?.summary.unreadable || 0) > 0 ? "danger" : "default" },
            ]} />
            {data?.summary.truncated && <Notice tone="warning">已达到扫描上限，当前索引不是全部结果。可提高 <code>DOCKERBRIDGE_COMPOSE_SCAN_LIMIT</code>。</Notice>}
            {error && <Notice tone="error">{error}</Notice>}
            <Panel>
                <div className={repositoryStyles.filters}>
                    <form className={repositoryStyles.searchForm} onSubmit={submitSearch}>
                        <SearchField label="搜索 Compose 仓库" onChange={event => setSearchDraft(event.target.value)} placeholder="项目名、文件路径或服务名" value={searchDraft} />
                        <Button size="compact" type="submit">搜索</Button>
                    </form>
                    <label className={repositoryStyles.selectField}><span>来源目录</span><select onChange={event => setQuery(current => ({ ...current,
                        page: 1,
                        source: event.target.value }))} value={query.source}><option value="">全部目录</option>{data?.sources.map(source => <option key={source.path} value={source.path}>{source.name} ({source.count})</option>)}</select></label>
                    <label className={repositoryStyles.selectField}><span>运行状态</span><select onChange={event => setQuery(current => ({ ...current,
                        page: 1,
                        status: event.target.value }))} value={query.status}><option value="all">全部状态</option><option value="running">运行中</option><option value="exited">已退出</option><option value="created">已创建</option><option value="inactive">未运行</option><option value="unknown">未知</option></select></label>
                </div>
                {loading && !data ? <SkeletonRows rows={9} /> : data?.items.length === 0 ? <EmptyState title="没有匹配的 Compose 配置" description="调整来源、状态或搜索条件；扫描只收录顶层 services 非空的 YAML 文件。" /> : (
                    <div className={styles.tableScroller}><table className={styles.table}><thead><tr><th>项目 / 文件</th><th>状态</th><th className={styles.mobileOptional}>服务</th><th className={styles.mobileOptional}>来源</th><th className={styles.mobileOptional}>修改时间</th><th>访问</th></tr></thead><tbody>{data?.items.map(item => <tr key={item.id}><td><div className={styles.primaryCell}><strong>{item.projectName}</strong><small className={styles.mono} title={item.filePath}>{item.filePath}</small></div></td><td><StatusBadge status={item.status} label={statusLabel(item.status)} /></td><td className={styles.mobileOptional}><div className={styles.primaryCell}><span>{item.serviceCount} 个服务</span><small title={item.services.join(", ")}>{item.services.slice(0, 3).join(", ")}{item.services.length > 3 ? ` +${item.services.length - 3}` : ""}</small></div></td><td className={styles.mobileOptional}><div className={styles.primaryCell}><span>{item.source}</span><small>{item.managed ? "平台目录" : "外部目录"}</small></div></td><td className={styles.mobileOptional}><div className={styles.primaryCell}><span>{new Date(item.modifiedAt).toLocaleDateString()}</span><small>{formatSize(item.size)}</small></div></td><td><span className={item.readable ? "text-[var(--success)]" : "text-[var(--danger)]"}>{item.editable ? "可编辑" : item.readable ? "只读" : "不可读"}</span></td></tr>)}</tbody></table></div>
                )}
                {data && <div className={repositoryStyles.pagination}><span>第 {data.pagination.page} / {data.pagination.pageCount} 页，共 {data.pagination.total} 项</span><label>每页<select onChange={event => setQuery(current => ({ ...current,
                    page: 1,
                    pageSize: Number(event.target.value) }))} value={query.pageSize}><option value={25}>25</option><option value={50}>50</option><option value={100}>100</option></select></label><Button size="compact" disabled={data.pagination.page <= 1 || loading} onClick={() => setQuery(current => ({ ...current,
                    page: current.page - 1 }))}><Icon name="chevronLeft" size={15} />上一页</Button><Button size="compact" disabled={data.pagination.page >= data.pagination.pageCount || loading} onClick={() => setQuery(current => ({ ...current,
                    page: current.page + 1 }))}>下一页<Icon name="chevronRight" size={15} /></Button></div>}
            </Panel>
        </div>
    );
}
