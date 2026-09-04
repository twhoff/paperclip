import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/db", "packages/adapter-utils", "packages/adapters/codex-local", "packages/adapters/opencode-local", "packages/adapters/pi-local", "packages/adapters/oz-local", "packages/adapters/copilot-cli", "server", "ui", "cli"],
  },
});
