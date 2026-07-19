import { KeyboardEvent, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/primitives/Button";
import { Icon } from "@/components/Icon";
import { FailureDialog, Notice, useModalDialog } from "@/components/ui";
import { ComposeDraftRequest, previewComposeDraft, previewComposeRevision, queryComposeEditor, queryComposeRevisions, restoreComposeRevision, saveComposeDraft } from "@/services/runtime";
import { ComposeEditorPreview, ComposeRevisionSummary, EndpointSummary, StackSummary } from "@/types/domain";
import styles from "./ComposeEditor.module.css";

const NEW_COMPOSE = `services:
  app:
    image: nginx:alpine
    restart: unless-stopped
    ports:
      - "8080:80"
`;

type EditorSection = "compose" | "environment" | "history";

interface EditorFailure {
    action: string;
    message: string;
    saved?: boolean;
}

interface ComposeEditorDialogProps {
    stack?: StackSummary;
    endpoints: EndpointSummary[];
    onClose: () => void;
    onSaved: () => void;
}

function revisionReason(reason : ComposeRevisionSummary["reason"]) {
    return { save: "保存",
        deploy: "保存并部署",
        rollback: "版本恢复",
        "pre-change": "变更前快照" }[reason];
}

function formatBytes(value : number) {
    return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KiB`;
}

function sourceLines(source : string) {
    return source ? source.split(/\r?\n/).length : 0;
}

export function ComposeEditorDialog({ stack, endpoints, onClose, onSaved } : ComposeEditorDialogProps) {
    const dialogRef = useModalDialog();
    const isInitialAdd = !stack;
    const onlineEndpoints = useMemo(() => endpoints.filter(endpoint => endpoint.status === "online"), [ endpoints ]);
    const [ endpoint, setEndpoint ] = useState(stack?.endpoint || onlineEndpoints[0]?.endpoint || "");
    const [ name, setName ] = useState(stack?.name || "");
    const [ baselineName, setBaselineName ] = useState(stack?.name || "");
    const [ composeYAML, setComposeYAML ] = useState(isInitialAdd ? NEW_COMPOSE : "");
    const [ composeENV, setComposeENV ] = useState("");
    const [ baseline, setBaseline ] = useState({ composeYAML: isInitialAdd ? NEW_COMPOSE : "",
        composeENV: "" });
    const [ sourceVersion, setSourceVersion ] = useState(isInitialAdd ? "new" : "");
    const [ revisions, setRevisions ] = useState<ComposeRevisionSummary[]>([]);
    const [ section, setSection ] = useState<EditorSection>("compose");
    const [ loading, setLoading ] = useState(!isInitialAdd);
    const [ busy, setBusy ] = useState("");
    const [ created, setCreated ] = useState(false);
    const [ editable, setEditable ] = useState(isInitialAdd);
    const [ preview, setPreview ] = useState<ComposeEditorPreview>();
    const [ revisionPreview, setRevisionPreview ] = useState<ComposeEditorPreview>();
    const [ feedback, setFeedback ] = useState("");
    const [ failure, setFailure ] = useState<EditorFailure>();
    const isAdd = isInitialAdd && !created;
    const dirty = name !== baselineName || composeYAML !== baseline.composeYAML || composeENV !== baseline.composeENV;
    const endpointState = endpoints.find(item => item.endpoint === endpoint);
    const endpointOnline = endpointState?.status === "online" || (!endpointState && endpoint === "");

    const close = () => {
        if (dirty && !window.confirm("当前 Compose 草稿尚未保存，确认关闭编辑器？")) {
            return;
        }
        onClose();
    };

    useEffect(() => {
        if (!stack) {
            return;
        }
        void queryComposeEditor(stack.endpoint, stack.name).then(response => {
            if (!response.ok) {
                setFailure({ action: "读取 Compose 源文件",
                    message: response.msg || "读取 Compose 源文件失败" });
                setLoading(false);
                return;
            }
            setComposeYAML(response.editor.composeYAML);
            setComposeENV(response.editor.composeENV);
            setBaseline({ composeYAML: response.editor.composeYAML,
                composeENV: response.editor.composeENV });
            setSourceVersion(response.editor.sourceVersion);
            setRevisions(response.editor.revisions);
            setEditable(response.editor.endpointEditable);
            setLoading(false);
        });
    }, [ stack ]);

    const changeCompose = (value : string) => {
        setComposeYAML(value);
        setPreview(undefined);
        setRevisionPreview(undefined);
        setFeedback("");
    };

    const changeEnvironment = (value : string) => {
        setComposeENV(value);
        setPreview(undefined);
        setRevisionPreview(undefined);
        setFeedback("");
    };

    const draft = () : ComposeDraftRequest => ({ name: name.trim(),
        composeYAML,
        composeENV,
        isAdd,
        expectedSourceVersion: sourceVersion });

    const validate = async () => {
        setBusy("validate");
        setFeedback("");
        const response = await previewComposeDraft(endpoint, draft());
        setBusy("");
        if (!response.ok) {
            setFailure({ action: "校验 Compose 草稿",
                message: response.msg || "Compose 草稿校验失败" });
            return;
        }
        setPreview(response.preview);
        setFeedback(response.preview.changed ? "服务端校验已通过，可以保存当前变更。" : "服务端校验已通过，源文件没有变化。 ");
    };

    const save = async (deploy : boolean) => {
        if (!preview || preview.proposedSourceVersion !== previewSourceVersion()) {
            return;
        }
        if (deploy && !window.confirm(`确认保存并部署 Compose 项目 ${name.trim()}？运行中的服务可能被重建。`)) {
            return;
        }
        setBusy(deploy ? "deploy" : "save");
        setFeedback("");
        const response = await saveComposeDraft(endpoint, draft(), deploy);
        setBusy("");
        if (!response.ok) {
            if (response.saved && response.sourceVersion) {
                setSourceVersion(response.sourceVersion);
                setRevisions(response.revisions || []);
                setBaseline({ composeYAML,
                    composeENV });
                setBaselineName(name);
                setCreated(true);
                setPreview(undefined);
                onSaved();
            }
            setFailure({ action: deploy ? "保存并部署 Compose" : "保存 Compose 草稿",
                message: response.msg || "Compose 保存失败",
                saved: response.saved });
            return;
        }
        setSourceVersion(response.sourceVersion);
        setRevisions(response.revisions);
        setBaseline({ composeYAML,
            composeENV });
        setBaselineName(name);
        setCreated(true);
        setPreview(undefined);
        setFeedback(deploy ? "Compose 已保存并完成部署。" : "Compose 草稿已保存并生成版本快照。 ");
        onSaved();
    };

    const refreshHistory = async () => {
        if (isAdd) {
            return;
        }
        setBusy("history");
        const response = await queryComposeRevisions(endpoint, name);
        setBusy("");
        if (!response.ok) {
            setFailure({ action: "刷新 Compose 版本",
                message: response.msg || "读取版本历史失败" });
            return;
        }
        setRevisions(response.revisions);
    };

    const inspectRevision = async (revision : ComposeRevisionSummary) => {
        setBusy(`revision:${revision.id}`);
        const response = await previewComposeRevision(endpoint, name, revision.id);
        setBusy("");
        if (!response.ok) {
            setFailure({ action: "校验 Compose 历史版本",
                message: response.msg || "版本校验失败" });
            return;
        }
        setRevisionPreview(response.preview);
    };

    const restoreRevision = async (deploy : boolean) => {
        if (!revisionPreview?.revision || !revisionPreview.composeYAML || revisionPreview.composeENV === undefined) {
            return;
        }
        if (!window.confirm(`确认恢复版本 ${revisionPreview.revision.id}${deploy ? " 并立即部署" : " 为当前草稿"}？`)) {
            return;
        }
        setBusy(deploy ? "restore-deploy" : "restore");
        const response = await restoreComposeRevision(endpoint, name, revisionPreview.revision.id, sourceVersion, deploy);
        setBusy("");
        if (response.ok || response.saved) {
            setComposeYAML(revisionPreview.composeYAML);
            setComposeENV(revisionPreview.composeENV);
            setBaseline({ composeYAML: revisionPreview.composeYAML,
                composeENV: revisionPreview.composeENV });
            setBaselineName(name);
            setSourceVersion(response.sourceVersion);
            setRevisions(response.revisions || []);
            setRevisionPreview(undefined);
            setPreview(undefined);
            onSaved();
        }
        if (!response.ok) {
            setFailure({ action: deploy ? "恢复并部署 Compose 版本" : "恢复 Compose 版本",
                message: response.msg || "Compose 版本恢复失败",
                saved: response.saved });
            return;
        }
        setFeedback(deploy ? "历史版本已恢复并部署。" : "历史版本已恢复为当前草稿。 ");
        setSection("compose");
    };

    const previewSourceVersion = () => preview?.proposedSourceVersion || "";
    const canValidate = editable && endpointOnline && Boolean(name.trim()) && Boolean(composeYAML.trim()) && !loading && !busy;
    const canSave = Boolean(preview?.changed) && !busy;
    const editorSections : EditorSection[] = isAdd ? [ "compose", "environment" ] : [ "compose", "environment", "history" ];
    const handleTabKeyDown = (event : KeyboardEvent<HTMLElement>) => {
        if (![ "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End" ].includes(event.key)) {
            return;
        }
        event.preventDefault();
        const currentIndex = Math.max(0, editorSections.indexOf(section));
        const nextIndex = event.key === "Home"
            ? 0
            : event.key === "End"
                ? editorSections.length - 1
                : [ "ArrowRight", "ArrowDown" ].includes(event.key)
                    ? (currentIndex + 1) % editorSections.length
                    : (currentIndex - 1 + editorSections.length) % editorSections.length;
        const nextSection = editorSections[nextIndex];
        setSection(nextSection);
        window.requestAnimationFrame(() => document.getElementById(`compose-tab-${nextSection}`)?.focus());
    };

    return <>
        <dialog aria-labelledby="compose-editor-title" className={styles.dialog} onCancel={event => {
            event.preventDefault();
            close();
        }} onClick={event => {
            if (event.target === event.currentTarget) {
                close();
            }
        }} ref={dialogRef}>
            <div className={styles.content}>
                <header className={styles.header}><div><span>{isAdd ? "新建 Compose 项目" : stack?.composeFilePath}</span><h2 id="compose-editor-title">{isAdd ? "Compose 工作区" : name}</h2></div><button aria-label="关闭编辑器" className={styles.closeButton} onClick={close} type="button"><Icon name="close" /></button></header>
                <div className={styles.identity}><label><span>项目名称</span><input autoFocus={isAdd} disabled={!isAdd || loading || Boolean(busy)} onChange={event => {
                    setName(event.target.value.toLocaleLowerCase());
                    setPreview(undefined);
                }} placeholder="my-service" value={name} /></label><label><span>运行节点</span><select disabled={!isAdd || created || loading || Boolean(busy)} onChange={event => {
                    setEndpoint(event.target.value);
                    setPreview(undefined);
                }} value={endpoint}>{onlineEndpoints.length === 0 && <option value="">本机</option>}{onlineEndpoints.map(item => <option key={item.endpoint || "local"} value={item.endpoint}>{item.name || item.endpoint || "本机"}</option>)}</select></label><div className={styles.sourceVersion}><span>源版本</span><code>{sourceVersion === "new" ? "尚未保存" : sourceVersion.slice(0, 12)}</code></div></div>
                <nav aria-label="Compose 编辑区域" className={styles.tabs} onKeyDown={handleTabKeyDown} role="tablist"><Button aria-controls="compose-panel-compose" aria-selected={section === "compose"} id="compose-tab-compose" role="tab" size="compact" tabIndex={section === "compose" ? 0 : -1} variant={section === "compose" ? "primary" : "ghost"} onClick={() => setSection("compose")}>Compose YAML</Button><Button aria-controls="compose-panel-environment" aria-selected={section === "environment"} id="compose-tab-environment" role="tab" size="compact" tabIndex={section === "environment" ? 0 : -1} variant={section === "environment" ? "primary" : "ghost"} onClick={() => setSection("environment")}>环境变量</Button><Button aria-controls="compose-panel-history" aria-selected={section === "history"} disabled={isAdd} id="compose-tab-history" role="tab" size="compact" tabIndex={section === "history" ? 0 : -1} variant={section === "history" ? "primary" : "ghost"} onClick={() => setSection("history")}><Icon name="history" size={14} />版本历史</Button><span>{dirty ? "未保存变更" : "与已保存版本一致"}</span></nav>
                {!endpointOnline && <Notice className={styles.notice} tone="error">运行节点当前不可用，编辑与保存已禁用。</Notice>}
                {!editable && !loading && <Notice className={styles.notice} tone="error">当前 Compose 文件或所在目录不可写。</Notice>}
                {feedback && <Notice className={styles.notice}>{feedback}</Notice>}
                <div className={styles.body}>
                    {loading ? <div className={styles.loading}>正在读取 Compose 源文件…</div> : section === "compose" ? <section aria-labelledby="compose-tab-compose" className={styles.editorPane} id="compose-panel-compose" role="tabpanel"><header><div><strong>compose.yaml</strong><span>{sourceLines(composeYAML)} 行 · {formatBytes(new Blob([ composeYAML ]).size)}</span></div></header><textarea aria-label="Compose YAML" autoCapitalize="off" autoCorrect="off" disabled={!editable || Boolean(busy)} onChange={event => changeCompose(event.target.value)} spellCheck={false} value={composeYAML} /></section> : section === "environment" ? <section aria-labelledby="compose-tab-environment" className={styles.editorPane} id="compose-panel-environment" role="tabpanel"><header><div><strong>.env</strong><span>{sourceLines(composeENV)} 行 · 值仅在管理员编辑器中显示</span></div></header><textarea aria-label="Compose 环境变量" autoCapitalize="off" autoComplete="off" autoCorrect="off" disabled={!editable || Boolean(busy)} onChange={event => changeEnvironment(event.target.value)} placeholder="APP_ENV=production" spellCheck={false} value={composeENV} /></section> : <section aria-labelledby="compose-tab-history" className={styles.historyPane} id="compose-panel-history" role="tabpanel"><header><div><strong>版本快照</strong><span>保留最近 {revisions.length} 个可恢复版本</span></div><Button loading={busy === "history"} size="compact" onClick={() => void refreshHistory()}><Icon name="refresh" size={14} />刷新</Button></header>{revisions.length === 0 ? <div className={styles.emptyHistory}>保存一次草稿后会生成首个版本快照。</div> : <div className={styles.historyScroller}><table><thead><tr><th>版本</th><th>来源</th><th>时间</th><th>大小</th><th aria-label="操作" /></tr></thead><tbody>{revisions.map(revision => <tr key={revision.id}><td><code>{revision.id}</code></td><td>{revisionReason(revision.reason)}</td><td>{revision.createdAt ? new Date(revision.createdAt).toLocaleString() : "清单不可读"}</td><td>{formatBytes(revision.composeSize + revision.environmentSize)}</td><td><Button disabled={revision.status === "invalid"} loading={busy === `revision:${revision.id}`} size="compact" onClick={() => void inspectRevision(revision)}>校验与预览</Button></td></tr>)}</tbody></table></div>}</section>}
                    {preview && section !== "history" && <section className={styles.preview}><header><div><strong>{preview.changed ? "变更预览" : "没有源文件变化"}</strong><span>结构校验 · Docker {preview.validation.docker === "valid" ? "Compose 校验通过" : "CLI 不可用"}</span></div></header><dl><div><dt>服务</dt><dd>{preview.validation.serviceNames.length}</dd></div><div><dt>YAML</dt><dd>+{preview.changes.compose.added} / -{preview.changes.compose.removed}</dd></div><div><dt>.env</dt><dd>+{preview.changes.environment.added} / -{preview.changes.environment.removed}</dd></div><div><dt>网络 / 卷</dt><dd>{preview.validation.networkNames.length} / {preview.validation.volumeNames.length}</dd></div></dl><div className={styles.changeRows}><span>新增服务：{preview.changes.servicesAdded.join(", ") || "无"}</span><span>移除服务：{preview.changes.servicesRemoved.join(", ") || "无"}</span><span>变更服务：{preview.changes.servicesChanged.join(", ") || "无"}</span><span>环境键变化：{[ ...preview.changes.environmentKeysAdded, ...preview.changes.environmentKeysRemoved, ...preview.changes.environmentKeysChanged ].join(", ") || "无"}</span></div>{preview.validation.warnings.length > 0 && <p>{preview.validation.warnings.join("；")}</p>}</section>}
                    {revisionPreview && section === "history" && <section className={styles.revisionPreview}><div><span>恢复预览</span><strong>{revisionPreview.revision?.id}</strong><p>YAML +{revisionPreview.changes.compose.added} / -{revisionPreview.changes.compose.removed}，环境键变化 {[ ...revisionPreview.changes.environmentKeysAdded, ...revisionPreview.changes.environmentKeysRemoved, ...revisionPreview.changes.environmentKeysChanged ].length} 项。</p></div><div className={styles.revisionActions}><Button disabled={Boolean(busy)} onClick={() => setRevisionPreview(undefined)}>取消</Button><Button loading={busy === "restore"} onClick={() => void restoreRevision(false)}>恢复为草稿</Button><Button loading={busy === "restore-deploy"} variant="danger" onClick={() => void restoreRevision(true)}>恢复并部署</Button></div></section>}
                </div>
                <footer className={styles.actions}><span>{preview ? `已校验 ${preview.proposedSourceVersion.slice(0, 12)}` : "保存前需要服务端校验"}</span><Button disabled={Boolean(busy)} variant="ghost" onClick={close}>关闭</Button><Button disabled={!canValidate} loading={busy === "validate"} onClick={() => void validate()}>校验并预览</Button><Button disabled={!canSave} loading={busy === "save"} onClick={() => void save(false)}><Icon name="save" size={15} />保存草稿</Button><Button disabled={!canSave} loading={busy === "deploy"} variant="primary" onClick={() => void save(true)}><Icon name="play" size={15} />保存并部署</Button></footer>
            </div>
        </dialog>
        {failure && <FailureDialog description={failure.saved ? "源文件与版本快照已经保存，但运行态操作失败。" : "Compose 编辑操作未完成，当前源文件未按预期更新。"} details={[{ label: "项目",
            value: name || "尚未命名" }, { label: "节点",
            value: endpointState?.name || endpoint || "本机" }, { label: "文件状态",
            value: failure.saved ? "已保存，部署失败" : "未确认保存" }]} message={failure.message} onClose={() => setFailure(undefined)} open title={`${failure.action}失败`} />}
    </>;
}
