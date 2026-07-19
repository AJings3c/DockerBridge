import { ReactNode } from "react";
import styles from "./Notice.module.css";

export function Notice({ children, tone = "default", className = "" } : { children: ReactNode; tone?: "default" | "error" | "warning"; className?: string }) {
    return <div className={[ styles.notice, tone !== "default" ? styles[tone] : "", className ].filter(Boolean).join(" ")} role={tone === "error" ? "alert" : "status"}>{children}</div>;
}
