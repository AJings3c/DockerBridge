import os from "os";

const MAX_POINTS = 180;
const LOCK_CODES = [ "EBUSY", "EPERM", "ENOTEMPTY" ];

export interface HostMetricsSample {
    t : number;
    cpuPercent : number;
    memoryPercent : number;
    memoryUsedBytes : number;
    memoryTotalBytes : number;
    netRxBytesPerSec : number;
    netTxBytesPerSec : number;
}

export interface ContainerMetricsSample {
    t : number;
    cpuPercent : number;
    memoryPercent : number;
    memoryUsedBytes : number;
    netRxBytesPerSec : number;
    netTxBytesPerSec : number;
    blockReadBytesPerSec : number;
    blockWriteBytesPerSec : number;
}

interface RingBuffer<T> {
    points : T[];
}

function pushCapped<T>(buffer : RingBuffer<T>, point : T, cap = MAX_POINTS) {
    buffer.points.push(point);
    if (buffer.points.length > cap) {
        buffer.points.splice(0, buffer.points.length - cap);
    }
}

function parsePercent(value : unknown) : number {
    const parsed = parseFloat(String(value ?? "").replace("%", ""));
    return Number.isFinite(parsed) ? parsed : 0;
}

function parseBytes(value : unknown) : number {
    const match = /([\d.]+)\s*(B|kB|MB|GB|TB|KiB|MiB|GiB|TiB)/.exec(String(value ?? ""));
    if (!match) {
        return 0;
    }
    const units : Record<string, number> = {
        "B": 1,
        "kB": 1000,
        "MB": 1000 ** 2,
        "GB": 1000 ** 3,
        "TB": 1000 ** 4,
        "KiB": 1024,
        "MiB": 1024 ** 2,
        "GiB": 1024 ** 3,
        "TiB": 1024 ** 4,
    };
    return parseFloat(match[1]) * (units[match[2]] || 1);
}

/**
 * Parses docker stats MemUsage like "123.4MiB / 15.5GiB" into the used bytes part.
 */
export function parseMemUsageBytes(value : unknown) : number {
    const used = String(value ?? "").split("/")[0];
    return parseBytes(used);
}

export function parseNetIOTotals(value : unknown) : { rx : number; tx : number } {
    const [ inPart = "", outPart = "" ] = String(value ?? "").split("/");
    return { rx: parseBytes(inPart),
        tx: parseBytes(outPart) };
}

export function parseBlockIOTotals(value : unknown) : { read : number; write : number } {
    const [ readPart = "", writePart = "" ] = String(value ?? "").split("/");
    return { read: parseBytes(readPart),
        write: parseBytes(writePart) };
}

function cpuPercentFromDelta(prev : os.CpuInfo[], next : os.CpuInfo[]) : number {
    if (prev.length === 0 || prev.length !== next.length) {
        return 0;
    }
    let idle = 0;
    let total = 0;
    for (let i = 0; i < next.length; i++) {
        const a = prev[i].times;
        const b = next[i].times;
        const prevTotal = a.user + a.nice + a.sys + a.idle + a.irq;
        const nextTotal = b.user + b.nice + b.sys + b.idle + b.irq;
        idle += b.idle - a.idle;
        total += nextTotal - prevTotal;
    }
    if (total <= 0) {
        return 0;
    }
    return Math.min(100, Math.max(0, Math.round(((total - idle) / total) * 1000) / 10));
}

/**
 * In-memory ring buffers of host and container metrics samples.
 * Nothing is persisted; history restarts with the server process.
 */
export class MetricsHistory {
    private host : RingBuffer<HostMetricsSample> = { points: [] };
    private containers = new Map<string, RingBuffer<ContainerMetricsSample>>();
    private lastCpus = os.cpus();
    private lastHostNet = { rx: 0,
        tx: 0 };

    private lastContainerNet = new Map<string, { rx : number; tx : number; read : number; write : number }>();

    get size() {
        return this.host.points.length;
    }

    recordHost(now = Date.now()) : HostMetricsSample {
        const cpus = os.cpus();
        const memoryTotal = os.totalmem();
        const memoryUsed = memoryTotal - os.freemem();
        const sample : HostMetricsSample = {
            t: now,
            cpuPercent: cpuPercentFromDelta(this.lastCpus, cpus),
            memoryPercent: memoryTotal > 0 ? Math.round((memoryUsed / memoryTotal) * 1000) / 10 : 0,
            memoryUsedBytes: memoryUsed,
            memoryTotalBytes: memoryTotal,
            netRxBytesPerSec: 0,
            netTxBytesPerSec: 0,
        };
        this.lastCpus = cpus;
        pushCapped(this.host, sample);
        return sample;
    }

    /**
     * Records one docker stats row. Net/block values are cumulative totals from
     * docker, so rates are derived from the delta against the previous sample.
     */
    recordContainer(name : string, stats : Record<string, unknown>, now = Date.now()) {
        const net = parseNetIOTotals(stats.NetIO);
        const block = parseBlockIOTotals(stats.BlockIO);
        const prev = this.lastContainerNet.get(name);
        const elapsedSec = prev ? Math.max(1, Math.round((now - (this.lastContainerSampleTime(name) || now)) / 1000)) : 0;
        const sample : ContainerMetricsSample = {
            t: now,
            cpuPercent: parsePercent(stats.CPUPerc),
            memoryPercent: parsePercent(stats.MemPerc),
            memoryUsedBytes: parseMemUsageBytes(stats.MemUsage),
            netRxBytesPerSec: prev ? Math.max(0, Math.round((net.rx - prev.rx) / elapsedSec)) : 0,
            netTxBytesPerSec: prev ? Math.max(0, Math.round((net.tx - prev.tx) / elapsedSec)) : 0,
            blockReadBytesPerSec: prev ? Math.max(0, Math.round((block.read - prev.read) / elapsedSec)) : 0,
            blockWriteBytesPerSec: prev ? Math.max(0, Math.round((block.write - prev.write) / elapsedSec)) : 0,
        };
        this.lastContainerNet.set(name, { ...net,
            ...block });
        this.lastContainerTimes.set(name, now);
        let buffer = this.containers.get(name);
        if (!buffer) {
            buffer = { points: [] };
            this.containers.set(name, buffer);
        }
        pushCapped(buffer, sample);
        return sample;
    }

    private lastContainerTimes = new Map<string, number>();

    private lastContainerSampleTime(name : string) : number | undefined {
        return this.lastContainerTimes.get(name);
    }

    /**
     * Drops containers that no longer appear in docker stats output.
     */
    retainContainers(activeNames : string[]) {
        const active = new Set(activeNames);
        for (const name of Array.from(this.containers.keys())) {
            if (!active.has(name)) {
                this.containers.delete(name);
                this.lastContainerNet.delete(name);
                this.lastContainerTimes.delete(name);
            }
        }
    }

    hostSeries(limit = MAX_POINTS) : HostMetricsSample[] {
        return this.host.points.slice(-limit);
    }

    containerSeries(name : string, limit = MAX_POINTS) : ContainerMetricsSample[] {
        return (this.containers.get(name)?.points || []).slice(-limit);
    }

    containerNames() : string[] {
        return Array.from(this.containers.keys());
    }
}
