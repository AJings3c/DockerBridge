import { CSSProperties } from "react";
import styles from "./ProgressBar.module.css";

export function ProgressBar({ value, label } : { value: number; label: string }) {
    const safeValue = Math.max(0, Math.min(100, value));
    const tone = safeValue >= 85 ? styles.danger : safeValue >= 70 ? styles.warning : "";
    const style = { "--meter-value": safeValue / 100 } as CSSProperties;
    return (
        <div aria-label={`${label} ${safeValue.toFixed(1)}%`} aria-valuemax={100} aria-valuemin={0} aria-valuenow={safeValue} className={styles.track} role="meter">
            <div className={`${styles.fill} ${tone}`} style={style} />
        </div>
    );
}
