import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  // Each matchAll runs the whole production analysis (four windows, 20 Hz to 3.8 kHz): seconds, not ms.
  test: { include: ["lib/**/*.test.ts", "evals/**/*.test.ts"], testTimeout: 120_000 },
});
