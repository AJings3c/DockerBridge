import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "frontend-react/src"),
        },
    },
    test: {
        environment: "node",
        include: [ "frontend-react/src/**/*.test.ts" ],
    },
});
