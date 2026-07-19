import { ReactNode } from "react";
import { Icon } from "@/components/Icon";
import styles from "./EmptyState.module.css";

export function EmptyState({ title, description, action } : { title: string; description: string; action?: ReactNode }) {
    return (
        <div className={styles.empty}>
            <div aria-hidden="true" className={styles.icon}><Icon name="boxes" size={19} /></div>
            <h3>{title}</h3>
            <p>{description}</p>
            {action && <div className={styles.action}>{action}</div>}
        </div>
    );
}
