import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/primitives/Button";
import { EmptyState } from "@/components/primitives/EmptyState";
import { ProgressBar } from "@/components/primitives/ProgressBar";
import { StatusBadge } from "@/components/primitives/StatusBadge";
import { Icon } from "@/components/Icon";
import { LineChart, Notice, PageHeader, Panel, PanelHeader } from "@/components/ui";
import { refreshSnapshot } from "@/services/runtime";
import { formatChartValue } from "@/components/ui/LineChart";
import { formatBytes, formatUptime } from "@/services/format";
import { endpointFor, formatLastSeen, isStackStale } from "@/services/endpoints";
import { useAppSelector } from "@/store/hooks";
import dashboardStyles from "./DashboardPage.module.css";
import styles from "./Page.module.css";

export function DashboardPage() {
    const { snapshot, loadingSnapshot, snapshotError, stacks, endpoints, stackSyncErrors, metricsHost, events } = useAppSelector(state => state.runtime);
    const [ now, setNow ] = useState(Date.now());

    useEffect(() => {
        void refreshSnapshot();
        const timer = window.setInterval(() => void refreshSnapshot(), 30000);
        return () => window.clearInterval(timer);
    }, []);

    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 15_000);
        return () => window.clearInterval(timer);
    }, []);

    const stackList = Object.values(stacks);
    const abnormalContainers = snapshot?.containers.filter(container => container.status === "abnormal" || container.status === "restarting") || [];
    const abnormalTotal = snapshot ? snapshot.summary.abnormal + snapshot.summary.restarting : 0;
    const recentStacks = stackList.slice(0, 8);
    const containerTotal = snapshot?.summary.containerTotal || 0;
    const endpointList = Object.values(endpoints);
    const diskRows = (snapshot?.summary.disk || []).map(row => ({ type: String(row.Type || ""),
        count: String(row.TotalCount ?? "—"),
        active: String(row.Active ?? ""),
        size: String(row.Size ?? ""),
        reclaimable: String(row.Reclaimable ?? "") }));
    const stateTitle = !snapshot?.dockerAvailable
        ? "Docker Engine 不可用"
        : abnormalTotal > 0
            ? `发现 ${abnormalTotal} 项运行异常`
            : "Docker Engine 运行稳定";
    const stateDescription = !snapshot?.dockerAvailable
        ? "检查 Docker socket 挂载和运行服务权限。"
        : abnormalTotal > 0
            ? "异常和重启中的容器已置顶，建议优先检查日志与依赖。"
            : "容器与 Compose 项目状态正常，数据每 30 秒自动刷新。";

    return (
        <div className={styles.page}>
            <PageHeader
                actions={<Button loading={loadingSnapshot} onClick={() => void refreshSnapshot()}><Icon name="refresh" size={16} />同步状态</Button>}
                description="从整体健康进入异常、资源与具体工作负载。"
                title="今天的运行现场"
            />
            {snapshotError && <Notice tone="error">{snapshotError}</Notice>}
            <section className={dashboardStyles.overview}>
                <div className={dashboardStyles.statePane}>
                    <div className={dashboardStyles.stateMeta}><span className={dashboardStyles.liveDot} />本机运行态</div>
                    <div>
                        <h3>{stateTitle}</h3>
                        <p>{stateDescription}</p>
                    </div>
                    <div className={dashboardStyles.stateActions}>
                        <Link to="/containers">检查容器 <span>→</span></Link>
                        <Link to="/compose">查看 Compose <span>→</span></Link>
                    </div>
                    <div className={dashboardStyles.engineMark} aria-hidden="true"><Icon name="activity" size={44} strokeWidth={1.35} /></div>
                </div>
                <div className={dashboardStyles.resourcePane}>
                    <div className={dashboardStyles.resourceHeader}>
                        <div><span>主机资源</span><strong>{snapshot?.generatedAt ? new Date(snapshot.generatedAt).toLocaleTimeString() : "等待采样"}</strong></div>
                        <Icon name="server" size={20} />
                    </div>
                    <div className={dashboardStyles.resourceRows}>
                        <LineChart points={metricsHost.map(item => ({ t: item.t,
                            value: item.cpuPercent }))} label="CPU" unit="%" maxY={100} warnAbove={85} height={56} />
                        <LineChart points={metricsHost.map(item => ({ t: item.t,
                            value: item.memoryPercent }))} label="内存" unit="%" maxY={100} warnAbove={90} height={56} />
                        <LineChart points={metricsHost.map(item => ({ t: item.t,
                            value: item.netRxBytesPerSec + item.netTxBytesPerSec }))} label="容器网络" unit="bytes/s" height={56} />
                    </div>
                    <div className={dashboardStyles.resourceFacts}>
                        <div><span>运行容器</span><strong>{snapshot?.summary.running ?? "—"}<small> / {containerTotal || "—"}</small></strong></div>
                        <div><span>Compose</span><strong>{stackList.length}</strong></div>
                        <div><span>镜像</span><strong>{snapshot?.summary.imageTotal ?? "—"}</strong></div>
                        <div><span>引擎</span><strong className={dashboardStyles.factMono}>{snapshot?.summary.engine?.serverVersion || "—"}</strong></div>
                    </div>
                </div>
            </section>
            <div className={dashboardStyles.sections}>
                <Panel className={dashboardStyles.attentionPanel}>
                    <PanelHeader action={<Link to="/containers">查看全部</Link>} description="异常退出或正在反复重启的容器" title="需要关注" />
                    {abnormalContainers.length === 0 ? <EmptyState title="当前没有容器异常" description="运行状态正常；DockerBridge 会持续刷新并把异常置顶。" /> : (
                        <div className={styles.tableScroller}><table className={styles.table}><tbody>{abnormalContainers.slice(0, 8).map(container => <tr key={container.id}><td><div className={styles.primaryCell}><strong>{container.name}</strong><small>{container.image}</small></div></td><td><StatusBadge status={container.status} label={container.statusText || container.status} /></td></tr>)}</tbody></table></div>
                    )}
                </Panel>
                <Panel className={dashboardStyles.stackPanel}>
                    <PanelHeader action={<Link to="/compose">管理项目</Link>} description="最近同步的运行项目" title="Compose 现场" />
                    {recentStacks.length === 0 ? <EmptyState title="尚未发现 Compose 项目" description="前往 Compose 仓库扫描宿主机上的 YAML 配置。" action={<Link to="/compose-repository"><Button>打开 Compose 仓库</Button></Link>} /> : (
                        <div className={styles.tableScroller}><table className={styles.table}><tbody>{recentStacks.map(stack => <tr key={`${stack.name}_${stack.endpoint}`}><td><div className={styles.primaryCell}><strong>{stack.name}</strong><small>{stack.composeFilePath}</small></div></td><td><StatusBadge status={stack.status === 3 ? "running" : stack.status === 4 ? "exited" : "inactive"} label={stack.status === 3 ? "运行中" : stack.status === 4 ? "已退出" : "未运行"} /></td></tr>)}</tbody></table></div>
                    )}
                </Panel>
            </div>
            <Panel className={dashboardStyles.hostPanel}>
                <PanelHeader description="引擎版本、宿主机事实与 Docker 磁盘占用" title="宿主与引擎" />
                <div className={dashboardStyles.factGrid}>
                    <div className={dashboardStyles.factItem}><span>引擎版本</span><strong>{snapshot?.summary.engine?.serverVersion || "—"}<small>{snapshot?.summary.engine?.apiVersion ? " API " + snapshot.summary.engine.apiVersion : ""}</small></strong></div>
                    <div className={dashboardStyles.factItem}><span>存储驱动</span><strong>{snapshot?.summary.engine?.storageDriver || "—"}</strong></div>
                    <div className={dashboardStyles.factItem}><span>操作系统</span><strong className={dashboardStyles.factMono}>{snapshot?.summary.engine?.operatingSystem || snapshot?.summary.host?.platform || "—"}</strong></div>
                    <div className={dashboardStyles.factItem}><span>内核</span><strong className={dashboardStyles.factMono}>{snapshot?.summary.engine?.kernelVersion || snapshot?.summary.host?.release || "—"}</strong></div>
                    <div className={dashboardStyles.factItem}><span>架构 / CPU</span><strong>{snapshot?.summary.engine?.architecture || snapshot?.summary.host?.arch || "—"}<small> {snapshot?.summary.engine?.cpus || snapshot?.summary.host?.cpuCount || "?"} 核</small></strong></div>
                    <div className={dashboardStyles.factItem}><span>宿主运行时长</span><strong>{formatUptime(snapshot?.summary.host?.uptimeSeconds)}</strong></div>
                    <div className={dashboardStyles.factItem}><span>内存</span><strong>{snapshot?.summary.host ? formatBytes(snapshot.summary.host.totalMemoryBytes, "—") : "—"}</strong></div>
                    <div className={dashboardStyles.factItem}><span>Docker 根目录</span><strong className={dashboardStyles.factMono}>{snapshot?.summary.engine?.dockerRootDir || "—"}</strong></div>
                </div>
                {diskRows.length > 0 && <div className={styles.tableScroller}><table className={styles.table}><thead><tr><th>类型</th><th className={styles.mobileOptional}>数量 / 活跃</th><th>占用</th><th>可回收</th></tr></thead><tbody>{diskRows.map(row => <tr key={row.type}><td><div className={styles.primaryCell}><strong>{row.type}</strong><small>{row.active ? `活跃 ${row.active}` : ""}</small></div></td><td className={styles.mobileOptional}>{row.count}</td><td>{row.size}</td><td className={dashboardStyles.reclaimCell}>{row.reclaimable}</td></tr>)}</tbody></table></div>}
            </Panel>
            <Panel className={dashboardStyles.endpointPanel}>
                <PanelHeader description="容器与镜像的实时事件流，来自 Docker 事件监听。" title="最近事件" />
                {events.length === 0 ? <EmptyState title="暂无事件" description="容器启动、退出或镜像更新时会在这里实时出现。" /> : <div className={styles.tableScroller}><table className={styles.table}><thead><tr><th>动作</th><th>对象</th><th className={styles.mobileOptional}>类型</th><th className={styles.mobileOptional}>时间</th></tr></thead><tbody>{events.slice().reverse().slice(0, 10).map((record, index) => <tr key={`${record.t}-${index}`}><td><div className={styles.primaryCell}><strong>{record.action}</strong></div></td><td><div className={styles.primaryCell}><strong>{record.actorName}</strong><small>{record.image || ""}</small></div></td><td className={styles.mobileOptional}>{record.type === "container" ? "容器" : record.type === "image" ? "镜像" : record.type}</td><td className={styles.mobileOptional}>{new Date(record.t).toLocaleTimeString()}</td></tr>)}</tbody></table></div>}
            </Panel>
            <Panel className={dashboardStyles.endpointPanel}>
                <PanelHeader description="本机与远程 Agent 的实时连接状态；离线节点保留最后一次同步数据但禁止操作。" title="运行节点" />
                {endpointList.length === 0 ? <EmptyState description="登录后正在读取本机与远程 Agent 清单。" title="等待节点状态" /> : <div className={styles.tableScroller}><table className={styles.table}><thead><tr><th>节点</th><th>连接</th><th>项目</th><th className={styles.mobileOptional}>最后在线</th><th className={styles.mobileOptional}>状态说明</th></tr></thead><tbody>{endpointList.map(endpoint => {
                    const endpointStacks = stackList.filter(stack => stack.endpoint === endpoint.endpoint);
                    const staleCount = endpointStacks.filter(stack => isStackStale(stack, now)).length;
                    const status = endpoint.status === "online" ? "online" : endpoint.status === "connecting" ? "connecting" : "offline";
                    const label = endpoint.status === "online" ? "在线" : endpoint.status === "connecting" ? "连接中" : "离线";
                    const resolved = endpointFor(endpoints, endpoint.endpoint);
                    const syncError = stackSyncErrors[endpoint.endpoint];
                    return <tr className={endpoint.status === "offline" || syncError ? styles.staleRow : ""} key={endpoint.endpoint || "local"}><td><div className={styles.primaryCell}><strong>{resolved.name}</strong><small>{endpoint.endpoint || "本机运行服务"}</small></div></td><td><StatusBadge label={syncError && endpoint.status === "online" ? "同步失败" : label} status={syncError && endpoint.status === "online" ? "abnormal" : status} /></td><td><div className={styles.primaryCell}><span>{endpointStacks.length} 个项目</span><small>{staleCount > 0 ? `${staleCount} 个状态已过期` : syncError ? "无法更新项目状态" : "状态有效"}</small></div></td><td className={styles.mobileOptional}>{endpoint.status === "online" ? "刚刚" : formatLastSeen(endpoint.lastSeenAt)}</td><td className={styles.mobileOptional}>{syncError || endpoint.message || (endpoint.status === "online" ? "连接正常" : "等待自动重连")}</td></tr>;
                })}</tbody></table></div>}
            </Panel>
        </div>
    );
}
