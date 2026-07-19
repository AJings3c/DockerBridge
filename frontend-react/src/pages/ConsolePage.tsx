import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { emitAgentWithAck, realtime } from "@/services/realtime/client";
import { ApiResponse } from "@/types/domain";
import { Notice, PageHeader, Panel } from "@/components/ui";
import { StatusBadge } from "@/components/primitives/StatusBadge";
import { createConsoleTerminalName } from "@/services/terminal";
import styles from "./Page.module.css";

interface ConsoleProfile {
    target: "host" | "runtime";
    shell: string;
    platform: string;
    label: string;
    transport?: "pty" | "pipe";
}

interface ConsolePolicy {
    idleTimeoutSeconds: number;
    maxSessions: number;
}

export function ConsolePage() {
    const host = useRef<HTMLDivElement>(null);
    const [ error, setError ] = useState("");
    const [ profile, setProfile ] = useState<ConsoleProfile>();
    const [ policy, setPolicy ] = useState<ConsolePolicy>();

    useEffect(() => {
        if (!host.current) {
            return;
        }
        const terminal = new Terminal({
            cursorBlink: true,
            fontFamily: "JetBrains Mono, Consolas, monospace",
            fontSize: 13,
            theme: {
                background: "#080d14",
                foreground: "#eef3f8",
                cursor: "#58a6ff",
                selectionBackground: "#1f4d73",
            },
        });
        const fit = new FitAddon();
        terminal.loadAddon(fit);
        terminal.open(host.current);
        fit.fit();
        const terminalName = createConsoleTerminalName();
        const offWrite = realtime.on("agent", (event : unknown, name : unknown, data : unknown, metadata : unknown) => {
            if (event === "terminalWrite" && name === terminalName && typeof data === "string") {
                terminal.write(data);
            } else if (event === "terminalExit" && name === terminalName) {
                const reason = metadata && typeof metadata === "object" && "reason" in metadata ? String((metadata as { reason?: unknown }).reason || "") : "";
                const reasonLabel = reason === "idle_timeout" ? "空闲超时" : reason === "socket_disconnect" ? "连接断开" : reason === "client_close" ? "页面关闭" : "进程退出";
                setError(`终端已关闭（${reasonLabel}${typeof data === "number" ? `，退出码 ${data}` : ""}）。`);
            }
        });
        void emitAgentWithAck<ApiResponse & { profile?: ConsoleProfile; policy?: ConsolePolicy }>("", "mainTerminal", terminalName)
            .then(response => {
                if (!response.ok) {
                    setError(response.msg === "Console is not enabled."
                        ? "终端尚未启用。请设置 DOCKERBRIDGE_ENABLE_CONSOLE=true；宿主机终端还需额外配置 pid/privileged。"
                        : response.msg || "无法启动终端，请检查 shell 与部署权限。 ");
                    return;
                }
                setProfile(response.profile);
                setPolicy(response.policy);
            })
            .catch(error => {
                setError(error instanceof Error ? `终端连接失败：${error.message}` : "终端连接失败，请检查运行服务连接。 ");
            });
        const input = terminal.onData(data => {
            realtime.emit("agent", "", "terminalInput", terminalName, data, () => undefined);
        });
        const resize = new ResizeObserver(() => {
            fit.fit();
            realtime.emit("agent", "", "terminalResize", terminalName, terminal.rows, terminal.cols, () => undefined);
        });
        resize.observe(host.current);
        return () => {
            realtime.emit("agent", "", "closeMainTerminal", terminalName, () => undefined);
            resize.disconnect();
            input.dispose();
            offWrite();
            terminal.dispose();
        };
    }, []);

    return (
        <div className={styles.page}>
            <PageHeader
                actions={profile && <StatusBadge label={`${profile.target === "host" ? "宿主机" : "运行环境"} · ${profile.label} · ${profile.shell}${profile.transport === "pipe" ? " · 兼容模式" : ""}`} status="online" />}
                description="命令会在标注的目标系统中执行，请谨慎操作。"
                title="主机终端"
            />
            {error && <Notice tone="error">{error}</Notice>}
            {policy && <Notice>会话空闲 {Math.max(1, Math.round(policy.idleTimeoutSeconds / 60))} 分钟后自动关闭，最多允许 {policy.maxSessions} 个并发终端。会话开关会进入审计，但命令和输出不会被记录。</Notice>}
            <Panel className={styles.terminalPanel} flush><div className={styles.terminalFrame} ref={host} /></Panel>
        </div>
    );
}
