import { describe, expect, it } from "vitest";
import { formatBytes, formatDuration, formatSnapshot, formatTime, formatUptime } from "./format";

describe("formatBytes", () => {
    it("formats byte units in binary steps", () => {
        expect(formatBytes(0)).toBe("0 B");
        expect(formatBytes(512)).toBe("512 B");
        expect(formatBytes(1024)).toBe("1.0 KiB");
        expect(formatBytes(1536)).toBe("1.5 KiB");
        expect(formatBytes(1024 * 1024 * 5)).toBe("5.0 MiB");
        expect(formatBytes(1024 ** 4 * 2)).toBe("2.0 TiB");
    });

    it("caps at the largest unit", () => {
        expect(formatBytes(1024 ** 6)).toContain("TiB");
    });

    it("returns the fallback for null, undefined, non-finite and non-positive values", () => {
        expect(formatBytes(null, "未采样")).toBe("未采样");
        expect(formatBytes(undefined, "未知")).toBe("未知");
        expect(formatBytes(Number.NaN, "未知")).toBe("未知");
        expect(formatBytes(-5, "未知")).toBe("未知");
        expect(formatBytes(0, "未知")).toBe("未知");
    });

    it("defaults the fallback to 0 B", () => {
        expect(formatBytes(null)).toBe("0 B");
    });
});

describe("formatTime", () => {
    it("returns the fallback for empty values", () => {
        expect(formatTime(null, "从未")).toBe("从未");
        expect(formatTime(undefined, "—")).toBe("—");
        expect(formatTime("", "—")).toBe("—");
    });

    it("returns the raw value when it is not a valid date", () => {
        expect(formatTime("not-a-date", "—")).toBe("not-a-date");
    });

    it("formats valid dates with the default locale", () => {
        const iso = "2026-01-02T03:04:05Z";
        expect(formatTime(iso)).toBe(new Date(iso).toLocaleString());
    });
});

describe("formatUptime", () => {
    it("returns 未知 for missing or negative values", () => {
        expect(formatUptime(undefined)).toBe("未知");
        expect(formatUptime(-1)).toBe("未知");
    });

    it("renders hours below one day", () => {
        expect(formatUptime(3600 * 5)).toBe("5 小时");
    });

    it("renders days plus hours at or above one day", () => {
        expect(formatUptime(86400 * 2 + 3600 * 3)).toBe("2 天 3 小时");
    });
});

describe("formatDuration", () => {
    it("renders a dash for null", () => {
        expect(formatDuration(null)).toBe("—");
    });

    it("keeps sub-second values in milliseconds", () => {
        expect(formatDuration(250)).toBe("250 ms");
    });

    it("uses one decimal below ten seconds and whole seconds above", () => {
        expect(formatDuration(1500)).toBe("1.5 s");
        expect(formatDuration(15000)).toBe("15 s");
    });
});

describe("formatSnapshot", () => {
    it("returns 无快照 for empty values", () => {
        expect(formatSnapshot(null)).toBe("无快照");
        expect(formatSnapshot("")).toBe("无快照");
    });

    it("pretty-prints valid JSON", () => {
        expect(formatSnapshot("{\"a\":1}")).toBe("{\n  \"a\": 1\n}");
    });

    it("passes through invalid JSON unchanged", () => {
        expect(formatSnapshot("not json")).toBe("not json");
    });
});
