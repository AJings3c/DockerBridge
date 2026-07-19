import { FormEvent, useState } from "react";
import { Navigate } from "react-router-dom";
import { Button } from "@/components/primitives/Button";
import { login, setup } from "@/services/session";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { rememberChanged } from "@/store/sessionSlice";
import styles from "./AuthPage.module.css";

export function AuthPage() {
    const dispatch = useAppDispatch();
    const session = useAppSelector(state => state.session);
    const [ username, setUsername ] = useState("");
    const [ password, setPassword ] = useState("");
    const [ twoFactorToken, setTwoFactorToken ] = useState("");
    const [ tokenRequired, setTokenRequired ] = useState(false);
    const [ pending, setPending ] = useState(false);
    const [ error, setError ] = useState("");

    if (session.loggedIn) {
        return <Navigate replace to="/" />;
    }

    const submit = async (event : FormEvent) => {
        event.preventDefault();
        setPending(true);
        setError("");
        if (session.setupRequired) {
            const response = await setup(username, password);
            if (response.ok) {
                const loginResponse = await login(username, password);
                if (!loginResponse.ok) {
                    setError(loginResponse.msg || "初始化完成，但自动登录失败");
                }
            } else {
                setError(response.msg || "初始化失败");
            }
        } else {
            const response = await login(username, password, twoFactorToken);
            if (response.tokenRequired) {
                setTokenRequired(true);
            } else if (!response.ok) {
                setError(response.msg || "用户名或密码不正确");
            }
        }
        setPending(false);
    };

    return (
        <main className={styles.page}>
            <header className={styles.topBar}>
                <div className={styles.brand}><span className={styles.brandMark}><img src="/icon.svg" alt="" /></span><span><strong>DockerBridge</strong><small>Docker 控制面</small></span></div>
            </header>
            <section aria-labelledby="auth-title" className={styles.authPanel}>
                <div className={styles.copy}><span className={styles.eyebrow}>{session.setupRequired ? "首次设置" : "安全登录"}</span><h1 id="auth-title">{session.setupRequired ? "创建管理员账户" : "欢迎回来"}</h1><p>{session.setupRequired ? "完成账户设置后即可进入工作区。" : "使用你的 DockerBridge 账户继续。"}</p></div>
                <form onSubmit={submit}>
                    <label><span>用户名</span><input aria-describedby={error ? "auth-error" : undefined} aria-invalid={Boolean(error)} autoComplete="username" autoFocus onChange={event => setUsername(event.target.value)} required value={username} /></label>
                    <label><span>密码</span><input aria-describedby={error ? "auth-error" : undefined} aria-invalid={Boolean(error)} autoComplete={session.setupRequired ? "new-password" : "current-password"} minLength={6} onChange={event => setPassword(event.target.value)} required type="password" value={password} /></label>
                    {tokenRequired && <label><span>两步验证码</span><input autoComplete="one-time-code" inputMode="numeric" maxLength={6} onChange={event => setTwoFactorToken(event.target.value)} pattern="[0-9]{6}" required value={twoFactorToken} /></label>}
                    {!session.setupRequired && <label className={styles.remember}><input checked={session.remember} onChange={event => dispatch(rememberChanged(event.target.checked))} type="checkbox" />在此设备保持登录</label>}
                    {error && <div className={styles.error} id="auth-error" role="alert">{error}</div>}
                    <Button className={styles.submit} disabled={!session.connected} loading={pending} variant="primary" type="submit">{session.setupRequired ? "创建管理员" : "登录"}</Button>
                </form>
            </section>
            <div aria-live="polite" className={styles.connection} role="status"><span className={session.connected ? styles.online : styles.offline} />{session.connected ? "运行服务已连接" : session.connecting ? "正在连接运行服务" : "运行服务连接失败"}</div>
        </main>
    );
}
