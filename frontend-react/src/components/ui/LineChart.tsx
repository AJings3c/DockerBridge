import { useId } from "react";
import styles from "./LineChart.module.css";

export interface LineChartPoint {
    t : number;
    value : number;
}

interface LineChartProps {
    points : LineChartPoint[];
    label : string;
    unit ?: string;
    /** Y-axis maximum; when omitted the scale adapts to the data. */
    maxY ?: number;
    /** Value above which the current-value chip turns into the danger tone. */
    warnAbove ?: number;
    formatValue ?: (value : number) => string;
    height ?: number;
}

function formatBytesShort(value : number) {
    if (value >= 1024 ** 3) {
        return `${(value / 1024 ** 3).toFixed(1)} GB`;
    }
    if (value >= 1024 ** 2) {
        return `${(value / 1024 ** 2).toFixed(1)} MB`;
    }
    if (value >= 1024) {
        return `${(value / 1024).toFixed(1)} KB`;
    }
    return `${Math.round(value)} B`;
}

export function formatChartValue(value : number, unit ?: string) {
    if (unit === "%") {
        return `${value.toFixed(1)}%`;
    }
    if (unit === "bytes/s") {
        return `${formatBytesShort(value)}/s`;
    }
    return String(Math.round(value * 10) / 10);
}

/**
 * Dependency-free SVG sparkline with an area fill, tuned to the design tokens.
 * Expects chronological points; renders an empty state when fewer than two exist.
 */
export function LineChart({ points, label, unit, maxY, warnAbove, formatValue, height = 64 } : LineChartProps) {
    const gradientId = useId();
    const width = 300;
    const values = points.map(point => point.value);
    const current = values.length > 0 ? values[values.length - 1] : 0;
    const scaleMax = maxY ?? Math.max(1, ...values) * 1.15;
    const resolvedFormat = formatValue ?? ((value : number) => formatChartValue(value, unit));
    const danger = warnAbove !== undefined && current >= warnAbove;

    const step = points.length > 1 ? width / (points.length - 1) : width;
    const coords = points.map((point, index) => {
        const x = index * step;
        const y = height - (Math.min(point.value, scaleMax) / scaleMax) * (height - 4) - 2;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    const linePath = coords.length > 0 ? `M${coords.join(" L")}` : "";
    const areaPath = coords.length > 1 ? `${linePath} L${width},${height} L0,${height} Z` : "";
    const timeSpan = points.length > 1 ? Math.round((points[points.length - 1].t - points[0].t) / 1000) : 0;

    return (
        <div className={styles.chart} role="img" aria-label={`${label}: ${resolvedFormat(current)}`}>
            <div className={styles.chartHeader}>
                <span className={styles.chartLabel}>{label}</span>
                <strong className={`${styles.chartValue} ${danger ? styles.chartValueDanger : ""}`}>{resolvedFormat(current)}</strong>
            </div>
            <svg className={styles.chartSvg} preserveAspectRatio="none" viewBox={`0 0 ${width} ${height}`} style={{ height }}>
                {areaPath && <defs>
                    <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.28" />
                        <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.02" />
                    </linearGradient>
                </defs>}
                {areaPath && <path d={areaPath} fill={`url(#${gradientId})`} />}
                {linePath && <path className={styles.chartLine} d={linePath} fill="none" />}
                {warnAbove !== undefined && warnAbove <= scaleMax && <line className={styles.chartWarnLine} x1="0" x2={width} y1={height - (warnAbove / scaleMax) * (height - 4) - 2} y2={height - (warnAbove / scaleMax) * (height - 4) - 2} />}
            </svg>
            <div className={styles.chartFooter}>
                <span>{timeSpan > 0 ? `最近 ${Math.round(timeSpan / 60) || 1} 分钟` : "采样中"}</span>
                <span>峰值 {resolvedFormat(Math.max(...values, 0))}</span>
            </div>
        </div>
    );
}
