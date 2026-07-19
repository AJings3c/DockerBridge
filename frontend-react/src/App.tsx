import { lazy, ReactNode, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "@/layout/AppShell";
import { useAppSelector } from "@/store/hooks";
import { UserPermission } from "@/types/domain";

const AuthPage = lazy(() => import("@/pages/AuthPage").then(module => ({ default: module.AuthPage })));
const AgentsPage = lazy(() => import("@/pages/AgentsPage").then(module => ({ default: module.AgentsPage })));
const ComposeProjectsPage = lazy(() => import("@/pages/ComposeProjectsPage").then(module => ({ default: module.ComposeProjectsPage })));
const ComposeRepositoryPage = lazy(() => import("@/pages/ComposeRepositoryPage").then(module => ({ default: module.ComposeRepositoryPage })));
const ConsolePage = lazy(() => import("@/pages/ConsolePage").then(module => ({ default: module.ConsolePage })));
const ContainersPage = lazy(() => import("@/pages/ContainersPage").then(module => ({ default: module.ContainersPage })));
const DockerResourcesPage = lazy(() => import("@/pages/DockerResourcesPage").then(module => ({ default: module.DockerResourcesPage })));
const DashboardPage = lazy(() => import("@/pages/DashboardPage").then(module => ({ default: module.DashboardPage })));
const OperationLogPage = lazy(() => import("@/pages/OperationLogPage").then(module => ({ default: module.OperationLogPage })));
const SettingsPage = lazy(() => import("@/pages/SettingsPage").then(module => ({ default: module.SettingsPage })));

function AppLoading({ label } : { label: string }) {
    return (
        <div className="grid min-h-screen place-items-center bg-[var(--bg-canvas)] px-6">
            <div className="flex items-center gap-3 text-sm text-[var(--ink-secondary)]">
                <span className="h-2.5 w-2.5 rounded-full bg-[var(--accent)] shadow-[0_0_0_6px_color-mix(in_oklch,var(--accent),transparent_86%)]" />
                <span>{label}</span>
            </div>
        </div>
    );
}

function ProtectedShell() {
    const session = useAppSelector(state => state.session);
    if (!session.loggedIn) {
        return <Navigate replace to="/login" />;
    }
    return <AppShell />;
}

function PermissionRoute({ permission, children } : { permission: UserPermission; children: ReactNode }) {
    const permissions = useAppSelector(state => state.session.permissions);
    return permissions.includes(permission) ? children : <Navigate replace to="/" />;
}

export function App() {
    const session = useAppSelector(state => state.session);
    if (!session.initialized && !session.setupRequired) {
        return <AppLoading label="正在连接 DockerBridge…" />;
    }
    return (
        <Suspense fallback={<AppLoading label="正在载入工作区…" />}>
            <Routes>
                <Route element={<AuthPage />} path="/login" />
                <Route element={<ProtectedShell />}>
                    <Route element={<DashboardPage />} index />
                    <Route element={<ContainersPage />} path="containers" />
                    <Route element={<DockerResourcesPage />} path="resources" />
                    <Route element={<ComposeProjectsPage />} path="compose" />
                    <Route element={<ComposeRepositoryPage />} path="compose-repository" />
                    <Route element={<OperationLogPage />} path="operations" />
                    <Route element={<PermissionRoute permission="agents"><AgentsPage /></PermissionRoute>} path="agents" />
                    <Route element={<PermissionRoute permission="terminal"><ConsolePage /></PermissionRoute>} path="console" />
                    <Route element={<PermissionRoute permission="settings"><SettingsPage /></PermissionRoute>} path="settings" />
                </Route>
                <Route element={<Navigate replace to={session.loggedIn ? "/" : "/login"} />} path="*" />
            </Routes>
        </Suspense>
    );
}
