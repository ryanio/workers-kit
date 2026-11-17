import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Two projects: `unit` runs under Node, `workerd` runs inside the Workers
// runtime with a real D1 database and real Workflows (test/workerd/).
export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["test/unit/**/*.test.ts"] } },
      {
        plugins: [cloudflareTest({ wrangler: { configPath: "./test/workerd/wrangler.jsonc" } })],
        test: { name: "workerd", include: ["test/workerd/**/*.test.ts"] },
      },
    ],
  },
});
