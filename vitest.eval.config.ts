import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Evals: slow, run on demand (`pnpm eval`, or `pnpm eval evals/synthetic` for one), never in CI's
// unit run. Each corpus file runs in its own worker.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: { include: ["evals/**/*.eval.ts"], testTimeout: 1_800_000, hookTimeout: 600_000 },
});
