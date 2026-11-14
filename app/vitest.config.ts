import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          AUTH_MODE: "dev",
          DEV_USER_EMAIL: "tester@example.com",
          AI_PROVIDER: "mock",
          VECTOR_BACKEND: "d1-exact",
        },
      },
    }),
  ],
  test: { setupFiles: ["./test/setup.ts"] },
});
