const BYTE_UNITS = [ "B", "KiB", "MiB", "GiB", "TiB" ];

export function formatBytes(value : number | null | undefined, fallback = "0 B") : string {
    if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) {
        return fallback;
    }
    let size = value;
    let unit = 0;
    while (size >= 1024 && unit < BYTE_UNITS.length - 1) {
        size /= 1024;
        unit += 1;
    }
    return `${size.toFixed(unit === 0 ? 0 : 1)} ${BYTE_UNITS[unit]}`;
}

export function formatTime(value : string | null | undefined, fallback = "—") : string {
    if (!value) {
        return fallback;
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function formatUptime(value : number | undefined) : string {
    if (!value || value < 0) {
        return "未知";
    }
    const days = Math.floor(value / 86400);
    const hours = Math.floor((value % 86400) / 3600);
    if (days > 0) {
        return `${days} 天 ${hours} 小时`;
    }
    return `${hours} 小时`;
}

export function formatDuration(value : number | null) : string {
    if (value === null) {
        return "—";
    }
    if (value < 1000) {
        return `${value} ms`;
    }
    return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)} s`;
}

export function formatSnapshot(value : string | null) : string {
    if (!value) {
        return "无快照";
    }
    try {
        return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
        return value;
    }
}
