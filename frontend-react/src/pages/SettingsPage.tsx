import { FormEvent, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "@/components/primitives/Button";
import { FailureDialog, Notice, PageHeader, Panel, PanelHeader } from "@/components/ui";
import { emitWithAck } from "@/services/realtime/client";
import { createSystemBackup, createUser, deleteSystemBackup, previewDockerDaemonConfig, previewSystemRestore, queryDockerDaemonConfig, querySystemBackups, queryUsers, resetUserPassword, restartDockerDaemon, restoreSystemBackup, rollbackDockerDaemonConfig, saveDockerDaemonConfig, updateUser, validateSystemBackup } from "@/services/runtime";
import { ApiResponse, DockerDaemonConfigForm, DockerDaemonConfigPreviewResponse, DockerDaemonConfigResponse, SystemBackupSummary, SystemRestorePreviewResponse, UserRole, UserSummary } from "@/types/domain";
import styles from "./Page.module.css";
import dockerStyles from "./SettingsDocker.module.css";
import accessStyles from "./SettingsAccess.module.css";
import backupStyles from "./SettingsBackup.module.css";
import settingsStyles from "./SettingsPage.module.css";

interface GeneralSettings {
    primaryHostname?: string;
    trustProxy?: boolean;
    disableAuth?: boolean;
    checkUpdate?: boolean;
    [key: string]: unknown;
}

interface SettingsFailure {
    action: string;
    message: string;
    contextLabel?: string;
    contextValue?: string;
}

const emptyDockerForm : DockerDaemonConfigForm = {
    registryMirrors: [],
    httpProxy: "",
    httpsProxy: "",
    noProxy: "",
    dns: [],
    insecureRegistries: [],
    logDriver: "",
    logMaxSize: "",
    logMaxFile: "",
};

function lines(value : string[]) {
    return value.join("\n");
}

function parseLines(value : string) {
    return value.split(/[\n,]/).map(item => item.trim()).filter(Boolean);
}

function formatBytes(value : number) {
    const units = [ "B", "KiB", "MiB", "GiB", "TiB" ];
    let size = value;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
        size /= 1024;
        unit += 1;
    }
    return `${unit === 0 ? size : size.toFixed(1)} ${units[unit]}`;
}

export function SettingsPage() {
    const [ searchParams ] = useSearchParams();
    const [ settings, setSettings ] = useState<GeneralSettings>({});
    const [ loading, setLoading ] = useState(true);
    const [ saving, setSaving ] = useState(false);
    const [ feedback, setFeedback ] = useState("");
    const [ dockerConfig, setDockerConfig ] = useState<DockerDaemonConfigResponse>();
    const [ dockerForm, setDockerForm ] = useState<DockerDaemonConfigForm>(emptyDockerForm);
    const [ dockerBusy, setDockerBusy ] = useState<"load" | "preview" | "save" | "rollback" | "restart" | "">("load");
    const [ dockerFeedback, setDockerFeedback ] = useState("");
    const [ preview, setPreview ] = useState<DockerDaemonConfigPreviewResponse>();
    const [ failure, setFailure ] = useState<SettingsFailure>();
    const [ users, setUsers ] = useState<UserSummary[]>([]);
    const [ userBusy, setUserBusy ] = useState("");
    const [ accessFeedback, setAccessFeedback ] = useState("");
    const [ newUser, setNewUser ] = useState({ username: "",
        password: "",
        role: "viewer" as UserRole });
    const [ passwordEdit, setPasswordEdit ] = useState<{ id: number; username: string; password: string }>();
    const [ backups, setBackups ] = useState<SystemBackupSummary[]>([]);
    const [ backupBusy, setBackupBusy ] = useState("");
    const [ backupFeedback, setBackupFeedback ] = useState("");
    const [ restorePreview, setRestorePreview ] = useState<SystemRestorePreviewResponse>();

    const loadDockerConfig = async () => {
        setDockerBusy("load");
        const response = await queryDockerDaemonConfig();
        if (response.ok) {
            setDockerConfig(response);
            setDockerForm(response.form || emptyDockerForm);
        } else {
            setFailure({ action: "读取 Docker 配置",
                message: response.msg || "读取 Docker 配置失败" });
        }
        setDockerBusy("");
    };

    const loadUsers = async () => {
        setUserBusy("load");
        const response = await queryUsers();
        setUserBusy("");
        if (!response.ok) {
            setFailure({ action: "读取账户列表",
                message: response.msg || "读取账户列表失败" });
            return;
        }
        setUsers(response.users);
    };

    const loadBackups = async () => {
        setBackupBusy("load");
        const response = await querySystemBackups();
        setBackupBusy("");
        if (!response.ok) {
            setFailure({ action: "读取系统备份",
                message: response.msg || "读取系统备份失败" });
            return;
        }
        setBackups(response.backups);
    };

    useEffect(() => {
        void emitWithAck<ApiResponse & { data?: GeneralSettings }>("getSettings").then(response => {
            if (response.ok && response.data) {
                setSettings(response.data);
            } else {
                setFeedback(response.msg || "读取设置失败");
            }
            setLoading(false);
        });
        void loadDockerConfig();
        void loadUsers();
        void loadBackups();
    }, []);

    useEffect(() => {
        const sectionName = searchParams.get("section");
        if (sectionName !== "docker" && sectionName !== "access" && sectionName !== "backup") {
            return;
        }
        const section = document.getElementById(sectionName === "docker" ? "docker-settings" : sectionName === "access" ? "access-settings" : "backup-settings");
        section?.focus({ preventScroll: true });
        section?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
            block: "start" });
    }, [ searchParams ]);

    const save = async (event : FormEvent) => {
        event.preventDefault();
        setSaving(true);
        const response = await emitWithAck<ApiResponse>("setSettings", settings, null);
        setFeedback(response.ok ? "设置已保存" : response.msg || "保存失败");
        setSaving(false);
    };

    const previewConfig = async () => {
        setDockerBusy("preview");
        setDockerFeedback("");
        const response = await previewDockerDaemonConfig(dockerForm);
        setDockerBusy("");
        if (!response.ok) {
            setFailure({ action: "预览 Docker 配置",
                message: response.msg || "配置校验失败" });
            return;
        }
        setPreview(response);
    };

    const saveConfig = async () => {
        if (!preview?.changed) {
            return;
        }
        setDockerBusy("save");
        const response = await saveDockerDaemonConfig(dockerForm);
        setDockerBusy("");
        if (!response.ok) {
            setFailure({ action: "保存 Docker 配置",
                message: response.msg || "保存 Docker 配置失败" });
            return;
        }
        setDockerConfig(current => current ? { ...current,
            config: response.config,
            form: response.form,
            backups: response.backups } : current);
        setDockerForm(response.form);
        setPreview(undefined);
        setDockerFeedback("Docker 配置已写入并生成备份。新配置需要重启 Docker 服务后生效。");
    };

    const rollbackConfig = async (backupFile : string) => {
        if (!window.confirm("确认从该备份恢复 daemon.json？恢复后仍需要重启 Docker 服务。")) {
            return;
        }
        setDockerBusy("rollback");
        const response = await rollbackDockerDaemonConfig(backupFile);
        setDockerBusy("");
        if (!response.ok) {
            setFailure({ action: "回滚 Docker 配置",
                message: response.msg || "回滚 Docker 配置失败" });
            return;
        }
        setDockerConfig(current => current ? { ...current,
            config: response.config,
            form: response.form,
            backups: response.backups } : current);
        setDockerForm(response.form);
        setPreview(undefined);
        setDockerFeedback("Docker 配置已从备份恢复。重启 Docker 服务后生效。");
    };

    const restartDaemon = async () => {
        if (!window.confirm(`确认执行 Docker 服务重启？\n\n命令：${dockerConfig?.restartCommand || "未配置"}\n\n运行中的容器网络可能短暂中断。`)) {
            return;
        }
        setDockerBusy("restart");
        const response = await restartDockerDaemon();
        setDockerBusy("");
        if (!response.ok) {
            setFailure({ action: "重启 Docker 服务",
                message: response.msg || "Docker 服务重启失败" });
            return;
        }
        setDockerFeedback("Docker 服务已重启并通过连通性检查。");
    };

    const updateDocker = <K extends keyof DockerDaemonConfigForm>(key : K, value : DockerDaemonConfigForm[K]) => {
        setDockerForm(current => ({ ...current,
            [key]: value }));
        setPreview(undefined);
        setDockerFeedback("");
    };

    const createAccount = async (event : FormEvent) => {
        event.preventDefault();
        setUserBusy("create");
        setAccessFeedback("");
        const response = await createUser(newUser.username.trim(), newUser.password, newUser.role);
        setUserBusy("");
        if (!response.ok) {
            setFailure({ action: "创建账户",
                message: response.msg || "创建账户失败" });
            return;
        }
        setUsers(response.users);
        setNewUser({ username: "",
            password: "",
            role: "viewer" });
        setAccessFeedback("账户已创建，新角色会在该账户下次登录时生效。");
    };

    const changeAccount = async (user : UserSummary, role : UserRole, active : boolean) => {
        if (!window.confirm(`确认将 ${user.username} 更新为${active ? "启用" : "停用"}的${role === "admin" ? "管理员" : role === "operator" ? "操作员" : "只读用户"}？`)) {
            return;
        }
        setUserBusy(`update:${user.id}`);
        setAccessFeedback("");
        const response = await updateUser(user.id, role, active);
        setUserBusy("");
        if (!response.ok) {
            setFailure({ action: "更新账户",
                message: response.msg || "更新账户失败" });
            return;
        }
        setUsers(response.users);
        setAccessFeedback(`${user.username} 的权限已更新，现有会话将被断开。`);
    };

    const resetAccountPassword = async (event : FormEvent) => {
        event.preventDefault();
        if (!passwordEdit?.password) {
            return;
        }
        setUserBusy(`password:${passwordEdit.id}`);
        const response = await resetUserPassword(passwordEdit.id, passwordEdit.password);
        setUserBusy("");
        if (!response.ok) {
            setFailure({ action: "重置账户密码",
                message: response.msg || "密码重置失败" });
            return;
        }
        setAccessFeedback(`${passwordEdit.username} 的密码已重置，现有会话将被断开。`);
        setPasswordEdit(undefined);
    };

    const createBackup = async () => {
        setBackupBusy("create");
        setBackupFeedback("");
        setRestorePreview(undefined);
        const response = await createSystemBackup();
        setBackupBusy("");
        if (!response.ok) {
            setFailure({ action: "创建系统备份",
                message: response.msg || "创建系统备份失败" });
            return;
        }
        setBackups(response.backups);
        setBackupFeedback(`备份 ${response.backup?.id || ""} 已创建并完成校验。`);
    };

    const validateBackup = async (backup : SystemBackupSummary) => {
        setBackupBusy(`validate:${backup.id}`);
        setBackupFeedback("");
        const response = await validateSystemBackup(backup.id);
        setBackupBusy("");
        if (!response.ok || !response.backup) {
            setBackups(current => current.map(item => item.id === backup.id ? { ...item,
                status: "invalid",
                message: response.msg || "校验失败" } : item));
            setFailure({ action: "校验系统备份",
                message: response.msg || "备份校验失败",
                contextLabel: "备份 ID",
                contextValue: backup.id });
            return;
        }
        setBackups(current => current.map(item => item.id === backup.id ? response.backup as SystemBackupSummary : item));
        setBackupFeedback(`备份 ${backup.id} 的文件大小与 SHA-256 校验均通过。`);
    };

    const prepareRestore = async (backup : SystemBackupSummary) => {
        setBackupBusy(`preview:${backup.id}`);
        setBackupFeedback("");
        const response = await previewSystemRestore(backup.id);
        setBackupBusy("");
        if (!response.ok) {
            setFailure({ action: "生成恢复预览",
                message: response.msg || "恢复预览失败",
                contextLabel: "备份 ID",
                contextValue: backup.id });
            return;
        }
        setBackups(current => current.map(item => item.id === backup.id ? { ...item,
            status: "valid" } : item));
        setRestorePreview(response);
    };

    const applyRestore = async () => {
        if (!restorePreview || !window.confirm(`确认从 ${restorePreview.backup.id} 恢复？\n\n将覆盖 ${restorePreview.overwriteCount} 个现有文件并写入 ${restorePreview.newFileCount} 个新文件。服务会重启，备份中不存在的现有 Compose 文件不会被删除。`)) {
            return;
        }
        setBackupBusy(`restore:${restorePreview.backup.id}`);
        const response = await restoreSystemBackup(restorePreview.backup.id);
        setBackupBusy("");
        if (!response.ok) {
            setFailure({ action: "暂存系统恢复",
                message: response.msg || "系统恢复暂存失败",
                contextLabel: "备份 ID",
                contextValue: restorePreview.backup.id });
            return;
        }
        setBackupFeedback(response.restartScheduled
            ? "恢复已暂存，服务即将重启。重连后数据库与 Compose 文件将来自所选备份。"
            : "恢复已暂存。请重启 DockerBridge 以应用数据库与 Compose 文件。 ");
        setRestorePreview(undefined);
    };

    const removeBackup = async (backup : SystemBackupSummary) => {
        if (!window.confirm(`确认永久删除系统备份 ${backup.id}？此操作不可撤销。`)) {
            return;
        }
        setBackupBusy(`delete:${backup.id}`);
        setBackupFeedback("");
        const response = await deleteSystemBackup(backup.id);
        setBackupBusy("");
        if (!response.ok) {
            setFailure({ action: "删除系统备份",
                message: response.msg || "删除系统备份失败",
                contextLabel: "备份 ID",
                contextValue: backup.id });
            return;
        }
        setBackups(response.backups);
        setRestorePreview(current => current?.backup.id === backup.id ? undefined : current);
        setBackupFeedback(`备份 ${backup.id} 已删除。`);
    };

    return <div className={styles.page}>
        <PageHeader description="调整平台偏好与 Docker 守护进程运行参数。" title="系统设置" />
        <nav aria-label="设置分类" className={settingsStyles.sectionNav}><a href="#general-settings">常规</a><a href="#access-settings">账户与角色</a><a href="#backup-settings">备份与恢复</a><a href="#docker-settings">Docker</a></nav>
        {feedback && <Notice>{feedback}</Notice>}
        <form className={styles.formPanel} id="general-settings" onSubmit={save} tabIndex={-1}>
            <Panel flush>
                <PanelHeader description="这些配置影响所有登录用户。" title="常规" />
                <fieldset className={styles.settingsFields} disabled={loading || saving}>
                    <label className={styles.textField}><span>主要主机名</span><input onChange={event => setSettings(current => ({ ...current,
                        primaryHostname: event.target.value }))} placeholder="localhost" value={settings.primaryHostname || ""} /></label>
                    <label className={styles.toggleField}><input checked={Boolean(settings.trustProxy)} onChange={event => setSettings(current => ({ ...current,
                        trustProxy: event.target.checked }))} type="checkbox" /><span><strong>信任反向代理头</strong><small>仅在代理由你控制时启用。</small></span></label>
                    <label className={styles.toggleField}><input checked={Boolean(settings.checkUpdate)} onChange={event => setSettings(current => ({ ...current,
                        checkUpdate: event.target.checked }))} type="checkbox" /><span><strong>检查新版本</strong><small>定期读取版本信息，不自动升级。</small></span></label>
                    <label className={`${styles.toggleField} ${styles.dangerField}`}><input checked={Boolean(settings.disableAuth)} onChange={event => setSettings(current => ({ ...current,
                        disableAuth: event.target.checked }))} type="checkbox" /><span><strong>禁用登录验证</strong><small>风险较高，只适合完全隔离的本地网络。</small></span></label>
                </fieldset>
                <div className={styles.formActions}><Button disabled={loading} loading={saving} variant="primary" type="submit">保存常规设置</Button></div>
            </Panel>
        </form>

        <Panel className={accessStyles.panel} flush id="access-settings" tabIndex={-1}>
            <PanelHeader action={<Button loading={userBusy === "load"} size="compact" onClick={() => void loadUsers()}>刷新</Button>} description="只读用户只能查看；操作员可执行日常启停；管理员可进入终端、系统配置和高风险清理。" title="账户与角色" />
            {accessFeedback && <Notice className={accessStyles.feedback}>{accessFeedback}</Notice>}
            <form className={accessStyles.createForm} onSubmit={createAccount}><label><span>用户名</span><input autoComplete="off" disabled={Boolean(userBusy)} onChange={event => setNewUser(current => ({ ...current,
                username: event.target.value }))} placeholder="operator-2" value={newUser.username} /></label><label><span>初始密码</span><input autoComplete="new-password" disabled={Boolean(userBusy)} onChange={event => setNewUser(current => ({ ...current,
                password: event.target.value }))} placeholder="至少包含字母和数字" type="password" value={newUser.password} /></label><label><span>角色</span><select disabled={Boolean(userBusy)} onChange={event => setNewUser(current => ({ ...current,
                role: event.target.value as UserRole }))} value={newUser.role}><option value="viewer">只读</option><option value="operator">操作员</option><option value="admin">管理员</option></select></label><Button disabled={!newUser.username.trim() || !newUser.password} loading={userBusy === "create"} variant="primary" type="submit">创建账户</Button></form>
            <div className={styles.tableScroller}><table className={`${styles.table} ${accessStyles.userTable}`}><thead><tr><th>账户</th><th>角色</th><th>状态</th><th aria-label="操作" /></tr></thead><tbody>{users.map(user => <tr key={user.id}><td><div className={styles.primaryCell}><strong>{user.username}</strong><small className={styles.mono}>ID {user.id}</small></div></td><td><select aria-label={`${user.username} 角色`} disabled={Boolean(userBusy)} onChange={event => void changeAccount(user, event.target.value as UserRole, user.active)} value={user.role}><option value="viewer">只读</option><option value="operator">操作员</option><option value="admin">管理员</option></select></td><td><label className={accessStyles.activeToggle}><input checked={user.active} disabled={Boolean(userBusy)} onChange={event => void changeAccount(user, user.role, event.target.checked)} type="checkbox" /><span>{user.active ? "启用" : "停用"}</span></label></td><td><div className={styles.rowActions}><Button loading={userBusy === `password:${user.id}`} size="compact" variant="ghost" onClick={() => setPasswordEdit({ id: user.id,
                username: user.username,
                password: "" })}>重置密码</Button></div></td></tr>)}</tbody></table></div>
            {passwordEdit && <form className={accessStyles.passwordForm} onSubmit={resetAccountPassword}><div><strong>重置 {passwordEdit.username} 的密码</strong><span>保存后该账户的现有会话和旧令牌立即失效。</span></div><input aria-label="新密码" autoFocus autoComplete="new-password" disabled={Boolean(userBusy)} onChange={event => setPasswordEdit({ ...passwordEdit,
                password: event.target.value })} placeholder="输入新密码" type="password" value={passwordEdit.password} /><Button disabled={!passwordEdit.password} loading={userBusy === `password:${passwordEdit.id}`} variant="primary" type="submit">保存新密码</Button><Button disabled={Boolean(userBusy)} variant="ghost" onClick={() => setPasswordEdit(undefined)} type="button">取消</Button></form>}
        </Panel>

        <Panel className={backupStyles.panel} flush id="backup-settings" tabIndex={-1}>
            <PanelHeader action={<div className={backupStyles.headerActions}><Button loading={backupBusy === "load"} size="compact" onClick={() => void loadBackups()}>刷新</Button><Button loading={backupBusy === "create"} size="compact" variant="primary" onClick={() => void createBackup()}>创建完整备份</Button></div>} description="保存 SQLite 一致性快照、数据库配置和托管 Compose 文件；所有内容都记录 SHA-256。" title="系统备份与恢复" />
            {backupFeedback && <Notice className={backupStyles.feedback} tone={backupFeedback.includes("重启") ? "warning" : undefined}>{backupFeedback}</Notice>}
            {restorePreview && <section className={backupStyles.restorePreview}><div><span className={backupStyles.eyebrow}>恢复预览</span><strong>{restorePreview.backup.id}</strong><p>已重新校验全部 {restorePreview.backup.fileCount} 个文件。恢复会覆盖现有数据库和备份中包含的 Compose 文件，但不会删除后来新增的其他项目。</p></div><dl><div><dt>覆盖文件</dt><dd>{restorePreview.overwriteCount}</dd></div><div><dt>新增文件</dt><dd>{restorePreview.newFileCount}</dd></div><div><dt>Compose</dt><dd>{restorePreview.stackFiles}</dd></div><div><dt>总大小</dt><dd>{formatBytes(restorePreview.backup.totalSize)}</dd></div></dl><div className={backupStyles.restoreActions}><Button disabled={Boolean(backupBusy)} variant="ghost" onClick={() => setRestorePreview(undefined)}>取消</Button><Button loading={backupBusy === `restore:${restorePreview.backup.id}`} variant="danger" onClick={() => void applyRestore()}>确认恢复并重启</Button></div></section>}
            {backups.length === 0 ? <div className={backupStyles.empty}><strong>还没有系统备份</strong><p>首次创建会快照当前账户、设置、审计数据和托管 Compose 文件。</p></div> : <div className={styles.tableScroller}><table className={`${styles.table} ${backupStyles.table}`}><thead><tr><th>备份</th><th>内容</th><th>大小</th><th>校验</th><th aria-label="操作" /></tr></thead><tbody>{backups.map(backup => <tr key={backup.id}><td><div className={styles.primaryCell}><strong className={styles.mono}>{backup.id}</strong><small>{backup.createdAt ? new Date(backup.createdAt).toLocaleString() : "清单不可读"} · v{backup.appVersion}</small></div></td><td><div className={styles.primaryCell}><strong>{backup.fileCount} 个文件</strong><small>{backup.stackFileCount} 个 Compose 文件</small></div></td><td className={styles.mono}>{formatBytes(backup.totalSize)}</td><td><span className={`${backupStyles.status} ${backupStyles[backup.status]}`}>{backup.status === "valid" ? "SHA-256 通过" : backup.status === "invalid" ? "校验失败" : "尚未校验"}</span>{backup.message && <small className={backupStyles.error}>{backup.message}</small>}</td><td><div className={styles.rowActions}><Button loading={backupBusy === `validate:${backup.id}`} size="compact" variant="ghost" onClick={() => void validateBackup(backup)}>校验</Button><Button disabled={backup.status === "invalid"} loading={backupBusy === `preview:${backup.id}`} size="compact" onClick={() => void prepareRestore(backup)}>恢复预览</Button><Button loading={backupBusy === `delete:${backup.id}`} size="compact" variant="danger" onClick={() => void removeBackup(backup)}>删除</Button></div></td></tr>)}</tbody></table></div>}
        </Panel>

        <Panel className={dockerStyles.dockerPanel} flush id="docker-settings" tabIndex={-1}>
            <PanelHeader action={<Button loading={dockerBusy === "load"} size="compact" onClick={() => void loadDockerConfig()}>刷新</Button>} description={dockerConfig ? `${dockerConfig.configPath} · 重启命令 ${dockerConfig.restartCommand}` : "读取 daemon.json 访问能力"} title="Docker 守护进程" />
            {!dockerConfig?.editable ? <div className={dockerStyles.disabledState}><strong>配置编辑未启用</strong><p>{dockerConfig?.reason || (dockerBusy === "load" ? "正在检查 daemon.json 挂载和写入权限…" : "未获取到配置访问状态。")}</p><code>DOCKERBRIDGE_DAEMON_JSON=/host/etc/docker/daemon.json</code></div> : <>
                {dockerFeedback && <Notice className={dockerStyles.feedback} tone="warning">{dockerFeedback}<Button loading={dockerBusy === "restart"} size="compact" onClick={() => void restartDaemon()}>重启 Docker</Button></Notice>}
                <fieldset className={dockerStyles.fields} disabled={Boolean(dockerBusy)}>
                    <label><span>镜像加速地址</span><textarea onChange={event => updateDocker("registryMirrors", parseLines(event.target.value))} placeholder="https://mirror.example.com" rows={3} value={lines(dockerForm.registryMirrors)} /><small>每行一个 HTTP/HTTPS 地址。</small></label>
                    <label><span>DNS 服务器</span><textarea onChange={event => updateDocker("dns", parseLines(event.target.value))} placeholder={"1.1.1.1\n8.8.8.8"} rows={3} value={lines(dockerForm.dns)} /><small>只接受 IPv4 或 IPv6 地址。</small></label>
                    <label><span>HTTP 代理</span><input onChange={event => updateDocker("httpProxy", event.target.value)} placeholder="http://proxy.example.com:3128" value={dockerForm.httpProxy} /></label>
                    <label><span>HTTPS 代理</span><input onChange={event => updateDocker("httpsProxy", event.target.value)} placeholder="http://proxy.example.com:3128" value={dockerForm.httpsProxy} /></label>
                    <label className={dockerStyles.wide}><span>不使用代理</span><input onChange={event => updateDocker("noProxy", event.target.value)} placeholder="localhost,127.0.0.1,.internal" value={dockerForm.noProxy} /></label>
                    <label className={dockerStyles.wide}><span>不安全 Registry</span><textarea onChange={event => updateDocker("insecureRegistries", parseLines(event.target.value))} placeholder="registry.internal:5000" rows={2} value={lines(dockerForm.insecureRegistries)} /><small>每行一个主机名或主机名:端口。</small></label>
                    <label><span>日志驱动</span><select onChange={event => updateDocker("logDriver", event.target.value)} value={dockerForm.logDriver}><option value="">Docker 默认</option><option value="json-file">json-file</option><option value="local">local</option><option value="journald">journald</option><option value="syslog">syslog</option><option value="none">none</option></select></label>
                    <label><span>单文件上限</span><input onChange={event => updateDocker("logMaxSize", event.target.value)} placeholder="10m" value={dockerForm.logMaxSize} /></label>
                    <label><span>保留文件数</span><input inputMode="numeric" onChange={event => updateDocker("logMaxFile", event.target.value)} placeholder="3" value={dockerForm.logMaxFile} /></label>
                </fieldset>
                <div className={dockerStyles.configActions}><span>保存前必须先生成服务端校验预览。</span><Button loading={dockerBusy === "preview"} onClick={() => void previewConfig()}>校验并预览</Button></div>
                {preview && <section className={dockerStyles.preview}><header><div><h4>{preview.changed ? "配置变更预览" : "没有配置变化"}</h4><p>{preview.changedKeys.length > 0 ? `变更键：${preview.changedKeys.join(", ")}` : "当前表单与 daemon.json 一致。"}</p></div><Button disabled={!preview.changed} loading={dockerBusy === "save"} variant="primary" onClick={() => void saveConfig()}>写入 daemon.json</Button></header><div><article><span>当前配置</span><pre>{JSON.stringify(preview.beforeConfig, null, 2)}</pre></article><article><span>将写入</span><pre>{JSON.stringify(preview.nextConfig, null, 2)}</pre></article></div></section>}
                <section className={dockerStyles.backups}><header><h4>配置备份</h4><p>每次写入前自动生成，恢复后仍需重启 Docker。</p></header>{dockerConfig.backups.length === 0 ? <p className={dockerStyles.emptyCopy}>还没有 Docker 配置备份。</p> : <div className={styles.tableScroller}><table className={styles.table}><thead><tr><th>备份</th><th>时间</th><th>大小</th><th aria-label="操作" /></tr></thead><tbody>{dockerConfig.backups.map(backup => <tr key={backup.file}><td className={styles.mono}>{backup.filename}</td><td>{new Date(backup.createdAt).toLocaleString()}</td><td className={styles.mono}>{formatBytes(backup.size)}</td><td><div className={styles.rowActions}><Button loading={dockerBusy === "rollback"} size="compact" onClick={() => void rollbackConfig(backup.file)}>恢复</Button></div></td></tr>)}</tbody></table></div>}</section>
            </>}
        </Panel>
        <div className={styles.pageVersion}>前端版本 {FRONTEND_VERSION}</div>
        {failure && <FailureDialog description="DockerBridge 返回了原始操作错误，操作未按预期完成。" details={[{ label: "操作",
            value: failure.action }, { label: failure.contextLabel || "配置路径",
            value: failure.contextValue || dockerConfig?.configPath || "未启用" }]} message={failure.message} onClose={() => setFailure(undefined)} open title={`${failure.action}失败`} />}
    </div>;
}
