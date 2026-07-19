import { CSSProperties, ReactNode } from "react";
import styles from "./MetricStrip.module.css";

export interface MetricItem {
    label: string;
    value: ReactNode;
    tone?: "default" | "warning" | "danger";
}

export function MetricStrip({ items } : { items: MetricItem[] }) {
    const style = { "--metric-count": items.length } as CSSProperties;
    return <div className={styles.strip} style={style}>{items.map(item => <div className={`${styles.metric} ${item.tone && item.tone !== "default" ? styles[item.tone] : ""}`} key={item.label}><span>{item.label}</span><strong>{item.value}</strong></div>)}</div>;
}
