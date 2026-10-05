import { afterEach, describe, expect, it, vi } from "vitest";
import { StackSummary } from "@/types/domain";
import { endpointFor, formatLastSeen, isEndpointOperational, isStackStale } from "./endpoints";

function makeStack(syncedAt ?: string) : StackSummary {
    return {
        name: "s",
        status: 3,
        endpoint: "",
        isManagedByDockge: true,
        isDiscoveredCompose: false,
        composeFileName: "compose.yaml",
        composeFilePath: "/opt/stacks/s/compose.yaml",
        syncedAt,
    };
}

afterEach(() => {
    vi.useRealTimers();
});

describe("endpointFor", () => {
    it("returns the registered endpoint unchanged", () => {
        const registered = { endpoint: "a",
            name: "A",
            url: "http://a",
            status: "online" as const,
            changedAt: "",
            lastSeenAt: null,
            message: "" };
        expect(endpointFor({ a: registered }, "a")).toBe(registered);
    });

    it("synthesizes a placeholder for unknown endpoints", () => {
        expect(endpointFor({}, "b")).toMatchObject({ endpoint: "b",
            name: "b",
            status: "connecting" });
    });

    it("treats the empty endpoint as the local online instance", () => {
        expect(endpointFor({}, "")).toMatchObject({ name: "本机",
            status: "online" });
    });
});

describe("isEndpointOperational", () => {
    it("is true only for online status", () => {
        const endpoints = { a: { endpoint: "a",
            name: "A",
            url: "",
            status: "online" as const,
            changedAt: "",
            lastSeenAt: null,
            message: "" } };
        expect(isEndpointOperational(endpoints, "a")).toBe(true);
        expect(isEndpointOperational(endpoints, "missing")).toBe(false);
    });
});

describe("isStackStale", () => {
    it("treats missing sync time as stale", () => {
        expect(isStackStale(makeStack(""))).toBe(true);
    });

    it("treats unparseable sync time as stale", () => {
        expect(isStackStale(makeStack("garbage"))).toBe(true);
    });

    it("is fresh within 90 seconds", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:01:00Z"));
        expect(isStackStale(makeStack("2026-01-01T00:00:30Z"))).toBe(false);
    });

    it("is stale after 90 seconds", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:02:00Z"));
        expect(isStackStale(makeStack("2026-01-01T00:00:00Z"))).toBe(true);
    });
});

describe("formatLastSeen", () => {
    it("returns 尚未连通 for null", () => {
        expect(formatLastSeen(null)).toBe("尚未连通");
    });

    it("returns the raw value for unparseable input", () => {
        expect(formatLastSeen("garbage")).toBe("garbage");
    });

    it("renders relative Chinese labels", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
        expect(formatLastSeen("2026-01-01T00:00:00Z")).toBe("刚刚");
        expect(formatLastSeen("2025-12-31T23:59:30Z")).toBe("30 秒前");
        expect(formatLastSeen("2025-12-31T23:30:00Z")).toBe("30 分钟前");
        expect(formatLastSeen("2025-12-31T21:00:00Z")).toBe("3 小时前");
    });

    it("falls back to locale string beyond a day", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-02T00:00:00Z"));
        const iso = "2026-01-01T00:00:00Z";
        expect(formatLastSeen(iso)).toBe(new Date(iso).toLocaleString());
    });
});
