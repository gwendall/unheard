import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // The physics core runs in the browser, in Node tests and later in a worker: no DOM, no React.
    files: ["lib/core/**"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{ group: ["react", "react-dom", "next", "next/*", "@/components/*"], message: "lib/core stays free of the DOM and React." }] }],
    },
  },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", ".claude/**", "public/**", "test-results/**"]),
]);
