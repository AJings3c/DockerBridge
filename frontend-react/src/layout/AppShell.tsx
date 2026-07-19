import { CSSProperties, PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { Icon, IconName } from "@/components/Icon";
import { Button } from "@/components/primitives/Button";
import { useAppSelector } from "@/store/hooks";
import { logout } from "@/services/session";
import { UserPermission } from "@/types/domain";
import styles from "./AppShell.module.css";

interface NavigationItem {
    to: string;
    label: string;
    icon: IconName;
    mobile?: boolean;
    permission?: UserPermission;
}

type Theme = "light" | "dark";

interface DrawerGesture {
    pointerId: number;
    startX: number;
    startOffset: number;
    lastX: number;
    lastTime: number;
    velocity: number;
    width: number;
}

function projectVelocity(velocity: number, decelerationRate = 0.998) {
    return (velocity / 1000) * decelerationRate / (1 - decelerationRate);
}

function rubberband(overshoot: number, dimension: number, constant = 0.55) {
    return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

function initialTheme() : Theme {
    const stored = localStorage.getItem("dockerbridge-theme");
    if (stored === "light" || stored === "dark") {
        return stored;
    }
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

const workspaceItems : NavigationItem[] = [
    { to: "/",
        label: "运行概览",
        icon: "dashboard",
        mobile: true },
    { to: "/containers",
        label: "容器与镜像",
        icon: "box",
        mobile: true },
    { to: "/resources",
        label: "网络与卷",
        icon: "network" },
    { to: "/compose",
        label: "Compose 项目",
        icon: "compose",
        mobile: true },
    { to: "/compose-repository",
        label: "Compose 仓库",
        icon: "database",
        mobile: true },
];

const toolItems : NavigationItem[] = [
    { to: "/operations",
        label: "操作审计",
        icon: "history" },
    { to: "/agents",
        label: "Agent 节点",
        icon: "server",
        permission: "agents" },
    { to: "/console",
        label: "终端",
        icon: "terminal",
        permission: "terminal" },
    { to: "/settings",
        label: "系统设置",
        icon: "settings",
        permission: "settings" },
];

const pageMeta = [
    { match: (path : string) => path === "/",
        title: "运行概览",
        description: "本机 Docker 工作负载与异常状态" },
    { match: (path : string) => path.startsWith("/containers"),
        title: "容器与镜像",
        description: "生命周期、资源、端口和镜像" },
    { match: (path : string) => path.startsWith("/resources"),
        title: "网络与卷",
        description: "依赖关系、孤立资源与安全变更" },
    { match: (path : string) => path === "/compose",
        title: "Compose 项目",
        description: "已登记项目的运行与部署状态" },
    { match: (path : string) => path.startsWith("/compose-repository"),
        title: "Compose 仓库",
        description: "扫描、筛选并定位宿主机 Compose 配置" },
    { match: (path : string) => path.startsWith("/console"),
        title: "终端",
        description: "DockerBridge 命令执行环境" },
    { match: (path : string) => path.startsWith("/operations"),
        title: "操作审计",
        description: "关键操作结果、变更快照与失败线索" },
    { match: (path : string) => path.startsWith("/agents"),
        title: "Agent 节点",
        description: "远程节点登记、诊断、兼容性与凭据" },
    { match: (path : string) => path.startsWith("/settings"),
        title: "系统设置",
        description: "平台偏好、安全与运行配置" },
];

function Navigation({ label, items, permissions, onNavigate } : { label: string; items: NavigationItem[]; permissions: UserPermission[]; onNavigate?: () => void }) {
    return (
        <nav aria-label={label} className={styles.navigation}>
            {items.filter(item => !item.permission || permissions.includes(item.permission)).map(item => (
                <NavLink
                    className={({ isActive }) => `${styles.navLink} ${isActive ? styles.active : ""}`}
                    end={item.to === "/"}
                    key={item.to}
                    onClick={onNavigate}
                    to={item.to}
                >
                    <span className={styles.navIcon}><Icon name={item.icon} /></span>
                    <span>{item.label}</span>
                </NavLink>
            ))}
        </nav>
    );
}

export function AppShell() {
    const location = useLocation();
    const session = useAppSelector(state => state.session);
    const [ menuOpen, setMenuOpen ] = useState(false);
    const [ theme, setTheme ] = useState<Theme>(initialTheme);
    const [ drawerOffset, setDrawerOffset ] = useState(0);
    const [ drawerMoving, setDrawerMoving ] = useState(false);
    const sidebarRef = useRef<HTMLElement>(null);
    const menuButtonRef = useRef<HTMLButtonElement>(null);
    const closeButtonRef = useRef<HTMLButtonElement>(null);
    const drawerGestureRef = useRef<DrawerGesture | null>(null);
    const drawerAnimationRef = useRef<number | null>(null);
    const meta = pageMeta.find(item => item.match(location.pathname)) || pageMeta[0];

    const drawerWidth = () => sidebarRef.current?.getBoundingClientRect().width || 300;

    const readDrawerOffset = () => {
        const sidebar = sidebarRef.current;
        if (!sidebar) {
            return 0;
        }
        const transform = getComputedStyle(sidebar).transform;
        if (transform === "none") {
            return menuOpen ? 0 : -drawerWidth();
        }
        const matrix = transform.match(/^matrix(3d)?\((.+)\)$/);
        if (!matrix) {
            return 0;
        }
        const values = matrix[2].split(",").map(Number);
        return matrix[1] ? values[12] || 0 : values[4] || 0;
    };

    const stopDrawerAnimation = () => {
        if (drawerAnimationRef.current !== null) {
            window.cancelAnimationFrame(drawerAnimationRef.current);
            drawerAnimationRef.current = null;
        }
    };

    const animateDrawer = (target: number, initialVelocity = 0, closeOnEnd = false) => {
        stopDrawerAnimation();
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            setDrawerMoving(false);
            setDrawerOffset(target);
            if (closeOnEnd) {
                setMenuOpen(false);
                setDrawerOffset(0);
            }
            return;
        }
        setDrawerMoving(true);
        let position = readDrawerOffset();
        let velocity = initialVelocity;
        let lastTime = performance.now();
        const tick = (time: number) => {
            const delta = Math.min((time - lastTime) / 1000, 0.032);
            lastTime = time;
            const acceleration = (target - position) * 260 - velocity * 34;
            velocity += acceleration * delta;
            position += velocity * delta;
            setDrawerOffset(position);
            if (Math.abs(target - position) < 0.5 && Math.abs(velocity) < 4) {
                setDrawerOffset(target);
                setDrawerMoving(false);
                drawerAnimationRef.current = null;
                if (closeOnEnd) {
                    setMenuOpen(false);
                    setDrawerOffset(0);
                }
                return;
            }
            drawerAnimationRef.current = window.requestAnimationFrame(tick);
        };
        drawerAnimationRef.current = window.requestAnimationFrame(tick);
    };

    const openMenu = () => {
        stopDrawerAnimation();
        const width = drawerWidth();
        setDrawerOffset(-width);
        setMenuOpen(true);
        window.requestAnimationFrame(() => {
            setDrawerMoving(false);
            setDrawerOffset(0);
        });
    };

    const dismissMenu = () => {
        if (!menuOpen) {
            return;
        }
        animateDrawer(-drawerWidth(), 0, true);
    };

    useEffect(() => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.colorScheme = theme;
        document.querySelector("meta[name='theme-color']")?.setAttribute("content", theme === "dark" ? "#1b1b1d" : "#f5f5f7");
        localStorage.setItem("dockerbridge-theme", theme);
    }, [ theme ]);

    useEffect(() => {
        stopDrawerAnimation();
        setMenuOpen(false);
        setDrawerOffset(0);
    }, [ location.pathname ]);

    useEffect(() => () => {
        stopDrawerAnimation();
        document.body.style.userSelect = "";
    }, []);

    useEffect(() => {
        if (!menuOpen) {
            return;
        }
        const previousOverflow = document.body.style.overflow;
        const focusFrame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
        const handleKeyDown = (event : KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                dismissMenu();
                menuButtonRef.current?.focus();
            }
        };
        document.body.style.overflow = "hidden";
        window.addEventListener("keydown", handleKeyDown);
        return () => {
            window.cancelAnimationFrame(focusFrame);
            document.body.style.overflow = previousOverflow;
            window.removeEventListener("keydown", handleKeyDown);
        };
    }, [ menuOpen ]);

    const closeMenu = () => {
        dismissMenu();
        menuButtonRef.current?.focus();
    };

    const handleDrawerPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
        if (!menuOpen || event.pointerType === "mouse") {
            return;
        }
        const width = drawerWidth();
        stopDrawerAnimation();
        const now = performance.now();
        event.currentTarget.setPointerCapture(event.pointerId);
        drawerGestureRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startOffset: readDrawerOffset(),
            lastX: event.clientX,
            lastTime: now,
            velocity: 0,
            width,
        };
        setDrawerMoving(true);
        document.body.style.userSelect = "none";
    };

    const handleDrawerPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
        const gesture = drawerGestureRef.current;
        if (!gesture || gesture.pointerId !== event.pointerId) {
            return;
        }
        const now = performance.now();
        const delta = event.clientX - gesture.startX;
        const rawOffset = gesture.startOffset + delta;
        const offset = rawOffset > 0
            ? rubberband(rawOffset, gesture.width)
            : rawOffset < -gesture.width
                ? -gesture.width - rubberband(-gesture.width - rawOffset, gesture.width)
                : rawOffset;
        const elapsed = Math.max(now - gesture.lastTime, 1);
        gesture.velocity = ((event.clientX - gesture.lastX) / elapsed) * 1000;
        gesture.lastX = event.clientX;
        gesture.lastTime = now;
        setDrawerOffset(offset);
    };

    const handleDrawerPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
        const gesture = drawerGestureRef.current;
        if (!gesture || gesture.pointerId !== event.pointerId) {
            return;
        }
        event.currentTarget.releasePointerCapture(event.pointerId);
        const current = readDrawerOffset();
        const projected = current + projectVelocity(gesture.velocity);
        const target = projected < -gesture.width / 2 ? -gesture.width : 0;
        drawerGestureRef.current = null;
        document.body.style.userSelect = "";
        animateDrawer(target, gesture.velocity, target === -gesture.width);
    };

    return (
        <div className={styles.shell}>
            <a className={styles.skipLink} href="#main-content">跳到主要内容</a>
            <aside
                aria-label="应用导航"
                className={`${styles.sidebar} ${menuOpen ? styles.sidebarOpen : ""} ${drawerMoving ? styles.drawerMoving : ""}`}
                id="primary-navigation"
                onPointerCancel={handleDrawerPointerUp}
                onPointerDown={handleDrawerPointerDown}
                onPointerMove={handleDrawerPointerMove}
                onPointerUp={handleDrawerPointerUp}
                ref={sidebarRef}
                style={{ "--drawer-offset": `${drawerOffset}px` } as CSSProperties}
            >
                <NavLink className={styles.brand} to="/">
                    <span className={styles.brandMark}><img src="/icon.svg" alt="" /></span>
                    <span><strong>DockerBridge</strong><small>本机 Docker 控制面</small></span>
                </NavLink>
                <button aria-label="关闭导航" className={styles.closeMenu} onClick={closeMenu} ref={closeButtonRef} title="关闭导航" type="button">
                    <Icon name="close" />
                </button>
                <div className={styles.navGroup}>
                    <p>工作区</p>
                    <Navigation items={workspaceItems} label="工作区" permissions={session.permissions} onNavigate={() => setMenuOpen(false)} />
                </div>
                <div className={styles.navGroup}>
                    <p>工具</p>
                    <Navigation items={toolItems} label="工具" permissions={session.permissions} onNavigate={() => setMenuOpen(false)} />
                </div>
                <div className={styles.sidebarFooter}>
                    <div aria-live="polite" className={styles.connectionSummary} role="status">
                        <span className={session.connected ? styles.onlineDot : styles.offlineDot} />
                        <span><strong>{session.connected ? "运行服务在线" : "连接已中断"}</strong><small>{session.connected ? "状态持续同步" : "正在自动恢复"}</small></span>
                    </div>
                    <Button className={styles.sidebarTheme} variant="ghost" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}><Icon name={theme === "dark" ? "sun" : "moon"} size={16} />{theme === "dark" ? "切换浅色外观" : "切换深色外观"}</Button>
                    <Button variant="ghost" onClick={logout}><Icon name="logout" size={16} />退出登录</Button>
                </div>
            </aside>
            {menuOpen && <button aria-label="关闭导航遮罩" className={styles.scrim} onClick={closeMenu} type="button" />}
            <header className={styles.header}>
                <button aria-controls="primary-navigation" aria-expanded={menuOpen} aria-label="打开导航" className={styles.menuButton} onClick={openMenu} ref={menuButtonRef} title="打开导航" type="button"><Icon name="menu" /></button>
                <div className={styles.pageContext}>
                    <h1>{meta.title}</h1>
                    <p>{meta.description}</p>
                </div>
                <div className={styles.headerActions}>
                    <span aria-live="polite" className={`${styles.connectionPill} ${session.connected ? styles.connected : ""}`} role="status"><span />{session.connected ? "实时连接" : "正在重连"}</span>
                    <button aria-label={theme === "dark" ? "切换浅色主题" : "切换深色主题"} aria-pressed={theme === "dark"} className={styles.iconButton} onClick={() => setTheme(theme === "dark" ? "light" : "dark")} title={theme === "dark" ? "切换浅色主题" : "切换深色主题"} type="button">
                        <Icon name={theme === "dark" ? "sun" : "moon"} size={17} />
                    </button>
                    <span className={styles.rolePill}>{session.role === "admin" ? "管理员" : session.role === "operator" ? "操作员" : "只读"}</span>
                    <span className={styles.avatar} title={`${session.username} · ${session.role}`}>{session.username.slice(0, 1).toUpperCase()}</span>
                </div>
            </header>
            {!session.connected && session.connectionError && <div className={styles.connectionBanner}>{session.connectionError}</div>}
            <main className={styles.main} id="main-content"><div className={styles.routeStage} key={location.pathname}><Outlet /></div></main>
            <nav aria-label="移动端主导航" className={styles.mobileNav}>
                {workspaceItems.filter(item => item.mobile).map(item => (
                    <NavLink className={({ isActive }) => isActive ? styles.mobileActive : ""} end={item.to === "/"} key={item.to} to={item.to}>
                        <Icon name={item.icon} size={19} /><span>{item.label.replace("运行", "").replace("Compose ", "")}</span>
                    </NavLink>
                ))}
            </nav>
        </div>
    );
}
