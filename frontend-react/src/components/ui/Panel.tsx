import { HTMLAttributes, ReactNode } from "react";
import styles from "./Panel.module.css";

export function Panel({ className = "", flush = false, ...props } : HTMLAttributes<HTMLElement> & { flush?: boolean }) {
    return <section className={[ styles.panel, flush ? styles.flush : "", className ].filter(Boolean).join(" ")} {...props} />;
}

export function PanelHeader({ title, description, action } : { title: string; description?: string; action?: ReactNode }) {
    return <div className={styles.header}><div><h3>{title}</h3>{description && <p>{description}</p>}</div>{action}</div>;
}
