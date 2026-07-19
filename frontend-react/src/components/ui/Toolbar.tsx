import { HTMLAttributes } from "react";
import styles from "./Toolbar.module.css";

export function Toolbar(props : HTMLAttributes<HTMLDivElement>) {
    return <div className={styles.bar} {...props} />;
}

export function SegmentedControl(props : HTMLAttributes<HTMLDivElement>) {
    return <div className={styles.segmented} {...props} />;
}
