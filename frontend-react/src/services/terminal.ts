let terminalSequence = 0;

/**
 * Generate a Socket-safe terminal name without requiring a secure browser
 * context. crypto.randomUUID() is unavailable on some HTTP/LAN origins.
 */
export function createConsoleTerminalName() {
    const bytes = new Uint32Array(3);
    if (typeof globalThis.crypto?.getRandomValues === "function") {
        globalThis.crypto.getRandomValues(bytes);
    } else {
        bytes[0] = Date.now() >>> 0;
        bytes[1] = terminalSequence++ >>> 0;
        bytes[2] = Math.floor(Math.random() * 0xffffffff) >>> 0;
    }
    const suffix = Array.from(bytes, value => value.toString(36)).join("").slice(0, 12);
    return `console_${Date.now()}_${suffix || terminalSequence++}`;
}
