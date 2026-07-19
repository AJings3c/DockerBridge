import styles from "./SkeletonRows.module.css";

export function SkeletonRows({ rows = 6 } : { rows?: number }) {
    return (
        <div aria-label="正在加载" className={styles.rows} role="status">
            {Array.from({ length: rows }).map((_, index) => (
                <div className={styles.row} key={index}>
                    <span className={styles.primary} />
                    <span className={styles.secondary} />
                    <span className={styles.short} />
                </div>
            ))}
        </div>
    );
}
