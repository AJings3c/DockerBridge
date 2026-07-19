import styles from "./StatusBadge.module.css";

type Tone = "success" | "danger" | "warning" | "neutral" | "info";

function toneForStatus(status : string) : Tone {
    if ([ "running", "online", "active" ].includes(status)) {
        return "success";
    }
    if ([ "exited", "abnormal", "offline" ].includes(status)) {
        return "danger";
    }
    if ([ "restarting", "created", "stale", "connecting" ].includes(status)) {
        return "warning";
    }
    if (status === "unknown") {
        return "info";
    }
    return "neutral";
}

export function StatusBadge({ status, label } : { status: string; label?: string }) {
    const tone = toneForStatus(status);
    return <span className={`${styles.badge} ${styles[tone]}`}>{label || status}</span>;
}
